import { proveRecoveryWeeklyLineage } from "./recovery-weekly-lineage.js";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  createAuthoritativePromotionControlTransport,
  createBareTestPromotionControlTransport,
  createRemotePromotionControlStore,
  type PromotionControlStore,
  type PromotionControlTransport,
  type PromotionControlHistory,
} from "./promotion-control-git.js";
import {
  createCompletionProof,
  parsePromotionControl,
  promotionDigest,
  validatePromotionAppend,
  verifyCompletionProof,
  applyPromotionTransition,
  serializePromotionControl,
  type PromotionPhase,
  type PromotionRequest,
} from "./promotion-control.js";
import { type OperatorRecoveryCheckpoint } from "./operator-recovery.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import { sha256 } from "./steve-preflight.js";
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
import { preparePagesWorkflowDispatch } from "./pages-dispatch.js";
import {
  parseSavedPagesDispatch,
  parseSavedPagesDispatchReceipt,
  type SavedPagesDispatch,
} from "./pages-dispatch-runner.js";

interface RecoveryCandidateRemoteInput {
  repositoryRoot: string;
  checkpoint: OperatorRecoveryCheckpoint;
  recoveryKey: Buffer;
  runId: string;
  workflowCommit: string;
  profile?: "pending-dispatch";
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
  profile?: "pending-dispatch";
  pendingDispatchSha256?: string;
  capturedClaimSha256?: string | null;
  capturedDispatchSha256?: string | null;
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
  readonly pendingDispatch?: {
    readonly operationId: string;
    readonly attemptId: string;
    readonly controlHead: string;
    readonly savedBytes: Buffer;
    /** Enforce fresh native admission if known; unadmitted additions still require GET proof. */
    assertReceipt(receipt: unknown): void;
  };
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
  let lineage: ReturnType<typeof proveRecoveryWeeklyLineage>;
  try {
    lineage = proveRecoveryWeeklyLineage({
      ...input,
      stage: input.profile ?? "validated",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("RECOVERY_WEEKLY_LINEAGE_")
    )
      fail(error.message.slice("RECOVERY_WEEKLY_LINEAGE_".length));
    throw error;
  }
  const {
    checkpoint,
    run,
    baseline,
    files,
    artifact,
    readRetainedFile: required,
  } = lineage;
  const load = { ledger: lineage.loadedLedger },
    frozen = { after: lineage.frozenWeeklyBytes.toString("base64") };
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
    files,
    artifact,
    deployAnchor: lineage.optionalArtifact("deploy"),
  };
}

/** Bind GET-only recovery to the one original accepted intent, never a prepared fork. */
function provePendingDispatch(
  input: RecoveryCandidateRemoteInput,
  retained: ReturnType<typeof retainedCandidate>,
  history: PromotionControlHistory,
  claim: PromotionControlHistory["commits"][number],
  payloadReceiptId: string
) {
  if (!claim.parentHead || !claim.parentBytes)
    fail("PENDING_CLAIM_PARENT_REQUIRED");
  const operation = parsePromotionControl(claim.bytes).active;
  if (!operation) fail("PENDING_CLAIM_REQUIRED");
  const matches = history.commits.filter((record) => {
    const event = parsePromotionControl(record.bytes).lastTransition.event;
    return (
      event.type === "dispatch-intent" &&
      event.operationId === operation.operationId
    );
  });
  if (matches.length !== 1) fail("PENDING_INTENT_MISSING_OR_AMBIGUOUS");
  const record = matches[0],
    event = parsePromotionControl(record.bytes).lastTransition.event;
  if (
    event.type !== "dispatch-intent" ||
    event.mode !== "promote" ||
    event.workflowCommit !== input.workflowCommit ||
    !event.dispatchNonce ||
    !record.parentHead ||
    !record.parentBytes
  )
    fail("PENDING_INTENT_CHANGED");
  const before = parsePromotionControl(record.parentBytes);
  const intent = preparePagesWorkflowDispatch({
    control: before,
    controlHead: record.parentHead,
    workflowCommit: input.workflowCommit,
    mode: "promote",
    reviewedMainAncestor: true,
    dispatchNonce: event.dispatchNonce,
  });
  same(intent.event, event, "PENDING_INTENT_CHANGED");
  if (
    !serializePromotionControl(
      applyPromotionTransition(before, intent.event)
    ).equals(record.bytes)
  )
    fail("PENDING_INTENT_CHANGED");
  const prefix = "operator/weekly-publication/" + retained.run.runId + "/";
  const planBytes = retained.files.get(prefix + "claim-plan.json") ?? null;
  if (planBytes) {
    const plan: unknown = JSON.parse(planBytes.toString("utf8"));
    same(
      plan,
      {
        schemaVersion: 1,
        runId: retained.run.runId,
        candidateId: retained.candidate.candidateId,
        workflowCommit: input.workflowCommit,
        payloadCommit: operation.request.payloadCommit,
        payloadReceiptId,
        createdAt: claim.createdAt,
        claim: {
          expectedHead: claim.parentHead,
          attemptedHead: claim.head,
          bytes: claim.bytes.toString("base64"),
          createdAt: claim.createdAt,
        },
      },
      "CAPTURED_CLAIM_CHANGED"
    );
    if (!planBytes.equals(Buffer.from(canonicalJson(plan) + "\n")))
      fail("CAPTURED_CLAIM_CHANGED");
  }
  const dispatchBytes =
    retained.files.get(prefix + "dispatch/pages-dispatch.json") ?? null;
  const expected: SavedPagesDispatch = {
    schemaVersion: 1,
    intent,
    pendingAppend: {
      expectedHead: record.parentHead,
      attemptedHead: record.head,
      bytes: record.bytes.toString("base64"),
      createdAt: record.createdAt,
    },
  };
  let saved = expected;
  if (dispatchBytes) {
    saved = parseSavedPagesDispatch(dispatchBytes);
    same(saved.intent, expected.intent, "CAPTURED_DISPATCH_CHANGED");
    same(
      saved.pendingAppend,
      expected.pendingAppend,
      "CAPTURED_DISPATCH_CHANGED"
    );
  }
  const admissions = new Set<string>();
  for (const entry of history.commits) {
    const active = parsePromotionControl(entry.bytes).active;
    if (active?.operationId !== operation.operationId) continue;
    const attempt = active.promotionAttempt;
    if (attempt?.attemptId === event.attemptId && attempt.admission)
      admissions.add(attempt.admission.runId);
  }
  if (
    admissions.size > 1 ||
    (saved.receipt &&
      admissions.size === 1 &&
      !admissions.has(saved.receipt.runId))
  )
    fail("CAPTURED_DISPATCH_ADMISSION_CHANGED");
  if (retained.deployAnchor) {
    const anchor: unknown = JSON.parse(retained.deployAnchor.toString("utf8"));
    const fields = object(anchor, [
      "schemaVersion",
      "runId",
      "candidateId",
      "controlHead",
      "controlSha256",
    ]);
    const proof = history.commits.find(
      (entry) => entry.head === fields.controlHead
    );
    const active = proof && parsePromotionControl(proof.bytes).active;
    if (
      !proof ||
      active?.operationId !== operation.operationId ||
      active.phase !== "verified" ||
      active.promotionAttempt?.attemptId !== event.attemptId
    )
      fail("CAPTURED_DELIVERY_ANCHOR_CHANGED");
    same(
      fields,
      {
        schemaVersion: 1,
        runId: retained.run.runId,
        candidateId: retained.candidate.candidateId,
        controlHead: proof.head,
        controlSha256: sha256(proof.bytes),
      },
      "CAPTURED_DELIVERY_ANCHOR_CHANGED"
    );
    if (
      !retained.deployAnchor.equals(Buffer.from(canonicalJson(fields) + "\n"))
    )
      fail("CAPTURED_DELIVERY_ANCHOR_CHANGED");
  }
  const savedBytes = dispatchBytes
    ? Buffer.from(dispatchBytes)
    : Buffer.from(JSON.stringify(saved) + "\n");
  parseSavedPagesDispatch(savedBytes);
  return {
    operationId: operation.operationId,
    attemptId: event.attemptId,
    controlHead: record.head,
    savedBytes,
    claimSha256: planBytes ? sha256(planBytes) : null,
    dispatchSha256: dispatchBytes ? sha256(dispatchBytes) : null,
    admittedRunId: [...admissions][0] ?? null,
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
  if (input.profile !== undefined && input.profile !== "pending-dispatch")
    fail("INVALID_PROFILE");
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
  function payload(request: PromotionRequest, createdAt?: string) {
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
        createdAt,
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
  let pending: ReturnType<typeof provePendingDispatch> | undefined;
  if (input.profile === "pending-dispatch") {
    if (!claim) fail("PENDING_CLAIM_REQUIRED");
    const owner = parsePromotionControl(claim.bytes).active;
    if (!owner) fail("PENDING_CLAIM_REQUIRED");
    const retainedPayload = payload(owner.request, claim.createdAt);
    same(retainedPayload.receipt.candidate, candidate, "CANDIDATE_CHANGED");
    pending = provePendingDispatch(
      input,
      retained,
      history,
      claim,
      retainedPayload.receipt.receiptId
    );
  }
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
    ...(pending
      ? {
          profile: "pending-dispatch" as const,
          pendingDispatchSha256: sha256(pending.savedBytes),
          capturedClaimSha256: pending.claimSha256,
          capturedDispatchSha256: pending.dispatchSha256,
        }
      : {}),
  });
  let cached: RecoveryCandidateProgress | undefined;
  let admittedRunId = pending?.admittedRunId ?? null;
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
      if (
        pending &&
        operation.promotionAttempt &&
        operation.promotionAttempt.attemptId !== pending.attemptId
      )
        fail("PENDING_ATTEMPT_CHANGED");
      if (pending && operation.promotionAttempt?.admission)
        admittedRunId = operation.promotionAttempt.admission.runId;
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
  const pendingProof = pending;
  return Object.freeze({
    binding,
    store,
    transport,
    ...(pendingProof
      ? {
          pendingDispatch: Object.freeze({
            operationId: pendingProof.operationId,
            attemptId: pendingProof.attemptId,
            controlHead: pendingProof.controlHead,
            get savedBytes() {
              return Buffer.from(pendingProof.savedBytes);
            },
            assertReceipt(value: unknown) {
              const expected = parseSavedPagesDispatch(pendingProof.savedBytes);
              const receipt = parseSavedPagesDispatchReceipt(value, {
                intent: expected.intent,
                controlHead: pendingProof.controlHead,
              });
              validateProgress(binding.initialControlHead);
              if (admittedRunId !== null && receipt.runId !== admittedRunId)
                fail("CAPTURED_DISPATCH_ADMISSION_CHANGED");
            },
          }),
        }
      : {}),
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
