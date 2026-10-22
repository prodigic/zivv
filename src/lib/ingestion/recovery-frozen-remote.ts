import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  createAuthoritativePromotionControlTransport,
  createBareTestPromotionControlTransport,
  createRemotePromotionControlStore,
  type PromotionControlTransport,
} from "./promotion-control-git.js";
import {
  createCompletionProof,
  parsePromotionControl,
  promotionDigest,
  validatePromotionAppend,
  verifyCompletionProof,
} from "./promotion-control.js";
import type { OperatorRecoveryCheckpoint } from "./operator-recovery.js";
import { proveRecoveryWeeklyLineage } from "./recovery-weekly-lineage.js";
import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { readPublicationPayloadGit } from "./publication-git.js";
import { verifyPublicationPayload } from "./publication-payload.js";

interface RecoveryFrozenRemoteInput {
  repositoryRoot: string;
  checkpoint: OperatorRecoveryCheckpoint;
  recoveryKey: Buffer;
  runId: string;
  sourceCommit: string;
}
export interface RecoveryFrozenRemoteBinding {
  mainHead: string;
  controlHead: string;
  controlSha256: string;
  acknowledgedOperationId: string;
  acknowledgedCandidateId: string;
  acknowledgedLedgerRevision: string;
  acknowledgedCutoffEpochMs: number;
  runId: string;
  ledgerRevision: string;
  sourceCommit: string;
  freezeSha256: string;
}
export interface RecoveryFrozenRemote {
  readonly binding: Readonly<RecoveryFrozenRemoteBinding>;
  /** Observe the same authoritative heads and retained artifact before a local effect. */
  assertCurrent(): void;
}
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function refuse(code: string): never {
  throw new Error(`RECOVERY_FROZEN_REMOTE_${code}`);
}

function open(
  input: RecoveryFrozenRemoteInput,
  transport: PromotionControlTransport
): RecoveryFrozenRemote {
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit)) refuse("SOURCE_REQUIRED");
  const lineage = proveRecoveryWeeklyLineage({ ...input, stage: "frozen" });
  const { checkpoint, run } = lineage;
  if (!Buffer.isBuffer(input.recoveryKey) || input.recoveryKey.length !== 32)
    refuse("INVALID_KEY");
  const key = Buffer.from(input.recoveryKey);
  const root = realpathSync(input.repositoryRoot);
  const mainHead = transport.readMainHead?.();
  if (!mainHead) refuse("MAIN_REQUIRED");
  transport.fetchCommit(mainHead);
  const store = createRemotePromotionControlStore({
    repositoryRoot: root,
    destination: "production",
    transport,
    validateState(bytes, destination) {
      const state = parsePromotionControl(bytes);
      if (state.destination !== destination) refuse("DESTINATION_MISMATCH");
      return state.completionRoot;
    },
    validateTransition: validatePromotionAppend,
  });
  const history = store.readCanonicalHistory!();
  if (!history.complete) refuse("INCOMPLETE_HISTORY");
  const latest = history.commits[0];
  if (!history.head || !latest) refuse("CONTROL_REQUIRED");
  const current = parsePromotionControl(latest.bytes);
  if (current.active) refuse("ACTIVE_OWNER");
  const acknowledged = history.commits.find(
    (entry) =>
      parsePromotionControl(entry.bytes).lastTransition.event.type ===
      "acknowledged"
  );
  if (!acknowledged?.parentBytes) refuse("ACKNOWLEDGED_WATERMARK_REQUIRED");
  const event = parsePromotionControl(acknowledged.bytes).lastTransition.event;
  const operation = parsePromotionControl(acknowledged.parentBytes).active;
  if (
    event.type !== "acknowledged" ||
    !operation ||
    event.operationId !== operation.operationId
  )
    refuse("INVALID_ACKNOWLEDGEMENT");
  const proof = createCompletionProof(
    current.completionRoot,
    operation.request.requestId,
    (id, type) => store.readCompletionObject(history.head!, id, type)
  );
  const completed = verifyCompletionProof(
    current.completionRoot,
    operation.request.requestId,
    proof
  );
  if (
    !completed ||
    completed.operationId !== operation.operationId ||
    completed.outcome !== "acknowledged" ||
    completed.acknowledgementId !== event.acknowledgementId ||
    completed.verification.receiptId !== event.verificationReceiptId
  )
    refuse("COMPLETION_MISMATCH");
  const request = completed.request;
  if (request.purpose !== "release" || request.basePath !== "/zivv/")
    refuse("DESTINATION_MISMATCH");
  const artifactRef = `refs/heads/zivv-candidate-artifacts/${request.payloadCommit}`;
  if (transport.readHead(artifactRef) !== request.payloadCommit)
    refuse("ARTIFACT_NOT_RETAINED");
  transport.fetchCommit(request.payloadCommit);
  const payload = verifyPublicationPayload(
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
  if (
    promotionDigest(payload.receipt.candidate.files) !==
    request.publicInventorySha256
  )
    refuse("INVENTORY_MISMATCH");
  const ledger = decryptLedgerSnapshot(payload.snapshot, key);
  const revision = ledgerDigest(ledger);
  if (
    revision !== payload.receipt.candidate.ledgerRevision ||
    revision !== ledgerDigest(lineage.baseline) ||
    canonicalJson(ledger) !== canonicalJson(lineage.baseline)
  )
    refuse("LEDGER_DIVERGED");
  if (
    run.source.importObservedAtEpochMs < payload.receipt.candidate.cutoffEpochMs
  )
    refuse("OBSERVATION_BEFORE_ACKNOWLEDGED_CUTOFF");
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TMP",
    "TEMP",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });
  try {
    for (const sourceCommit of [request.sourceCommit, input.sourceCommit]) {
      execFileSync(
        "git",
        [
          "--no-replace-objects",
          "-c",
          "core.hooksPath=",
          "-c",
          "core.fsmonitor=false",
          "merge-base",
          "--is-ancestor",
          sourceCommit,
          mainHead,
        ],
        {
          cwd: root,
          env,
          windowsHide: true,
          timeout: 30_000,
          stdio: "pipe",
          maxBuffer: 65536,
        }
      );
    }
  } catch {
    refuse("SOURCE_NOT_ON_MAIN");
  }
  const binding = Object.freeze({
    mainHead,
    controlHead: history.head,
    controlSha256: sha256(latest.bytes),
    acknowledgedOperationId: completed.operationId,
    acknowledgedCandidateId: request.candidateId,
    acknowledgedLedgerRevision: revision,
    acknowledgedCutoffEpochMs: payload.receipt.candidate.cutoffEpochMs,
    runId: run.runId,
    ledgerRevision: checkpoint.ledgerRevision,
    sourceCommit: input.sourceCommit,
    freezeSha256: sha256(lineage.artifact("freeze")),
  });
  function assertCurrent(): void {
    if (realpathSync(input.repositoryRoot) !== root) refuse("REPOSITORY_MOVED");
    if (
      transport.readMainHead?.() !== binding.mainHead ||
      transport.readHead(store.ref) !== binding.controlHead ||
      transport.readHead(artifactRef) !== request.payloadCommit
    )
      refuse("REMOTE_CHANGED");
  }
  assertCurrent();
  return Object.freeze({ binding, assertCurrent });
}

/** Prove a frozen run against idle canonical authority; never append or authorize publication. */
export function openRecoveryFrozenRemote(
  input: RecoveryFrozenRemoteInput & { credentials?: { token: string } }
): RecoveryFrozenRemote {
  return open(
    input,
    createAuthoritativePromotionControlTransport(
      input.repositoryRoot,
      input.credentials
    )
  );
}

/** Isolated real bare-Git fixture adapter. Never exposed by the operator CLI. */
export function openRecoveryFrozenRemoteForTest(
  input: RecoveryFrozenRemoteInput & { bareDirectory: string }
): RecoveryFrozenRemote {
  return open(
    input,
    createBareTestPromotionControlTransport(
      input.repositoryRoot,
      input.bareDirectory
    )
  );
}
