import { createHmac, timingSafeEqual } from "node:crypto";
import type { RecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import type { RecoveryGmailSelectedLoadFrameInput } from "./recovery-gmail-selected-load-framing.js";
import { readNextSelectedLoadAdmissionEvidence } from "./recovery-gmail-selected-load-next-inspection.js";
import { canonicalJson } from "./sqlite-store.js";

const domain = "zivv-recovery-gmail-selected-load-admission/v2\0";
const maximum = 64 * 1024;

function fail(): never {
  throw Error("INVALID_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_ADMISSION");
}

function body(
  evidence: ReturnType<typeof readNextSelectedLoadAdmissionEvidence>,
  admittedAtEpochMs: number
) {
  if (
    !Number.isSafeInteger(admittedAtEpochMs) ||
    admittedAtEpochMs < evidence.earliestAdmissionEpochMs ||
    admittedAtEpochMs > Date.now()
  )
    return fail();
  const { status: _status, ...commitments } = evidence.report;
  return {
    kind: "zivv-recovery-gmail-selected-load-admission" as const,
    version: 2 as const,
    stopAfter: "load" as const,
    admittedAtEpochMs,
    anchorBaselineSha256: evidence.anchorBaselineSha256,
    runtimeIdentitySha256: evidence.runtimeIdentitySha256,
    selector: evidence.selector,
    source: evidence.source,
    ...commitments,
  };
}

function signature(value: unknown, key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return fail();
  return createHmac("sha256", key)
    .update(domain)
    .update(canonicalJson(value))
    .digest();
}

function read(admission: Buffer, key: Buffer) {
  if (
    !Buffer.isBuffer(admission) ||
    !admission.length ||
    admission.length > maximum
  )
    return fail();
  const parsed: unknown = JSON.parse(admission.toString("utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !admission.equals(Buffer.from(canonicalJson(parsed) + "\n"))
  )
    return fail();
  const { signature: saved, ...payload } = parsed as Record<string, unknown>;
  if (
    typeof saved !== "string" ||
    !/^[a-f0-9]{64}$/.test(saved) ||
    payload.version !== 2 ||
    !timingSafeEqual(Buffer.from(saved, "hex"), signature(payload, key))
  )
    return fail();
  return payload;
}

/** Authenticate the exact immutable intent against independently reobserved
 * predecessor and receipt evidence. The observation grants no writer scope. */
export function authenticateRecoveryGmailNextSelectedLoadAdmission(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer
) {
  try {
    // Check the fixed-size framing and MAC before inspecting a prepared runtime.
    const parsed = read(admission, prior.recoveryKey);
    if (typeof parsed.admittedAtEpochMs !== "number") return fail();
    const expected = body(
      readNextSelectedLoadAdmissionEvidence(prior, next),
      parsed.admittedAtEpochMs
    );
    if (canonicalJson(expected) !== canonicalJson(parsed)) return fail();
    return expected;
  } catch {
    return fail();
  }
}

function validAdmissionBuffer(admission: Buffer) {
  if (!Buffer.isBuffer(admission) || admission.length > maximum) return fail();
  return admission;
}

/** Produce deterministic v2 intent bytes. Preserve the original timestamp and
 * bytes on retry. Installation and fresh validation under writer guards follow
 * separately. */
export function createRecoveryGmailNextSelectedLoadAdmission(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  admittedAtEpochMs: number,
  retainedAdmission?: Buffer
): Buffer {
  try {
    if (retainedAdmission !== undefined) {
      const bytes = Buffer.from(validAdmissionBuffer(retainedAdmission));
      const saved = authenticateRecoveryGmailNextSelectedLoadAdmission(
        prior,
        next,
        bytes
      );
      if (saved.admittedAtEpochMs !== admittedAtEpochMs) return fail();
      return bytes;
    }
    const payload = body(
      readNextSelectedLoadAdmissionEvidence(prior, next),
      admittedAtEpochMs
    );
    const bytes = Buffer.from(
      canonicalJson({
        ...payload,
        signature: signature(payload, prior.recoveryKey).toString("hex"),
      }) + "\n"
    );
    return validAdmissionBuffer(bytes);
  } catch {
    return fail();
  }
}

/** Observe admission-only retry evidence. An authenticated, fixed tail can be
 * projected out only while independently proving the predecessor and this intent. */
export function readNextSelectedLoadAdmissionForInstallation(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  bytes: Buffer
) {
  try {
    const parsed = read(bytes, prior.recoveryKey);
    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.admittedAtEpochMs !== "number"
    )
      return fail();
    const tail = { runId: parsed.runId, bytes };
    const evidence = readNextSelectedLoadAdmissionEvidence(prior, next, tail);
    const record = body(evidence, parsed.admittedAtEpochMs);
    if (canonicalJson(record) !== canonicalJson(parsed)) return fail();
    return { record, tail, effective: evidence.effective };
  } catch {
    return fail();
  }
}
