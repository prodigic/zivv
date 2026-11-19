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
import {
  validateOperatorRecoveryCheckpoint,
  type OperatorRecoveryCheckpoint,
} from "./operator-recovery.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";
import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import {
  getLatestPublishedWeeklyEdition,
  parseWeeklyEditionLedger,
} from "./weekly.js";
import { readPublicationPayloadGit } from "./publication-git.js";
import { verifyPublicationPayload } from "./publication-payload.js";

interface RecoveryImportRemoteInput {
  repositoryRoot: string;
  checkpoint: OperatorRecoveryCheckpoint;
  recoveryKey: Buffer;
  runId: string;
}
export interface RecoveryImportRemoteBinding {
  mainHead: string;
  controlHead: string;
  controlSha256: string;
  acknowledgedOperationId: string;
  acknowledgedCandidateId: string;
  acknowledgedLedgerRevision: string;
  acknowledgedCutoffEpochMs: number;
}
export interface RecoveryImportRemote {
  readonly binding: Readonly<RecoveryImportRemoteBinding>;
  /** Observe the same authoritative heads and retained artifact before a local effect. */
  assertCurrent(): void;
}
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function refuse(code: string): never {
  throw new Error(`RECOVERY_IMPORT_REMOTE_${code}`);
}

interface RecoveryPublicationInput {
  repositoryRoot: string;
  recoveryKey: Buffer;
}

function openCanonicalRecoveryPublication(
  input: RecoveryPublicationInput,
  transport: PromotionControlTransport,
  checkPublication: (publication: {
    candidate: ReleaseCandidate;
    ledgerRevision: string;
    currentAcknowledgement: boolean;
    verifiedManifest: Buffer | undefined;
  }) => void
) {
  if (!Buffer.isBuffer(input.recoveryKey) || input.recoveryKey.length !== 32)
    refuse("INVALID_KEY");
  const repositoryRoot = input.repositoryRoot;
  const root = realpathSync(repositoryRoot);
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
  const completedControl = parsePromotionControl(acknowledged.bytes);
  const event = completedControl.lastTransition.event;
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
  const candidate = payload.receipt.candidate;
  const key = Buffer.from(input.recoveryKey);
  let revision: string;
  try {
    revision = ledgerDigest(decryptLedgerSnapshot(payload.snapshot, key));
  } finally {
    key.fill(0);
  }
  if (revision !== candidate.ledgerRevision) refuse("LEDGER_DIVERGED");
  checkPublication({
    candidate,
    ledgerRevision: revision,
    verifiedManifest: payload.publicFiles.get("data/manifest.json"),
    currentAcknowledgement:
      canonicalJson(current.lastVerified) ===
      canonicalJson(completedControl.lastVerified),
  });
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
        request.sourceCommit,
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
  });
  function assertCurrent(): void {
    if (realpathSync(repositoryRoot) !== root) refuse("REPOSITORY_MOVED");
    if (
      transport.readMainHead?.() !== binding.mainHead ||
      transport.readHead(store.ref) !== binding.controlHead ||
      transport.readHead(artifactRef) !== request.payloadCommit
    )
      refuse("REMOTE_CHANGED");
  }
  assertCurrent();
  return { binding, assertCurrent, candidate };
}

function open(
  input: RecoveryImportRemoteInput,
  transport: PromotionControlTransport
): RecoveryImportRemote {
  const checkpoint = validateOperatorRecoveryCheckpoint(input.checkpoint);
  const journal = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(checkpoint.journal, "base64")
  );
  const retained = journal.runState.find(
    (row) => row.id === input.runId && row.scope === "prodigic/zivv/production"
  );
  if (!retained) refuse("RUN_NOT_RETAINED");
  const run = parseWeeklyRunState(JSON.parse(retained.payload));
  const { binding, assertCurrent } = openCanonicalRecoveryPublication(
    input,
    transport,
    ({ candidate, ledgerRevision }) => {
      if (ledgerRevision !== checkpoint.ledgerRevision)
        refuse("LEDGER_DIVERGED");
      if (run.source.importObservedAtEpochMs < candidate.cutoffEpochMs)
        refuse("OBSERVATION_BEFORE_ACKNOWLEDGED_CUTOFF");
    }
  );
  return Object.freeze({ binding, assertCurrent });
}

/** Fresh canonical reads only; never appends a ref or authorizes publication. */
export function openRecoveryImportRemote(
  input: RecoveryImportRemoteInput & { credentials?: { token: string } }
): RecoveryImportRemote {
  return open(
    input,
    createAuthoritativePromotionControlTransport(
      input.repositoryRoot,
      input.credentials
    )
  );
}

/** Isolated real bare-Git fixture adapter. Never exposed by the operator CLI. */
export function openRecoveryImportRemoteForTest(
  input: RecoveryImportRemoteInput & { bareDirectory: string }
): RecoveryImportRemote {
  return open(
    input,
    createBareTestPromotionControlTransport(
      input.repositoryRoot,
      input.bareDirectory
    )
  );
}

/** Isolated read-only replacement preflight against a canonical bare Git fixture. */
export function observeReplacementAcknowledgedWatermarkForTest(
  input: RecoveryPublicationInput & {
    bareDirectory: string;
    checkpoint: OperatorRecoveryCheckpoint;
  }
) {
  const unavailable = () => {
    throw Error("REPLACEMENT_PUBLICATION_WATERMARK_UNVERIFIED");
  };
  try {
    const checkpoint = validateOperatorRecoveryCheckpoint(input.checkpoint);
    const record = checkpoint.files.find(
      (entry) =>
        entry.area === "checkout" &&
        entry.path === "data/ingestion/weekly-editions.json"
    );
    if (!record?.bytes) return unavailable();
    const weekly = parseWeeklyEditionLedger(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(record.bytes, "base64")
        )
      )
    );
    const edition = getLatestPublishedWeeklyEdition(weekly);
    if (!edition) return unavailable();
    const transport = createBareTestPromotionControlTransport(
      input.repositoryRoot,
      input.bareDirectory
    );
    const observed = openCanonicalRecoveryPublication(
      input,
      transport,
      ({
        candidate,
        ledgerRevision,
        currentAcknowledgement,
        verifiedManifest,
      }) => {
        if (!verifiedManifest) return unavailable();
        const manifest = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(verifiedManifest)
        ) as { weeklyEdition?: unknown };
        const archivedEdition = {
          editionId: edition.editionId,
          startEpochMs: edition.startEpochMs,
          endEpochMs: edition.endEpochMs,
          eventIds: edition.eventIds.map(Number),
          datasetVersion: edition.datasetVersion,
        };
        if (
          !currentAcknowledgement ||
          ledgerRevision !== checkpoint.ledgerRevision ||
          edition.editionId !== candidate.editionId ||
          edition.endEpochMs !== candidate.cutoffEpochMs ||
          weekly.publishedCutoffEpochMs !== candidate.cutoffEpochMs ||
          canonicalJson(manifest.weeklyEdition) !==
            canonicalJson(archivedEdition) ||
          sha256(Buffer.from(canonicalJson(edition.eventIds))) !==
            candidate.membershipSha256
        )
          return unavailable();
      }
    );
    return Object.freeze({
      status: "replacement-publication-watermark-observed" as const,
      activationAllowed: false as const,
      binding: Object.freeze({
        ...observed.binding,
        editionId: observed.candidate.editionId,
        membershipSha256: observed.candidate.membershipSha256,
        datasetVersion: edition.datasetVersion,
        releaseDatasetVersion: observed.candidate.datasetVersion,
      }),
      assertCurrent: observed.assertCurrent,
    });
  } catch {
    return unavailable();
  }
}
