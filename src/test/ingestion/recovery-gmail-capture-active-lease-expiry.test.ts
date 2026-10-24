import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
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
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { listRetainedSteveEmailSources } from "../../lib/ingestion/steve-email-intake.js";
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
let journalIdentity: ReturnType<typeof lstatSync> | undefined;
let failed = true;

const journalPath = () =>
  join(input.destination, "operator/weekly-runs.sqlite");
function journal() {
  return validateWeeklyJournalRecoverySnapshot(
    readWeeklyJournalRecoverySnapshotReadOnly(journalPath())
  );
}
function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
function expectedLeaseOwner(
  admission: Buffer,
  messageId: string,
  fence: number
) {
  const digest = sha256(
    canonicalJson([
      "zivv-recovery-gmail-capture-lease/v1",
      sha256(admission),
      messageId,
      fence,
    ])
  );
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
function withoutDigestAndOwnership(
  snapshot: ReturnType<typeof validateWeeklyJournalRecoverySnapshot>
) {
  const { digest, ownership, ...logical } = snapshot;
  void digest;
  void ownership;
  return logical;
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
  // Use the signed checkpoint for the pre-intent journal and physical baseline;
  // do not open a SQL reader before capture admission.
  opened = openPreparedRuntimeForAdmission(input);
  physicalBaseline = opened.inventory();
  journalIdentity = lstatSync(journalPath());
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
    console.error(`Preserved active-lease-expiry fixture at ${fixture.base}`);
  fixture?.cleanup(failed);
});

it("observes real active-lease expiry at source, preserves fenced cleanup, then retries and replays", async () => {
  const startedAt = Date.now();
  await expect(
    resumeOperatorRecoveryGmailBatchForTest(
      input,
      "lease-expires-before-source"
    )
  ).rejects.toMatchObject({
    message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
    cause: { message: "RECOVERY_GMAIL_CAPTURE_SOURCE_EXPIRY_OBSERVED" },
  });

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
  expect(existsSync(admissionPath)).toBe(true);
  expect(existsSync(keyPath)).toBe(true);
  expect(existsSync(resultPath)).toBe(false);
  // Pin all original non-journal inventory entries and enumerate the only
  // permitted new paths before any additional SQL inspection.
  const afterExpiryInventory = opened.inventory();
  const mutableJournalPaths = new Set([
    "operator/weekly-runs.sqlite",
    "operator/weekly-runs.sqlite-wal",
    "operator/weekly-runs.sqlite-shm",
  ]);
  const originalPaths = new Set(physicalBaseline.map((entry) => entry.path));
  expect(
    afterExpiryInventory.filter(
      (entry) =>
        originalPaths.has(entry.path) && !mutableJournalPaths.has(entry.path)
    )
  ).toEqual(
    physicalBaseline.filter((entry) => !mutableJournalPaths.has(entry.path))
  );
  const originalJournalIdentity = journalIdentity;
  if (!originalJournalIdentity)
    throw new Error("Missing pre-admission journal identity");
  const currentJournalStat = lstatSync(journalPath());
  expect(currentJournalStat.isFile()).toBe(true);
  expect(currentJournalStat.isSymbolicLink()).toBe(false);
  expect(currentJournalStat.dev).toBe(originalJournalIdentity.dev);
  expect(currentJournalStat.ino).toBe(originalJournalIdentity.ino);
  expect(currentJournalStat.nlink).toBe(originalJournalIdentity.nlink);
  expect(currentJournalStat.mode).toBe(originalJournalIdentity.mode);
  for (const path of [
    "operator/weekly-runs.sqlite-wal",
    "operator/weekly-runs.sqlite-shm",
  ]) {
    const entry = afterExpiryInventory.find((item) => item.path === path);
    if (!entry) continue;
    expect(entry.kind).toBe("file");
    const stat = lstatSync(join(input.destination, path));
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.nlink).toBe(1);
    if (path.endsWith("-shm")) expect(stat.size).toBe(32768);
  }
  const added = afterExpiryInventory
    .filter((entry) => !originalPaths.has(entry.path))
    .map(({ path, kind }) => ({ path, kind }))
    .filter(({ path }) => !mutableJournalPaths.has(path));
  expect(added).toEqual(
    [
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
      {
        path: `recovery-gmail-capture/${input.batchId}/key-stage`,
        kind: "directory",
      },
      {
        path: `operator/${process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"}`,
        kind: "file",
      },
    ].sort((left, right) => left.path.localeCompare(right.path))
  );

  expect(inspectRecoveryGmailCaptureAdmission(input).status).toBe(
    "capture-partial"
  );
  const afterExpiry = journal();
  expect(withoutDigestAndOwnership(afterExpiry)).toEqual(
    withoutDigestAndOwnership(baseline)
  );
  const beforeOwner = baseline.ownership.find(
    (row) => row.scope === "prodigic/zivv/production"
  );
  expect(beforeOwner).toBeDefined();
  const admission = readFileSync(admissionPath);
  const observedOwner = afterExpiry.ownership.find(
    (row) => row.scope === "prodigic/zivv/production"
  );
  expect(observedOwner).toBeDefined();
  expect(observedOwner).toMatchObject({
    owner: expectedLeaseOwner(admission, "b1", beforeOwner!.fence + 1),
    fence: beforeOwner!.fence + 1,
  });
  expect(observedOwner!.expiresAtEpochMs).toBeGreaterThan(startedAt);
  expect(observedOwner!.expiresAtEpochMs).toBeLessThanOrEqual(Date.now());
  expect(
    afterExpiry.ownership.filter(
      (row) => row.scope !== "prodigic/zivv/production"
    )
  ).toEqual(
    baseline.ownership.filter((row) => row.scope !== "prodigic/zivv/production")
  );

  const retainedAfterFailure = listRetainedSteveEmailSources({
    operatorDirectory: join(input.destination, "operator"),
    accountId: "capture-runtime@fixture.invalid",
    expectedEditionId: fixture!.sourceReceipts[0]!.receipt.editionId,
  });
  expect(retainedAfterFailure.map(({ receipt }) => receipt.messageId)).toEqual([
    "a1",
  ]);
  expect(
    retainedAfterFailure.some(({ receipt }) => receipt.messageId === "b1")
  ).toBe(false);

  const retryStartedAt = Date.now();
  const report = await resumeOperatorRecoveryGmailBatch(input);
  expect(report).toMatchObject({
    status: "capture-complete",
    activationAllowed: false,
    captureAllowed: false,
  });
  expect(report.receipts).toHaveLength(2);
  expect(
    report.receipts.every((receipt) => receipt.disposition === "ready")
  ).toBe(true);
  const completed = journal();
  const captured = listRetainedSteveEmailSources({
    operatorDirectory: join(input.destination, "operator"),
    accountId: "capture-runtime@fixture.invalid",
    expectedEditionId: fixture!.sourceReceipts[0]!.receipt.editionId,
  });
  const nextReceipt = captured.find(
    ({ receipt }) => receipt.messageId === "b1"
  );
  expect(nextReceipt).toBeDefined();
  expect(nextReceipt!.receipt.firstObservedAtEpochMs).toBeGreaterThanOrEqual(
    retryStartedAt
  );
  expect(
    completed.ownership.find((row) => row.scope === "prodigic/zivv/production")
      ?.fence
  ).toBe(beforeOwner!.fence + 2);
  expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(report);
  expect(journal()).toEqual(completed);
  failed = false;
});
