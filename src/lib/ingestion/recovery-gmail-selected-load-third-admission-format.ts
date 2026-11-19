import { createHmac, timingSafeEqual } from "node:crypto";
import type { RecoveryGmailNextSelectedLoadFrameInput } from "./recovery-gmail-selected-load-next-framing.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

const domain = "zivv-recovery-gmail-selected-load-admission/v3\0";
const maximum = 64 * 1024;

function invalid(): never {
  throw Error("INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_ADMISSION");
}

function signature(value: unknown, key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== 32) return invalid();
  return createHmac("sha256", key)
    .update(domain)
    .update(canonicalJson(value))
    .digest();
}

function serialize(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value) + "\n");
}

export function checkedThirdSelectedLoadAdmission(bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum)
    return invalid();
  return bytes;
}

export function verifyThirdSelectedLoadAdmissionRecord(
  bytes: Buffer,
  key: Buffer
) {
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      checkedThirdSelectedLoadAdmission(bytes)
    )
  );
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !bytes.equals(serialize(parsed))
  )
    return invalid();
  const { signature: saved, ...body } = parsed as Record<string, unknown>;
  if (
    body.kind !== "zivv-recovery-gmail-selected-load-admission" ||
    body.version !== 3 ||
    typeof body.admittedAtEpochMs !== "number" ||
    typeof saved !== "string" ||
    saved.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(saved) ||
    !timingSafeEqual(Buffer.from(saved, "hex"), signature(body, key))
  )
    return invalid();
  return { body, admittedAtEpochMs: body.admittedAtEpochMs };
}

/** Bind the signed third admission to one exact prepared host and predecessor pair. */
export function verifyThirdSelectedLoadAdmissionForHost(
  { prior, next, admission }: RecoveryGmailNextSelectedLoadFrameInput,
  runId: string,
  bytes: Buffer,
  preparedReceiptSha256: string
) {
  const verified = verifyThirdSelectedLoadAdmissionRecord(
    bytes,
    prior.recoveryKey
  );
  const { body } = verified;
  if (
    body.runId !== runId ||
    body.archiveSha256 !== sha256(prior.archive) ||
    body.retirementReceiptSha256 !== sha256(prior.retirementReceipt) ||
    body.preparedReceiptSha256 !== preparedReceiptSha256 ||
    body.secondAdmissionSha256 !== sha256(admission) ||
    canonicalJson(body.firstSelector) !== canonicalJson(prior.selector) ||
    canonicalJson(body.secondSelector) !== canonicalJson(next)
  )
    return invalid();
  return verified;
}

export function digestThirdSelectedLoadCompletedPrefix(commitments: {
  firstLoadFamilySha256: string;
  second: {
    runId: string;
    admissionSha256: string;
    executionBaselineSha256: string;
    historyManifestSha256: string;
    resultSha256: string;
  };
  catalogSha256: string;
  generation: number;
  journalSha256: string;
  inventorySha256: string;
}): string {
  return sha256(
    canonicalJson({
      ...commitments,
      domain: "zivv-recovery-gmail-selected-load-prefix/v1",
    })
  );
}

/** Wire preparation only. The detached intent builder must bind actual authority. */
export function encodeThirdSelectedLoadAdmission(
  body: Record<string, unknown>,
  key: Buffer
): Buffer {
  return checkedThirdSelectedLoadAdmission(
    serialize({
      ...body,
      signature: signature(body, key).toString("hex"),
    })
  );
}
