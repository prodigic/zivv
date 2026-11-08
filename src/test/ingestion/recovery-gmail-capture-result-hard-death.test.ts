import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { inspectRecoveryGmailCaptureAdmission } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import {
  resumeOperatorRecoveryGmailBatch,
  resumeOperatorRecoveryGmailBatchForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { readWeeklyJournalRecoverySnapshotReadOnly } from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 600000 });
it("returns the saved capture result after the retained worker dies", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture();
  let preserve = true;
  try {
    const original = fixture.sourceReceipts[0]!.receipt;
    const input = {
      ...fixture.input,
      batchId: fixture.batchIds[0]!,
      correctionOfByMessageId: { b1: original.receiptId },
    };
    await expect(
      resumeOperatorRecoveryGmailBatchForTest(input, "result-saved-hard-death")
    ).rejects.toMatchObject({
      message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
      cause: { message: "RECOVERY_GMAIL_RESULT_SAVED_HARD_DEATH" },
    });
    const observed = await inspectRecoveryGmailCaptureAdmission(input);
    expect(observed).toMatchObject({
      status: "capture-complete",
      activationAllowed: false,
      captureAllowed: false,
    });
    const journalPath = join(input.destination, "operator/weekly-runs.sqlite");
    const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    const inventory =
      openPreparedRuntimeForAdmission(input).inventoryGmailCapture();
    const replay = await resumeOperatorRecoveryGmailBatch(input);
    expect(replay).toEqual(observed);
    expect(replay.receipts).toHaveLength(2);
    expect(
      replay.receipts.find((row) => row.receiptId === original.receiptId)
    ).toMatchObject({
      firstObservedAtEpochMs: original.firstObservedAtEpochMs,
      disposition: "ready",
    });
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    expect(
      openPreparedRuntimeForAdmission(input).inventoryGmailCapture()
    ).toEqual(inventory);
    preserve = false;
  } finally {
    if (preserve)
      console.error("RECOVERY_GMAIL_RESULT_DEATH_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
