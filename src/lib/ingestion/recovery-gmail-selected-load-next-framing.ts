import {
  copyRecoveryGmailSelectedReceiptSelector,
  type RecoveryGmailSelectedReceiptSelector,
} from "./recovery-gmail-capture-admission-proof.js";
import {
  decodeRecoveryGmailSelectedLoadFrame,
  encodeRecoveryGmailSelectedLoadFrame,
  MAX_RECOVERY_GMAIL_SELECTED_LOAD_FRAME_BYTES,
  type RecoveryGmailSelectedLoadFrameInput,
} from "./recovery-gmail-selected-load-framing.js";
import { canonicalJson } from "./sqlite-store.js";

const magic = Buffer.from("ZGLN", "ascii");
const headerBytes = 17;
const maxSelectorBytes = 4096;
const maxAdmissionBytes = 64 * 1024;
export const recoveryGmailNextSelectedLoadFramingVersion = 1;
export const MAX_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_FRAME_BYTES =
  headerBytes +
  MAX_RECOVERY_GMAIL_SELECTED_LOAD_FRAME_BYTES +
  maxSelectorBytes +
  maxAdmissionBytes;

export interface RecoveryGmailNextSelectedLoadFrameInput {
  prior: RecoveryGmailSelectedLoadFrameInput;
  next: RecoveryGmailSelectedReceiptSelector;
  admission: Buffer;
}

function fail(): never {
  throw Error("INVALID_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_FRAME");
}

export function encodeRecoveryGmailNextSelectedLoadFrame(
  input: RecoveryGmailNextSelectedLoadFrameInput
): Buffer {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(input) as object | null
    )
  )
    return fail();
  const fields = Reflect.ownKeys(input);
  const names = ["prior", "next", "admission"];
  if (
    fields.length !== names.length ||
    fields.some(
      (field) =>
        typeof field !== "string" ||
        !names.includes(field) ||
        !Object.hasOwn(
          Object.getOwnPropertyDescriptor(input, field) ?? {},
          "value"
        )
    ) ||
    !Buffer.isBuffer(input.admission) ||
    input.admission.length === 0 ||
    input.admission.length > maxAdmissionBytes
  )
    return fail();
  let prior: Buffer | undefined;
  try {
    prior = encodeRecoveryGmailSelectedLoadFrame(input.prior);
    const next = copyRecoveryGmailSelectedReceiptSelector(input.next);
    if (input.prior.selector.receiptId === next.receiptId) return fail();
    const nextBytes = Buffer.from(canonicalJson(next));
    if (nextBytes.length > maxSelectorBytes) return fail();
    const header = Buffer.alloc(headerBytes);
    magic.copy(header);
    header.writeUInt8(recoveryGmailNextSelectedLoadFramingVersion, 4);
    header.writeUInt32BE(prior.length, 5);
    header.writeUInt32BE(nextBytes.length, 9);
    header.writeUInt32BE(input.admission.length, 13);
    return Buffer.concat([header, prior, nextBytes, input.admission]);
  } catch {
    return fail();
  } finally {
    prior?.fill(0);
  }
}

/** Decode owned transport bytes. The retained executor authenticates the admission. */
export function decodeRecoveryGmailNextSelectedLoadFrame(
  wire: Buffer
): RecoveryGmailNextSelectedLoadFrameInput {
  if (
    !Buffer.isBuffer(wire) ||
    wire.length < headerBytes ||
    wire.length > MAX_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_FRAME_BYTES ||
    !wire.subarray(0, 4).equals(magic) ||
    wire.readUInt8(4) !== recoveryGmailNextSelectedLoadFramingVersion
  )
    return fail();
  const priorLength = wire.readUInt32BE(5);
  const nextLength = wire.readUInt32BE(9);
  const admissionLength = wire.readUInt32BE(13);
  if (
    priorLength === 0 ||
    priorLength > MAX_RECOVERY_GMAIL_SELECTED_LOAD_FRAME_BYTES ||
    nextLength === 0 ||
    nextLength > maxSelectorBytes ||
    admissionLength === 0 ||
    admissionLength > maxAdmissionBytes ||
    wire.length !== headerBytes + priorLength + nextLength + admissionLength
  )
    return fail();

  const nextStart = headerBytes + priorLength;
  const admissionStart = nextStart + nextLength;
  let prior: RecoveryGmailSelectedLoadFrameInput | undefined;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(wire.subarray(nextStart, admissionStart));
    const next = copyRecoveryGmailSelectedReceiptSelector(JSON.parse(text));
    if (canonicalJson(next) !== text) return fail();
    prior = decodeRecoveryGmailSelectedLoadFrame(
      wire.subarray(headerBytes, nextStart)
    );
    if (prior.selector.receiptId === next.receiptId) return fail();
    return {
      prior,
      next,
      admission: Buffer.from(wire.subarray(admissionStart)),
    };
  } catch {
    prior?.recoveryKey.fill(0);
    return fail();
  }
}
