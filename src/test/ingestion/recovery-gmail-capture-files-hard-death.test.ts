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
it("reconstructs the missing result after the retained worker dies", async () => {
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
      resumeOperatorRecoveryGmailBatchForTest(
        input,
        "capture-files-written-hard-death"
      )
    ).rejects.toMatchObject({
      message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
      cause: { message: "RECOVERY_GMAIL_FILES_WRITTEN_HARD_DEATH" },
    });
    const partial = await inspectRecoveryGmailCaptureAdmission(input);
    expect(partial).toMatchObject({
      status: "capture-partial",
      activationAllowed: false,
      captureAllowed: false,
    });
    const journalPath = join(input.destination, "operator/weekly-runs.sqlite");
    const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    const inventory = () =>
      openPreparedRuntimeForAdmission(input).inventoryGmailCapture();
    const resultPrefix = `recovery-gmail-capture/${input.batchId}/result`;
    const withoutResult = () =>
      inventory().filter(
        (entry) =>
          entry.path !== resultPrefix + ".json" &&
          entry.path !== resultPrefix + "-stage" &&
          !entry.path.startsWith(resultPrefix + "-stage/")
      );
    const beforeFiles = withoutResult();
    const completed = await resumeOperatorRecoveryGmailBatch(input);
    expect(completed).toMatchObject({
      status: "capture-complete",
      activationAllowed: false,
      captureAllowed: false,
    });
    expect(completed.receipts).toHaveLength(2);
    expect(
      completed.receipts.find((row) => row.receiptId === original.receiptId)
    ).toMatchObject({
      firstObservedAtEpochMs: original.firstObservedAtEpochMs,
      disposition: "ready",
    });
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    expect(withoutResult()).toEqual(beforeFiles);
    const completedFiles = inventory();
    expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(completed);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    expect(inventory()).toEqual(completedFiles);
    preserve = false;
  } finally {
    if (preserve)
      console.error("RECOVERY_GMAIL_FILES_DEATH_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
