import type { GmailMessagePart } from "./steve-email-intake.js";

const maxPartBytes = 8 * 1024 * 1024;
const maxTotalBytes = 16 * 1024 * 1024;
const maxDepth = 20;
const maxNodes = 100;
const maxHeaders = 256;
const maxHeaderLength = 16 * 1024;
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface SteveGmailSnapshot {
  accountId: string;
  rawMessage: { id: string; raw: string };
  fullMessage: {
    id: string;
    internal_date: number;
    payload: GmailMessagePart;
  };
  observedAtEpochMs: number;
}

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("INVALID_GMAIL_PROJECTION");
  return value as Record<string, unknown>;
}

function boundedEmail(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    !emailPattern.test(value)
  )
    return fail("INVALID_GMAIL_ACCOUNT");
  return value;
}

function messageId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{1,128}$/.test(value))
    return fail("INVALID_GMAIL_MESSAGE_ID");
  return value;
}

function base64Url(
  value: unknown,
  expectedSize?: unknown
): {
  encoded: string;
  size: number;
} {
  if (value === "" && expectedSize === 0) return { encoded: value, size: 0 };
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maxPartBytes / 3) * 4 + 4 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(value)
  )
    return fail("INVALID_GMAIL_ENCODING");
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length > maxPartBytes ||
    bytes.toString("base64url") !== value.replace(/=+$/, "")
  )
    return fail("INVALID_GMAIL_ENCODING");
  if (expectedSize !== undefined && expectedSize !== bytes.length)
    return fail("GMAIL_BODY_SIZE_MISMATCH");
  return { encoded: value, size: bytes.length };
}

function safeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function retainMetadata(value: string, state: { totalBytes: number }): string {
  state.totalBytes += Buffer.byteLength(value, "utf8");
  if (state.totalBytes > maxTotalBytes) return fail("GMAIL_PART_LIMIT");
  return value;
}

function projectPart(
  value: unknown,
  state: { nodes: number; totalBytes: number },
  depth: number
): GmailMessagePart {
  if (depth > maxDepth) return fail("GMAIL_PART_LIMIT");
  if (++state.nodes > maxNodes) return fail("GMAIL_PART_LIMIT");
  const source = record(value);
  if (!safeText(source.mimeType, 256) || !source.mimeType.trim())
    return fail("INVALID_GMAIL_MIME_TYPE");
  const result: GmailMessagePart = {
    mime_type: retainMetadata(source.mimeType, state),
  };
  if (source.filename !== undefined) {
    if (!safeText(source.filename, 1024)) return fail("INVALID_GMAIL_FILENAME");
    result.filename = retainMetadata(source.filename, state);
  }
  if (source.headers !== undefined) {
    if (!Array.isArray(source.headers) || source.headers.length > maxHeaders)
      return fail("INVALID_GMAIL_HEADERS");
    result.headers = source.headers.map((header) => {
      const item = record(header);
      if (
        !safeText(item.name, 256) ||
        !item.name.trim() ||
        !safeText(item.value, maxHeaderLength)
      )
        return fail("INVALID_GMAIL_HEADERS");
      return {
        name: retainMetadata(item.name, state),
        value: retainMetadata(item.value, state),
      };
    });
  }
  if (source.body !== undefined) {
    const body = record(source.body);
    if (!Number.isSafeInteger(body.size) || (body.size as number) < 0)
      return fail("INVALID_GMAIL_BODY_SIZE");
    const size = body.size as number;
    if (size > maxPartBytes) return fail("GMAIL_PART_LIMIT");
    const projected: NonNullable<GmailMessagePart["body"]> = { size };
    if (body.data !== undefined) {
      const decoded = base64Url(body.data, size);
      state.totalBytes += decoded.size;
      if (state.totalBytes > maxTotalBytes) return fail("GMAIL_PART_LIMIT");
      projected.base64_url_content = decoded.encoded;
    } else if (source.mimeType.toLowerCase() === "text/plain") {
      return fail("INCOMPLETE_GMAIL_PROJECTION");
    }
    result.body = projected;
  } else if (source.mimeType.toLowerCase() === "text/plain") {
    return fail("INCOMPLETE_GMAIL_PROJECTION");
  }
  if (source.parts !== undefined) {
    if (!Array.isArray(source.parts)) return fail("INVALID_GMAIL_PARTS");
    result.parts = source.parts.map((part) =>
      projectPart(part, state, depth + 1)
    );
  }
  return result;
}

/** Validate and detach the Gmail API responses into the local intake snapshot shape. */
export function projectSteveGmailSnapshot(input: {
  expectedAccountId: string;
  profile: unknown;
  messageId: string;
  rawMessage: unknown;
  fullMessage: unknown;
  observedAtEpochMs: number;
}): SteveGmailSnapshot {
  const expected = boundedEmail(input.expectedAccountId);
  const profile = record(input.profile);
  const accountId = boundedEmail(profile.emailAddress);
  if (accountId.toLowerCase() !== expected.toLowerCase())
    return fail("GMAIL_ACCOUNT_MISMATCH");
  const listedId = messageId(input.messageId);
  const raw = record(input.rawMessage);
  const full = record(input.fullMessage);
  const rawId = messageId(raw.id);
  const fullId = messageId(full.id);
  if (listedId !== rawId || listedId !== fullId)
    return fail("GMAIL_MESSAGE_ID_MISMATCH");
  if (
    !Number.isSafeInteger(input.observedAtEpochMs) ||
    input.observedAtEpochMs < 0 ||
    input.observedAtEpochMs > Date.now()
  )
    return fail("INVALID_GMAIL_OBSERVATION_TIME");
  if (typeof full.internalDate !== "string" || !/^\d+$/.test(full.internalDate))
    return fail("INVALID_GMAIL_RECEIPT_TIME");
  const internalDate = Number(full.internalDate);
  if (
    !Number.isSafeInteger(internalDate) ||
    internalDate < 0 ||
    internalDate > input.observedAtEpochMs
  )
    return fail("INVALID_GMAIL_RECEIPT_TIME");
  const rawValue = base64Url(raw.raw);
  const state = { nodes: 0, totalBytes: rawValue.size };
  if (state.totalBytes > maxTotalBytes) return fail("GMAIL_PART_LIMIT");
  const payload = projectPart(full.payload, state, 0);
  return {
    accountId,
    rawMessage: { id: rawId, raw: rawValue.encoded },
    fullMessage: {
      id: fullId,
      internal_date: internalDate,
      payload,
    },
    observedAtEpochMs: input.observedAtEpochMs,
  };
}
