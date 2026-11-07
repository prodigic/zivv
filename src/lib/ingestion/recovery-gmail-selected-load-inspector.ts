import { sha256 } from "./steve-preflight.js";
import { readRecoveryGmailCaptureHostForSelectedLoad } from "./recovery-gmail-capture-admission.js";
import { proveRecoveryGmailSelectedLoadBaseline } from "./recovery-gmail-selected-load-proof.js";
import type { RecoveryRuntimeInput } from "./recovery-runtime.js";
import {
  copyRecoveryGmailSelectedReceiptSelector,
  type RecoveryGmailSelectedReceiptSelector,
} from "./recovery-gmail-capture-admission-proof.js";

export const recoveryGmailSelectedLoadInspectorVersion = 1;
export interface RecoveryGmailSelectedLoadInspectionInput extends RecoveryRuntimeInput {
  selector: RecoveryGmailSelectedReceiptSelector;
}
/** Actual prepared-host observation only. The catalog is proved unchanged by
 * exact prepared-file-tree identity, not by adopting a workspace copy. No SQL
 * writer, intent installation, runtime handle or permission escapes. */
export function inspectRecoveryGmailSelectedLoadAdmission(
  input: RecoveryGmailSelectedLoadInspectionInput
) {
  let key: Buffer | undefined;
  try {
    if (
      !input ||
      typeof input !== "object" ||
      ![Object.prototype, null].includes(
        Object.getPrototypeOf(input) as object | null
      )
    )
      throw Error();
    const names = Reflect.ownKeys(input),
      fields = [
        "archive",
        "retirementReceipt",
        "recoveryKey",
        "destination",
        "npmCli",
        "selector",
      ];
    if (
      names.length !== fields.length ||
      names.some(
        (name) =>
          typeof name !== "string" ||
          !fields.includes(name) ||
          !Object.hasOwn(
            Object.getOwnPropertyDescriptor(input, name) ?? {},
            "value"
          )
      )
    )
      throw Error();
    if (!Buffer.isBuffer(input.recoveryKey) || input.recoveryKey.length !== 32)
      throw Error();
    key = Buffer.from(input.recoveryKey);
    const selector = copyRecoveryGmailSelectedReceiptSelector(input.selector);
    const host = readRecoveryGmailCaptureHostForSelectedLoad({
      archive: input.archive,
      retirementReceipt: input.retirementReceipt,
      recoveryKey: key,
      destination: input.destination,
      npmCli: input.npmCli,
    });
    const proof = proveRecoveryGmailSelectedLoadBaseline({
      checkpoint: host.checkpoint,
      recoveryKey: key,
      completed: host.completed,
      unfinishedAdmissions: host.unfinishedAdmissions,
      current: host.current,
      currentLedger: host.checkpoint.ledger,
      currentRuntime: host.currentRuntime,
      priorLoads: [],
      selector,
      ...(host.ownProductionOwnership
        ? { ownProductionOwnership: host.ownProductionOwnership }
        : {}),
    });
    return {
      status: "inspected" as const,
      preLoadOnly: true as const,
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
      physicalValidationRequired: true as const,
      catalogEvidence: "unchanged-prepared-file-tree" as const,
      baselineSha256: proof.baselineSha256,
      catalogSha256: proof.catalogSha256,
      journalSha256: proof.journalSha256,
      physicalSnapshotSha256: host.physicalSnapshotSha256,
      familySha256: proof.selection.familySha256,
      selectionSha256: proof.selection.selectionSha256,
      source: { ...proof.source },
      runId: proof.runState.runId,
      runDisposition: proof.runDisposition,
      captureRepairRequired: host.captureRepairRequired,
      completedCaptures: host.completed.length,
      unfinishedCaptures: host.unfinishedAdmissions.length,
      obligations: proof.selection.obligations.map((row) => ({
        batchId: row.batchId,
        messageSha256: sha256(row.messageId),
        status: row.status,
        receiptId: row.receiptId,
      })),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME"
    )
      throw error;
    throw Error("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_INSPECTION");
  } finally {
    key?.fill(0);
  }
}
