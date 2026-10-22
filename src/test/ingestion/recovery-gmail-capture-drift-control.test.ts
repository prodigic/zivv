import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  resumeOperatorRecoveryGmailBatch,
  resumeOperatorRecoveryGmailBatchForTest,
  startRecoveryGmailCaptureDriftProbeForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import {
  inspectRecoveryGmailCaptureAdmission,
  type RecoveryGmailCaptureInput,
} from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
  type WeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureRuntimeFixture,
  type RecoveryGmailCaptureRuntimeFixture,
} from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 540_000, hookTimeout: 180_000 });

type RuntimeInventory = ReturnType<
  ReturnType<typeof openPreparedRuntimeForAdmission>["inventory"]
>;
type DriftProbeSession = Awaited<
  ReturnType<typeof startRecoveryGmailCaptureDriftProbeForTest>
>;
type ProbeOutcome =
  | { status: "resolved"; value: Awaited<DriftProbeSession["result"]> }
  | { status: "rejected"; error: unknown };

let fixture: RecoveryGmailCaptureRuntimeFixture;
let input: RecoveryGmailCaptureInput;
let opened: ReturnType<typeof openPreparedRuntimeForAdmission>;
let initialInventory: RuntimeInventory;
let baselineJournal: WeeklyJournalRecoverySnapshot;
let failed = false;

function captureOutcome(
  promise: DriftProbeSession["result"]
): Promise<ProbeOutcome> {
  return promise.then(
    (value) => ({ status: "resolved", value }),
    (error: unknown) => ({ status: "rejected", error })
  );
}

function journalForComparison(snapshot: WeeklyJournalRecoverySnapshot) {
  return {
    format: snapshot.format,
    version: snapshot.version,
    journalSchemaVersion: snapshot.journalSchemaVersion,
    ownership: snapshot.ownership,
    runState: snapshot.runState,
    stageArtifacts: snapshot.stageArtifacts,
    intakeEvidence: snapshot.intakeEvidence,
  };
}

function normalizedBaselineJournal(snapshot: WeeklyJournalRecoverySnapshot) {
  return {
    ...journalForComparison(snapshot),
    ownership: snapshot.ownership.map((row) => ({
      ...row,
      expiresAtEpochMs: 0,
    })),
  };
}

function currentJournal(): WeeklyJournalRecoverySnapshot {
  return validateWeeklyJournalRecoverySnapshot(
    readWeeklyJournalRecoverySnapshotReadOnly(
      join(input.destination, "operator/weekly-runs.sqlite")
    )
  );
}

function sourceRows(
  snapshot: WeeklyJournalRecoverySnapshot
): WeeklyJournalRecoverySnapshot["intakeEvidence"] {
  return snapshot.intakeEvidence.filter((row) => row.kind === "source");
}

function familyPath(name: "admission.json" | "result.json"): string {
  return join(input.destination, "recovery-gmail-capture", input.batchId, name);
}

function assertOnlyAdmissionAdded(
  before: RuntimeInventory,
  after: RuntimeInventory
): void {
  const originalPaths = new Set(before.map((entry) => entry.path));
  for (const entry of before)
    expect(after.find((current) => current.path === entry.path)).toEqual(entry);
  const added = after
    .filter((current) => !originalPaths.has(current.path))
    .map(({ path, kind }) => ({ path, kind }))
    .sort((a, b) => a.path.localeCompare(b.path));
  expect(added).toEqual(
    [
      { path: "operator/weekly-runs.sqlite-shm", kind: "file" },
      { path: "operator/weekly-runs.sqlite-wal", kind: "file" },
      { path: "recovery-gmail-capture", kind: "directory" },
      {
        path: `recovery-gmail-capture/${input.batchId}`,
        kind: "directory",
      },
      {
        path: `recovery-gmail-capture/${input.batchId}/admission-stage`,
        kind: "directory",
      },
      {
        path: `recovery-gmail-capture/${input.batchId}/admission.json`,
        kind: "file",
      },
    ].sort((a, b) => a.path.localeCompare(b.path))
  );
}

function assertExpectedReadonlySidecars(inventory: RuntimeInventory): void {
  expect(
    readFileSync(join(input.destination, "operator/weekly-runs.sqlite-wal"))
  ).toHaveLength(0);
  expect(
    inventory.find((entry) => entry.path === "operator/weekly-runs.sqlite-shm")
  ).toMatchObject({ kind: "file", size: 32_768 });
}

beforeAll(async () => {
  try {
    fixture = await createRecoveryGmailCaptureRuntimeFixture();
    const original = fixture.sourceReceipts.find(
      (item) => item.receipt.messageId === "a1"
    );
    if (!original) throw new Error("Missing retained original receipt a1");
    input = {
      ...fixture.input,
      batchId: fixture.batchIds[0]!,
      correctionOfByMessageId: {
        b1: original.receipt.receiptId,
      },
    };
    // Freeze complete physical and logical baselines before any admission or
    // SQLite observer is opened in the test process.
    opened = openPreparedRuntimeForAdmission(input);
    initialInventory = opened.inventory();
    baselineJournal = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(opened.checkpoint.journal, "base64")
    );
  } catch (error) {
    failed = true;
    throw error;
  }
}, 180_000);

afterAll(() => {
  if (failed && fixture)
    console.error(`Preserved drift-control fixture at ${fixture.base}`);
  fixture?.cleanup(failed);
});

describe.sequential(
  "fixed IPC lifecycle controls for retained Gmail capture",
  () => {
    it("refuses direct pause execution without IPC before creating admission", async () => {
      try {
        await expect(
          resumeOperatorRecoveryGmailBatchForTest(
            input,
            "pause-before-key-guard"
          )
        ).rejects.toMatchObject({
          message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
          cause: { message: "RECOVERY_GMAIL_CAPTURE_HANDSHAKE_REQUIRED" },
        });

        // The direct route must refuse before SQL, sidecars, or admission.
        expect(opened.inventory()).toEqual(initialInventory);
        expect(await inspectRecoveryGmailCaptureAdmission(input)).toMatchObject(
          {
            status: "capture-pending",
            activationAllowed: false,
            captureAllowed: false,
          }
        );
        expect(opened.inventory()).toEqual(initialInventory);
      } catch (error) {
        failed = true;
        throw error;
      }
    }, 540_000);

    it("stops a real paused child idempotently, refuses late resume, then captures normally", async () => {
      let session: DriftProbeSession | undefined;
      let stopFailed = false;
      let stopFailure: unknown;
      let outcome: ProbeOutcome | undefined;
      try {
        session = await startRecoveryGmailCaptureDriftProbeForTest(input);
        // Observe rejection before awaiting readiness, so early child failures are
        // always handled and cannot become unhandled process rejections.
        const outcomePromise = captureOutcome(session.result);
        await session.paused;
        const pausedInventory = opened.inventory();
        assertOnlyAdmissionAdded(initialInventory, pausedInventory);
        assertExpectedReadonlySidecars(pausedInventory);

        await session.stop();
        await session.stop();
        outcome = await outcomePromise;
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected")
          throw new Error("Stopped probe unexpectedly completed");
        expect(outcome.error).toMatchObject({
          message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
          cause: { message: "RECOVERY_GMAIL_CAPTURE_PROBE_STOPPED" },
        });
        expect(() => session!.resume()).toThrow(
          "RECOVERY_GMAIL_CAPTURE_HANDSHAKE_PROTOCOL_ERROR"
        );

        // No SQLite observer is read while the child is alive or paused.
        expect(opened.inventory()).toEqual(pausedInventory);
        expect(existsSync(familyPath("result.json"))).toBe(false);
        const keyName =
          process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin";
        expect(existsSync(join(input.destination, "operator", keyName))).toBe(
          false
        );
        expect(existsSync(familyPath("admission.json"))).toBe(true);
        expect(
          pausedInventory
            .filter((entry) => entry.path.startsWith("operator/email-intake/"))
            .sort((a, b) => a.path.localeCompare(b.path))
        ).toEqual(
          initialInventory
            .filter((entry) => entry.path.startsWith("operator/email-intake/"))
            .sort((a, b) => a.path.localeCompare(b.path))
        );
        expect(journalForComparison(currentJournal())).toEqual(
          normalizedBaselineJournal(baselineJournal)
        );

        const report = await resumeOperatorRecoveryGmailBatch(input);
        expect(report.status).toBe("capture-complete");
        expect(report.receipts).toHaveLength(2);
        expect(
          report.receipts.every((receipt) => receipt.disposition === "ready")
        ).toBe(true);
        const completedJournal = currentJournal();
        expect(sourceRows(completedJournal)).toHaveLength(2);
        expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(report);
        expect(currentJournal()).toEqual(completedJournal);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (session) {
          try {
            await session.stop();
          } catch (error) {
            failed = true;
            stopFailed = true;
            stopFailure = error;
          }
        }
      }
      if (stopFailed) throw stopFailure;
    }, 540_000);
  }
);
