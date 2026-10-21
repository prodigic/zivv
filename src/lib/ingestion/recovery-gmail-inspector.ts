import {
  openPreparedRuntimeForAdmission,
  type RecoveryRuntimeInput,
} from "./recovery-runtime.js";
import { proveRecoveryGmailBatchInventory } from "./recovery-gmail-batch-proof.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";

export interface RecoveryGmailInspectionReport {
  status: "inspected";
  activationAllowed: false;
  captureAllowed: false;
  checkpointSha256: string;
  preparedReceiptSha256: string;
  treeSha256: string;
  batches: Array<{
    batchId: string;
    accountSha256: string;
    editionId: string;
    firstSavedAtEpochMs: number;
    messages: Array<
      | { messageSha256: string; status: "capture-pending" }
      | {
          messageSha256: string;
          status: "review-required" | "load-pending" | "loaded";
          receiptId: string;
          deliveryId: string;
          sourceSha256: string;
          firstObservedAtEpochMs: number;
          loadRunIds: string[];
        }
    >;
  }>;
}

function fail(): never {
  throw new Error("INVALID_RECOVERY_GMAIL_INSPECTION");
}

/** Inspect unchanged prepared evidence only. This report grants no reader, capture,
 * load, freeze or activation permission, and never opens SQL or the original roots.
 */
export function inspectOperatorRecoveryGmailBatches(
  input: RecoveryRuntimeInput
): RecoveryGmailInspectionReport {
  try {
    if (
      !Buffer.isBuffer(input.archive) ||
      !input.archive.length ||
      input.archive.length > 256 * 1024 * 1024 * 1.4 ||
      !Buffer.isBuffer(input.retirementReceipt) ||
      !input.retirementReceipt.length ||
      input.retirementReceipt.length > 16 * 1024 ||
      !Buffer.isBuffer(input.recoveryKey) ||
      input.recoveryKey.length !== 32
    )
      fail();
    return inspect({
      ...input,
      archive: Buffer.from(input.archive),
      retirementReceipt: Buffer.from(input.retirementReceipt),
      recoveryKey: Buffer.from(input.recoveryKey),
    });
  } catch {
    return fail();
  }
}

function inspect(input: RecoveryRuntimeInput): RecoveryGmailInspectionReport {
  const opened = openPreparedRuntimeForAdmission(input);
  const before = opened.inventory();
  if (
    before.length !== opened.report.entryCount ||
    sha256(canonicalJson(before)) !== opened.report.treeSha256
  )
    fail();
  opened.assertRuntime();
  const proof = proveRecoveryGmailBatchInventory({
    checkpoint: opened.checkpoint,
    recoveryKey: input.recoveryKey,
  });
  const journal = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(opened.checkpoint.journal, "base64")
  );
  const states = journal.runState
    .filter((row) => row.scope === "prodigic/zivv/production")
    .map((row) => {
      const state = parseWeeklyRunState(JSON.parse(row.payload) as unknown);
      if (
        row.id !== state.runId ||
        row.revision !== state.revision ||
        canonicalJson(state) !== row.payload
      )
        fail();
      return state;
    });
  const batches: RecoveryGmailInspectionReport["batches"] = proof.batches
    .map(({ batch, messages }) => ({
      batchId: batch.batchId,
      accountSha256: batch.accountSha256,
      editionId: batch.expectedEditionId,
      firstSavedAtEpochMs: batch.firstSavedAtEpochMs,
      messages: messages.map((message) => {
        const messageSha256 = sha256(message.messageId);
        if (message.status === "pending")
          return { messageSha256, status: "capture-pending" as const };
        // Receipt/account/edition/source bindings and explicit approval were already
        // validated by the pure proof. A later first observation never removes a
        // batch's earlier registration from a caller's cutoff obligations.
        const loadRunIds =
          message.disposition === "ready"
            ? states
                .filter(
                  (state) =>
                    state.source.editionId === batch.expectedEditionId &&
                    state.source.deliveryId === message.deliveryId &&
                    state.source.rawSha256 === message.sourceSha256 &&
                    state.source.importObservedAtEpochMs ===
                      message.firstObservedAtEpochMs &&
                    state.stages.find((stage) => stage.stage === "load")
                      ?.status === "succeeded"
                )
                .map((state) => state.runId)
                .sort()
            : [];
        return {
          messageSha256,
          status:
            message.disposition !== "ready"
              ? ("review-required" as const)
              : loadRunIds.length
                ? ("loaded" as const)
                : ("load-pending" as const),
          receiptId: message.receiptId,
          deliveryId: message.deliveryId,
          sourceSha256: message.sourceSha256,
          firstObservedAtEpochMs: message.firstObservedAtEpochMs,
          loadRunIds,
        };
      }),
    }))
    .sort(
      (a, b) =>
        a.firstSavedAtEpochMs - b.firstSavedAtEpochMs ||
        a.batchId.localeCompare(b.batchId)
    );
  opened.assertRuntime();
  if (canonicalJson(before) !== canonicalJson(opened.inventory())) fail();
  return {
    status: "inspected",
    activationAllowed: false,
    captureAllowed: false,
    checkpointSha256: opened.report.checkpointSha256,
    preparedReceiptSha256: opened.receiptSha256,
    treeSha256: opened.report.treeSha256,
    batches,
  };
}
