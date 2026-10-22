import { lstatSync, readFileSync, readdirSync } from "node:fs";
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
import type { SteveEmailReceipt } from "../../lib/ingestion/steve-email-intake.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureRuntimeFixture,
  type RecoveryGmailCaptureRuntimeFixture,
} from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

// The launcher owns a 150-second hard stop; this composed case allows its two
// sequential launches to finish before Vitest can abandon either child.
vi.setConfig({ testTimeout: 360_000, hookTimeout: 180_000 });
let fixture: RecoveryGmailCaptureRuntimeFixture | undefined;
let failed = true;
let input: RecoveryGmailCaptureInput;
let baseline: ReturnType<typeof validateWeeklyJournalRecoverySnapshot>;
beforeAll(async () => {
  fixture = await createRecoveryGmailCaptureRuntimeFixture();
  input = {
    ...fixture.input,
    batchId: fixture.batchIds[0]!,
    correctionOfByMessageId: {
      b1: fixture.sourceReceipts[0]!.receipt.receiptId,
    },
  };
  // Reading SQLite before intent would create sidecars and change the signed
  // prepared tree. The authenticated checkpoint supplies this baseline.
  baseline = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(
      openPreparedRuntimeForAdmission(input).checkpoint.journal,
      "base64"
    )
  );
});
afterAll(() => {
  if (failed && fixture)
    console.error(
      `Preserved failed rename-publication fixture at ${fixture.base}`
    );
  fixture?.cleanup(failed);
});

function journal() {
  return validateWeeklyJournalRecoverySnapshot(
    readWeeklyJournalRecoverySnapshotReadOnly(
      join(input.destination, "operator/weekly-runs.sqlite")
    )
  );
}

it("retries an actual rename publication with no orphan alias and preserves its canonical inode", async () => {
  await expect(
    resumeOperatorRecoveryGmailBatchForTest(input, "intake-raw-published")
  ).rejects.toMatchObject({
    message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
    cause: { message: "RECOVERY_GMAIL_CAPTURE_TEST_INTERRUPTION" },
  });
  expect(inspectRecoveryGmailCaptureAdmission(input).status).toBe(
    "capture-partial"
  );
  const partial = journal();
  const source = partial.intakeEvidence.find((row) => {
    if (row.kind !== "source") return false;
    const receipt = JSON.parse(
      Buffer.from(row.bytes, "base64").toString("utf8")
    ) as SteveEmailReceipt;
    return receipt.messageId === "b1";
  });
  expect(source).toBeDefined();
  const receipt = JSON.parse(
    Buffer.from(source!.bytes, "base64").toString("utf8")
  ) as SteveEmailReceipt;
  const messageDirectory = join(
    input.destination,
    "operator/email-intake",
    receipt.accountSha256,
    "messages",
    sha256(receipt.messageId)
  );
  const rawPath = join(messageDirectory, "message.eml");
  const original = lstatSync(rawPath);
  const bytes = readFileSync(rawPath);
  expect(original.nlink).toBe(1);
  expect(sha256(bytes)).toBe(receipt.rawSha256);
  expect(
    readdirSync(messageDirectory).filter((name) => name.endsWith(".tmp"))
  ).toEqual([]);
  expect(partial.runState).toEqual(baseline.runState);
  expect(partial.stageArtifacts).toEqual(baseline.stageArtifacts);

  const report = await resumeOperatorRecoveryGmailBatch(input);
  expect(report.status).toBe("capture-complete");
  expect(report.receipts).toHaveLength(2);
  expect(report.receipts.every((item) => item.disposition === "ready")).toBe(
    true
  );
  expect(lstatSync(rawPath).ino).toBe(original.ino);
  expect(lstatSync(rawPath).dev).toBe(original.dev);
  expect(lstatSync(rawPath).nlink).toBe(1);
  expect(readFileSync(rawPath)).toEqual(bytes);
  expect(
    journal().intakeEvidence.find(
      (row) => row.kind === "source" && row.id === source!.id
    )?.bytes
  ).toBe(source!.bytes);
  const beforeReplay = journal();
  expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(report);
  expect(journal()).toEqual(beforeReplay);
  failed = false;
});
