import { createHmac, timingSafeEqual } from "node:crypto";
import type { RecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import type { RecoveryGmailNextSelectedLoadFrameInput } from "./recovery-gmail-selected-load-next-framing.js";
import { readThirdSelectedLoadAdmissionEvidence } from "./recovery-gmail-selected-load-third-inspection.js";
import { canonicalJson } from "./sqlite-store.js";

const domain = "zivv-recovery-gmail-selected-load-admission/v3\0";
const maximum = 64 * 1024;

function invalid(): never {
  throw Error("INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_ADMISSION");
}

function payload(
  family: RecoveryGmailNextSelectedLoadFrameInput,
  third: RecoveryGmailSelectedReceiptSelector,
  admittedAtEpochMs: number
) {
  const evidence = readThirdSelectedLoadAdmissionEvidence(family, third);
  const {
    status: _status,
    earliestAdmissionEpochMs,
    ...commitments
  } = evidence.report;
  if (
    !Number.isSafeInteger(admittedAtEpochMs) ||
    admittedAtEpochMs < earliestAdmissionEpochMs ||
    admittedAtEpochMs > Date.now()
  )
    return invalid();
  return {
    kind: "zivv-recovery-gmail-selected-load-admission" as const,
    version: 3 as const,
    stopAfter: "load" as const,
    admittedAtEpochMs,
    ...commitments,
    archiveSha256: evidence.archiveSha256,
    retirementReceiptSha256: evidence.retirementReceiptSha256,
    preparedReceiptSha256: evidence.preparedReceiptSha256,
    firstSelector: evidence.firstSelector,
    secondSelector: evidence.secondSelector,
    secondAdmissionSha256: evidence.secondAdmissionSha256,
    selector: evidence.selector,
    source: evidence.source,
    runtimeIdentitySha256: evidence.runtimeIdentitySha256,
  };
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

function checkedBytes(bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum)
    return invalid();
  return bytes;
}

function read(bytes: Buffer, key: Buffer) {
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(checkedBytes(bytes))
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

/** Authenticate a detached third admission and reprove its exact live prefix. */
export function authenticateRecoveryGmailThirdSelectedLoadAdmission(
  family: RecoveryGmailNextSelectedLoadFrameInput,
  third: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer
) {
  try {
    const { body, admittedAtEpochMs } = read(
      admission,
      family.prior.recoveryKey
    );
    const expected = payload(family, third, admittedAtEpochMs);
    if (canonicalJson(expected) !== canonicalJson(body)) return invalid();
    return expected;
  } catch {
    return invalid();
  }
}

/** Form an external signed intent. This function never installs it or starts
 * the selected run. A retry reuses its original time and exact signed bytes. */
export function createRecoveryGmailThirdSelectedLoadAdmission(
  family: RecoveryGmailNextSelectedLoadFrameInput,
  third: RecoveryGmailSelectedReceiptSelector,
  admittedAtEpochMs: number,
  retainedAdmission?: Buffer
): Buffer {
  try {
    if (retainedAdmission !== undefined) {
      const bytes = Buffer.from(checkedBytes(retainedAdmission));
      const verified = authenticateRecoveryGmailThirdSelectedLoadAdmission(
        family,
        third,
        bytes
      );
      if (verified.admittedAtEpochMs !== admittedAtEpochMs) return invalid();
      return bytes;
    }
    const body = payload(family, third, admittedAtEpochMs);
    return checkedBytes(
      serialize({
        ...body,
        signature: signature(body, family.prior.recoveryKey).toString("hex"),
      })
    );
  } catch {
    return invalid();
  }
}
