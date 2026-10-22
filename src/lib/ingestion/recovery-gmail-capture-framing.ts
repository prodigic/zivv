import { TextDecoder } from "node:util";
import { canonicalJson } from "./sqlite-store.js";

const magic = Buffer.from("ZGCF", "ascii");
const version = 1;
const headerBytes = 4 + 1 + 4 * 4;
const maxMetadataBytes = 64 * 1024;
const maxArchiveBytes = Math.floor(256 * 1024 * 1024 * 1.4);
const maxRetirementBytes = 16 * 1024;
const exactKeyBytes = 32;

export const MAX_RECOVERY_GMAIL_CAPTURE_FRAME_BYTES =
  headerBytes +
  maxMetadataBytes +
  maxArchiveBytes +
  maxRetirementBytes +
  exactKeyBytes;

export interface RecoveryGmailCaptureFrameInput {
  archive: Buffer;
  retirementReceipt: Buffer;
  recoveryKey: Buffer;
  destination: string;
  npmCli: string;
  batchId: string;
  correctionOfByMessageId?: Readonly<Record<string, string>>;
}

export interface RecoveryGmailCaptureFrame {
  archive: Buffer;
  retirementReceipt: Buffer;
  recoveryKey: Buffer;
  destination: string;
  npmCli: string;
  batchId: string;
  correctionOfByMessageId: Readonly<Record<string, string>>;
}

interface FrameMetadata {
  destination: string;
  npmCli: string;
  batchId: string;
  correctionOfByMessageId: Record<string, string>;
}

function fail(): never {
  throw new Error("INVALID_RECOVERY_GMAIL_CAPTURE_FRAME");
}

function checkedPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  );
}

function checkedMetadata(value: unknown): FrameMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fail();
  const metadata = value as Record<string, unknown>;
  const keys = Object.keys(metadata).sort();
  if (
    canonicalJson(keys) !==
      canonicalJson(
        ["batchId", "correctionOfByMessageId", "destination", "npmCli"].sort()
      ) ||
    !checkedPath(metadata.destination) ||
    !checkedPath(metadata.npmCli) ||
    typeof metadata.batchId !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.batchId)
  )
    return fail();

  const corrections = metadata.correctionOfByMessageId;
  if (
    typeof corrections !== "object" ||
    corrections === null ||
    Array.isArray(corrections)
  )
    return fail();
  const correctionMap = corrections as Record<string, unknown>;
  const correctionKeys = Object.keys(correctionMap);
  if (correctionKeys.length > 100) return fail();
  for (const [messageId, receiptId] of Object.entries(correctionMap))
    if (
      !/^[a-f0-9]{1,128}$/.test(messageId) ||
      typeof receiptId !== "string" ||
      !/^[a-f0-9]{64}$/.test(receiptId)
    )
      return fail();
  return {
    destination: metadata.destination,
    npmCli: metadata.npmCli,
    batchId: metadata.batchId,
    correctionOfByMessageId: Object.fromEntries(
      correctionKeys.sort().map((key) => [key, correctionMap[key] as string])
    ),
  };
}

function metadataBytes(metadata: FrameMetadata): Buffer {
  const bytes = Buffer.from(canonicalJson(metadata), "utf8");
  if (bytes.length > maxMetadataBytes) return fail();
  return bytes;
}

function checkedPayload(
  value: unknown,
  maxBytes: number,
  allowEmpty = false
): Buffer {
  if (
    !Buffer.isBuffer(value) ||
    value.length > maxBytes ||
    (!allowEmpty && value.length === 0)
  )
    return fail();
  return value;
}

export function encodeRecoveryGmailCaptureFrame(
  input: RecoveryGmailCaptureFrameInput
): Buffer {
  const archive = checkedPayload(input.archive, maxArchiveBytes);
  const retirement = checkedPayload(
    input.retirementReceipt,
    maxRetirementBytes
  );
  const key = checkedPayload(input.recoveryKey, exactKeyBytes);
  if (key.length !== exactKeyBytes) return fail();
  const metadata = checkedMetadata({
    destination: input.destination,
    npmCli: input.npmCli,
    batchId: input.batchId,
    correctionOfByMessageId: input.correctionOfByMessageId ?? {},
  });
  const encodedMetadata = metadataBytes(metadata);
  const total =
    headerBytes +
    encodedMetadata.length +
    archive.length +
    retirement.length +
    key.length;
  if (total > MAX_RECOVERY_GMAIL_CAPTURE_FRAME_BYTES) return fail();

  const header = Buffer.alloc(headerBytes);
  magic.copy(header, 0);
  header.writeUInt8(version, 4);
  header.writeUInt32BE(encodedMetadata.length, 5);
  header.writeUInt32BE(archive.length, 9);
  header.writeUInt32BE(retirement.length, 13);
  header.writeUInt32BE(key.length, 17);
  return Buffer.concat(
    [header, encodedMetadata, archive, retirement, key],
    total
  );
}

export function decodeRecoveryGmailCaptureFrame(
  frame: Buffer
): RecoveryGmailCaptureFrame {
  if (!Buffer.isBuffer(frame) || frame.length < headerBytes) return fail();
  if (
    !frame.subarray(0, magic.length).equals(magic) ||
    frame.readUInt8(4) !== version
  )
    return fail();

  const metadataLength = frame.readUInt32BE(5);
  const archiveLength = frame.readUInt32BE(9);
  const retirementLength = frame.readUInt32BE(13);
  const keyLength = frame.readUInt32BE(17);
  if (
    metadataLength === 0 ||
    metadataLength > maxMetadataBytes ||
    archiveLength === 0 ||
    archiveLength > maxArchiveBytes ||
    retirementLength === 0 ||
    retirementLength > maxRetirementBytes ||
    keyLength !== exactKeyBytes
  )
    return fail();
  const expectedLength =
    headerBytes + metadataLength + archiveLength + retirementLength + keyLength;
  if (
    expectedLength > MAX_RECOVERY_GMAIL_CAPTURE_FRAME_BYTES ||
    frame.length !== expectedLength
  )
    return fail();

  const metadataStart = headerBytes;
  const archiveStart = metadataStart + metadataLength;
  const retirementStart = archiveStart + archiveLength;
  const keyStart = retirementStart + retirementLength;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        frame.subarray(metadataStart, archiveStart)
      )
    );
  } catch {
    return fail();
  }
  const metadata = checkedMetadata(parsed);
  if (
    canonicalJson(metadata) !==
    frame.toString("utf8", metadataStart, archiveStart)
  )
    return fail();

  return Object.freeze({
    archive: Buffer.from(frame.subarray(archiveStart, retirementStart)),
    retirementReceipt: Buffer.from(frame.subarray(retirementStart, keyStart)),
    recoveryKey: Buffer.from(frame.subarray(keyStart)),
    destination: metadata.destination,
    npmCli: metadata.npmCli,
    batchId: metadata.batchId,
    correctionOfByMessageId: Object.freeze({
      ...metadata.correctionOfByMessageId,
    }),
  });
}
