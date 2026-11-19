import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { resumeOperatorRecoveryGmailBatch } from "../../lib/ingestion/recovery-gmail-capture.js";
import { inspectRecoveryGmailCaptureAdmission } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { inspectOperatorRecoveryGmailBatches } from "../../lib/ingestion/recovery-gmail-inspector.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { fridayDeliveryTimes } from "../../lib/ingestion/weekly.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 360_000 });

it("keeps a signed closed-edition source pending after native review refusal and retry", async () => {
  const startedAt = Date.now();
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    latePendingEdition: true,
    seedAuthorityControls: true,
  });
  let preserve = true;
  try {
    for (const name of [
      "original checkout",
      "original operator",
      "original npm",
    ])
      expect(existsSync(join(fixture.base, name))).toBe(false);
    const late = fixture.latePending!;
    const { newSourceReviewAtEpochMs } = fridayDeliveryTimes(late.editionId);
    expect(late.firstSavedAtEpochMs).toBeGreaterThanOrEqual(startedAt);
    expect(late.firstSavedAtEpochMs).toBeGreaterThanOrEqual(
      newSourceReviewAtEpochMs
    );
    expect(
      fixture.sourceReceipts.some(
        ({ receipt }) => receipt.receiptId === late.receiptId
      )
    ).toBe(false);

    const input = { ...fixture.input, batchId: late.batchId };
    const opened = openPreparedRuntimeForAdmission(input);
    const originalAudit = inspectOperatorRecoveryGmailBatches(input);
    const before = opened.inventory();
    const journal = () =>
      validateWeeklyJournalRecoverySnapshot(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(input.destination, "operator/weekly-runs.sqlite")
        )
      );
    const baseline = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(opened.checkpoint.journal, "base64")
    );
    const family = (name: string) =>
      join(input.destination, "recovery-gmail-capture", input.batchId, name);
    expect(
      originalAudit.batches.find(({ batchId }) => batchId === late.batchId)
    ).toMatchObject({
      editionId: late.editionId,
      firstSavedAtEpochMs: late.firstSavedAtEpochMs,
      messages: [
        { messageSha256: sha256(late.messageId), status: "capture-pending" },
      ],
    });
    expect(inspectRecoveryGmailCaptureAdmission(input).status).toBe(
      "capture-pending"
    );

    let admission: Buffer | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        resumeOperatorRecoveryGmailBatch(input)
      ).rejects.toMatchObject({
        message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
        cause: { message: "SOURCE_WINDOW_REQUIRES_REVIEW" },
      });
      const current = journal();
      expect(current.intakeEvidence).toEqual(baseline.intakeEvidence);
      expect(current.runState).toEqual(baseline.runState);
      expect(current.stageArtifacts).toEqual(baseline.stageArtifacts);
      expect(
        current.ownership.find(
          ({ scope }) => scope === "prodigic/zivv/production"
        )
      ).toMatchObject({ expiresAtEpochMs: 0 });
      const createdAdmission = readFileSync(family("admission.json"));
      if (admission) expect(createdAdmission).toEqual(admission);
      else admission = createdAdmission;
      expect(existsSync(family("result.json"))).toBe(false);
      expect(inspectRecoveryGmailCaptureAdmission(input)).toMatchObject({
        status: "capture-partial",
        activationAllowed: false,
        captureAllowed: false,
        receipts: [],
      });

      const after = opened.inventory();
      const journalFiles = new Set([
        "operator/weekly-runs.sqlite",
        "operator/weekly-runs.sqlite-wal",
        "operator/weekly-runs.sqlite-shm",
      ]);
      const initialPaths = new Set(before.map(({ path }) => path));
      for (const entry of before)
        if (!journalFiles.has(entry.path))
          expect(after.find(({ path }) => path === entry.path)).toEqual(entry);
      const prefix = "recovery-gmail-capture/" + input.batchId;
      const backupKey =
        process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin";
      const newPaths = after
        .filter(({ path }) => !initialPaths.has(path))
        .map(({ path }) => path)
        .sort();
      expect(newPaths.filter((path) => !journalFiles.has(path))).toEqual(
        [
          "operator/" + backupKey,
          "recovery-gmail-capture",
          prefix,
          prefix + "/admission-stage",
          prefix + "/admission.json",
          prefix + "/key-stage",
        ].sort()
      );
    }
    preserve = false;
  } finally {
    if (preserve)
      console.error("LATE_GMAIL_CAPTURE_FIXTURE_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
