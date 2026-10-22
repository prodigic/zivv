import { proveRecoveryGmailBatchInventory } from "./recovery-gmail-batch-proof.js";
import { selectSteveEmailPlaintext } from "./steve-email-intake.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

type Checkpoint = Parameters<
  typeof proveRecoveryGmailBatchInventory
>[0]["checkpoint"];
export interface RecoveryGmailCaptureSelection {
  readonly kind: "zivv-recovery-gmail-capture-selection";
  readonly version: 1;
  readonly captureAllowed: false;
  readonly activationAllowed: false;
  readonly physicalValidationRequired: true;
  /** Bounded metadata commitment, NOT authentication of unrelated bytes/the full capsule. */
  readonly checkpointInventorySha256: string;
  readonly batchId: string;
  readonly batchSha256: string;
  readonly originalOperatorDirectory: string;
  readonly accountSha256: string;
  readonly editionId: string;
  readonly orderedRecipeSha256: string;
  readonly selectionSha256: string;
  readonly messages: readonly Readonly<{
    messageId: string;
    rawSha256: string;
    fullSha256: string;
    observedAtEpochMs: number;
    receivedAtEpochMs: number;
    sourceSha256: string | null;
    /** Existing canonical body receipt; this alone does not prove this message captured. */
    existingReceiptId: string | null;
    correctionOf: string | null;
    /** Earlier recipe dependency only; normal intake must first admit/approve it. */
    prospectiveParentMessageId: string | null;
  }>[];
}
function fail(): never {
  throw new Error("INVALID_RECOVERY_GMAIL_CAPTURE_SELECTION");
}
const hash = /^[a-f0-9]{64}$/;

/** Pure selection/provenance only. Outer archive/preparation authentication and
 * normal intake admissibility remain required; this object is never a permit.
 */
export function proveRecoveryGmailCaptureSelection(input: {
  checkpoint: Checkpoint;
  recoveryKey: Buffer;
  batchId: string;
  correctionOfByMessageId?: Record<string, string>;
}): RecoveryGmailCaptureSelection {
  try {
    return prove(input);
  } catch {
    return fail();
  }
}
function prove(
  input: Parameters<typeof proveRecoveryGmailCaptureSelection>[0]
): RecoveryGmailCaptureSelection {
  if (
    !Buffer.isBuffer(input.recoveryKey) ||
    input.recoveryKey.length !== 32 ||
    typeof input.batchId !== "string" ||
    !hash.test(input.batchId)
  )
    fail();
  const supplied = input.correctionOfByMessageId;
  const corrections: Record<string, string> = {};
  if (supplied !== undefined) {
    if (
      !supplied ||
      typeof supplied !== "object" ||
      Array.isArray(supplied) ||
      ![Object.prototype, null].includes(
        Object.getPrototypeOf(supplied) as object | null
      ) ||
      Reflect.ownKeys(supplied).length > 100
    )
      fail();
    for (const name of Reflect.ownKeys(supplied)) {
      if (typeof name !== "string" || !/^[a-f0-9]{1,128}$/.test(name)) fail();
      const property = Object.getOwnPropertyDescriptor(supplied, name);
      if (
        !property?.enumerable ||
        !Object.hasOwn(property, "value") ||
        typeof property.value !== "string" ||
        !hash.test(property.value)
      )
        fail();
      corrections[name] = property.value;
    }
    if (Buffer.byteLength(canonicalJson(corrections)) > 32 * 1024) fail();
  }
  const proof = proveRecoveryGmailBatchInventory(input);
  const selected = proof.batches.find(
    ({ batch }) => batch.batchId === input.batchId
  );
  if (!selected || !proof.journalDigest) fail();
  const { batch } = selected;
  const ids = new Set(
    batch.snapshots.map((snapshot) => snapshot.rawMessage.id)
  );
  if (Object.keys(corrections).some((id) => !ids.has(id))) fail();
  const receipts = new Map(
    proof.receipts.map((receipt) => [receipt.receiptId, receipt])
  );
  const chosenParent = new Map<string, string>(),
    chosenChild = new Map<string, string>();
  const seen = new Set(
    proof.receipts
      .filter(
        (receipt) =>
          receipt.accountSha256 === batch.accountSha256 &&
          receipt.editionId === batch.expectedEditionId
      )
      .map((receipt) => receipt.receiptId)
  );
  const earlier = new Map<
    string,
    { messageId: string; eligibleAfterAdmission: boolean }
  >();
  const messages = batch.snapshots.map((snapshot) => {
    let sourceSha256: string | null;
    try {
      sourceSha256 = sha256(
        selectSteveEmailPlaintext(snapshot.fullMessage.payload).source
      );
    } catch {
      sourceSha256 = null;
    }
    const receiptId =
      sourceSha256 === null
        ? null
        : sha256(
            canonicalJson([
              batch.accountSha256,
              batch.expectedEditionId,
              sourceSha256,
            ])
          );
    const existing = receiptId === null ? undefined : receipts.get(receiptId);
    const correctionOf = corrections[snapshot.rawMessage.id] ?? null;
    let prospectiveParentMessageId: string | null = null;
    if (correctionOf !== null) {
      const parent = receipts.get(correctionOf);
      const prospective = earlier.get(correctionOf);
      if (
        !receiptId ||
        correctionOf === receiptId ||
        (parent &&
          (parent.accountSha256 !== batch.accountSha256 ||
            parent.editionId !== batch.expectedEditionId)) ||
        (parent?.disposition !== "ready" &&
          !prospective?.eligibleAfterAdmission) ||
        (existing?.disposition === "ready" &&
          existing.correctionOf !== correctionOf) ||
        proof.receipts.some(
          (receipt) =>
            receipt.correctionOf === correctionOf &&
            receipt.receiptId !== receiptId
        ) ||
        (chosenParent.has(receiptId) &&
          chosenParent.get(receiptId) !== correctionOf) ||
        (chosenChild.has(correctionOf) &&
          chosenChild.get(correctionOf) !== receiptId)
      )
        fail();
      chosenParent.set(receiptId, correctionOf);
      chosenChild.set(correctionOf, receiptId);
      if (parent?.disposition !== "ready")
        prospectiveParentMessageId = prospective!.messageId;
    }
    if (receiptId) {
      const prior = earlier.get(receiptId);
      const eligibleAfterAdmission =
        existing?.disposition === "ready" ||
        correctionOf !== null ||
        prior?.eligibleAfterAdmission === true ||
        (!existing && seen.size === 0);
      earlier.set(receiptId, {
        messageId: prior?.messageId ?? snapshot.rawMessage.id,
        eligibleAfterAdmission,
      });
      seen.add(receiptId);
    }
    return Object.freeze({
      messageId: snapshot.rawMessage.id,
      rawSha256: sha256(Buffer.from(snapshot.rawMessage.raw, "base64url")),
      fullSha256: sha256(canonicalJson(snapshot.fullMessage)),
      observedAtEpochMs: snapshot.observedAtEpochMs,
      receivedAtEpochMs: snapshot.fullMessage.internal_date,
      sourceSha256,
      existingReceiptId: existing?.receiptId ?? null,
      correctionOf,
      prospectiveParentMessageId,
    });
  });
  // Hash SHA claims and canonical paths only: unrelated file.bytes are neither read
  // nor authenticated here. Their verification belongs to the outer capsule proof.
  const files = input.checkpoint.files.map((file) => {
    if (
      (file.sha256 !== null &&
        (typeof file.sha256 !== "string" || !hash.test(file.sha256))) ||
      (file.bytes === null) !== (file.sha256 === null) ||
      (file.bytes !== null && typeof file.bytes !== "string")
    )
      fail();
    return [file.area, file.path, file.sha256];
  });
  const checkpointInventorySha256 = sha256(
    canonicalJson({
      originalOperatorDirectory: input.checkpoint.originalOperatorDirectory,
      createdAtEpochMs: input.checkpoint.createdAtEpochMs,
      files,
      directories: input.checkpoint.directories.map(({ area, path }) => [
        area,
        path,
      ]),
      journalDigest: proof.journalDigest,
    })
  );
  const file = input.checkpoint.files.find(
    (file) =>
      file.area === "operator" &&
      file.path === `email-acquisition/batches/${batch.batchId}.json`
  );
  if (!file?.sha256) fail();
  const orderedRecipeSha256 = sha256(
    canonicalJson(
      messages.map((message, index) => [
        sha256(canonicalJson(batch.snapshots[index]!)),
        message,
      ])
    )
  );
  const body = {
    kind: "zivv-recovery-gmail-capture-selection" as const,
    version: 1 as const,
    captureAllowed: false as const,
    activationAllowed: false as const,
    physicalValidationRequired: true as const,
    checkpointInventorySha256,
    batchId: batch.batchId,
    batchSha256: file.sha256,
    originalOperatorDirectory: batch.operatorDirectory,
    accountSha256: batch.accountSha256,
    editionId: batch.expectedEditionId,
    orderedRecipeSha256,
  };
  if (Buffer.byteLength(canonicalJson({ ...body, corrections })) > 64 * 1024)
    fail();
  return Object.freeze({
    ...body,
    selectionSha256: sha256(canonicalJson({ ...body, corrections })),
    messages: Object.freeze(messages),
  });
}
