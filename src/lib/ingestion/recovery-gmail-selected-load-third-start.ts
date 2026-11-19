import {
  signSelectedThirdLoadExecutionBaseline,
  verifySelectedThirdLoadExecutionBaseline,
  type SelectedThirdLoadExecutionBaseline,
} from "./recovery-gmail-execution-baseline.js";
import {
  readThirdSelectedLoadAdmissionForInstallation,
  readThirdSelectedLoadAdmissionFromHistory,
  readThirdSelectedLoadAdmissionWithStartBaseline,
} from "./recovery-gmail-selected-load-third-admission.js";
import type { RecoveryGmailThirdSelectedLoadFrameInput } from "./recovery-gmail-selected-load-third-framing.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

function invalid(): never {
  throw Error("INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_START");
}

function observeStart(
  input: RecoveryGmailThirdSelectedLoadFrameInput,
  startedAtEpochMs: number,
  executionBaseline?: Buffer
) {
  if (
    !Number.isSafeInteger(startedAtEpochMs) ||
    startedAtEpochMs < 0 ||
    startedAtEpochMs > Date.now()
  )
    return invalid();
  const prefix =
    executionBaseline === undefined
      ? readThirdSelectedLoadAdmissionForInstallation(
          input.family,
          input.third,
          input.admission
        )
      : readThirdSelectedLoadAdmissionWithStartBaseline(
          input.family,
          input.third,
          input.admission,
          executionBaseline
        );
  return buildStartEvidence(prefix, startedAtEpochMs);
}

function buildStartEvidence(
  prefix: ReturnType<typeof readThirdSelectedLoadAdmissionForInstallation>,
  startedAtEpochMs: number
) {
  const { record, effective, presence, tail, thirdStartPresence } = prefix;
  if (
    presence !== "installed" ||
    effective.catalog.generation !== 3 ||
    startedAtEpochMs < record.admittedAtEpochMs
  )
    return invalid();

  const baseline: SelectedThirdLoadExecutionBaseline = {
    runId: record.runId,
    admissionSha256: sha256(tail.bytes),
    completedPrefixSha256: record.completedPrefixSha256,
    preparedReceiptSha256: record.preparedReceiptSha256,
    catalogSha256: record.catalogSha256,
    journalSha256: record.journalSha256,
    predecessorInventorySha256: record.inventorySha256,
    physicalSnapshotSha256: sha256(canonicalJson(effective.entries)),
    generation: 3,
    startedAtEpochMs,
    entries: effective.entries,
  };
  return { baseline, presence: thirdStartPresence };
}

/** Bind a detached pre-effect baseline to the exact installed third admission.
 * Writing or starting the run requires a separate guarded writer. */
export function prepareThirdSelectedLoadExecutionBaseline(
  input: RecoveryGmailThirdSelectedLoadFrameInput,
  startedAtEpochMs: number
): Buffer {
  try {
    const { baseline } = observeStart(input, startedAtEpochMs);
    return signSelectedThirdLoadExecutionBaseline(
      baseline,
      input.family.prior.recoveryKey
    );
  } catch {
    return invalid();
  }
}

/** Reprove an authenticated baseline against the same released catalog and host. */
export function authenticateThirdSelectedLoadExecutionBaseline(
  input: RecoveryGmailThirdSelectedLoadFrameInput,
  bytes: Buffer
): SelectedThirdLoadExecutionBaseline {
  try {
    const retained = verifySelectedThirdLoadExecutionBaseline(
      bytes,
      input.family.prior.recoveryKey
    );
    const { baseline: observed } = observeStart(
      input,
      retained.startedAtEpochMs
    );
    if (canonicalJson(retained) !== canonicalJson(observed)) return invalid();
    return observed;
  } catch {
    return invalid();
  }
}

/** Verify an exact start tail without installing it or opening a writer. */
export function inspectInstalledThirdSelectedLoadExecutionBaseline(
  input: RecoveryGmailThirdSelectedLoadFrameInput,
  bytes: Buffer
) {
  try {
    const retained = verifySelectedThirdLoadExecutionBaseline(
      bytes,
      input.family.prior.recoveryKey
    );
    const { baseline, presence } = observeStart(
      input,
      retained.startedAtEpochMs,
      bytes
    );
    if (!presence || canonicalJson(retained) !== canonicalJson(baseline))
      return invalid();
    return {
      status: "third-load-start-observed" as const,
      presence,
      runId: baseline.runId,
      executionBaselineSha256: sha256(bytes),
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
      freezeAllowed: false as const,
    };
  } catch {
    return invalid();
  }
}

/** Private historical plan evidence. A later caller still needs a full live
 * generation-four delta proof before calling this load settled. */
export function readThirdSelectedLoadPlanFromHistory(
  input: RecoveryGmailThirdSelectedLoadFrameInput,
  bytes: Buffer
) {
  try {
    const retained = verifySelectedThirdLoadExecutionBaseline(
      bytes,
      input.family.prior.recoveryKey
    );
    const prefix = readThirdSelectedLoadAdmissionFromHistory(
      input.family,
      input.third,
      input.admission,
      bytes
    );
    const { baseline, presence } = buildStartEvidence(
      prefix,
      retained.startedAtEpochMs
    );
    if (
      presence !== "installed" ||
      canonicalJson(retained) !== canonicalJson(baseline)
    )
      return invalid();
    return {
      baseline,
      record: prefix.record,
      effective: prefix.effective,
      historicalOnly: true as const,
      liveDeltaRequired: true as const,
    };
  } catch {
    return invalid();
  }
}
