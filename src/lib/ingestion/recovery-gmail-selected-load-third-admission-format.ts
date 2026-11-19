import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";

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
