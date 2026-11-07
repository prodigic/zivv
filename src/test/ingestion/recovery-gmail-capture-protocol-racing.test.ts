import { expect, it, vi } from "vitest";
import { join } from "node:path";
import {
  resumeOperatorRecoveryGmailBatch,
  startRecoveryGmailCaptureProtocolProbeForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import { inspectRecoveryGmailCaptureAdmission } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 300_000 });

it("authenticates actual progress when duplicate delivery races an accepted GO", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture();
  let preserve = true;
  try {
    const original = fixture.sourceReceipts.find(
      (item) => item.receipt.messageId === "a1"
    );
    if (!original) throw new Error("Missing original receipt");
    const input = {
      ...fixture.input,
      batchId: fixture.batchIds[0]!,
      correctionOfByMessageId: { b1: original.receipt.receiptId },
    };
    const opened = openPreparedRuntimeForAdmission(input);
    const before = opened.inventory();
    const baseline = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(opened.checkpoint.journal, "base64")
    );
    const session = await startRecoveryGmailCaptureProtocolProbeForTest(
      input,
      "duplicate-go-racing"
    );
    const outcome = session.result.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    let observed: Awaited<typeof outcome>;
    try {
      await session.paused;
      session.resume();
      observed = await outcome;
    } finally {
      await session.stop();
    }
    const current = inspectRecoveryGmailCaptureAdmission(input);
    if (observed.status === "resolved") {
      expect(current.status).toBe("capture-complete");
      expect(observed.value).toEqual(current);
    } else {
      expect(observed.error).toMatchObject({
        message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
        cause: { message: "RECOVERY_GMAIL_CAPTURE_HANDSHAKE_INVALID" },
      });
      expect(current.status).toBe("capture-partial");
    }
    // The physical/family inspector authenticates the actual allowed delta.
    // A queued command cannot retroactively erase a legitimate completed capture.
    const completed = await resumeOperatorRecoveryGmailBatch(input);
    expect(completed).toMatchObject({
      status: "capture-complete",
      activationAllowed: false,
      captureAllowed: false,
    });
    expect(completed.receipts).toHaveLength(2);
    expect(completed.receipts.every((r) => r.disposition === "ready")).toBe(
      true
    );
    const after = opened.inventory();
    for (const item of before) {
      if (item.path.startsWith("operator/weekly-runs.sqlite")) continue;
      expect(after.find((entry) => entry.path === item.path)).toEqual(item);
    }
    const journal = () =>
      validateWeeklyJournalRecoverySnapshot(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(input.destination, "operator/weekly-runs.sqlite")
        )
      );
    const saved = journal();
    expect(saved.runState).toEqual(baseline.runState);
    expect(saved.stageArtifacts).toEqual(baseline.stageArtifacts);
    for (const row of baseline.intakeEvidence)
      expect(saved.intakeEvidence).toContainEqual(row);
    expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(completed);
    expect(journal()).toEqual(saved);
    preserve = false;
  } finally {
    if (preserve)
      console.error(`Preserved racing protocol fixture at ${fixture.base}`);
    fixture.cleanup(preserve);
  }
});
