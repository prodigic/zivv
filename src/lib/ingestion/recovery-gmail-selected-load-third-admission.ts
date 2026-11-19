import type { RecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import type { RecoveryGmailNextSelectedLoadFrameInput } from "./recovery-gmail-selected-load-next-framing.js";
import {
  checkedThirdSelectedLoadAdmission,
  encodeThirdSelectedLoadAdmission,
  verifyThirdSelectedLoadAdmissionRecord,
} from "./recovery-gmail-selected-load-third-admission-format.js";
import { readThirdSelectedLoadAdmissionEvidence } from "./recovery-gmail-selected-load-third-inspection.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

function invalid(): never {
  throw Error("INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_ADMISSION");
}

function payload(
  family: RecoveryGmailNextSelectedLoadFrameInput,
  third: RecoveryGmailSelectedReceiptSelector,
  admittedAtEpochMs: number,
  installedTail?: { runId: string; bytes: Buffer }
) {
  const evidence = readThirdSelectedLoadAdmissionEvidence(
    family,
    third,
    installedTail
  );
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
  const body = {
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
  return {
    body,
    thirdAdmissionPresence: evidence.thirdAdmissionPresence,
    effective: evidence.effective,
  };
}

/** Authenticate a detached third admission and reprove its exact live prefix. */
export function authenticateRecoveryGmailThirdSelectedLoadAdmission(
  family: RecoveryGmailNextSelectedLoadFrameInput,
  third: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer
) {
  try {
    const { body, admittedAtEpochMs } = verifyThirdSelectedLoadAdmissionRecord(
      admission,
      family.prior.recoveryKey
    );
    const { body: expected } = payload(family, third, admittedAtEpochMs);
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
      const bytes = Buffer.from(
        checkedThirdSelectedLoadAdmission(retainedAdmission)
      );
      const verified = authenticateRecoveryGmailThirdSelectedLoadAdmission(
        family,
        third,
        bytes
      );
      if (verified.admittedAtEpochMs !== admittedAtEpochMs) return invalid();
      return bytes;
    }
    const { body } = payload(family, third, admittedAtEpochMs);
    return encodeThirdSelectedLoadAdmission(body, family.prior.recoveryKey);
  } catch {
    return invalid();
  }
}

/**
 * Verify an exact fixed third-admission prefix without adopting its files.
 * The signed identity is checked before projecting out only this admission.
 */
export function readThirdSelectedLoadAdmissionForInstallation(
  family: RecoveryGmailNextSelectedLoadFrameInput,
  third: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer
) {
  try {
    const bytes = Buffer.from(checkedThirdSelectedLoadAdmission(admission));
    const { body, admittedAtEpochMs } = verifyThirdSelectedLoadAdmissionRecord(
      bytes,
      family.prior.recoveryKey
    );
    const runId = body.runId;
    if (
      typeof runId !== "string" ||
      runId.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(runId)
    )
      return invalid();
    const {
      body: expected,
      thirdAdmissionPresence: presence,
      effective,
    } = payload(family, third, admittedAtEpochMs, { runId, bytes });
    if (!presence || canonicalJson(expected) !== canonicalJson(body))
      return invalid();
    return {
      record: expected,
      tail: { runId, bytes },
      effective,
      presence,
    };
  } catch {
    return invalid();
  }
}

/** Return only the observed fixed admission status and its public-safe digests. */
export function inspectInstalledRecoveryGmailThirdSelectedLoadAdmission(
  family: RecoveryGmailNextSelectedLoadFrameInput,
  third: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer
) {
  const { record, tail, presence } =
    readThirdSelectedLoadAdmissionForInstallation(family, third, admission);
  return {
    status: "third-load-admission-observed" as const,
    presence,
    runId: record.runId,
    admissionSha256: sha256(tail.bytes),
    completedPrefixSha256: record.completedPrefixSha256,
    activationAllowed: false as const,
    captureAllowed: false as const,
    loadAllowed: false as const,
    freezeAllowed: false as const,
  };
}
