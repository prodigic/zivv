import { existsSync, readFileSync } from "node:fs";
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
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureRuntimeFixture,
  type RecoveryGmailCaptureRuntimeFixture,
} from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 540_000, hookTimeout: 180_000 });
let fixture: RecoveryGmailCaptureRuntimeFixture | undefined;
let input: RecoveryGmailCaptureInput;
let baseline: ReturnType<typeof validateWeeklyJournalRecoverySnapshot>;
let opened: ReturnType<typeof openPreparedRuntimeForAdmission>;
let physicalBaseline: ReturnType<typeof opened.inventory>;
let failed = true;

function journal() {
  return validateWeeklyJournalRecoverySnapshot(
    readWeeklyJournalRecoverySnapshotReadOnly(
      join(input.destination, "operator/weekly-runs.sqlite")
    )
  );
}

function withoutDigest(
  snapshot: ReturnType<typeof validateWeeklyJournalRecoverySnapshot>
) {
  const { digest, ...logical } = snapshot;
  void digest;
  return logical;
}

beforeAll(async () => {
  fixture = await createRecoveryGmailCaptureRuntimeFixture();
  input = { ...fixture.input, batchId: fixture.batchIds[0]! };
  // Capture the authenticated physical and logical baselines before any SQL
  // reader can materialize SQLite sidecars.
  opened = openPreparedRuntimeForAdmission(input);
  physicalBaseline = opened.inventory();
  baseline = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(opened.checkpoint.journal, "base64")
  );
  baseline.ownership = baseline.ownership.map((row) => ({
    ...row,
    expiresAtEpochMs: 0,
  }));
});

afterAll(() => {
  if (failed && fixture)
    console.error(`Preserved escaped-task fixture at ${fixture.base}`);
  fixture?.cleanup(failed);
});

it("blocks an escaped write after scope revocation without changing original evidence", async () => {
  const admissionPath = join(
    input.destination,
    "recovery-gmail-capture",
    input.batchId,
    "admission.json"
  );
  const resultPath = join(
    input.destination,
    "recovery-gmail-capture",
    input.batchId,
    "result.json"
  );
  const keyPath = join(
    input.destination,
    "operator",
    process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
  );

  await expect(
    resumeOperatorRecoveryGmailBatchForTest(
      input,
      "authority-escaped-after-admission"
    )
  ).rejects.toMatchObject({
    message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
    cause: { message: "RECOVERY_GMAIL_CAPTURE_AUTHORITY_ESCAPE_VERIFIED" },
  });
  expect(existsSync(admissionPath)).toBe(true);
  expect(existsSync(keyPath)).toBe(false);
  expect(existsSync(resultPath)).toBe(false);

  const afterEscape = opened.inventory();
  const originalPaths = new Set(physicalBaseline.map((entry) => entry.path));
  expect(afterEscape.filter((entry) => originalPaths.has(entry.path))).toEqual(
    physicalBaseline
  );
  expect(
    afterEscape
      .filter((entry) => !originalPaths.has(entry.path))
      .map(({ path, kind }) => ({ path, kind }))
  ).toEqual([
    { path: "operator/weekly-runs.sqlite-shm", kind: "file" },
    { path: "operator/weekly-runs.sqlite-wal", kind: "file" },
    { path: "recovery-gmail-capture", kind: "directory" },
    { path: `recovery-gmail-capture/${input.batchId}`, kind: "directory" },
    {
      path: `recovery-gmail-capture/${input.batchId}/admission-stage`,
      kind: "directory",
    },
    {
      path: `recovery-gmail-capture/${input.batchId}/admission.json`,
      kind: "file",
    },
  ]);
  expect(
    readFileSync(join(input.destination, "operator/weekly-runs.sqlite-wal"))
  ).toHaveLength(0);
  expect(
    afterEscape.find(
      (entry) => entry.path === "operator/weekly-runs.sqlite-shm"
    )
  ).toMatchObject({ kind: "file", size: 32768 });

  expect(inspectRecoveryGmailCaptureAdmission(input).status).toBe(
    "capture-partial"
  );
  const refused = journal();
  // The source checkpoint digest includes the old production expiry. Its
  // documented restored-runtime normalization is expiresAtEpochMs = 0.
  expect(withoutDigest(refused)).toEqual(withoutDigest(baseline));

  const report = await resumeOperatorRecoveryGmailBatch(input);
  expect(report).toMatchObject({
    status: "capture-complete",
    activationAllowed: false,
    captureAllowed: false,
  });
  const completed = journal();
  for (const evidence of baseline.intakeEvidence)
    expect(completed.intakeEvidence).toContainEqual(evidence);
  expect(completed.runState).toEqual(baseline.runState);
  expect(completed.stageArtifacts).toEqual(baseline.stageArtifacts);
  expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(report);
  expect(journal()).toEqual(completed);
  failed = false;
});
