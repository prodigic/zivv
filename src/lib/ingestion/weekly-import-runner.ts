import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compiledEtlDigest } from "./source-build.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { loadLedger, validateLedger } from "./ledger.js";
import { preflightSteveContent, sha256 } from "./steve-preflight.js";
import {
  importConfigurationDigest,
  parseSteveImportReview,
  importReportDigest,
} from "./steve-import-review.js";
import {
  reviewSteveImport,
  loadReviewedSteveImport,
  recoverReviewedSteveImport,
} from "./imports.js";
import { projectLedgerLocation } from "./store-location.js";
import { WeeklyRunJournal } from "./weekly-run-journal.js";
import { parseWeeklyEditionLedger } from "./weekly.js";
import { freezeWeeklyImport } from "./weekly-edition-freeze.js";
import { journalVerifiedWeeklyDelivery } from "./weekly-delivery.js";
import { acknowledgeVerifiedWeeklyRelease } from "./weekly-acknowledgement.js";
import {
  ensureWeeklyPublication,
  type WeeklyPublicationOptions,
} from "./weekly-publication.js";
import type { PromotionControlStore } from "./promotion-control-git.js";
import {
  runWeeklyCandidateStages,
  type WeeklyCandidateBuildOptions,
} from "./weekly-candidate-runner.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
  type WeeklyRunState,
  type StageEvidence,
  type WeeklyRunStage,
} from "./weekly-run-state.js";
import type {
  ReconciliationReport,
  IngestionLedger,
} from "../../types/ingestion.js";

const STAGES = ["acquire", "prepare", "reconcile", "load"] as const;
type ImportStage = (typeof STAGES)[number];
type WorkerStage =
  | ImportStage
  | "freeze"
  | "enrich"
  | "export"
  | "validate"
  | "dispatch"
  | "verify"
  | "acknowledge";
export interface WeeklyImportProgress {
  runId: string;
  stage: WorkerStage | "deploy";
  phase: "started" | "artifact-saved" | "effect-committed" | "completed";
}
export class WeeklyImportRunnerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "WeeklyImportRunnerError";
  }
}
function fail(code: string): never {
  throw new WeeklyImportRunnerError(code);
}
const encode = (value: unknown) => Buffer.from(canonicalJson(value) + "\n");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("INVALID_STAGE_ARTIFACT");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(expected.sort())
  )
    fail("INVALID_STAGE_ARTIFACT");
}
function report(value: unknown): ReconciliationReport {
  const raw = object(value);
  keys(raw, [
    "runId",
    "replay",
    "acceptedEventIds",
    "newEventIds",
    "updatedEventIds",
    "linkedEventIds",
    "review",
    "conflicts",
  ]);
  if (
    typeof raw.runId !== "string" ||
    typeof raw.replay !== "boolean" ||
    !Array.isArray(raw.review) ||
    raw.review.length ||
    !Array.isArray(raw.conflicts) ||
    raw.conflicts.length
  )
    return fail("INVALID_STAGE_ARTIFACT");
  for (const name of [
    "acceptedEventIds",
    "newEventIds",
    "updatedEventIds",
    "linkedEventIds",
  ])
    if (
      !Array.isArray(raw[name]) ||
      (raw[name] as unknown[]).some(
        (id) => typeof id !== "number" || !Number.isSafeInteger(id) || id < 0
      )
    )
      fail("INVALID_STAGE_ARTIFACT");
  return raw as unknown as ReconciliationReport;
}

/** Execute import and optional edition freezing, recovering durable side effects. */
export async function runWeeklyImport(input: {
  root: string;
  source?: {
    editionId: string;
    deliveryId: string;
    raw: Buffer;
    importObservedAtEpochMs: number;
  };
  runId?: string;
  stopAfter?: WorkerStage;
  freezeCutoffEpochMs?: number;
  reuseFrozen?: boolean;
  candidateBuild?: WeeklyCandidateBuildOptions;
  verifiedDelivery?: { store: PromotionControlStore; candidate: Buffer };
  publication?: WeeklyPublicationOptions;
  controlledPublishing?: string;
  manualPublisherJoined?: string;
  onProgress?: (event: WeeklyImportProgress) => void | Promise<void>;
  leaseTtlMs?: number;
}): Promise<WeeklyRunState> {
  const root = resolve(input.root);
  const delivering =
    input.stopAfter === "dispatch" ||
    input.stopAfter === "verify" ||
    input.stopAfter === "acknowledge";
  if (input.publication && input.verifiedDelivery) fail("INVALID_RUN_INPUT");
  const publication = input.publication
    ? {
        ...input.publication,
        candidate: Buffer.from(input.publication.candidate),
      }
    : undefined;
  const suppliedDelivery = publication ?? input.verifiedDelivery;
  const verifiedDelivery = suppliedDelivery
    ? {
        store: suppliedDelivery.store,
        candidate: Buffer.from(suppliedDelivery.candidate),
      }
    : undefined;
  if (
    delivering &&
    (!input.runId ||
      !verifiedDelivery ||
      input.controlledPublishing !== "enabled" ||
      input.manualPublisherJoined !== "true")
  )
    fail("VERIFIED_DELIVERY_NOT_ENABLED");
  if (verifiedDelivery && !delivering) fail("INVALID_RUN_INPUT");
  if (input.stopAfter === "dispatch" && !publication) fail("INVALID_RUN_INPUT");
  const candidateBuild = input.candidateBuild
    ? { ...input.candidateBuild }
    : undefined;
  const source = input.source
    ? { ...input.source, raw: Buffer.from(input.source.raw) }
    : undefined;
  if (
    !!source === !!input.runId ||
    (input.stopAfter &&
      ![
        ...STAGES,
        "freeze",
        "enrich",
        "export",
        "validate",
        "dispatch",
        "verify",
        "acknowledge",
      ].includes(input.stopAfter)) ||
    (input.freezeCutoffEpochMs !== undefined &&
      (!Number.isSafeInteger(input.freezeCutoffEpochMs) ||
        input.freezeCutoffEpochMs < 0 ||
        input.freezeCutoffEpochMs > Date.now()))
  )
    fail("INVALID_RUN_INPUT");
  const location = projectLedgerLocation(root);
  if (location.backend !== "sqlite" || !existsSync(location.path))
    fail("SHARED_SQLITE_REQUIRED");
  const storePath = realpathSync(location.path);
  const runtimeRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../.."
  );
  const runtimeSha256 = compiledEtlDigest(runtimeRoot, "worker");
  const packageLockSha256 = sha256(
    readFileSync(join(runtimeRoot, "package-lock.json"))
  );
  const configurationSha256 = importConfigurationDigest(root);
  const rulesSha256 = sha256(
    canonicalJson({
      runner: "weekly-import-v1",
      runtimeSha256,
      packageLockSha256,
      configurationSha256,
      node: process.version,
      icu: process.versions.icu ?? "",
    })
  );
  const journal = new WeeklyRunJournal(location.directory);
  let lease: ReturnType<WeeklyRunJournal["acquire"]> | undefined;
  let state: WeeklyRunState;
  try {
    lease = journal.acquire(
      "prodigic/zivv/production",
      input.leaseTtlMs ?? 120000
    );
    let owned = lease;
    const ttl = input.leaseTtlMs ?? 120000;
    let renewalAt = Date.now() + Math.floor(ttl / 3);
    if (source) {
      if (source.importObservedAtEpochMs > Date.now())
        fail("INVALID_RUN_INPUT");
      const rawSha256 = sha256(source.raw);
      for (const previous of journal.findDelivery(
        owned.scope,
        source.editionId,
        source.deliveryId
      )) {
        if (previous.source.rawSha256 !== rawSha256)
          fail("SOURCE_DELIVERY_CHANGED");
        if (
          previous.source.importObservedAtEpochMs !==
          source.importObservedAtEpochMs
        )
          fail("IMPORT_OBSERVATION_CHANGED");
        if (previous.source.rulesSha256 !== rulesSha256)
          fail("RUN_CONTEXT_CHANGED");
      }
      state = journal.create(
        createWeeklyRunState({
          editionId: source.editionId,
          deliveryId: source.deliveryId,
          importObservedAtEpochMs: source.importObservedAtEpochMs,
          rawSha256,
          rulesSha256,
        }),
        owned,
        source.raw
      );
    } else {
      state = journal.loadOwned(input.runId!, owned);
      if (state.source.rulesSha256 !== rulesSha256) fail("RUN_CONTEXT_CHANGED");
    }
    const raw = journal.readArtifact(state.runId, "acquire", 0);
    if (!raw || sha256(raw) !== state.source.rawSha256)
      fail("SOURCE_ARTIFACT_CHANGED");
    const verifyContext = () => {
      if (Date.now() >= renewalAt) {
        owned = journal.renew(owned, ttl);
        lease = owned;
        renewalAt = Date.now() + Math.floor(ttl / 3);
      }
      journal.checkOwnership(owned);
      const currentLocation = projectLedgerLocation(root);
      if (
        currentLocation.backend !== location.backend ||
        currentLocation.path !== location.path ||
        realpathSync(currentLocation.path) !== storePath
      )
        fail("RUN_CONTEXT_CHANGED");
      if (
        compiledEtlDigest(runtimeRoot, "worker") !== runtimeSha256 ||
        sha256(readFileSync(join(runtimeRoot, "package-lock.json"))) !==
          packageLockSha256 ||
        importConfigurationDigest(root) !== configurationSha256
      )
        fail("RUN_CONTEXT_CHANGED");
    };
    const notify = async (
      stage: WeeklyImportProgress["stage"],
      phase: WeeklyImportProgress["phase"]
    ) => {
      await input.onProgress?.({ runId: state.runId, stage, phase });
    };
    const transition = (
      stage: WeeklyRunStage,
      change: Parameters<typeof transitionWeeklyRun>[3]
    ) => {
      state = journal.save(
        transitionWeeklyRun(state, state.revision, stage, change, Date.now()),
        state.revision,
        owned
      );
    };
    const saved = (stage: ImportStage) => {
      const item = state.stages.find((value) => value.stage === stage)!;
      const bytes = journal.readArtifact(state.runId, stage, item.attempt);
      if (!bytes) fail("MISSING_STAGE_ARTIFACT");
      return bytes;
    };
    function preflightFor(ledger: IngestionLedger) {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(raw!);
      const aliases = existsSync(join(root, "data/venue-aliases.json"))
        ? (JSON.parse(
            readFileSync(join(root, "data/venue-aliases.json"), "utf8")
          ) as Record<string, string>)
        : {};
      const corrections = existsSync(join(root, "data/line-corrections.json"))
        ? JSON.parse(
            readFileSync(join(root, "data/line-corrections.json"), "utf8")
          )
        : [];
      const preflight = preflightSteveContent(
        content,
        ledger,
        aliases,
        corrections
      );
      preflight.rawSha256 = sha256(raw!);
      verifyContext();
      return {
        schemaVersion: 1,
        configurationSha256,
        ledgerRevision: ledgerDigest(ledger),
        ledger,
        preflight,
      };
    }
    async function currentPreflight() {
      verifyContext();
      return preflightFor(
        await loadLedger(join(root, "data/ingestion/ledger.json"))
      );
    }
    async function preparedArtifact() {
      const value = object(JSON.parse(saved("prepare").toString("utf8")));
      keys(value, [
        "schemaVersion",
        "configurationSha256",
        "ledgerRevision",
        "ledger",
        "preflight",
      ]);
      const snapshot = value.ledger as IngestionLedger;
      validateLedger(snapshot);
      const fresh = preflightFor(snapshot);
      if (
        value.schemaVersion !== 1 ||
        value.configurationSha256 !== configurationSha256 ||
        typeof value.ledgerRevision !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.ledgerRevision) ||
        value.ledgerRevision !== fresh.ledgerRevision ||
        canonicalJson(value.preflight) !== canonicalJson(fresh.preflight)
      )
        fail("INVALID_STAGE_ARTIFACT");
      const preflight = fresh.preflight;
      if (
        preflight.errors.length ||
        preflight.preparedContent === null ||
        preflight.preparedSha256 === null
      )
        fail("PREFLIGHT_REVIEW_REQUIRED");
      if (
        new Date(Date.parse(preflight.issueDate + " 12:00:00 GMT"))
          .toISOString()
          .slice(0, 10) !== state.source.editionId
      )
        fail("SOURCE_EDITION_CHANGED");
      return {
        prepared: preflight.preparedContent,
        preparedSha256: preflight.preparedSha256,
        ledgerRevision: value.ledgerRevision,
        preflight,
      };
    }
    async function reviewedArtifact() {
      const value = object(JSON.parse(saved("reconcile").toString("utf8")));
      if (value.blockedCode === "CORE_RECONCILIATION_REQUIRED")
        fail("CORE_RECONCILIATION_REQUIRED");
      keys(value, ["schemaVersion", "receipt", "report", "preflightContext"]);
      const receipt = parseSteveImportReview(value.receipt);
      const decision = report(value.report);
      const prepared = await preparedArtifact();
      const context = object(value.preflightContext);
      keys(context, [
        "schemaVersion",
        "configurationSha256",
        "ledgerRevision",
        "ledger",
        "preflight",
      ]);
      const reviewedLedger = context.ledger as IngestionLedger;
      validateLedger(reviewedLedger);
      const checkedContext = preflightFor(reviewedLedger);
      if (
        canonicalJson(context) !== canonicalJson(checkedContext) ||
        canonicalJson(checkedContext.preflight) !==
          canonicalJson(prepared.preflight)
      )
        fail("INVALID_STAGE_ARTIFACT");
      if (
        value.schemaVersion !== 1 ||
        receipt.inputSha256 !== prepared.preparedSha256 ||
        receipt.ledgerRevision !== checkedContext.ledgerRevision ||
        receipt.configurationSha256 !== configurationSha256 ||
        receipt.observedAtEpochMs !== state.source.importObservedAtEpochMs ||
        receipt.importRunId !== decision.runId ||
        receipt.reportSha256 !== importReportDigest(decision)
      )
        fail("INVALID_STAGE_ARTIFACT");
      return { ...prepared, receipt, decision };
    }
    async function committedImport() {
      const reviewed = await reviewedArtifact();
      verifyContext();
      return journal.guardOperation(owned, () =>
        recoverReviewedSteveImport(
          root,
          reviewed.prepared,
          reviewed.receipt,
          verifyContext
        )
      );
    }
    async function evidence(
      stage: ImportStage,
      bytes: Buffer
    ): Promise<StageEvidence> {
      if (stage === "acquire") {
        if (!bytes.equals(raw!)) fail("SOURCE_ARTIFACT_CHANGED");
        return {
          rawSha256: state.source.rawSha256,
          deliveryId: state.source.deliveryId,
        };
      }
      if (stage === "prepare") {
        const prepared = await preparedArtifact();
        return { preparedSha256: prepared.preparedSha256, rulesSha256 };
      }
      if (stage === "reconcile") {
        const reviewed = await reviewedArtifact();
        return {
          ledgerRevision: reviewed.receipt.ledgerRevision,
          reportSha256: reviewed.receipt.reportSha256,
          preparedSha256: reviewed.preparedSha256,
        };
      }
      const artifact = object(JSON.parse(bytes.toString("utf8")));
      keys(artifact, ["schemaVersion", "ledger", "evidence"]);
      if (artifact.schemaVersion !== 1) fail("INVALID_STAGE_ARTIFACT");
      const snapshot = artifact.ledger as IngestionLedger;
      validateLedger(snapshot);
      const value = object(artifact.evidence);
      keys(value, [
        "ledgerRevision",
        "importRunId",
        "reviewedLedgerRevision",
        "reportSha256",
        "preparedSha256",
      ]);
      const imported = await committedImport();
      const reviewed = await reviewedArtifact();
      const snapshotRun = snapshot.runs.find(
        (run) => run.runId === reviewed.receipt.importRunId
      );
      if (
        value.ledgerRevision !== ledgerDigest(snapshot) ||
        !snapshotRun ||
        !["committed", "published"].includes(snapshotRun.status) ||
        snapshotRun.observedAtEpochMs !==
          state.source.importObservedAtEpochMs ||
        snapshotRun.reviewCount !== 0 ||
        snapshotRun.conflictCount !== 0 ||
        value.importRunId !== imported.report.runId ||
        value.importRunId !== reviewed.receipt.importRunId ||
        value.reviewedLedgerRevision !== reviewed.receipt.ledgerRevision ||
        value.reportSha256 !== reviewed.receipt.reportSha256 ||
        value.preparedSha256 !== reviewed.preparedSha256
      )
        fail("INVALID_STAGE_ARTIFACT");
      for (const name of [
        "acceptedEventIds",
        "newEventIds",
        "updatedEventIds",
        "linkedEventIds",
      ] as const)
        if (
          canonicalJson(snapshotRun[name]) !==
          canonicalJson(imported.report[name])
        )
          fail("INVALID_STAGE_ARTIFACT");
      return value as StageEvidence;
    }
    for (const stage of STAGES) {
      verifyContext();
      let item = state.stages.find((value) => value.stage === stage)!;
      if (item.status === "succeeded") {
        const checked = await evidence(stage, saved(stage));
        if (canonicalJson(checked) !== canonicalJson(item.evidence))
          fail("INVALID_STAGE_ARTIFACT");
      } else {
        const recovering = item.status === "running";
        if (!recovering) transition(stage, { status: "running" });
        await notify(stage, "started");
        item = state.stages.find((value) => value.stage === stage)!;
        let bytes = journal.readArtifact(state.runId, stage, item.attempt);
        if (!bytes) {
          let completedEffect = false;
          try {
            if (stage === "acquire") bytes = Buffer.from(raw!);
            else if (stage === "prepare")
              bytes = encode(await currentPreflight());
            else if (stage === "reconcile") {
              const prepared = await preparedArtifact();
              const preflightContext = await currentPreflight();
              if (
                canonicalJson(preflightContext.preflight) !==
                canonicalJson(prepared.preflight)
              )
                fail("PREFLIGHT_CONTEXT_CHANGED");
              const reviewed = await reviewSteveImport(
                root,
                prepared.prepared,
                state.source.importObservedAtEpochMs
              );
              if (
                reviewed.receipt.ledgerRevision !==
                preflightContext.ledgerRevision
              )
                fail("PREFLIGHT_CONTEXT_CHANGED");
              verifyContext();
              bytes = encode({
                schemaVersion: 1,
                ...reviewed,
                preflightContext,
              });
            } else {
              const reviewed = await reviewedArtifact();
              let result;
              if (recovering) result = await committedImport();
              else
                result = await journal.guardOperation(owned, async () => {
                  try {
                    return await recoverReviewedSteveImport(
                      root,
                      reviewed.prepared,
                      reviewed.receipt,
                      verifyContext
                    );
                  } catch (error) {
                    if (
                      !(
                        error instanceof Error &&
                        "code" in error &&
                        error.code === "NO_COMMITTED_IMPORT"
                      )
                    )
                      throw error;
                  }
                  const weeklyPath = join(
                    root,
                    "data/ingestion/weekly-editions.json"
                  );
                  const weeklyBytes = existsSync(weeklyPath)
                    ? readFileSync(weeklyPath)
                    : null;
                  const weekly = weeklyBytes
                    ? parseWeeklyEditionLedger(
                        JSON.parse(weeklyBytes.toString("utf8"))
                      )
                    : null;
                  const frozenCutoff = Math.max(
                    0,
                    ...(weekly?.editions.map((edition) => edition.endEpochMs) ??
                      [])
                  );
                  const checkNewImport = () => {
                    verifyContext();
                    const currentBytes = existsSync(weeklyPath)
                      ? readFileSync(weeklyPath)
                      : null;
                    if (
                      currentBytes === null
                        ? weeklyBytes !== null
                        : weeklyBytes === null ||
                          !currentBytes.equals(weeklyBytes)
                    )
                      fail("WEEKLY_STATE_CHANGED");
                    if (
                      state.source.importObservedAtEpochMs < frozenCutoff &&
                      reviewed.decision.newEventIds.length
                    )
                      fail("LATE_IMPORT_REQUIRES_REVIEW");
                  };
                  checkNewImport();
                  return loadReviewedSteveImport(
                    root,
                    reviewed.prepared,
                    reviewed.receipt,
                    checkNewImport
                  );
                });
              completedEffect = true;
              bytes = encode({
                schemaVersion: 1,
                ledger: result.ledger,
                evidence: {
                  ledgerRevision: ledgerDigest(result.ledger),
                  importRunId: result.report.runId,
                  reviewedLedgerRevision: reviewed.receipt.ledgerRevision,
                  reportSha256: reviewed.receipt.reportSha256,
                  preparedSha256: reviewed.preparedSha256,
                },
              });
            }
          } catch (error) {
            const code =
              error instanceof Error &&
              "code" in error &&
              typeof error.code === "string" &&
              /^[A-Z0-9_]{1,64}$/.test(error.code)
                ? error.code
                : "STAGE_EXECUTION_FAILED";
            if (
              error instanceof Error &&
              "diagnostic" in error &&
              error.diagnostic
            )
              journal.writeArtifact(
                state.runId,
                stage,
                encode({
                  schemaVersion: 1,
                  blockedCode: code,
                  diagnostic: error.diagnostic,
                }),
                owned
              );
            transition(stage, {
              status: [
                "PREFLIGHT_REVIEW_REQUIRED",
                "CORE_RECONCILIATION_REQUIRED",
                "PREFLIGHT_CONTEXT_CHANGED",
                "LATE_IMPORT_REQUIRES_REVIEW",
              ].includes(code)
                ? "blocked"
                : "failed",
              errorCode: code,
            });
            throw error;
          }
          // Observers run outside the effect catch: interruption leaves running
          // evidence, which the next owner must inspect rather than blindly retry.
          if (completedEffect) await notify(stage, "effect-committed");
          verifyContext();
          journal.writeArtifact(state.runId, stage, bytes!, owned);
          await notify(stage, "artifact-saved");
        }
        try {
          const checked = await evidence(stage, bytes!);
          verifyContext();
          transition(stage, { status: "succeeded", evidence: checked });
        } catch (error) {
          const code =
            error instanceof Error &&
            "code" in error &&
            typeof error.code === "string" &&
            /^[A-Z0-9_]{1,64}$/.test(error.code)
              ? error.code
              : "STAGE_EVIDENCE_FAILED";
          transition(stage, {
            status: [
              "PREFLIGHT_REVIEW_REQUIRED",
              "CORE_RECONCILIATION_REQUIRED",
            ].includes(code)
              ? "blocked"
              : "failed",
            errorCode: code,
          });
          throw error;
        }
        await notify(stage, "completed");
      }
      if (stage === (input.stopAfter ?? "load")) break;
    }
    if (
      input.stopAfter &&
      [
        "freeze",
        "enrich",
        "export",
        "validate",
        "dispatch",
        "verify",
        "acknowledge",
      ].includes(input.stopAfter)
    ) {
      state = await freezeWeeklyImport({
        root,
        state,
        journal,
        lease: owned,
        cutoffEpochMs: input.freezeCutoffEpochMs,
        reuseFrozen: input.reuseFrozen,
        verifyContext,
        onProgress: (phase) => notify("freeze", phase),
      });
    }
    if (
      input.stopAfter &&
      [
        "enrich",
        "export",
        "validate",
        "dispatch",
        "verify",
        "acknowledge",
      ].includes(input.stopAfter)
    ) {
      state = await runWeeklyCandidateStages({
        root,
        operatorDirectory: location.directory,
        state,
        journal,
        lease: owned,
        stopAfter: delivering
          ? "validate"
          : (input.stopAfter as "enrich" | "export" | "validate"),
        candidateBuild,
        requiredPurpose: delivering ? "release" : undefined,
        verifyContext,
        heartbeatMs: Math.max(10, Math.floor(ttl / 3)),
        onProgress: notify,
      });
    }
    if (delivering && verifiedDelivery) {
      if (
        publication &&
        state.stages.find((s) => s.stage === "verify")?.status !== "succeeded"
      ) {
        const result = await ensureWeeklyPublication({
          ...publication,
          root,
          operatorDirectory: location.directory,
          state,
          journal,
          lease: owned,
          controlledPublishing: input.controlledPublishing,
          manualPublisherJoined: input.manualPublisherJoined,
          verifyContext,
          heartbeatMs: Math.max(10, Math.floor(ttl / 3)),
          onProgress: notify,
        });
        state = result.state;
        if (result.status === "pending") return state;
      }
      if (input.stopAfter === "dispatch") return state;
      state = await journalVerifiedWeeklyDelivery({
        state,
        candidate: verifiedDelivery.candidate,
        store: verifiedDelivery.store,
        journal,
        lease: owned,
        verifyContext,
        onProgress: notify,
      });
      if (input.stopAfter === "acknowledge") {
        state = await acknowledgeVerifiedWeeklyRelease({
          root,
          state,
          candidate: verifiedDelivery.candidate,
          store: verifiedDelivery.store,
          journal,
          lease: owned,
          verifyContext,
          onProgress: (phase) =>
            notify(
              "acknowledge",
              phase === "intent-saved" ? "artifact-saved" : "effect-committed"
            ),
        });
        await notify("acknowledge", "completed");
      }
    }
    return state;
  } finally {
    try {
      if (lease) journal.release(lease);
    } finally {
      journal.close();
    }
  }
}
