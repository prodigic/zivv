import {
  copyRecoveryGmailSelectedReceiptSelector,
  type RecoveryGmailSelectedReceiptSelector,
} from "./recovery-gmail-capture-admission-proof.js";
import {
  decodeRecoveryGmailNextSelectedLoadFrame,
  encodeRecoveryGmailNextSelectedLoadFrame,
  MAX_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_FRAME_BYTES,
  type RecoveryGmailNextSelectedLoadFrameInput,
} from "./recovery-gmail-selected-load-next-framing.js";
import { canonicalJson } from "./sqlite-store.js";

const magic = Buffer.from("ZGL3", "ascii");
const headerBytes = 17;
const maxSelectorBytes = 4096;
const maxAdmissionBytes = 64 * 1024;
export const recoveryGmailThirdSelectedLoadFramingVersion = 1;
export const MAX_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_FRAME_BYTES =
  headerBytes +
  MAX_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_FRAME_BYTES +
  maxSelectorBytes +
  maxAdmissionBytes;

export interface RecoveryGmailThirdSelectedLoadFrameInput {
  family: RecoveryGmailNextSelectedLoadFrameInput;
  third: RecoveryGmailSelectedReceiptSelector;
  admission: Buffer;
}

function invalid(): never {
  throw Error("INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_FRAME");
}

function requireDistinct(
  family: RecoveryGmailNextSelectedLoadFrameInput,
  third: RecoveryGmailSelectedReceiptSelector
): void {
  if (
    family.prior.selector.receiptId === third.receiptId ||
    family.next.receiptId === third.receiptId
  )
    invalid();
}

export function encodeRecoveryGmailThirdSelectedLoadFrame(
  input: RecoveryGmailThirdSelectedLoadFrameInput
): Buffer {
  if (!input || typeof input !== "object") return invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  const names = ["family", "third", "admission"];
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(input).length !== names.length ||
    names.some((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
    }) ||
    !Buffer.isBuffer(input.admission) ||
    input.admission.length === 0 ||
    input.admission.length > maxAdmissionBytes
  )
    return invalid();
  let family: Buffer | undefined;
  try {
    family = encodeRecoveryGmailNextSelectedLoadFrame(input.family);
    const selector = copyRecoveryGmailSelectedReceiptSelector(input.third);
    requireDistinct(input.family, selector);
    const selectorBytes = Buffer.from(canonicalJson(selector));
    if (selectorBytes.length > maxSelectorBytes) return invalid();
    const header = Buffer.alloc(headerBytes);
    magic.copy(header);
    header.writeUInt8(recoveryGmailThirdSelectedLoadFramingVersion, 4);
    header.writeUInt32BE(family.length, 5);
    header.writeUInt32BE(selectorBytes.length, 9);
    header.writeUInt32BE(input.admission.length, 13);
    return Buffer.concat([header, family, selectorBytes, input.admission]);
  } catch {
    return invalid();
  } finally {
    family?.fill(0);
  }
}

/** Own all private input bytes before a retained worker verifies the admission. */
export function decodeRecoveryGmailThirdSelectedLoadFrame(
  wire: Buffer
): RecoveryGmailThirdSelectedLoadFrameInput {
  if (
    !Buffer.isBuffer(wire) ||
    wire.length < headerBytes ||
    wire.length > MAX_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_FRAME_BYTES ||
    !wire.subarray(0, 4).equals(magic) ||
    wire.readUInt8(4) !== recoveryGmailThirdSelectedLoadFramingVersion
  )
    return invalid();
  const familyLength = wire.readUInt32BE(5);
  const selectorLength = wire.readUInt32BE(9);
  const admissionLength = wire.readUInt32BE(13);
  if (
    familyLength === 0 ||
    familyLength > MAX_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_FRAME_BYTES ||
    selectorLength === 0 ||
    selectorLength > maxSelectorBytes ||
    admissionLength === 0 ||
    admissionLength > maxAdmissionBytes ||
    wire.length !==
      headerBytes + familyLength + selectorLength + admissionLength
  )
    return invalid();

  const selectorStart = headerBytes + familyLength;
  const admissionStart = selectorStart + selectorLength;
  let family: RecoveryGmailNextSelectedLoadFrameInput | undefined;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(wire.subarray(selectorStart, admissionStart));
    const third = copyRecoveryGmailSelectedReceiptSelector(JSON.parse(text));
    if (canonicalJson(third) !== text) return invalid();
    family = decodeRecoveryGmailNextSelectedLoadFrame(
      wire.subarray(headerBytes, selectorStart)
    );
    requireDistinct(family, third);
    return {
      family,
      third,
      admission: Buffer.from(wire.subarray(admissionStart)),
    };
  } catch {
    family?.prior.recoveryKey.fill(0);
    family?.admission.fill(0);
    return invalid();
  }
}
