import {
  signSelectedThirdLoadExecutionBaseline,
  verifySelectedThirdLoadExecutionBaseline,
  type SelectedThirdLoadExecutionBaseline,
} from "./recovery-gmail-execution-baseline.js";
import { readThirdSelectedLoadAdmissionForInstallation } from "./recovery-gmail-selected-load-third-admission.js";
import type { RecoveryGmailThirdSelectedLoadFrameInput } from "./recovery-gmail-selected-load-third-framing.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

function invalid(): never {
  throw Error("INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_START");
}

function observeStart(
  input: RecoveryGmailThirdSelectedLoadFrameInput,
  startedAtEpochMs: number
): SelectedThirdLoadExecutionBaseline {
  if (
    !Number.isSafeInteger(startedAtEpochMs) ||
    startedAtEpochMs < 0 ||
    startedAtEpochMs > Date.now()
  )
    return invalid();
  const { record, effective, presence, tail } =
    readThirdSelectedLoadAdmissionForInstallation(
      input.family,
      input.third,
      input.admission
    );
  if (
    presence !== "installed" ||
    effective.catalog.generation !== 3 ||
    startedAtEpochMs < record.admittedAtEpochMs
  )
    return invalid();

  return {
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
}

/** Bind a detached pre-effect baseline to the exact installed third admission.
 * Writing or starting the run requires a separate guarded writer. */
export function prepareThirdSelectedLoadExecutionBaseline(
  input: RecoveryGmailThirdSelectedLoadFrameInput,
  startedAtEpochMs: number
): Buffer {
  try {
    const evidence = observeStart(input, startedAtEpochMs);
    return signSelectedThirdLoadExecutionBaseline(
      evidence,
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
    const observed = observeStart(input, retained.startedAtEpochMs);
    if (canonicalJson(retained) !== canonicalJson(observed)) return invalid();
    return observed;
  } catch {
    return invalid();
  }
}
