import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  executeRecoveredGmailBatchCapture,
  inspectRecoveryGmailCaptureAdmission,
  type RecoveryGmailCaptureInput,
} from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import {
  resumeOperatorRecoveryGmailBatch,
  resumeOperatorRecoveryGmailBatchForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureRuntimeFixture,
  type RecoveryGmailCaptureRuntimeFixture,
} from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

// Include the launcher's 150-second hard stop so Vitest cannot abandon a live
// child before the launcher terminates and reports it. No observed failure has
// been a timeout; the previous scoped runs finished in 24–42 seconds.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
let fixture: RecoveryGmailCaptureRuntimeFixture;
let input: RecoveryGmailCaptureInput;
let setupComplete = false;
let failed = false;
function journal() {
  return validateWeeklyJournalRecoverySnapshot(
    readWeeklyJournalRecoverySnapshotReadOnly(
      join(input.destination, "operator/weekly-runs.sqlite")
    )
  );
}

beforeAll(async () => {
  fixture = await createRecoveryGmailCaptureRuntimeFixture();
  input = {
    ...fixture.input,
    batchId: fixture.batchIds[0]!,
    correctionOfByMessageId: {
      b1: fixture.sourceReceipts[0]!.receipt.receiptId,
    },
  };
  setupComplete = true;
});
afterAll(() => fixture?.cleanup(!setupComplete || failed));

describe.sequential(
  "closed cached Gmail capture through the genuine retained worker",
  () => {
    it("inspects without effects and refuses direct execution or general quarantine access", async () => {
      try {
        const opened = openPreparedRuntimeForAdmission(input);
        const before = opened.inventory();
        expect(await inspectRecoveryGmailCaptureAdmission(input)).toMatchObject(
          {
            status: "capture-pending",
            activationAllowed: false,
            captureAllowed: false,
          }
        );
        await expect(executeRecoveredGmailBatchCapture(input)).rejects.toThrow(
          "RECOVERY_GMAIL_CAPTURE_RETAINED_EXECUTOR_REQUIRED"
        );
        expect(() =>
          assertOperatorNotQuarantined(join(input.destination, "operator"))
        ).toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
        expect(opened.inventory()).toEqual(before);
      } catch (error) {
        failed = true;
        throw error;
      }
    });

    it("repairs a journal-first interruption without changing the original observation", async () => {
      try {
        await expect(
          resumeOperatorRecoveryGmailBatchForTest(input, "source-committed")
        ).rejects.toMatchObject({
          message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
          cause: { message: "RECOVERY_GMAIL_CAPTURE_TEST_INTERRUPTION" },
        });
        expect(
          existsSync(
            join(
              input.destination,
              "recovery-gmail-capture",
              input.batchId,
              "admission.json"
            )
          )
        ).toBe(true);
        const partial = await inspectRecoveryGmailCaptureAdmission(input);
        expect(partial.status).toBe("capture-partial");
        const report = await resumeOperatorRecoveryGmailBatch(input);
        expect(report).toMatchObject({
          status: "capture-complete",
          activationAllowed: false,
          captureAllowed: false,
        });
        expect(report.receipts).toHaveLength(2);
        const original = fixture.sourceReceipts[0]!.receipt;
        expect(
          report.receipts.find(
            (receipt) => receipt.receiptId === original.receiptId
          )
        ).toMatchObject({
          firstObservedAtEpochMs: original.firstObservedAtEpochMs,
          disposition: "ready",
        });
        expect(
          report.receipts.every((receipt) => receipt.disposition === "ready")
        ).toBe(true);
        const beforeReplay = journal();
        expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(report);
        expect(journal()).toEqual(beforeReplay);
        await expect(
          resumeOperatorRecoveryGmailBatch({
            ...input,
            correctionOfByMessageId: {},
          })
        ).rejects.toThrow();
        expect(journal()).toEqual(beforeReplay);
      } catch (error) {
        failed = true;
        throw error;
      }
    });
  }
);
