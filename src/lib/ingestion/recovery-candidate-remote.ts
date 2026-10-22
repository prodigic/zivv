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
  type PromotionControlAppend,
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
  type PromotionControl,
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
import { decryptRecoveryResultChain } from "./recovery-result-chain.js";
import { readPublicationPayloadGit } from "./publication-git.js";
import { verifyPublicationPayload } from "./publication-payload.js";
import { preparePagesWorkflowDispatch } from "./pages-dispatch.js";
import {
  parseSavedPagesDispatch,
  parseSavedPagesDispatchReceipt,
  type SavedPagesDispatch,
} from "./pages-dispatch-runner.js";
import {
  markWeeklyEditionPublished,
  parseWeeklyEditionLedger,
  serializeWeeklyEditionLedger,
} from "./weekly.js";

interface RecoveryCandidateRemoteInput {
  repositoryRoot: string;
  checkpoint: OperatorRecoveryCheckpoint;
  recoveryKey: Buffer;
  runId: string;
  workflowCommit: string;
  profile?: "pending-dispatch" | "verified";
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
  profile?: "pending-dispatch" | "verified";
  verifiedControlHead?: string;
  verifiedControlSha256?: string;
  verifiedAnchorSha256?: string;
  pendingDispatchSha256?: string;
  capturedClaimSha256?: string | null;
  capturedDispatchSha256?: string | null;
}
export interface RecoveryCandidateProgress {
  head: string;
  operationId: string | null;
  phase: PromotionPhase | null;
  acknowledgement?: "pending" | "intent-bound" | "completed";
}
export interface RecoveryVerifiedDelivery {
  readonly operationId: string;
  readonly attemptId: string;
  readonly controlHead: string;
  readonly controlSha256: string;
  readonly verificationReceiptId: string;
  readonly deploymentId: string;
  /** Only the exact sealed preimage or an already authorized publication is admissible. */
  assertWeekly(bytes: Buffer): void;
  /** Check one exact own acknowledgement append immediately before its CAS. */
  assertAppend(append: PromotionControlAppend): void;
}
export interface RecoveryCandidateRemote {
  readonly binding: Readonly<RecoveryCandidateRemoteBinding>;
  readonly candidate: ReleaseCandidate;
  readonly candidateBytes: Buffer;
  readonly store: PromotionControlStore;
  readonly transport: PromotionControlTransport;
  readonly verifiedDelivery?: RecoveryVerifiedDelivery;
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
function retainedCandidate(
  input: RecoveryCandidateRemoteInput,
  key: Buffer,
  chain?: ReturnType<typeof decryptRecoveryResultChain>
) {
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
  const paths = /^[A-Za-z]:\\/.test(checkpoint.originalOperatorDirectory)
    ? win32
    : posix;
  const relative = paths
    .relative(checkpoint.originalOperatorDirectory, exported.workDirectory)
    .split(paths.sep)
    .join("/");
  if (chain) {
    const namespace = "weekly-candidates/r-" + sha256(run.runId).slice(0, 16);
    same(checkpoint, chain.successorCheckpoint, "CHAIN_CHECKPOINT_CHANGED");
    same(
      relative,
      chain.certificate.exportRole.workRelative,
      "CHAIN_ROLE_CHANGED"
    );
    same(
      exported.workDirectory,
      chain.certificate.exportRole.workDirectory,
      "CHAIN_ROLE_CHANGED"
    );
    if (
      !new RegExp("^" + namespace + "/candidate-work-[A-Za-z0-9_-]+$").test(
        relative
      )
    )
      fail("CHAIN_ROLE_CHANGED");
  } else if (
    !/^weekly-candidates\/candidate-work-[A-Za-z0-9_-]+$/.test(relative)
  )
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
  if (chain) {
    same(
      directories[0].path,
      chain.certificate.exportRole.bundleRelative,
      "CHAIN_ROLE_CHANGED"
    );
    if (!candidateBytes.equals(chain.candidateBytes))
      fail("CHAIN_CANDIDATE_CHANGED");
  }
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
    frozenWeeklyBytes: lineage.frozenWeeklyBytes,
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

/** Prove both retained delivery receipts against the original canonical operation. */
function proveVerifiedDelivery(
  input: RecoveryCandidateRemoteInput,
  retained: ReturnType<typeof retainedCandidate>,
  history: PromotionControlHistory,
  claim: PromotionControlHistory["commits"][number],
  payloadReceiptId: string
) {
  const owner = parsePromotionControl(claim.bytes).active;
  if (!owner || !claim.parentHead || !claim.parentBytes)
    fail("VERIFIED_CLAIM_REQUIRED");
  const anchorBytes = retained.artifact("deploy");
  if (!anchorBytes.equals(retained.artifact("verify")))
    fail("CAPTURED_DELIVERY_ANCHOR_CHANGED");
  const anchor = object(JSON.parse(anchorBytes.toString("utf8")), [
    "schemaVersion",
    "runId",
    "candidateId",
    "controlHead",
    "controlSha256",
  ]);
  if (!anchorBytes.equals(Buffer.from(canonicalJson(anchor) + "\n")))
    fail("CAPTURED_DELIVERY_ANCHOR_CHANGED");
  const matches = history.commits.filter((record) => {
    const state = parsePromotionControl(record.bytes);
    return (
      state.lastTransition.event.type === "verified" &&
      state.active?.operationId === owner.operationId
    );
  });
  if (matches.length !== 1) fail("VERIFICATION_MISSING_OR_AMBIGUOUS");
  const record = matches[0],
    control = parsePromotionControl(record.bytes),
    operation = control.active!,
    event = control.lastTransition.event;
  if (
    event.type !== "verified" ||
    event.mode !== "promote" ||
    operation.phase !== "verified" ||
    !operation.verification ||
    !operation.promotionAttempt ||
    operation.acknowledgementIntent
  )
    fail("VERIFIED_OPERATION_REQUIRED");
  same(operation.request, owner.request, "VERIFIED_REQUEST_CHANGED");
  same(
    operation.request.requestId,
    retained.run.runId,
    "VERIFIED_REQUEST_CHANGED"
  );
  same(
    operation.promotionAttempt.workflowCommit,
    input.workflowCommit,
    "WORKFLOW_CHANGED"
  );
  same(
    anchor,
    {
      schemaVersion: 1,
      runId: retained.run.runId,
      candidateId: retained.candidate.candidateId,
      controlHead: record.head,
      controlSha256: sha256(record.bytes),
    },
    "CAPTURED_DELIVERY_ANCHOR_CHANGED"
  );
  const evidence = {
    candidateId: retained.candidate.candidateId,
    manifestSha256: retained.candidate.manifestSha256,
    deploymentId: operation.verification.deployment.deploymentId,
    destination: "production",
  };
  same(retained.run.stages[8].evidence, evidence, "DELIVERY_EVIDENCE_CHANGED");
  same(retained.run.stages[9].evidence, evidence, "DELIVERY_EVIDENCE_CHANGED");
  const prefix = "operator/weekly-publication/" + retained.run.runId + "/",
    planBytes = retained.files.get(prefix + "claim-plan.json");
  if (planBytes) {
    const plan: unknown = JSON.parse(planBytes.toString("utf8"));
    same(
      plan,
      {
        schemaVersion: 1,
        runId: retained.run.runId,
        candidateId: retained.candidate.candidateId,
        workflowCommit: input.workflowCommit,
        payloadCommit: owner.request.payloadCommit,
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
  const dispatchBytes = retained.files.get(
    prefix + "dispatch/pages-dispatch.json"
  );
  if (dispatchBytes) {
    const saved = parseSavedPagesDispatch(dispatchBytes),
      pending = history.commits.find(
        (entry) => entry.head === saved.pendingAppend.attemptedHead
      );
    if (!pending?.parentHead || !pending.parentBytes)
      fail("CAPTURED_DISPATCH_CHANGED");
    const pendingEvent = parsePromotionControl(pending.bytes).lastTransition
      .event;
    if (
      pendingEvent.type !== "dispatch-intent" ||
      pendingEvent.mode !== "promote" ||
      pendingEvent.operationId !== owner.operationId ||
      pendingEvent.attemptId !== operation.promotionAttempt.attemptId
    )
      fail("CAPTURED_DISPATCH_CHANGED");
    same(
      saved.pendingAppend,
      {
        expectedHead: pending.parentHead,
        attemptedHead: pending.head,
        bytes: pending.bytes.toString("base64"),
        createdAt: pending.createdAt,
      },
      "CAPTURED_DISPATCH_CHANGED"
    );
    same(
      saved.intent,
      preparePagesWorkflowDispatch({
        control: parsePromotionControl(pending.parentBytes),
        controlHead: pending.parentHead,
        workflowCommit: input.workflowCommit,
        reviewedMainAncestor: true,
        mode: "promote",
        ...(pendingEvent.dispatchNonce
          ? { dispatchNonce: pendingEvent.dispatchNonce }
          : {}),
      }),
      "CAPTURED_DISPATCH_CHANGED"
    );
    if (
      saved.receipt &&
      saved.receipt.runId !== operation.promotionAttempt.admission?.runId
    )
      fail("CAPTURED_DISPATCH_ADMISSION_CHANGED");
  }
  const before = Buffer.from(retained.frozenWeeklyBytes),
    after = Buffer.from(
      serializeWeeklyEditionLedger(
        markWeeklyEditionPublished(
          parseWeeklyEditionLedger(JSON.parse(before.toString("utf8"))),
          retained.candidate.editionId
        ).ledger
      )
    );
  const intent = (createdAt: string) => ({
    schemaVersion: 1,
    runId: retained.run.runId,
    operationId: operation.operationId,
    requestId: operation.request.requestId,
    candidateId: retained.candidate.candidateId,
    verificationReceiptId: operation.verification!.receiptId,
    before: before.toString("base64"),
    after: after.toString("base64"),
    createdAt,
  });
  return {
    operation,
    controlHead: record.head,
    controlSha256: sha256(record.bytes),
    anchorSha256: sha256(anchorBytes),
    before,
    after,
    acknowledgementId: (createdAt: string) =>
      sha256(canonicalJson(intent(createdAt))),
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
  transport: PromotionControlTransport,
  chain?: ReturnType<typeof decryptRecoveryResultChain>
): RecoveryCandidateRemote {
  if (
    input.profile !== undefined &&
    input.profile !== "pending-dispatch" &&
    input.profile !== "verified"
  )
    fail("INVALID_PROFILE");
  if (!Buffer.isBuffer(input.recoveryKey) || input.recoveryKey.length !== 32)
    fail("INVALID_KEY");
  if (!/^[a-f0-9]{40}$/.test(input.workflowCommit)) fail("WORKFLOW_REQUIRED");
  const key = Buffer.from(input.recoveryKey),
    retained = retainedCandidate(input, key, chain),
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
  const claims = history.commits.filter((item) => {
    const event = parsePromotionControl(item.bytes).lastTransition.event;
    return (
      event.type === "claim" && event.request.requestId === retained.run.runId
    );
  });
  if (claims.length > 1) fail("AMBIGUOUS_CLAIM");
  const claim = claims[0];
  if (input.profile === "verified" && !claim) fail("VERIFIED_CLAIM_REQUIRED");
  // A retry can already contain this run's own acknowledgement. Its baseline
  // remains the last acknowledged predecessor of the original claim.
  const baselineHistory =
    input.profile === "verified"
      ? history.commits.slice(history.commits.indexOf(claim) + 1)
      : history.commits;
  const current = parsePromotionControl(history.commits[0].bytes),
    ack = baselineHistory.find(
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
  const initialControlHead = claim?.parentHead ?? history.head,
    initialBytes = claim ? claim.parentBytes : history.commits[0].bytes;
  if (!initialControlHead || !initialBytes) fail("INITIAL_CONTROL_REQUIRED");
  if (parsePromotionControl(initialBytes).active) fail("ACTIVE_OWNER");
  let pending: ReturnType<typeof provePendingDispatch> | undefined;
  let verified: ReturnType<typeof proveVerifiedDelivery> | undefined;
  if (input.profile === "pending-dispatch" || input.profile === "verified") {
    if (!claim) fail("PENDING_CLAIM_REQUIRED");
    const owner = parsePromotionControl(claim.bytes).active;
    if (!owner) fail("PENDING_CLAIM_REQUIRED");
    const retainedPayload = payload(owner.request, claim.createdAt);
    same(retainedPayload.receipt.candidate, candidate, "CANDIDATE_CHANGED");
    if (input.profile === "pending-dispatch")
      pending = provePendingDispatch(
        input,
        retained,
        history,
        claim,
        retainedPayload.receipt.receiptId
      );
    else
      verified = proveVerifiedDelivery(
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
    ...(verified
      ? {
          profile: "verified" as const,
          verifiedControlHead: verified.controlHead,
          verifiedControlSha256: verified.controlSha256,
          verifiedAnchorSha256: verified.anchorSha256,
        }
      : {}),
  });
  if (chain) {
    const prior = chain.certificate.remote;
    for (const field of [
      "acknowledgedOperationId",
      "acknowledgedCandidateId",
      "acknowledgedLedgerRevision",
      "acknowledgedCutoffEpochMs",
    ] as const)
      same(binding[field], prior[field], "CHAIN_BASELINE_CHANGED");
    const anchor = history.commits.find(
      (item) => item.head === prior.controlHead
    );
    if (!anchor || sha256(anchor.bytes) !== prior.controlSha256)
      fail("CHAIN_CONTROL_ANCHOR_CHANGED");
  }
  let cached: RecoveryCandidateProgress | undefined;
  let acceptedAcknowledgement:
    | { acknowledgementId: string; createdAt: string; head: string }
    | undefined;
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
    let acknowledgement: RecoveryCandidateProgress["acknowledgement"] = verified
      ? "pending"
      : undefined;
    let verifiedSeen = false;
    let accepted: typeof acceptedAcknowledgement;
    for (const item of following) {
      const state = parsePromotionControl(item.bytes),
        event = state.lastTransition.event,
        operation = state.active;
      // Once this exact operation has completed, subsequent validated canonical
      // owners only permit local finalization; they grant no append authority.
      if (verified && acknowledgement === "completed") continue;
      if (verified && event.type === "acknowledgement-intent") {
        if (!verifiedSeen || accepted || !operation || !item.parentBytes)
          fail("UNRELATED_ACKNOWLEDGEMENT");
        same(
          operation.request,
          verified.operation.request,
          "UNRELATED_ACKNOWLEDGEMENT"
        );
        same(
          operation.verification,
          verified.operation.verification,
          "UNRELATED_ACKNOWLEDGEMENT"
        );
        same(
          event,
          {
            type: "acknowledgement-intent",
            operationId: verified.operation.operationId,
            verificationReceiptId: verified.operation.verification!.receiptId,
            acknowledgementId: verified.acknowledgementId(item.createdAt),
          },
          "UNRELATED_ACKNOWLEDGEMENT"
        );
        accepted = {
          acknowledgementId: event.acknowledgementId,
          createdAt: item.createdAt,
          head: item.head,
        };
        acknowledgement = "intent-bound";
        continue;
      }
      if (verified && event.type === "acknowledged") {
        if (
          !accepted ||
          item.parentHead !== accepted.head ||
          item.createdAt !== accepted.createdAt
        )
          fail("UNRELATED_ACKNOWLEDGEMENT");
        same(
          event,
          {
            type: "acknowledged",
            operationId: verified.operation.operationId,
            verificationReceiptId: verified.operation.verification!.receiptId,
            acknowledgementId: accepted.acknowledgementId,
            replayProof: null,
          },
          "UNRELATED_ACKNOWLEDGEMENT"
        );
        acknowledgement = "completed";
        phase = null;
        continue;
      }
      if (verifiedSeen) fail("UNRELATED_PROGRESS");
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
      if (verified && item.head === verified.controlHead) {
        same(
          sha256(item.bytes),
          verified.controlSha256,
          "CAPTURED_DELIVERY_ANCHOR_CHANGED"
        );
        same(operation, verified.operation, "VERIFIED_OPERATION_CHANGED");
        verifiedSeen = true;
      }
    }
    const tip = snapshot.commits[0];
    if (!snapshot.head || !tip) fail("CONTROL_REQUIRED");
    const active = parsePromotionControl(tip.bytes).active;
    if (!following.length && active) fail("ACTIVE_OWNER");
    if (verified) {
      if (!verifiedSeen) fail("VERIFIED_CONTROL_NOT_CANONICAL");
      if (acknowledgement === "completed") {
        const tipState = parsePromotionControl(tip.bytes),
          ownProof = createCompletionProof(
            tipState.completionRoot,
            binding.runId,
            (id, type) => store.readCompletionObject(snapshot.head!, id, type)
          ),
          ownCompletion = verifyCompletionProof(
            tipState.completionRoot,
            binding.runId,
            ownProof
          );
        if (
          !ownCompletion ||
          ownCompletion.outcome !== "acknowledged" ||
          !accepted
        )
          fail("ACKNOWLEDGEMENT_COMPLETION_MISMATCH");
        same(
          ownCompletion.operationId,
          verified.operation.operationId,
          "ACKNOWLEDGEMENT_COMPLETION_MISMATCH"
        );
        same(
          ownCompletion.request,
          verified.operation.request,
          "ACKNOWLEDGEMENT_COMPLETION_MISMATCH"
        );
        same(
          ownCompletion.verification,
          verified.operation.verification,
          "ACKNOWLEDGEMENT_COMPLETION_MISMATCH"
        );
        same(
          ownCompletion.acknowledgementId,
          accepted.acknowledgementId,
          "ACKNOWLEDGEMENT_COMPLETION_MISMATCH"
        );
        same(
          ownCompletion.terminalAttemptId,
          verified.operation.promotionAttempt!.attemptId,
          "ACKNOWLEDGEMENT_COMPLETION_MISMATCH"
        );
      }
    }
    if (
      transport.readMainHead?.() !== binding.mainHead ||
      transport.readHead(store.ref) !== snapshot.head
    )
      fail("REMOTE_CHANGED");
    acceptedAcknowledgement = accepted;
    cached = {
      head: snapshot.head,
      operationId,
      phase,
      ...(acknowledgement ? { acknowledgement } : {}),
    };
    return { ...cached };
  }
  validateProgress(binding.initialControlHead);
  const pendingProof = pending;
  const verifiedProof = verified;
  return Object.freeze({
    binding,
    store,
    transport,
    ...(verifiedProof
      ? {
          verifiedDelivery: Object.freeze({
            operationId: verifiedProof.operation.operationId,
            attemptId: verifiedProof.operation.promotionAttempt!.attemptId,
            controlHead: verifiedProof.controlHead,
            controlSha256: verifiedProof.controlSha256,
            verificationReceiptId:
              verifiedProof.operation.verification!.receiptId,
            deploymentId:
              verifiedProof.operation.verification!.deployment.deploymentId,
            assertWeekly(bytes: Buffer) {
              const progress = validateProgress(binding.initialControlHead);
              if (bytes.equals(verifiedProof.before)) return;
              if (
                bytes.equals(verifiedProof.after) &&
                progress.acknowledgement !== "pending"
              )
                return;
              fail("WEEKLY_STATE_CHANGED");
            },
            assertAppend(append: PromotionControlAppend) {
              const progress = validateProgress(binding.initialControlHead);
              if (progress.acknowledgement === "completed")
                fail("ACKNOWLEDGEMENT_ALREADY_COMPLETED");
              const current = store.read();
              if (
                !current.bytes ||
                current.head !== progress.head ||
                append.expectedHead !== current.head
              )
                fail("ACKNOWLEDGEMENT_CONTROL_CHANGED");
              const before: PromotionControl = parsePromotionControl(
                  current.bytes
                ),
                next = parsePromotionControl(append.bytes),
                event = next.lastTransition.event;
              if (
                !before.active ||
                before.active.operationId !==
                  verifiedProof.operation.operationId
              )
                fail("UNRELATED_ACKNOWLEDGEMENT");
              same(
                before.active.request,
                verifiedProof.operation.request,
                "UNRELATED_ACKNOWLEDGEMENT"
              );
              same(
                before.active.verification,
                verifiedProof.operation.verification,
                "UNRELATED_ACKNOWLEDGEMENT"
              );
              if (
                event.type === "acknowledgement-intent" &&
                progress.acknowledgement === "pending"
              ) {
                same(
                  event,
                  {
                    type: "acknowledgement-intent",
                    operationId: verifiedProof.operation.operationId,
                    verificationReceiptId:
                      verifiedProof.operation.verification!.receiptId,
                    acknowledgementId: verifiedProof.acknowledgementId(
                      append.createdAt
                    ),
                  },
                  "UNRELATED_ACKNOWLEDGEMENT"
                );
              } else if (
                event.type === "acknowledged" &&
                progress.acknowledgement === "intent-bound" &&
                acceptedAcknowledgement
              ) {
                same(
                  append.createdAt,
                  acceptedAcknowledgement.createdAt,
                  "ACKNOWLEDGEMENT_TIMESTAMP_CHANGED"
                );
                same(
                  event,
                  {
                    type: "acknowledged",
                    operationId: verifiedProof.operation.operationId,
                    verificationReceiptId:
                      verifiedProof.operation.verification!.receiptId,
                    acknowledgementId:
                      acceptedAcknowledgement.acknowledgementId,
                    replayProof: null,
                  },
                  "UNRELATED_ACKNOWLEDGEMENT"
                );
              } else fail("UNRELATED_ACKNOWLEDGEMENT");
              if (
                !serializePromotionControl(
                  applyPromotionTransition(before, event)
                ).equals(append.bytes)
              )
                fail("ACKNOWLEDGEMENT_APPEND_CHANGED");
            },
          }),
        }
      : {}),
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

interface RecoveryResultChainCandidateRemoteInput {
  chain: Buffer;
  recoveryKey: Buffer;
  repositoryRoot: string;
  workflowCommit: string;
  credentials?: { token: string };
}
function openChain(
  input: RecoveryResultChainCandidateRemoteInput,
  transport: PromotionControlTransport
): RecoveryCandidateRemote {
  const proof = decryptRecoveryResultChain(input.chain, input.recoveryKey);
  return open(
    {
      repositoryRoot: input.repositoryRoot,
      recoveryKey: input.recoveryKey,
      checkpoint: proof.successorCheckpoint,
      runId: proof.certificate.runId,
      workflowCommit: input.workflowCommit,
    },
    transport,
    proof
  );
}
/** Closed namespaced gate: a bare checkpoint or supplied role never suffices. */
export function openRecoveryResultChainCandidateRemote(
  input: RecoveryResultChainCandidateRemoteInput
): RecoveryCandidateRemote {
  return openChain(
    input,
    createAuthoritativePromotionControlTransport(
      input.repositoryRoot,
      input.credentials
    )
  );
}
export function openRecoveryResultChainCandidateRemoteForTest(
  input: RecoveryResultChainCandidateRemoteInput & { bareDirectory: string }
): RecoveryCandidateRemote {
  return openChain(
    input,
    createBareTestPromotionControlTransport(
      input.repositoryRoot,
      input.bareDirectory
    )
  );
}
