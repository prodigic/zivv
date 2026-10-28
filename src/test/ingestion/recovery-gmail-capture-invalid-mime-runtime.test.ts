import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { resumeOperatorRecoveryGmailBatch } from "../../lib/ingestion/recovery-gmail-capture.js";
import { inspectRecoveryGmailCaptureAdmission } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { inspectOperatorRecoveryGmailBatches } from "../../lib/ingestion/recovery-gmail-inspector.js";
import { proveRecoveryGmailCaptureSelection } from "../../lib/ingestion/recovery-gmail-capture-selection.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 360_000 });

it("preserves a genuinely cached invalid MIME message as pending across retained-worker refusal and retry", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    invalidPendingMime: true,
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
    const input = { ...fixture.input, batchId: fixture.batchIds[0]! };
    const opened = openPreparedRuntimeForAdmission(input);
    const before = opened.inventory();
    const baseline = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(opened.checkpoint.journal, "base64")
    );
    expect(baseline.runState.length).toBeGreaterThan(0);
    expect(fixture.sourceReceipts).toHaveLength(1);
    expect(fixture.sourceReceipts[0]!.receipt.messageId).toBe("a1");
    const inspection = inspectOperatorRecoveryGmailBatches(input);
    expect(inspection.batches).toHaveLength(1);
    expect(inspection.batches[0]!.messages.map((m) => m.status)).toEqual([
      "load-pending",
      "capture-pending",
    ]);
    const selection = proveRecoveryGmailCaptureSelection({
      checkpoint: opened.checkpoint,
      recoveryKey: input.recoveryKey,
      batchId: input.batchId,
    });
    expect(
      selection.messages.map((m) => [m.messageId, m.sourceSha256 === null])
    ).toEqual([
      ["a1", false],
      ["b1", true],
    ]);
    const journal = () =>
      validateWeeklyJournalRecoverySnapshot(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(input.destination, "operator/weekly-runs.sqlite")
        )
      );
    const family = (name: string) =>
      join(input.destination, "recovery-gmail-capture", input.batchId, name);
    let admission: Buffer | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        resumeOperatorRecoveryGmailBatch(input)
      ).rejects.toMatchObject({
        message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
        cause: { message: "AMBIGUOUS_STEVE_TEXT" },
      });
      const saved = readFileSync(family("admission.json"));
      if (admission) expect(saved).toEqual(admission);
      else admission = saved;
      expect(existsSync(family("result.json"))).toBe(false);
      const current = journal();
      expect(current.intakeEvidence).toEqual(baseline.intakeEvidence);
      expect(current.runState).toEqual(baseline.runState);
      expect(current.stageArtifacts).toEqual(baseline.stageArtifacts);
      // Only ordinary lease bookkeeping may change the journal. All original
      // catalog, batch, source and runtime files retain their complete inventory.
      const after = opened.inventory();
      const journalFiles = new Set([
        "operator/weekly-runs.sqlite",
        "operator/weekly-runs.sqlite-wal",
        "operator/weekly-runs.sqlite-shm",
      ]);
      for (const entry of before)
        if (!journalFiles.has(entry.path))
          expect(after.find((e) => e.path === entry.path)).toEqual(entry);
      const originalPaths = new Set(before.map((e) => e.path));
      const prefix = "recovery-gmail-capture/" + input.batchId;
      const key =
        process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin";
      const expectedNew = [
        { path: "operator/" + key, kind: "file" },
        { path: "operator/weekly-runs.sqlite-shm", kind: "file" },
        { path: "operator/weekly-runs.sqlite-wal", kind: "file" },
        { path: "recovery-gmail-capture", kind: "directory" },
        { path: prefix, kind: "directory" },
        { path: prefix + "/admission-stage", kind: "directory" },
        { path: prefix + "/admission.json", kind: "file" },
        { path: prefix + "/key-stage", kind: "directory" },
      ];
      const order = (a: { path: string }, b: { path: string }) =>
        a.path.localeCompare(b.path);
      expect(
        after
          .filter((e) => !originalPaths.has(e.path))
          .map(({ path, kind }) => ({ path, kind }))
          .sort(order)
      ).toEqual(expectedNew.sort(order));
      expect(inspectRecoveryGmailCaptureAdmission(input).status).toBe(
        "capture-partial"
      );
    }
    preserve = false;
  } finally {
    if (preserve)
      console.error(`Preserved invalid MIME Gmail fixture at ${fixture.base}`);
    fixture.cleanup(preserve);
  }
});
