import { verifyOperatorRetirementEvidence } from "./operator-recovery.js";
import { readNextSelectedLoadCompletionEvidence } from "./recovery-gmail-selected-load-next-replay.js";
import type { RecoveryGmailNextSelectedLoadFrameInput } from "./recovery-gmail-selected-load-next-framing.js";
import type { SteveEmailReceipt } from "./steve-email-intake.js";
import { matchesSuccessfulSteveGmailLoad } from "./steve-gmail-freeze.js";
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
  const states = recoveryRunStates(journal);
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
                .filter((state) =>
                  matchesSuccessfulSteveGmailLoad(state, {
                    editionId: batch.expectedEditionId,
                    deliveryId: message.deliveryId,
                    sourceSha256: message.sourceSha256,
                    firstObservedAtEpochMs: message.firstObservedAtEpochMs,
                  })
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

function recoveryRunStates(
  journal: ReturnType<typeof validateWeeklyJournalRecoverySnapshot>
) {
  return journal.runState
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
}

/** Audit the recorded Gmail obligations after the exact first and second loads.
 * The prepared installation remains quarantined in every report. */
export function inspectComposedRecoveryGmailObligations(
  input: RecoveryGmailNextSelectedLoadFrameInput & { cutoffEpochMs: number }
) {
  try {
    const { prior, next, admission, cutoffEpochMs } = input;
    if (
      !Number.isSafeInteger(cutoffEpochMs) ||
      cutoffEpochMs < 0 ||
      cutoffEpochMs > Date.now()
    )
      return fail();

    const completed = readNextSelectedLoadCompletionEvidence(
      prior,
      next,
      admission
    );
    if (
      completed.report.status !== "selected-load-complete" ||
      completed.report.lease.status !== "released"
    )
      return fail();
    const { checkpoint } = verifyOperatorRetirementEvidence(prior);
    const registered = proveRecoveryGmailBatchInventory({
      checkpoint,
      recoveryKey: prior.recoveryKey,
    });
    const journal = validateWeeklyJournalRecoverySnapshot(
      completed.observedJournal
    );
    const states = recoveryRunStates(journal);
    const sources = new Map(
      journal.intakeEvidence
        .filter(
          (row) =>
            row.scope === "prodigic/zivv/production" && row.kind === "source"
        )
        .map((row) => [row.id, row])
    );
    const obligations = completed.effective.proof.selection.obligations;
    const byMessage = new Map(
      obligations.map((member) => [
        member.batchId + "/" + member.messageId,
        member,
      ])
    );
    if (byMessage.size !== obligations.length) return fail();

    let blockingBatchCount = 0;
    const batches: RecoveryGmailInspectionReport["batches"] =
      registered.batches.map(({ batch, messages }) => {
        const resolved: RecoveryGmailInspectionReport["batches"][number]["messages"] =
          messages.map(({ messageId }) => {
            const key = batch.batchId + "/" + messageId;
            const obligation = byMessage.get(key);
            if (!obligation || !byMessage.delete(key)) return fail();
            const messageSha256 = sha256(messageId);
            if (obligation.status === "capture-pending")
              return { messageSha256, status: "capture-pending" as const };
            if (!obligation.receiptId) return fail();
            const row = sources.get(obligation.receiptId);
            if (!row) return fail();
            const receipt = JSON.parse(
              Buffer.from(row.bytes, "base64").toString("utf8")
            ) as Pick<
              SteveEmailReceipt,
              | "receiptId"
              | "accountSha256"
              | "editionId"
              | "deliveryId"
              | "sourceSha256"
              | "firstObservedAtEpochMs"
            >;
            if (
              receipt.receiptId !== obligation.receiptId ||
              receipt.accountSha256 !== batch.accountSha256 ||
              receipt.editionId !== batch.expectedEditionId ||
              receipt.deliveryId !== "gmail-" + receipt.receiptId ||
              !/^[a-f0-9]{64}$/.test(receipt.sourceSha256) ||
              !Number.isSafeInteger(receipt.firstObservedAtEpochMs) ||
              receipt.firstObservedAtEpochMs < 0
            )
              return fail();

            const loadRunIds =
              obligation.status === "ready"
                ? states
                    .filter((run) =>
                      matchesSuccessfulSteveGmailLoad(run, receipt)
                    )
                    .map((run) => run.runId)
                    .sort()
                : [];
            return {
              messageSha256,
              status:
                obligation.status === "review-required"
                  ? ("review-required" as const)
                  : loadRunIds.length
                    ? ("loaded" as const)
                    : ("load-pending" as const),
              receiptId: receipt.receiptId,
              deliveryId: receipt.deliveryId,
              sourceSha256: receipt.sourceSha256,
              firstObservedAtEpochMs: receipt.firstObservedAtEpochMs,
              loadRunIds,
            };
          });
        if (
          batch.firstSavedAtEpochMs < cutoffEpochMs &&
          resolved.some((entry) => entry.status !== "loaded")
        )
          blockingBatchCount++;
        return {
          batchId: batch.batchId,
          accountSha256: batch.accountSha256,
          editionId: batch.expectedEditionId,
          firstSavedAtEpochMs: batch.firstSavedAtEpochMs,
          messages: resolved,
        };
      });
    if (byMessage.size) return fail();
    return {
      status: "composed-gmail-obligations-inspected" as const,
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
      freezeAllowed: false as const,
      cutoffEpochMs,
      blockingBatchCount,
      runId: completed.report.runId,
      generation: completed.report.generation,
      catalogSha256: completed.report.ledgerRevision,
      journalSha256: sha256(completed.observedJournal),
      batches,
    };
  } catch {
    return fail();
  }
}
