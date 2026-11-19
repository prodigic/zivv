import {
  decodeRecoveryGmailThirdSelectedLoadFrame,
  encodeRecoveryGmailThirdSelectedLoadFrame,
  MAX_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_FRAME_BYTES,
  type RecoveryGmailThirdSelectedLoadFrameInput,
} from "./recovery-gmail-selected-load-third-framing.js";

const magic = Buffer.from("ZGLS", "ascii");
const headerBytes = 13;
export const maxThirdSelectedLoadBaselineBytes = 16 * 1024 * 1024;
export const recoveryGmailThirdStartFramingVersion = 1;
export const maxThirdSelectedLoadStartFrameBytes =
  headerBytes +
  MAX_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_FRAME_BYTES +
  maxThirdSelectedLoadBaselineBytes;

export interface RecoveryGmailThirdSelectedLoadStartFrameInput {
  input: RecoveryGmailThirdSelectedLoadFrameInput;
  executionBaseline: Buffer;
}

function invalid(): never {
  throw Error("INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_START_FRAME");
}

export function encodeThirdSelectedLoadStartFrame(
  supplied: RecoveryGmailThirdSelectedLoadStartFrameInput
): Buffer {
  if (!supplied || typeof supplied !== "object") return invalid();
  const prototype: unknown = Object.getPrototypeOf(supplied);
  const { input, executionBaseline } =
    Object.getOwnPropertyDescriptors(supplied);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(supplied).length !== 2 ||
    !input?.enumerable ||
    !Object.hasOwn(input, "value") ||
    !executionBaseline?.enumerable ||
    !Object.hasOwn(executionBaseline, "value") ||
    !Buffer.isBuffer(supplied.executionBaseline) ||
    !supplied.executionBaseline.length ||
    supplied.executionBaseline.length > maxThirdSelectedLoadBaselineBytes
  )
    return invalid();
  const prior = encodeRecoveryGmailThirdSelectedLoadFrame(supplied.input);
  try {
    const header = Buffer.alloc(headerBytes);
    magic.copy(header);
    header.writeUInt8(recoveryGmailThirdStartFramingVersion, 4);
    header.writeUInt32BE(prior.length, 5);
    header.writeUInt32BE(supplied.executionBaseline.length, 9);
    return Buffer.concat([header, prior, supplied.executionBaseline]);
  } finally {
    prior.fill(0);
  }
}

/** Own exact private buffers. The retained installer verifies their signatures. */
export function decodeThirdSelectedLoadStartFrame(
  wire: Buffer
): RecoveryGmailThirdSelectedLoadStartFrameInput {
  if (
    !Buffer.isBuffer(wire) ||
    wire.length < headerBytes ||
    wire.length > maxThirdSelectedLoadStartFrameBytes ||
    !wire.subarray(0, 4).equals(magic) ||
    wire.readUInt8(4) !== recoveryGmailThirdStartFramingVersion
  )
    return invalid();
  const inputBytes = wire.readUInt32BE(5),
    baselineBytes = wire.readUInt32BE(9);
  if (
    !inputBytes ||
    inputBytes > MAX_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_FRAME_BYTES ||
    !baselineBytes ||
    baselineBytes > maxThirdSelectedLoadBaselineBytes ||
    wire.length !== headerBytes + inputBytes + baselineBytes
  )
    return invalid();
  const end = headerBytes + inputBytes;
  return {
    input: decodeRecoveryGmailThirdSelectedLoadFrame(
      wire.subarray(headerBytes, end)
    ),
    executionBaseline: Buffer.from(wire.subarray(end)),
  };
}
