import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  inspectRecoveryGmailCaptureAdmission,
  type RecoveryGmailCaptureInput,
} from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import {
  resumeOperatorRecoveryGmailBatch,
  resumeOperatorRecoveryGmailBatchForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import { createRecoveryGmailCaptureProbeControls } from "../../lib/ingestion/recovery-gmail-capture-probe-controls.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureRuntimeFixture,
  type RecoveryGmailCaptureRuntimeFixture,
} from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

// Three sequential real launches may each reach the launcher's terminal timeout.
// Vitest must not abandon a live retained child before that cleanup finishes.
vi.setConfig({ testTimeout: 540_000, hookTimeout: 180_000 });
let fixture: RecoveryGmailCaptureRuntimeFixture | undefined;
let input: RecoveryGmailCaptureInput;
let failed = true;
let baseline: ReturnType<typeof validateWeeklyJournalRecoverySnapshot>;

beforeAll(async () => {
  fixture = await createRecoveryGmailCaptureRuntimeFixture({
    seedAuthorityControls: true,
  });
  input = {
    ...fixture.input,
    batchId: fixture.batchIds[0]!,
    correctionOfByMessageId: {
      b1: fixture.sourceReceipts[0]!.receipt.receiptId,
    },
  };
  baseline = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(
      openPreparedRuntimeForAdmission(input).checkpoint.journal,
      "base64"
    )
  );
  const controls = createRecoveryGmailCaptureProbeControls();
  expect(
    baseline.runState.find((row) => row.id === controls.seed.initialState.runId)
      ?.revision
  ).toBe(1);
  expect(baseline.stageArtifacts).toHaveLength(1);
  expect(baseline.stageArtifacts[0]).toMatchObject({
    runId: controls.seed.initialState.runId,
    stage: "acquire",
    attempt: 0,
    identity: controls.seed.initialState.source.rawSha256,
    bytes: controls.seed.rawSource.toString("base64"),
  });
});

afterAll(() => {
  if (failed && fixture)
    console.error(`Preserved authority-negative fixture at ${fixture.base}`);
  fixture?.cleanup(failed);
});

function journal() {
  return validateWeeklyJournalRecoverySnapshot(
    readWeeklyJournalRecoverySnapshotReadOnly(
      join(input.destination, "operator/weekly-runs.sqlite")
    )
  );
}

it("refuses fixed unrelated effects within genuine capture, then completes normally without changing seeded run history", async () => {
  await expect(
    resumeOperatorRecoveryGmailBatchForTest(
      input,
      "authority-negatives-before-source"
    )
  ).rejects.toMatchObject({
    message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
    cause: { message: "RECOVERY_GMAIL_CAPTURE_AUTHORITY_NEGATIVES_VERIFIED" },
  });
  expect(inspectRecoveryGmailCaptureAdmission(input).status).toBe(
    "capture-partial"
  );
  const partial = journal();
  expect(partial.runState).toEqual(baseline.runState);
  expect(partial.stageArtifacts).toEqual(baseline.stageArtifacts);
  expect(partial.intakeEvidence).toEqual(baseline.intakeEvidence);
  expect(existsSync(join(input.destination, "operator/ledger.sqlite"))).toBe(
    true
  );

  const report = await resumeOperatorRecoveryGmailBatch(input);
  expect(report.status).toBe("capture-complete");
  expect(report.receipts).toHaveLength(2);
  expect(report.receipts.every((item) => item.disposition === "ready")).toBe(
    true
  );
  const complete = journal();
  expect(complete.runState).toEqual(baseline.runState);
  expect(complete.stageArtifacts).toEqual(baseline.stageArtifacts);
  for (const row of baseline.intakeEvidence)
    expect(complete.intakeEvidence).toContainEqual(row);
  expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(report);
  expect(journal()).toEqual(complete);
  failed = false;
});
