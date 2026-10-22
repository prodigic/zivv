import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resumeOperatorRecoveryGmailBatch,
  startRecoveryGmailCaptureDriftProbeForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import type {
  RecoveryGmailCaptureInput,
  RecoveryGmailCaptureReport,
} from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
  type WeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  createRecoveryGmailCaptureRuntimeFixture,
  type RecoveryGmailCaptureRuntimeFixture,
} from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 540_000, hookTimeout: 180_000 });

interface ActiveFixture {
  fixture: RecoveryGmailCaptureRuntimeFixture;
  input: RecoveryGmailCaptureInput;
}

type Outcome<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown };

function captureOutcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: "resolved", value }),
    (error: unknown) => ({ status: "rejected", error })
  );
}

async function createFixture(): Promise<ActiveFixture> {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture();
  const original = fixture.sourceReceipts.find(
    (item) => item.receipt.messageId === "a1"
  );
  if (!original) throw new Error("Missing retained original receipt a1");
  return {
    fixture,
    input: {
      ...fixture.input,
      batchId: fixture.batchIds[0]!,
      correctionOfByMessageId: {
        b1: original.receipt.receiptId,
      },
    },
  };
}

function normalizedJournal(snapshot: WeeklyJournalRecoverySnapshot) {
  return {
    format: snapshot.format,
    version: snapshot.version,
    journalSchemaVersion: snapshot.journalSchemaVersion,
    ownership: snapshot.ownership.map((row) => ({
      ...row,
      expiresAtEpochMs: 0,
    })),
    runState: snapshot.runState,
    stageArtifacts: snapshot.stageArtifacts,
    intakeEvidence: snapshot.intakeEvidence,
  };
}

function withoutDigest(snapshot: WeeklyJournalRecoverySnapshot) {
  const { digest, ...logical } = snapshot;
  void digest;
  return logical;
}

function journalFromCheckpoint(input: RecoveryGmailCaptureInput) {
  const checkpoint = openPreparedRuntimeForAdmission(input).checkpoint;
  return validateWeeklyJournalRecoverySnapshot(
    Buffer.from(checkpoint.journal, "base64")
  );
}

function weeklyJournal(input: RecoveryGmailCaptureInput) {
  return validateWeeklyJournalRecoverySnapshot(
    readWeeklyJournalRecoverySnapshotReadOnly(
      join(input.destination, "operator/weekly-runs.sqlite")
    )
  );
}

function acquisitionBatchPath(input: RecoveryGmailCaptureInput): string {
  return join(
    input.destination,
    "operator/email-acquisition/batches",
    `${input.batchId}.json`
  );
}

function assertInventoryOnlyBatchChanged(
  before: ReturnType<
    ReturnType<typeof openPreparedRuntimeForAdmission>["inventory"]
  >,
  after: ReturnType<
    ReturnType<typeof openPreparedRuntimeForAdmission>["inventory"]
  >,
  relativePath: string,
  original: Buffer,
  changed: Buffer
): void {
  const beforeEntry = before.find((entry) => entry.path === relativePath);
  const afterEntry = after.find((entry) => entry.path === relativePath);
  expect(beforeEntry?.kind).toBe("file");
  expect(afterEntry?.kind).toBe("file");
  if (beforeEntry?.kind !== "file" || afterEntry?.kind !== "file")
    throw new Error("Selected authenticated batch is missing from inventory");
  expect(beforeEntry.size).toBe(original.length);
  expect(beforeEntry.sha256).toBe(sha256(original));
  expect(afterEntry.size).toBe(changed.length);
  expect(afterEntry.sha256).toBe(sha256(changed));
  const expected = before.map((entry) =>
    entry.path === relativePath
      ? { ...entry, size: changed.length, sha256: sha256(changed) }
      : entry
  );
  expect(after).toEqual(expected);
}

function assertPreparedInventoryUnchangedBeforePause(
  before: ReturnType<
    ReturnType<typeof openPreparedRuntimeForAdmission>["inventory"]
  >,
  paused: ReturnType<
    ReturnType<typeof openPreparedRuntimeForAdmission>["inventory"]
  >,
  batchId: string
): void {
  const beforePaths = new Set(before.map((entry) => entry.path));
  for (const entry of before)
    expect(paused.find((item) => item.path === entry.path)).toEqual(entry);
  expect(
    paused
      .filter((item) => !beforePaths.has(item.path))
      .map(({ path, kind }) => ({ path, kind }))
  ).toEqual([
    { path: "operator/weekly-runs.sqlite-shm", kind: "file" },
    { path: "operator/weekly-runs.sqlite-wal", kind: "file" },
    { path: "recovery-gmail-capture", kind: "directory" },
    { path: `recovery-gmail-capture/${batchId}`, kind: "directory" },
    {
      path: `recovery-gmail-capture/${batchId}/admission-stage`,
      kind: "directory",
    },
    { path: `recovery-gmail-capture/${batchId}/admission.json`, kind: "file" },
  ]);
}

describe.sequential("retained Gmail capture data-drift pause probe", () => {
  it("resumes a no-drift paused probe, completes capture, and replays saved evidence", async () => {
    let active: ActiveFixture | undefined;
    let session:
      | Awaited<ReturnType<typeof startRecoveryGmailCaptureDriftProbeForTest>>
      | undefined;
    let failed = false;
    let failure: unknown;
    try {
      active = await createFixture();
      const baseline = journalFromCheckpoint(active.input);
      session = await startRecoveryGmailCaptureDriftProbeForTest(active.input);
      const outcome = captureOutcome(session.result);
      await session.paused;
      session.resume();
      const result = await outcome;
      if (result.status === "rejected") throw result.error;
      expect(result.value.status).toBe("capture-complete");
      expect(result.value.receipts).toHaveLength(2);
      expect(
        result.value.receipts.every(
          (receipt) => receipt.disposition === "ready"
        )
      ).toBe(true);

      const originalReceiptId = active.fixture.sourceReceipts.find(
        (item) => item.receipt.messageId === "a1"
      )!.receipt.receiptId;
      const originalBefore = baseline.intakeEvidence.find(
        (row) => row.kind === "source" && row.id === originalReceiptId
      );
      const completedJournal = weeklyJournal(active.input);
      expect(
        completedJournal.intakeEvidence.find(
          (row) => row.kind === "source" && row.id === originalReceiptId
        )?.bytes
      ).toBe(originalBefore?.bytes);

      const beforeReplay = completedJournal;
      expect(await resumeOperatorRecoveryGmailBatch(active.input)).toEqual(
        result.value
      );
      expect(weeklyJournal(active.input)).toEqual(beforeReplay);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (session) {
        try {
          await session.stop();
        } catch (error) {
          failed = true;
          failure ??= error;
        }
      }
      if (failed && active)
        console.error(`Preserved no-drift fixture at ${active.fixture.base}`);
      active?.fixture.cleanup(failed);
    }
    if (failed) throw failure;
  }, 540_000);

  it("refuses selected-batch data drift before key, lease, result, or intake effects", async () => {
    let active: ActiveFixture | undefined;
    let session:
      | Awaited<ReturnType<typeof startRecoveryGmailCaptureDriftProbeForTest>>
      | undefined;
    let failed = false;
    let failure: unknown;
    let outcome: Outcome<RecoveryGmailCaptureReport> | undefined;
    let pausedInventory:
      | ReturnType<
          ReturnType<typeof openPreparedRuntimeForAdmission>["inventory"]
        >
      | undefined;
    let baselineJournal: WeeklyJournalRecoverySnapshot | undefined;
    let batchPath = "";
    let originalBatch = Buffer.alloc(0);
    let changedBatch = Buffer.alloc(0);
    try {
      active = await createFixture();
      const opened = openPreparedRuntimeForAdmission(active.input);
      const originalInventory = opened.inventory();
      baselineJournal = validateWeeklyJournalRecoverySnapshot(
        Buffer.from(opened.checkpoint.journal, "base64")
      );
      batchPath = acquisitionBatchPath(active.input);
      expect(existsSync(batchPath)).toBe(true);
      originalBatch = readFileSync(batchPath);

      session = await startRecoveryGmailCaptureDriftProbeForTest(active.input);
      const resultOutcome = captureOutcome(session.result);
      await session.paused;
      pausedInventory = opened.inventory();
      assertPreparedInventoryUnchangedBeforePause(
        originalInventory,
        pausedInventory,
        active.input.batchId
      );
      expect(
        readFileSync(
          join(active.input.destination, "operator/weekly-runs.sqlite-wal")
        )
      ).toHaveLength(0);
      expect(
        pausedInventory.find(
          (entry) => entry.path === "operator/weekly-runs.sqlite-shm"
        )
      ).toMatchObject({ kind: "file", size: 32768 });
      const relativePath =
        "operator/email-acquisition/batches/" + `${active.input.batchId}.json`;
      const pausedEntry = pausedInventory.find(
        (entry) => entry.path === relativePath
      );
      expect(pausedEntry?.kind).toBe("file");

      appendFileSync(batchPath, "\n");
      changedBatch = readFileSync(batchPath);
      expect(changedBatch.length).toBe(originalBatch.length + 1);
      expect(changedBatch.subarray(0, originalBatch.length)).toEqual(
        originalBatch
      );
      expect(() => JSON.parse(changedBatch.toString("utf8"))).not.toThrow();

      session.resume();
      outcome = await resultOutcome;
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (session) {
        try {
          await session.stop();
        } catch (error) {
          failed = true;
          failure ??= error;
        }
      }
    }

    try {
      if (failed) throw failure;
      if (!active || !outcome || !pausedInventory || !baselineJournal)
        throw new Error("Data-drift probe did not reach its terminal state");
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected")
        throw new Error("Drifted capture unexpectedly completed");
      expect(outcome.error).toMatchObject({
        message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
        cause: { message: "RECOVERY_GMAIL_CAPTURE_SCOPE_EXCEEDED" },
      });

      const openedAfter = openPreparedRuntimeForAdmission(active.input);
      const afterInventory = openedAfter.inventory();
      assertInventoryOnlyBatchChanged(
        pausedInventory,
        afterInventory,
        "operator/email-acquisition/batches/" + `${active.input.batchId}.json`,
        originalBatch,
        changedBatch
      );
      const afterJournal = weeklyJournal(active.input);
      expect(withoutDigest(afterJournal)).toEqual(
        normalizedJournal(baselineJournal)
      );
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (failed && active)
        console.error(`Preserved data-drift fixture at ${active.fixture.base}`);
      active?.fixture.cleanup(failed);
    }
    if (failed) throw failure;
  }, 540_000);
});
