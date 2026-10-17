import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  createAuthoritativePromotionControlTransport,
  createBareTestPromotionControlTransport,
  createRemotePromotionControlStore,
  type PromotionControlStore,
  type PromotionControlTransport,
} from "./promotion-control-git.js";
import {
  createCompletionProof,
  parsePromotionControl,
  promotionDigest,
  validatePromotionAppend,
  verifyCompletionProof,
  type PromotionPhase,
  type PromotionRequest,
} from "./promotion-control.js";
import {
  validateOperatorRecoveryCheckpoint,
  type OperatorRecoveryCheckpoint,
} from "./operator-recovery.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import { validateLedger, reconcileCandidates } from "./ledger.js";
import { prepareSteveBatch } from "./imports.js";
import {
  preflightSteveContent,
  sha256,
  type LineCorrection,
} from "./steve-preflight.js";
import {
  CURRENT_STEVE_IMPORTER,
  importReportDigest,
  parseSteveImportReview,
} from "./steve-import-review.js";
import { applyVenueLocationCorrectionEntries } from "./venue-location-corrections.js";
import {
  parseWeeklyEditionLedger,
  createEmptyWeeklyEditionLedger,
  prepareWeeklyEdition,
  serializeWeeklyEditionLedger,
} from "./weekly.js";
import {
  CANDIDATE_CONFIG_FILES,
  configurationDigest,
  type CandidateConfiguration,
} from "./export-configuration.js";
import {
  parseReleaseCandidate,
  verifySealedCandidate,
  type ReleaseCandidate,
} from "./release-candidate.js";
import {
  parseApplicationBuildReceipt,
  verifyBuildExecutionToolIdentity,
} from "./source-build.js";
import { validateNpmExecutionToolIdentity } from "./execution-tool-identity.js";
import { readPublicationPayloadGit } from "./publication-git.js";
import { verifyPublicationPayload } from "./publication-payload.js";

interface RecoveryCandidateRemoteInput {
  repositoryRoot: string;
  checkpoint: OperatorRecoveryCheckpoint;
  recoveryKey: Buffer;
  runId: string;
  workflowCommit: string;
}
export interface RecoveryCandidateRemoteBinding {
  mainHead: string;
  initialControlHead: string;
  initialControlSha256: string;
  acknowledgedOperationId: string;
  acknowledgedCandidateId: string;
  acknowledgedLedgerRevision: string;
  acknowledgedCutoffEpochMs: number;
  runId: string;
  candidateId: string;
  ledgerRevision: string;
  workflowCommit: string;
}
export interface RecoveryCandidateProgress {
  head: string;
  operationId: string | null;
  phase: PromotionPhase | null;
}
export interface RecoveryCandidateRemote {
  readonly binding: Readonly<RecoveryCandidateRemoteBinding>;
  readonly candidate: ReleaseCandidate;
  readonly candidateBytes: Buffer;
  readonly store: PromotionControlStore;
  readonly transport: PromotionControlTransport;
  validateProgress(initialControlHead: string): RecoveryCandidateProgress;
  assertCurrent(): void;
}
function fail(code: string): never {
  throw new Error(`RECOVERY_CANDIDATE_REMOTE_${code}`);
}
function same(a: unknown, b: unknown, code = "LINEAGE_MISMATCH"): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail(code);
}
function object(
  value: unknown,
  keys?: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_LINEAGE");
  if (keys)
    same(Object.keys(value).sort(), [...keys].sort(), "INVALID_LINEAGE");
  return value as Record<string, unknown>;
}
function decoded(value: unknown): Buffer {
  if (typeof value !== "string") fail("INVALID_LINEAGE");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("INVALID_LINEAGE");
  return bytes;
}

/** Prove the single captured import, its frozen edition and its already sealed bundle. */
function retainedCandidate(input: RecoveryCandidateRemoteInput, key: Buffer) {
  const checkpoint = validateOperatorRecoveryCheckpoint(input.checkpoint);
  const journal = validateWeeklyJournalRecoverySnapshot(
    decoded(checkpoint.journal)
  );
  const row = journal.runState.find(
    (item) =>
      item.id === input.runId && item.scope === "prodigic/zivv/production"
  );
  if (!row) fail("RUN_NOT_RETAINED");
  const run = parseWeeklyRunState(JSON.parse(row.payload));
  if (
    run.stages.slice(0, 8).some((stage) => stage.status !== "succeeded") ||
    run.stages.slice(8).some((stage) => stage.status !== "pending")
  )
    fail("VALIDATED_RUN_REQUIRED");
  const artifact = (stage: (typeof run.stages)[number]["stage"]) => {
    const item = run.stages.find((item) => item.stage === stage)!;
    const row = journal.stageArtifacts.find(
      (row) =>
        row.runId === run.runId &&
        row.stage === stage &&
        row.attempt === item.attempt
    );
    if (!row) fail("MISSING_STAGE_ARTIFACT");
    return decoded(row.bytes);
  };
  const files = new Map(
    checkpoint.files.map((file) => [
      file.area + "/" + file.path,
      file.bytes === null ? null : decoded(file.bytes),
    ])
  );
  const required = (path: string): Buffer => {
    const bytes = files.get(path);
    if (!bytes) fail("MISSING_RETAINED_FILE");
    return bytes;
  };
  const configJson = (path: string, fallback: unknown): unknown => {
    const bytes = files.get("checkout/data/" + path);
    return bytes ? JSON.parse(bytes.toString("utf8")) : fallback;
  };
  const configHash = sha256(
    canonicalJson(
      [
        "venue-aliases.json",
        "line-corrections.json",
        "venue-location-corrections.json",
        "ingestion/historical-batches.json",
        "ingestion/migration.json",
      ].map((path) => ({
        path,
        sha256: files.get("checkout/data/" + path)
          ? sha256(required("checkout/data/" + path))
          : null,
      }))
    )
  );
  same(
    run.source.rulesSha256,
    sha256(
      canonicalJson({
        runner: "weekly-import-v1",
        runtimeSha256: checkpoint.runtime.workerSha256,
        packageLockSha256: checkpoint.runtime.lockfileSha256,
        configurationSha256: configHash,
        node: checkpoint.runtime.node,
        icu: checkpoint.runtime.icu,
      })
    ),
    "RULES_CHANGED"
  );
  const raw = artifact("acquire");
  same(sha256(raw), run.source.rawSha256);
  same(run.stages[0].evidence, {
    rawSha256: run.source.rawSha256,
    deliveryId: run.source.deliveryId,
  });
  const prepared = object(JSON.parse(artifact("prepare").toString("utf8")), [
    "schemaVersion",
    "configurationSha256",
    "ledgerRevision",
    "ledger",
    "preflight",
  ]);
  const reviewed = object(JSON.parse(artifact("reconcile").toString("utf8")), [
    "schemaVersion",
    "receipt",
    "report",
    "preflightContext",
  ]);
  const receipt = parseSteveImportReview(reviewed.receipt);
  same(reviewed.schemaVersion, 1);
  if (receipt.importer !== CURRENT_STEVE_IMPORTER)
    fail("UNSUPPORTED_IMPORT_LINEAGE");
  const context = object(reviewed.preflightContext, [
    "schemaVersion",
    "configurationSha256",
    "ledgerRevision",
    "ledger",
    "preflight",
  ]);
  const baseline = context.ledger;
  validateLedger(baseline);
  same(prepared.ledger, baseline);
  const aliases = object(configJson("venue-aliases.json", {})) as Record<
    string,
    string
  >;
  if (Object.values(aliases).some((value) => typeof value !== "string"))
    fail("INVALID_LINEAGE");
  const correctionValues = configJson("line-corrections.json", []);
  if (!Array.isArray(correctionValues)) fail("INVALID_LINEAGE");
  const corrections: LineCorrection[] = correctionValues.map((value) => {
    const row = object(value, ["pattern", "replacement"]);
    if (typeof row.pattern !== "string" || typeof row.replacement !== "string")
      fail("INVALID_LINEAGE");
    return { pattern: row.pattern, replacement: row.replacement };
  });
  const fresh = preflightSteveContent(
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
    baseline,
    aliases,
    corrections
  );
  fresh.rawSha256 = sha256(raw);
  if (
    fresh.errors.length ||
    fresh.preparedContent === null ||
    fresh.preparedSha256 === null ||
    !fresh.issueDate
  )
    fail("UNCLEAN_IMPORT");
  same(
    new Date(Date.parse(fresh.issueDate + " 12:00:00 GMT"))
      .toISOString()
      .slice(0, 10),
    run.source.editionId
  );
  const expectedContext = {
    schemaVersion: 1,
    configurationSha256: configHash,
    ledgerRevision: ledgerDigest(baseline),
    ledger: baseline,
    preflight: fresh,
  };
  same(prepared, expectedContext);
  same(context, expectedContext);
  same(receipt.inputSha256, fresh.preparedSha256);
  same(receipt.ledgerRevision, ledgerDigest(baseline));
  same(receipt.configurationSha256, configHash);
  same(receipt.observedAtEpochMs, run.source.importObservedAtEpochMs);
  const expectedBaseline = structuredClone(baseline);
  applyVenueLocationCorrectionEntries(
    expectedBaseline.venues,
    configJson("venue-location-corrections.json", [])
  );
  const corrected = corrections.reduce(
    (text, entry) =>
      text.replace(new RegExp(entry.pattern, "gim"), entry.replacement),
    fresh.preparedContent
  );
  const result = reconcileCandidates(
    expectedBaseline,
    prepareSteveBatch(
      expectedBaseline,
      corrected,
      run.source.importObservedAtEpochMs,
      aliases,
      { requireCompleteNormalization: true }
    )
  );
  if (result.report.review.length || result.report.conflicts.length)
    fail("UNCLEAN_IMPORT");
  same(reviewed.report, result.report);
  same(importReportDigest(result.report), receipt.reportSha256);
  same(result.report.runId, receipt.importRunId);
  same(run.stages[1].evidence, {
    preparedSha256: fresh.preparedSha256,
    rulesSha256: run.source.rulesSha256,
  });
  same(run.stages[2].evidence, {
    ledgerRevision: receipt.ledgerRevision,
    reportSha256: receipt.reportSha256,
    preparedSha256: fresh.preparedSha256,
  });
  const load = object(JSON.parse(artifact("load").toString("utf8")), [
    "schemaVersion",
    "ledger",
    "evidence",
  ]);
  validateLedger(load.ledger);
  if (!result.report.replay) {
    const saved = load.ledger.runs.find(
        (item) => item.runId === receipt.importRunId
      ),
      expected = result.ledger.runs.find(
        (item) => item.runId === receipt.importRunId
      )!;
    if (
      !saved ||
      saved.status !== "committed" ||
      saved.committedAtEpochMs === null ||
      saved.committedAtEpochMs < run.source.importObservedAtEpochMs ||
      saved.committedAtEpochMs > checkpoint.createdAtEpochMs ||
      saved.publishedAtEpochMs !== null
    )
      fail("INVALID_COMMIT_LINEAGE");
    expected.status = "committed";
    expected.committedAtEpochMs = saved.committedAtEpochMs;
    // Legacy normalization observes the wall clock for newly allocated entity
    // metadata. Preserve those authenticated observations, not replay-time clocks.
    // IDs, names, counts, all existing entities and event/source times still have
    // to reproduce exactly from the reviewed baseline and original input.
    for (const table of ["artists", "venues"] as const) {
      const priorIds = new Set<number>(
        baseline[table].map((entity) => entity.id)
      );
      for (const entity of result.ledger[table]) {
        if (priorIds.has(entity.id)) continue;
        const original = load.ledger[table].find(
          (item) => item.id === entity.id
        );
        if (
          !original ||
          original.createdAtEpochMs < run.source.importObservedAtEpochMs ||
          original.updatedAtEpochMs < original.createdAtEpochMs ||
          original.updatedAtEpochMs > saved.committedAtEpochMs
        )
          fail("INVALID_ENTITY_CLOCK_LINEAGE");
        entity.createdAtEpochMs = original.createdAtEpochMs;
        entity.updatedAtEpochMs = original.updatedAtEpochMs;
      }
    }
  }
  same(load.ledger, result.ledger, "UNPROVEN_LEDGER_ADVANCEMENT");
  same(load.ledger, checkpoint.ledger, "UNPROVEN_LEDGER_ADVANCEMENT");
  const loadEvidence = {
    ledgerRevision: ledgerDigest(load.ledger),
    importRunId: receipt.importRunId,
    reviewedLedgerRevision: receipt.ledgerRevision,
    reportSha256: receipt.reportSha256,
    preparedSha256: fresh.preparedSha256,
  };
  same(load.schemaVersion, 1);
  same(load.evidence, loadEvidence);
  same(run.stages[3].evidence, loadEvidence);
  const frozen = object(JSON.parse(artifact("freeze").toString("utf8")), [
    "schemaVersion",
    "mode",
    "before",
    "after",
    "ledger",
    "ledgerRevision",
    "evidence",
  ]);
  same(frozen.schemaVersion, 1);
  same(frozen.ledger, load.ledger);
  same(frozen.ledgerRevision, checkpoint.ledgerRevision);
  const before = frozen.before === null ? null : decoded(frozen.before),
    after = decoded(frozen.after);
  const weekly = parseWeeklyEditionLedger(JSON.parse(after.toString("utf8"))),
    edition = weekly.editions.find(
      (item) => item.editionId === run.source.editionId
    );
  if (!edition || edition.endEpochMs > checkpoint.createdAtEpochMs)
    fail("INVALID_FREEZE");
  const beforeWeekly = before
    ? parseWeeklyEditionLedger(JSON.parse(before.toString("utf8")))
    : createEmptyWeeklyEditionLedger();
  const rebuilt = prepareWeeklyEdition(
    beforeWeekly,
    load.ledger.events.map((event) => ({ ...event })),
    {
      editionId: run.source.editionId,
      cutoffEpochMs: edition.endEpochMs,
      datasetVersion: `ingestion-v${load.ledger.version}`,
    }
  );
  same(
    Buffer.from(serializeWeeklyEditionLedger(rebuilt.ledger)).toString(
      "base64"
    ),
    frozen.after
  );
  const mode =
    beforeWeekly.editions.some(
      (item) => item.editionId === edition.editionId
    ) && run.source.importObservedAtEpochMs >= edition.endEpochMs
      ? "correction"
      : "initial";
  if (
    mode === "initial" &&
    edition.endEpochMs <= run.source.importObservedAtEpochMs
  )
    fail("INVALID_FREEZE");
  const freezeEvidence = {
    editionId: edition.editionId,
    cutoffEpochMs: edition.endEpochMs,
    membershipSha256: sha256(canonicalJson(edition.eventIds)),
    preCutoffPendingCount: 0,
    mode,
    ledgerRevision: checkpoint.ledgerRevision,
  };
  same(frozen.mode, mode);
  same(frozen.evidence, freezeEvidence);
  same(run.stages[4].evidence, freezeEvidence);
  same(
    required("checkout/data/ingestion/weekly-editions.json").toString("base64"),
    frozen.after,
    "WEEKLY_STATE_CHANGED"
  );
  const enriched = object(JSON.parse(artifact("enrich").toString("utf8")), [
    "schemaVersion",
    "build",
    "configuration",
    "configSha256",
  ]);
  same(enriched.schemaVersion, 1);
  const build = object(enriched.build, [
    "sourceCommit",
    "purpose",
    "basePath",
    "npmCli",
  ]);
  if (
    build.purpose !== "release" ||
    build.basePath !== "/zivv/" ||
    typeof build.sourceCommit !== "string" ||
    typeof build.npmCli !== "string"
  )
    fail("RELEASE_BUILD_REQUIRED");
  const encoded = object(enriched.configuration, CANDIDATE_CONFIG_FILES);
  const configuration = Object.fromEntries(
    CANDIDATE_CONFIG_FILES.map((path) => [
      path,
      encoded[path] === null ? null : decoded(encoded[path]),
    ])
  ) as CandidateConfiguration;
  same(
    configuration["ingestion/weekly-editions.json"]?.toString("base64"),
    frozen.after
  );
  same(configurationDigest(configuration), enriched.configSha256);
  same(run.stages[5].evidence, {
    configSha256: enriched.configSha256,
    buildSha256: sha256(canonicalJson(build)),
  });
  const exported = object(JSON.parse(artifact("export").toString("utf8")), [
    "schemaVersion",
    "workDirectory",
    "snapshot",
  ]);
  same(exported.schemaVersion, 1);
  if (typeof exported.workDirectory !== "string")
    fail("INVALID_CANDIDATE_DIRECTORY");
  const paths = win32.isAbsolute(checkpoint.originalOperatorDirectory)
    ? win32
    : posix;
  const relative = paths
    .relative(checkpoint.originalOperatorDirectory, exported.workDirectory)
    .split(paths.sep)
    .join("/");
  if (!/^weekly-candidates\/candidate-work-[A-Za-z0-9_-]+$/.test(relative))
    fail("INVALID_CANDIDATE_DIRECTORY");
  const directories = checkpoint.directories.filter(
    (item) =>
      item.area === "operator" &&
      item.path.startsWith(relative + "/") &&
      /^candidate-[^/]+$/.test(item.path.slice(relative.length + 1))
  );
  if (directories.length !== 1) fail("AMBIGUOUS_CANDIDATE");
  const prefix = "operator/" + directories[0].path + "/",
    candidateBytes = required(prefix + "candidate.json"),
    candidate = parseReleaseCandidate(candidateBytes);
  same(JSON.parse(required(prefix + "complete.json").toString("utf8")), {
    schemaVersion: 1,
    candidateId: candidate.candidateId,
  });
  same(
    JSON.parse(
      required(prefix + "workspace/data/ingestion/ledger.json").toString("utf8")
    ),
    load.ledger
  );
  const snapshot = required(prefix + "recovery/ledger.snapshot.enc");
  same(snapshot.toString("base64"), exported.snapshot);
  same(decryptLedgerSnapshot(snapshot, key), load.ledger);
  for (const path of CANDIDATE_CONFIG_FILES)
    same(
      (files.get(prefix + "workspace/data/" + path) ?? null)?.toString(
        "base64"
      ) ?? null,
      configuration[path]?.toString("base64") ?? null
    );
  const publicPrefix = prefix + "workspace/public/",
    publicFiles = new Map(
      [...files]
        .filter(
          ([path, bytes]) => path.startsWith(publicPrefix) && bytes !== null
        )
        .map(([path, bytes]) => [path.slice(publicPrefix.length), bytes!])
    );
  const applicationBuildManifest = required(
      prefix + "build/vite-manifest.json"
    ),
    applicationBuildReceipt = required(prefix + "build/application-build.json"),
    executionToolIdentity = required(prefix + "build/execution-tools.json");
  const application = parseApplicationBuildReceipt(applicationBuildReceipt);
  if (application.schemaVersion !== 2 || application.purpose !== "release")
    fail("PROVEN_BUILD_TOOL_REQUIRED");
  verifyBuildExecutionToolIdentity(application, executionToolIdentity);
  const tool = validateNpmExecutionToolIdentity(
    JSON.parse(executionToolIdentity.toString("utf8"))
  );
  same(tool.originalCli, build.npmCli, "BUILD_TOOL_PATH_MISMATCH");
  verifySealedCandidate(candidate, {
    sourceCommit: build.sourceCommit,
    basePath: "/zivv/",
    editionId: run.source.editionId,
    ledger: load.ledger,
    snapshot,
    recoveryKey: key,
    configuration,
    publicFiles,
    applicationBuildManifest,
    applicationBuildReceipt,
    executionToolIdentity,
  });
  const exportEvidence = {
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
  same(run.stages[6].evidence, exportEvidence);
  same(run.stages[7].evidence, {
    candidateId: candidate.candidateId,
    manifestSha256: candidate.manifestSha256,
  });
  same(
    object(JSON.parse(artifact("validate").toString("utf8")), [
      "schemaVersion",
      "candidateId",
      "manifestSha256",
    ]),
    {
      schemaVersion: 1,
      candidateId: candidate.candidateId,
      manifestSha256: candidate.manifestSha256,
    },
    "VALIDATION_ARTIFACT_MISMATCH"
  );
  return {
    checkpoint,
    run,
    baseline,
    candidate,
    candidateBytes: Buffer.from(candidateBytes),
  };
}

function gitRead(root: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });
  return execFileSync(
    "git",
    [
      "--no-replace-objects",
      "-c",
      "core.hooksPath=",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd: root,
      env,
      windowsHide: true,
      stdio: "pipe",
      timeout: 30_000,
      maxBuffer: 65536,
    }
  )
    .toString()
    .trim();
}
function open(
  input: RecoveryCandidateRemoteInput,
  transport: PromotionControlTransport
): RecoveryCandidateRemote {
  if (!Buffer.isBuffer(input.recoveryKey) || input.recoveryKey.length !== 32)
    fail("INVALID_KEY");
  if (!/^[a-f0-9]{40}$/.test(input.workflowCommit)) fail("WORKFLOW_REQUIRED");
  const key = Buffer.from(input.recoveryKey),
    retained = retainedCandidate(input, key),
    candidate = retained.candidate,
    root = realpathSync(input.repositoryRoot),
    mainHead = transport.readMainHead?.();
  if (!mainHead) fail("MAIN_REQUIRED");
  transport.fetchCommit(mainHead);
  try {
    for (const sha of [candidate.sourceCommit, input.workflowCommit])
      gitRead(root, ["merge-base", "--is-ancestor", sha, mainHead]);
    same(
      gitRead(root, [
        "cat-file",
        "-t",
        `${input.workflowCommit}:.github/workflows/publish-candidate.yml`,
      ]),
      "blob",
      "WORKFLOW_NOT_ON_MAIN"
    );
  } catch {
    fail("SOURCE_OR_WORKFLOW_NOT_ON_MAIN");
  }
  const store = createRemotePromotionControlStore({
    repositoryRoot: root,
    destination: "production",
    transport,
    validateState(bytes, destination) {
      const state = parsePromotionControl(bytes);
      if (state.destination !== destination) fail("DESTINATION_MISMATCH");
      return state.completionRoot;
    },
    validateTransition: validatePromotionAppend,
  });
  const history = store.readCanonicalHistory!();
  if (!history.complete) fail("INCOMPLETE_HISTORY");
  if (!history.head || !history.commits.length) fail("CONTROL_REQUIRED");
  const current = parsePromotionControl(history.commits[0].bytes),
    ack = history.commits.find(
      (item) =>
        parsePromotionControl(item.bytes).lastTransition.event.type ===
        "acknowledged"
    );
  if (!ack?.parentBytes) fail("ACKNOWLEDGED_WATERMARK_REQUIRED");
  const ackEvent = parsePromotionControl(ack.bytes).lastTransition.event,
    ackOperation = parsePromotionControl(ack.parentBytes).active;
  if (
    ackEvent.type !== "acknowledged" ||
    !ackOperation ||
    ackEvent.operationId !== ackOperation.operationId
  )
    fail("INVALID_ACKNOWLEDGEMENT");
  const proof = createCompletionProof(
    current.completionRoot,
    ackOperation.request.requestId,
    (id, type) => store.readCompletionObject(history.head!, id, type)
  );
  const completed = verifyCompletionProof(
    current.completionRoot,
    ackOperation.request.requestId,
    proof
  );
  if (
    !completed ||
    completed.outcome !== "acknowledged" ||
    completed.operationId !== ackOperation.operationId ||
    completed.acknowledgementId !== ackEvent.acknowledgementId ||
    completed.verification.receiptId !== ackEvent.verificationReceiptId
  )
    fail("COMPLETION_MISMATCH");
  const baselineRequest = completed.request;
  try {
    gitRead(root, [
      "merge-base",
      "--is-ancestor",
      baselineRequest.sourceCommit,
      mainHead,
    ]);
  } catch {
    fail("ACKNOWLEDGED_SOURCE_NOT_ON_MAIN");
  }
  function payload(request: PromotionRequest) {
    if (request.purpose !== "release" || request.basePath !== "/zivv/")
      fail("DESTINATION_MISMATCH");
    const ref = `refs/heads/zivv-candidate-artifacts/${request.payloadCommit}`;
    if (transport.readHead(ref) !== request.payloadCommit)
      fail("ARTIFACT_NOT_RETAINED");
    transport.fetchCommit(request.payloadCommit);
    const value = verifyPublicationPayload(
      readPublicationPayloadGit({
        repositoryRoot: root,
        payloadCommit: request.payloadCommit,
      }).files,
      {
        expectedCandidateId: request.candidateId,
        expectedSourceCommit: request.sourceCommit,
        purpose: "release",
        basePath: "/zivv/",
      }
    );
    same(
      promotionDigest(value.receipt.candidate.files),
      request.publicInventorySha256,
      "INVENTORY_MISMATCH"
    );
    return value;
  }
  const acknowledgedPayload = payload(baselineRequest),
    acknowledgedLedger = decryptLedgerSnapshot(
      acknowledgedPayload.snapshot,
      key
    ),
    baselineRevision = ledgerDigest(acknowledgedLedger);
  same(
    baselineRevision,
    acknowledgedPayload.receipt.candidate.ledgerRevision,
    "ACKNOWLEDGED_LEDGER_MISMATCH"
  );
  same(acknowledgedLedger, retained.baseline, "UNPROVEN_BASELINE");
  if (
    retained.run.source.importObservedAtEpochMs <
    acknowledgedPayload.receipt.candidate.cutoffEpochMs
  )
    fail("OBSERVATION_BEFORE_ACKNOWLEDGED_CUTOFF");
  const claims = history.commits.filter((item) => {
    const event = parsePromotionControl(item.bytes).lastTransition.event;
    return (
      event.type === "claim" && event.request.requestId === retained.run.runId
    );
  });
  if (claims.length > 1) fail("AMBIGUOUS_CLAIM");
  const claim = claims[0],
    initialControlHead = claim?.parentHead ?? history.head,
    initialBytes = claim ? claim.parentBytes : history.commits[0].bytes;
  if (!initialControlHead || !initialBytes) fail("INITIAL_CONTROL_REQUIRED");
  if (parsePromotionControl(initialBytes).active) fail("ACTIVE_OWNER");
  const binding = Object.freeze({
    mainHead,
    initialControlHead,
    initialControlSha256: sha256(initialBytes),
    acknowledgedOperationId: completed.operationId,
    acknowledgedCandidateId: baselineRequest.candidateId,
    acknowledgedLedgerRevision: baselineRevision,
    acknowledgedCutoffEpochMs:
      acknowledgedPayload.receipt.candidate.cutoffEpochMs,
    runId: retained.run.runId,
    candidateId: candidate.candidateId,
    ledgerRevision: candidate.ledgerRevision,
    workflowCommit: input.workflowCommit,
  });
  let cached: RecoveryCandidateProgress | undefined;
  let ownPayloadCommit: string | undefined;
  const allowed = new Set([
    "claim",
    "dispatch-intent",
    "dispatch-uncertain",
    "admit-run",
    "pages-create-intent",
    "pages-create-rejected",
    "deployed",
    "verified",
  ]);
  function validateProgress(
    savedInitialControlHead: string
  ): RecoveryCandidateProgress {
    if (savedInitialControlHead !== binding.initialControlHead)
      fail("INITIAL_CONTROL_CHANGED");
    if (
      realpathSync(input.repositoryRoot) !== root ||
      transport.readMainHead?.() !== binding.mainHead ||
      transport.readHead(
        `refs/heads/zivv-candidate-artifacts/${baselineRequest.payloadCommit}`
      ) !== baselineRequest.payloadCommit
    )
      fail("REMOTE_CHANGED");
    const observed = transport.readHead(store.ref);
    if (
      ownPayloadCommit &&
      transport.readHead(
        `refs/heads/zivv-candidate-artifacts/${ownPayloadCommit}`
      ) !== ownPayloadCommit
    )
      fail("ARTIFACT_NOT_RETAINED");
    if (cached?.head === observed) return { ...cached };
    // Reuse only the already validated immutable initial snapshot, with its
    // exact remote head freshly observed above. Later heads require new proof.
    const snapshot =
      !cached && observed === history.head
        ? history
        : store.readCanonicalHistory!();
    if (!snapshot.complete) fail("INCOMPLETE_HISTORY");
    const index = snapshot.commits.findIndex(
      (item) => item.head === binding.initialControlHead
    );
    if (index < 0) fail("INITIAL_CONTROL_NOT_CANONICAL");
    same(
      sha256(snapshot.commits[index].bytes),
      binding.initialControlSha256,
      "INITIAL_CONTROL_CHANGED"
    );
    const following = snapshot.commits.slice(0, index).reverse();
    let operationId: string | null = null,
      phase: PromotionPhase | null = null;
    for (const item of following) {
      const state = parsePromotionControl(item.bytes),
        event = state.lastTransition.event,
        operation = state.active;
      if (!allowed.has(event.type) || !operation) fail("UNRELATED_PROGRESS");
      const request = operation.request;
      if (
        request.requestId !== binding.runId ||
        request.candidateId !== binding.candidateId ||
        request.sourceCommit !== candidate.sourceCommit ||
        request.publicInventorySha256 !== promotionDigest(candidate.files) ||
        request.purpose !== "release" ||
        request.basePath !== "/zivv/"
      )
        fail("UNRELATED_PROGRESS");
      if (event.type === "claim") {
        if (operationId !== null) fail("AMBIGUOUS_CLAIM");
        const own = payload(request);
        ownPayloadCommit = request.payloadCommit;
        same(own.receipt.candidate, candidate, "CANDIDATE_CHANGED");
        operationId = operation.operationId;
      } else {
        if (
          operation.operationId !== operationId ||
          !("operationId" in event) ||
          event.operationId !== operationId ||
          !("mode" in event) ||
          event.mode !== "promote"
        )
          fail("UNRELATED_PROGRESS");
      }
      if (
        operation.promotionAttempt &&
        operation.promotionAttempt.workflowCommit !== binding.workflowCommit
      )
        fail("WORKFLOW_CHANGED");
      phase = operation.phase;
    }
    const tip = snapshot.commits[0];
    if (!snapshot.head || !tip) fail("CONTROL_REQUIRED");
    const active = parsePromotionControl(tip.bytes).active;
    if (!following.length && active) fail("ACTIVE_OWNER");
    if (
      transport.readMainHead?.() !== binding.mainHead ||
      transport.readHead(store.ref) !== snapshot.head
    )
      fail("REMOTE_CHANGED");
    cached = { head: snapshot.head, operationId, phase };
    return { ...cached };
  }
  validateProgress(binding.initialControlHead);
  return Object.freeze({
    binding,
    store,
    transport,
    get candidate() {
      return structuredClone(candidate);
    },
    get candidateBytes() {
      return Buffer.from(retained.candidateBytes);
    },
    validateProgress,
    assertCurrent() {
      validateProgress(binding.initialControlHead);
    },
  });
}

/** Read canonical production authority; this gate itself never appends a ref. */
export function openRecoveryCandidateRemote(
  input: RecoveryCandidateRemoteInput & { credentials?: { token: string } }
): RecoveryCandidateRemote {
  return open(
    input,
    createAuthoritativePromotionControlTransport(
      input.repositoryRoot,
      input.credentials
    )
  );
}
/** Isolated real bare repository adapter, unavailable to production CLI inputs. */
export function openRecoveryCandidateRemoteForTest(
  input: RecoveryCandidateRemoteInput & { bareDirectory: string }
): RecoveryCandidateRemote {
  return open(
    input,
    createBareTestPromotionControlTransport(
      input.repositoryRoot,
      input.bareDirectory
    )
  );
}
