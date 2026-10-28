import { createHmac, timingSafeEqual } from "node:crypto";
import type { RecoveryPreparedHostBinding } from "./recovery-host-binding.js";
import {
  compactRecoveryGmailCaptureInventory,
  restoreRecoveryGmailCaptureInventory,
  type RecoveryGmailCaptureFamilyInput,
  type RecoveryGmailCaptureSnapshotDelta,
  type RecoveryGmailSelectedReceiptSelector,
} from "./recovery-gmail-capture-admission-proof.js";
import {
  authenticateRecoveryGmailSelectedLoadAdmission,
  type RecoveryGmailSelectedLoadAdmissionContext,
} from "./recovery-gmail-selected-load-admission-proof.js";
import type { RecoveryGmailSelectedLoadBaselineInput } from "./recovery-gmail-selected-load-proof.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

const domain = "zivv-recovery-gmail-selected-load-baseline-evidence/v1\0";
const maxManifest = 16 * 1024 * 1024,
  maxRow = 8 * 1024 * 1024,
  maxRows = 200,
  maxTotal = 256 * 1024 * 1024;
type Row = RecoveryGmailCaptureSnapshotDelta["intakeEvidence"][number];
interface Descriptor extends Omit<Row, "bytes"> {
  chunkId: string;
}
export interface RecoveryGmailSelectedLoadEvidenceChunk {
  id: string;
  bytes: Buffer;
}
interface Manifest {
  kind: "zivv-recovery-gmail-selected-load-baseline-evidence";
  version: 1;
  checkpointSha256: string;
  admissionSha256: string;
  admission: string;
  baselineSha256: string;
  selector: RecoveryGmailSelectedReceiptSelector;
  captureFamily: {
    completed: { admissionSha256: string; resultSha256: string }[];
    unfinished: string[];
  };
  delta: Omit<RecoveryGmailCaptureSnapshotDelta, "intakeEvidence"> & {
    intakeEvidence: Descriptor[];
  };
}
function fail(): never {
  throw new Error("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_EVIDENCE");
}
function key(value: Buffer): void {
  if (!Buffer.isBuffer(value) || value.length !== 32) fail();
}
function decode(value: string, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4)
    fail();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value) fail();
  return bytes;
}
function chunkId(row: Omit<Row, "bytes">) {
  return sha256(
    canonicalJson({
      scope: row.scope,
      kind: row.kind,
      id: row.id,
      identity: row.identity,
    })
  );
}
function captureFamily(
  input: Pick<
    RecoveryGmailCaptureFamilyInput,
    "completed" | "unfinishedAdmissions"
  >
) {
  if (
    !Array.isArray(input.completed) ||
    input.completed.length > 1000 ||
    !Array.isArray(input.unfinishedAdmissions) ||
    input.unfinishedAdmissions.length > 1
  )
    fail();
  let total = 0;
  for (const pair of input.completed) {
    if (
      !Buffer.isBuffer(pair.admission) ||
      pair.admission.length > 64 * 1024 ||
      !Buffer.isBuffer(pair.result) ||
      pair.result.length > 16 * 1024 * 1024
    )
      fail();
    total += pair.admission.length + pair.result.length;
    if (total > maxTotal) fail();
  }
  for (const bytes of input.unfinishedAdmissions)
    if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024) fail();
  return {
    completed: input.completed.map(
      (pair: RecoveryGmailCaptureFamilyInput["completed"][number]) => ({
        admissionSha256: sha256(pair.admission),
        resultSha256: sha256(pair.result),
      })
    ),
    unfinished: input.unfinishedAdmissions.map((bytes: Buffer) =>
      sha256(bytes)
    ),
  };
}
function encode(manifest: Manifest, recoveryKey: Buffer) {
  const signature = createHmac("sha256", recoveryKey)
    .update(domain)
    .update(canonicalJson(manifest))
    .digest("hex");
  const bytes = Buffer.from(canonicalJson({ ...manifest, signature }) + "\n");
  if (bytes.length > maxManifest) fail();
  return bytes;
}
function read(bytes: Buffer, recoveryKey: Buffer): Manifest {
  key(recoveryKey);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxManifest)
    fail();
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const object = value as Record<string, unknown>;
  if (
    !bytes.equals(Buffer.from(canonicalJson(object) + "\n")) ||
    typeof object.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(object.signature)
  )
    fail();
  const { signature, ...payload } = object;
  const expected = createHmac("sha256", recoveryKey)
    .update(domain)
    .update(canonicalJson(payload))
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) fail();
  return payload as unknown as Manifest;
}
/** Private baseline artifact bytes only. No filesystem target or writer scope is
 * returned. Chunks contain only unfinished-tail source/approval rows; original
 * RAW, catalog, runs and completed capture pairs stay in their original evidence. */
export function createRecoveryGmailSelectedLoadEvidence(
  input: RecoveryGmailSelectedLoadAdmissionContext & { admission: Buffer }
) {
  try {
    const intent = authenticateRecoveryGmailSelectedLoadAdmission(input);
    const snapshot = compactRecoveryGmailCaptureInventory(input.baseline);
    const replay = restoreRecoveryGmailCaptureInventory({
      checkpoint: input.baseline.checkpoint,
      recoveryKey: input.baseline.recoveryKey,
      completed: input.baseline.completed,
      unfinishedAdmissions: input.baseline.unfinishedAdmissions,
      delta: snapshot.delta,
    });
    if (replay.familySha256 !== snapshot.familySha256) fail();
    if (snapshot.delta.intakeEvidence.length > maxRows) fail();
    let total = 0;
    const chunks: RecoveryGmailSelectedLoadEvidenceChunk[] = [];
    const rows = snapshot.delta.intakeEvidence.map((row) => {
      const bytes = decode(row.bytes, maxRow);
      total += bytes.length;
      if (total > maxTotal || sha256(bytes) !== row.identity) fail();
      const id = chunkId(row);
      chunks.push({ id, bytes });
      return {
        scope: row.scope,
        kind: row.kind,
        id: row.id,
        identity: row.identity,
        chunkId: id,
      };
    });
    const manifest: Manifest = {
      kind: "zivv-recovery-gmail-selected-load-baseline-evidence",
      version: 1,
      checkpointSha256: sha256(canonicalJson(input.baseline.checkpoint)),
      admissionSha256: sha256(input.admission),
      admission: input.admission.toString("base64"),
      baselineSha256: intent.baselineSha256,
      selector: { ...intent.selector },
      captureFamily: captureFamily(input.baseline),
      delta: {
        files: snapshot.delta.files,
        directories: snapshot.delta.directories,
        productionOwnership: snapshot.delta.productionOwnership,
        intakeEvidence: rows,
      },
    };
    return {
      manifest: encode(manifest, input.baseline.recoveryKey),
      chunks,
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
      physicalValidationRequired: true as const,
    };
  } catch {
    return fail();
  }
}
export interface RecoveryGmailSelectedLoadEvidenceInput {
  checkpoint: RecoveryGmailSelectedLoadBaselineInput["checkpoint"];
  recoveryKey: Buffer;
  binding: RecoveryPreparedHostBinding;
  completed: RecoveryGmailCaptureFamilyInput["completed"];
  unfinishedAdmissions: RecoveryGmailCaptureFamilyInput["unfinishedAdmissions"];
  manifest: Buffer;
  chunks: readonly RecoveryGmailSelectedLoadEvidenceChunk[];
  /** Actual observed canonical/staged intent, or explicit absence for validating
   * an orphan baseline artifact. Null grants no adoption/install permission. */
  observedAdmission: Buffer | null;
}
/** Restore the ORIGINAL admitted baseline, never a current physical-state claim.
 * The closed executor must separately prove the present load delta, complete
 * physical family and all identities before retry. No recovery key is returned. */
export interface RecoveryGmailRestoredLoadEvidence {
  activationAllowed: false;
  captureAllowed: false;
  loadAllowed: false;
  physicalValidationRequired: true;
  evidenceSha256: string;
  baselineSha256: string;
  admission: Buffer;
  originalBaseline: Pick<
    RecoveryGmailSelectedLoadBaselineInput,
    | "current"
    | "currentLedger"
    | "currentRuntime"
    | "selector"
    | "priorLoads"
    | "ownProductionOwnership"
  >;
}
export function restoreRecoveryGmailSelectedLoadEvidence(
  input: RecoveryGmailSelectedLoadEvidenceInput
): RecoveryGmailRestoredLoadEvidence {
  try {
    const manifest = read(input.manifest, input.recoveryKey);
    if (
      manifest.kind !== "zivv-recovery-gmail-selected-load-baseline-evidence" ||
      manifest.version !== 1 ||
      manifest.checkpointSha256 !== sha256(canonicalJson(input.checkpoint)) ||
      canonicalJson(manifest.captureFamily) !==
        canonicalJson(captureFamily(input))
    )
      fail();
    const admission = decode(manifest.admission, 64 * 1024);
    if (sha256(admission) !== manifest.admissionSha256) fail();
    if (
      input.observedAdmission !== null &&
      (!Buffer.isBuffer(input.observedAdmission) ||
        !input.observedAdmission.equals(admission))
    )
      fail();
    if (
      !Array.isArray(manifest.delta.intakeEvidence) ||
      manifest.delta.intakeEvidence.length > maxRows ||
      !Array.isArray(input.chunks) ||
      input.chunks.length !== manifest.delta.intakeEvidence.length
    )
      fail();
    const chunks = new Map<string, Buffer>();
    let total = 0;
    for (const chunk of input.chunks) {
      if (
        typeof chunk.id !== "string" ||
        !/^[a-f0-9]{64}$/.test(chunk.id) ||
        chunks.has(chunk.id) ||
        !Buffer.isBuffer(chunk.bytes) ||
        chunk.bytes.length > maxRow
      )
        fail();
      total += chunk.bytes.length;
      if (total > maxTotal) fail();
      chunks.set(chunk.id, chunk.bytes);
    }
    const rows: Row[] = manifest.delta.intakeEvidence.map(
      (descriptor: Descriptor) => {
        const bytes = chunks.get(descriptor.chunkId);
        if (
          !bytes ||
          descriptor.chunkId !== chunkId(descriptor) ||
          sha256(bytes) !== descriptor.identity
        )
          fail();
        return {
          scope: descriptor.scope,
          kind: descriptor.kind,
          id: descriptor.id,
          identity: descriptor.identity,
          bytes: bytes.toString("base64"),
        };
      }
    );
    const restored = restoreRecoveryGmailCaptureInventory({
      checkpoint: input.checkpoint,
      recoveryKey: input.recoveryKey,
      completed: input.completed,
      unfinishedAdmissions: input.unfinishedAdmissions,
      delta: {
        files: manifest.delta.files,
        directories: manifest.delta.directories,
        productionOwnership: manifest.delta.productionOwnership,
        intakeEvidence: rows,
      },
    });
    const runtime = input.checkpoint.runtime;
    const originalBaseline = {
      current: restored.projectedInventory,
      currentLedger: structuredClone(input.checkpoint.ledger),
      currentRuntime: {
        node: runtime.node,
        icu: runtime.icu,
        executableSha256: runtime.executableSha256,
        workerSha256: runtime.workerSha256,
        lockfileSha256: runtime.lockfileSha256,
      },
      selector: { ...manifest.selector },
      priorLoads: [],
      ...(input.unfinishedAdmissions.length
        ? { ownProductionOwnership: { ...manifest.delta.productionOwnership } }
        : {}),
    };
    const baseline: RecoveryGmailSelectedLoadBaselineInput = {
      checkpoint: input.checkpoint,
      recoveryKey: input.recoveryKey,
      completed: input.completed,
      unfinishedAdmissions: input.unfinishedAdmissions,
      ...originalBaseline,
    };
    const expected = createRecoveryGmailSelectedLoadEvidence({
      baseline,
      binding: input.binding,
      admission,
    });
    if (!expected.manifest.equals(input.manifest)) fail();
    const intent = authenticateRecoveryGmailSelectedLoadAdmission({
      baseline,
      binding: input.binding,
      admission,
    });
    if (intent.baselineSha256 !== manifest.baselineSha256) fail();
    return {
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
      physicalValidationRequired: true as const,
      evidenceSha256: sha256(input.manifest),
      baselineSha256: intent.baselineSha256,
      admission: Buffer.from(admission),
      originalBaseline: structuredClone(originalBaseline),
    };
  } catch {
    return fail();
  }
}
