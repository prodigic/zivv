import { join } from "node:path";
import { verifyOperatorRetirementEvidence } from "../../lib/ingestion/operator-recovery.js";
import { expect, it, vi } from "vitest";
import { inspectRecoveryGmailCaptureAdmission } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import {
  resumeOperatorRecoveryGmailBatch,
  resumeOperatorRecoveryGmailBatchForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 600000 });
it("repairs journal-first capture after the retained worker dies", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture();
  let preserve = true;
  try {
    const original = fixture.sourceReceipts[0]!.receipt;
    const input = {
      ...fixture.input,
      batchId: fixture.batchIds[0]!,
      correctionOfByMessageId: { b1: original.receiptId },
    };
    const readJournal = () =>
      validateWeeklyJournalRecoverySnapshot(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(input.destination, "operator/weekly-runs.sqlite")
        )
      );
    const before = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(
        verifyOperatorRetirementEvidence(input).checkpoint.journal,
        "base64"
      )
    );
    try {
      await resumeOperatorRecoveryGmailBatchForTest(
        input,
        "source-committed-hard-death"
      );
      throw Error("EXPECTED_HARD_DEATH");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED"
      )
        console.error("SOURCE_DEATH_DIAGNOSTIC", error);
      expect(error).toMatchObject({
        message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
        cause: { message: "RECOVERY_GMAIL_SOURCE_COMMIT_HARD_DEATH" },
      });
    }
    const partial = await inspectRecoveryGmailCaptureAdmission(input);
    expect(partial).toMatchObject({
      status: "capture-partial",
      activationAllowed: false,
      captureAllowed: false,
    });
    const afterDeath = readJournal();
    const added = afterDeath.intakeEvidence.filter(
      (row) =>
        !before.intakeEvidence.some(
          (old) =>
            old.scope === row.scope &&
            old.kind === row.kind &&
            old.id === row.id
        )
    );
    expect(added.filter((row) => row.kind === "source")).toHaveLength(1);
    const owner = afterDeath.ownership.find(
      (row) => row.scope === "prodigic/zivv/production"
    );
    expect(owner).toBeDefined();
    while (Date.now() <= owner!.expiresAtEpochMs)
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(1000, Math.max(1, owner!.expiresAtEpochMs - Date.now() + 1))
        )
      );
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
    const afterRepair = readJournal();
    for (const committed of added)
      expect(afterRepair.intakeEvidence).toContainEqual(committed);
    expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(completed);
    expect(readJournal()).toEqual(afterRepair);
    preserve = false;
  } finally {
    if (preserve)
      console.error("RECOVERY_GMAIL_SOURCE_DEATH_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
