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
  let lineage: ReturnType<typeof proveRecoveryWeeklyLineage>;
  try {
    lineage = proveRecoveryWeeklyLineage({ ...input, stage: "validated" });
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
