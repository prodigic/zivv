import { lstatSync, mkdtempSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { captureReviewedSource } from "./source-build.js";
import {
  CANDIDATE_CONFIG_FILES,
  captureExportConfiguration,
  configurationDigest,
  type CandidateConfiguration,
} from "./export-configuration.js";
import {
  encryptLedgerSnapshot,
  decryptLedgerSnapshot,
  loadBackupKey,
  secureOperatorDirectory,
} from "./encrypted-backup.js";
import { resolvePrivateCandidateDirectory } from "./private-artifacts.js";
import {
  buildReviewedWeeklyCandidate,
  readPublishableCandidate,
} from "./reviewed-candidate.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { validateLedger } from "./ledger.js";
import { normalizeSiteBase } from "../../utils/site-base.js";
import { sha256 } from "./steve-preflight.js";
import { parseWeeklyEditionLedger } from "./weekly.js";
import {
  transitionWeeklyRun,
  type StageEvidence,
  type WeeklyRunState,
} from "./weekly-run-state.js";
import type { WeeklyRunJournal, WeeklyRunLease } from "./weekly-run-journal.js";
import type { IngestionLedger } from "../../types/ingestion.js";
import type { ReleaseCandidate } from "./release-candidate.js";

export interface WeeklyCandidateBuildOptions {
  sourceCommit: string;
  purpose: "preview" | "release";
  basePath: string;
  npmCli: string;
}
type Stage = "enrich" | "export" | "validate";
type Phase = "started" | "artifact-saved" | "effect-committed" | "completed";
class CandidateRunError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
function fail(code: string): never {
  throw new CandidateRunError(code);
}
function exportEvidence(candidate: ReleaseCandidate): StageEvidence {
  return {
    ledgerRevision: candidate.ledgerRevision,
    snapshotRevision: candidate.ledgerRevision,
    manifestSha256: candidate.manifestSha256,
    datasetVersion: candidate.datasetVersion,
    candidateId: candidate.candidateId,
    editionId: candidate.editionId,
    cutoffEpochMs: candidate.cutoffEpochMs,
    membershipSha256: candidate.membershipSha256,
    configSha256: candidate.configSha256,
  };
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort())
  )
    fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
  return value as Record<string, unknown>;
}
function base64(value: unknown): Buffer {
  if (typeof value !== "string") fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
  return bytes;
}
function options(value: unknown): WeeklyCandidateBuildOptions {
  const raw = object(value, ["sourceCommit", "purpose", "basePath", "npmCli"]);
  if (
    typeof raw.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(raw.sourceCommit) ||
    !["preview", "release"].includes(String(raw.purpose)) ||
    typeof raw.basePath !== "string" ||
    normalizeSiteBase(raw.basePath) !== raw.basePath ||
    typeof raw.npmCli !== "string" ||
    !raw.npmCli
  )
    fail("INVALID_CANDIDATE_BUILD_OPTIONS");
  return raw as unknown as WeeklyCandidateBuildOptions;
}

/** Apply captured reviewed metadata and build/validate the frozen catalog's candidate. */
export async function runWeeklyCandidateStages(input: {
  root: string;
  operatorDirectory: string;
  state: WeeklyRunState;
  journal: WeeklyRunJournal;
  lease: WeeklyRunLease;
  stopAfter: Stage;
  candidateBuild?: WeeklyCandidateBuildOptions;
  verifyContext: () => void;
  heartbeatMs: number;
  onProgress: (stage: Stage, phase: Phase) => Promise<void>;
}): Promise<WeeklyRunState> {
  let state = input.state;
  const item = (stage: string) =>
    state.stages.find((value) => value.stage === stage)!;
  const transition = (
    stage: Stage,
    change: Parameters<typeof transitionWeeklyRun>[3]
  ) => {
    input.verifyContext();
    state = input.journal.save(
      transitionWeeklyRun(state, state.revision, stage, change, Date.now()),
      state.revision,
      input.lease
    );
  };
  const saved = (stage: "freeze" | Stage) => {
    const bytes = input.journal.readArtifact(
      state.runId,
      stage,
      item(stage).attempt
    );
    if (!bytes) fail("MISSING_STAGE_ARTIFACT");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  };
  // The preceding freeze helper verified this captured intent against its state and file.
  const frozen = saved("freeze") as {
    ledger: IngestionLedger;
    after: string;
    ledgerRevision: string;
  };
  validateLedger(frozen.ledger);
  if (
    ledgerDigest(frozen.ledger) !== frozen.ledgerRevision ||
    frozen.ledgerRevision !== item("freeze").evidence?.ledgerRevision
  )
    fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
  const weeklyBytes = base64(frozen.after);
  const edition = parseWeeklyEditionLedger(
    JSON.parse(weeklyBytes.toString("utf8"))
  ).editions.find((value) => value.editionId === state.source.editionId);
  if (
    !edition ||
    edition.endEpochMs !== item("freeze").evidence?.cutoffEpochMs ||
    sha256(canonicalJson(edition.eventIds)) !==
      item("freeze").evidence?.membershipSha256
  )
    fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
  const parent = resolvePrivateCandidateDirectory(
    join(input.operatorDirectory, "weekly-candidates")
  );
  secureOperatorDirectory(parent);
  const newDirectory = () => {
    input.verifyContext();
    const path = mkdtempSync(join(parent, "candidate-work-"));
    secureOperatorDirectory(path);
    return path;
  };
  const checkedDirectory = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !/^candidate-work-[A-Za-z0-9_-]+$/.test(relative(parent, value)) ||
      resolvePrivateCandidateDirectory(value) !== resolve(value) ||
      lstatSync(value).isSymbolicLink()
    )
      fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
    return value;
  };
  const saveArtifact = (stage: Stage, value: unknown) => {
    input.verifyContext();
    input.journal.writeArtifact(
      state.runId,
      stage,
      Buffer.from(canonicalJson(value) + "\n"),
      input.lease
    );
  };
  function enrichment() {
    const value = object(saved("enrich"), [
      "schemaVersion",
      "build",
      "configuration",
      "configSha256",
    ]);
    if (value.schemaVersion !== 1) fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
    const build = options(value.build);
    const buildSha256 = sha256(canonicalJson(build));
    if (
      item("enrich").status === "succeeded" &&
      item("enrich").evidence?.buildSha256 !== buildSha256
    )
      fail("CANDIDATE_BUILD_CONTEXT_CHANGED");
    if (
      input.candidateBuild &&
      canonicalJson(options(input.candidateBuild)) !== canonicalJson(build)
    )
      fail("CANDIDATE_BUILD_CONTEXT_CHANGED");
    const encoded = object(value.configuration, [...CANDIDATE_CONFIG_FILES]);
    const configuration = Object.fromEntries(
      CANDIDATE_CONFIG_FILES.map((path) => [
        path,
        encoded[path] === null ? null : base64(encoded[path]),
      ])
    ) as CandidateConfiguration;
    if (
      !configuration["ingestion/weekly-editions.json"]?.equals(weeklyBytes) ||
      configurationDigest(configuration) !== value.configSha256
    )
      fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
    return { build, buildSha256, configSha256: String(value.configSha256) };
  }
  const key = loadBackupKey(input.operatorDirectory);
  function exportIntent() {
    const value = object(saved("export"), [
      "schemaVersion",
      "workDirectory",
      "snapshot",
    ]);
    if (value.schemaVersion !== 1) fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
    const snapshot = base64(value.snapshot);
    if (
      ledgerDigest(decryptLedgerSnapshot(snapshot, key)) !==
      frozen.ledgerRevision
    )
      fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
    return { workDirectory: checkedDirectory(value.workDirectory), snapshot };
  }
  async function verifyCandidate(candidateId: string) {
    const captured = enrichment(),
      intent = exportIntent();
    const directories = readdirSync(intent.workDirectory).filter((name) =>
      name.startsWith("candidate-")
    );
    if (directories.length !== 1) fail("CANDIDATE_BUNDLE_MISSING_OR_AMBIGUOUS");
    input.verifyContext();
    const verified = await readPublishableCandidate({
      directory: join(intent.workDirectory, directories[0]),
      recoveryKey: key,
      expectedCandidateId: candidateId,
      expectedSourceCommit: captured.build.sourceCommit,
      purpose: captured.build.purpose,
      basePath: captured.build.basePath,
    });
    const candidate = verified.candidate;
    if (
      candidate.ledgerRevision !== frozen.ledgerRevision ||
      candidate.snapshotSha256 !== sha256(intent.snapshot) ||
      !verified.snapshot.equals(intent.snapshot) ||
      candidate.configSha256 !== captured.configSha256 ||
      candidate.editionId !== edition!.editionId ||
      candidate.cutoffEpochMs !== edition!.endEpochMs ||
      candidate.membershipSha256 !== sha256(canonicalJson(edition!.eventIds))
    )
      fail("CANDIDATE_FROZEN_INPUTS_CHANGED");
    input.verifyContext();
    return candidate;
  }
  for (const stage of ["enrich", "export", "validate"] as const) {
    input.verifyContext();
    const original = item(stage);
    if (original.status === "succeeded") {
      if (stage === "enrich") {
        if (enrichment().configSha256 !== original.evidence?.configSha256)
          fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
      } else {
        const candidate = await verifyCandidate(
          String(item("export").evidence?.candidateId)
        );
        const checked =
          stage === "export"
            ? exportEvidence(candidate)
            : {
                candidateId: candidate.candidateId,
                manifestSha256: candidate.manifestSha256,
              };
        if (canonicalJson(checked) !== canonicalJson(original.evidence))
          fail("INVALID_CANDIDATE_STAGE_ARTIFACT");
      }
    } else {
      if (original.status !== "running")
        transition(stage, { status: "running" });
      await input.onProgress(stage, "started");
      let evidence: StageEvidence;
      let observerInterrupted = false;
      try {
        if (stage === "enrich") {
          if (!input.candidateBuild) fail("CANDIDATE_BUILD_OPTIONS_REQUIRED");
          if (
            !input.journal.readArtifact(state.runId, stage, item(stage).attempt)
          ) {
            if (!input.candidateBuild) fail("CANDIDATE_BUILD_OPTIONS_REQUIRED");
            const build = options(input.candidateBuild);
            const source = captureReviewedSource({
              repositoryRoot: input.root,
              privateDirectory: newDirectory(),
              sourceCommit: build.sourceCommit,
              purpose: build.purpose,
            });
            input.verifyContext();
            const configuration = captureExportConfiguration(source.sourceRoot);
            configuration["ingestion/weekly-editions.json"] = weeklyBytes;
            saveArtifact(stage, {
              schemaVersion: 1,
              build,
              configuration: Object.fromEntries(
                CANDIDATE_CONFIG_FILES.map((path) => [
                  path,
                  configuration[path]?.toString("base64") ?? null,
                ])
              ),
              configSha256: configurationDigest(configuration),
            });
          }
          const captured = enrichment();
          evidence = {
            configSha256: captured.configSha256,
            buildSha256: captured.buildSha256,
          };
        } else if (stage === "export") {
          // Isolated builds may be repeated; unacknowledged output never becomes trusted.
          if (
            original.status === "running" &&
            input.journal.readArtifact(state.runId, stage, item(stage).attempt)
          )
            fail("INTERRUPTED_CANDIDATE_BUILD");
          const captured = enrichment();
          saveArtifact(stage, {
            schemaVersion: 1,
            workDirectory: newDirectory(),
            snapshot: encryptLedgerSnapshot(frozen.ledger, key).toString(
              "base64"
            ),
          });
          try {
            await input.onProgress(stage, "artifact-saved");
          } catch (error) {
            observerInterrupted = true;
            throw error;
          }
          const intent = exportIntent();
          let heartbeatError: unknown;
          const timer = setInterval(() => {
            try {
              input.verifyContext();
            } catch (error) {
              heartbeatError = error;
            }
          }, input.heartbeatMs);
          timer.unref();
          let result;
          try {
            result = await buildReviewedWeeklyCandidate({
              repositoryRoot: input.root,
              privateDirectory: intent.workDirectory,
              ...captured.build,
              editionId: edition!.editionId,
              weeklyEditionBytes: weeklyBytes,
              ledger: frozen.ledger,
              snapshot: intent.snapshot,
              recoveryKey: key,
            });
          } finally {
            clearInterval(timer);
          }
          if (heartbeatError) throw heartbeatError;
          const candidate = await verifyCandidate(result.candidate.candidateId);
          evidence = exportEvidence(candidate);
        } else {
          const candidate = await verifyCandidate(
            String(item("export").evidence?.candidateId)
          );
          evidence = {
            candidateId: candidate.candidateId,
            manifestSha256: candidate.manifestSha256,
          };
        }
      } catch (error) {
        if (observerInterrupted) throw error;
        const code =
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          /^[A-Z0-9_]{1,64}$/.test(error.code)
            ? error.code
            : "CANDIDATE_STAGE_FAILED";
        transition(stage, { status: "failed", errorCode: code });
        throw error;
      }
      // Interruption here leaves an unacknowledged build that must not be adopted.
      if (stage === "export") await input.onProgress(stage, "effect-committed");
      else if (stage === "enrich")
        await input.onProgress(stage, "artifact-saved");
      transition(stage, { status: "succeeded", evidence });
      await input.onProgress(stage, "completed");
    }
    if (stage === input.stopAfter) break;
  }
  return state;
}
