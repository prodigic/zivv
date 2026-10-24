import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  inspectRecoveryGmailCaptureAdmission,
  type CaptureInterruption,
  type RecoveryGmailCaptureInput,
} from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import {
  resumeOperatorRecoveryGmailBatch,
  resumeOperatorRecoveryGmailBatchForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureRuntimeFixture,
  type RecoveryGmailCaptureRuntimeFixture,
} from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const orderedCapturePoints = [
  "intake-raw-stage-flushed",
  "intake-raw-published",
  "intake-source-stage-flushed",
  "intake-source-published",
  "intake-receipt-stage-flushed",
  "intake-receipt-published",
  "intake-manifest-stage-flushed",
  "intake-manifest-published",
] as const satisfies readonly CaptureInterruption[];
const pointKinds = {
  "intake-raw-stage-flushed": "raw",
  "intake-raw-published": "raw",
  "intake-source-stage-flushed": "source",
  "intake-source-published": "source",
  "intake-receipt-stage-flushed": "receipt",
  "intake-receipt-published": "receipt",
  "intake-manifest-stage-flushed": "manifest",
  "intake-manifest-published": "manifest",
} as const;

interface ActiveFixture {
  fixture: RecoveryGmailCaptureRuntimeFixture;
  input: RecoveryGmailCaptureInput;
}
interface Candidate {
  stage: string;
  target: string;
  bytes: Buffer;
  dev: number;
  ino: number;
}
type JournalSnapshot = ReturnType<typeof validateWeeklyJournalRecoverySnapshot>;
interface CapturedReceipt {
  accountSha256: string;
  messageId: string;
  rawSha256: string;
  receivedAtEpochMs: number;
  receiptId: string;
  sourceSha256: string;
}

function journal(input: RecoveryGmailCaptureInput) {
  return validateWeeklyJournalRecoverySnapshot(
    readWeeklyJournalRecoverySnapshotReadOnly(
      join(input.destination, "operator/weekly-runs.sqlite")
    )
  );
}

function preparedJournal(input: RecoveryGmailCaptureInput): JournalSnapshot {
  const checkpoint = openPreparedRuntimeForAdmission(input).checkpoint;
  return validateWeeklyJournalRecoverySnapshot(
    Buffer.from(checkpoint.journal, "base64")
  );
}

function intakeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? intakeFiles(path)
      : entry.isFile()
        ? [path]
        : [];
  });
}

function stages(root: string): string[] {
  return intakeFiles(root).filter((path) => path.endsWith(".tmp"));
}

function targetForStage(stage: string): string {
  const target = stage.replace(/\.\d+\.[a-f0-9]{16}\.tmp$/, "");
  if (target === stage) throw new Error("Unrecognized intake stage filename");
  return target;
}

function sourceRowForMessage(
  input: RecoveryGmailCaptureInput,
  messageId: string
) {
  return journal(input).intakeEvidence.find((row) => {
    if (row.kind !== "source") return false;
    const receipt = JSON.parse(
      Buffer.from(row.bytes, "base64").toString("utf8")
    ) as { messageId?: string };
    return receipt.messageId === messageId;
  });
}

function sourceRowForMessageIn(snapshot: JournalSnapshot, messageId: string) {
  return snapshot.intakeEvidence.find((row) => {
    if (row.kind !== "source") return false;
    const receipt = JSON.parse(
      Buffer.from(row.bytes, "base64").toString("utf8")
    ) as { messageId?: string };
    return receipt.messageId === messageId;
  });
}

function originalIntakeFiles(
  input: RecoveryGmailCaptureInput
): Map<string, Buffer> {
  const root = join(input.destination, "operator/email-intake");
  return new Map(
    intakeFiles(root).map((path) => [relative(root, path), readFileSync(path)])
  );
}

function expectOriginalFilesPreserved(
  input: RecoveryGmailCaptureInput,
  original: Map<string, Buffer>
): void {
  const root = join(input.destination, "operator/email-intake");
  for (const [path, bytes] of original)
    expect(readFileSync(join(root, path))).toEqual(bytes);
}

async function createActiveFixture(
  reviewSecondMessage = false
): Promise<ActiveFixture> {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture(
    reviewSecondMessage ? { reviewSecondMessage: true } : undefined
  );
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

async function interrupt(
  active: ActiveFixture,
  point: CaptureInterruption
): Promise<void> {
  await expect(
    resumeOperatorRecoveryGmailBatchForTest(active.input, point)
  ).rejects.toMatchObject({
    message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
    cause: { message: "RECOVERY_GMAIL_CAPTURE_TEST_INTERRUPTION" },
  });
  expect(
    (await inspectRecoveryGmailCaptureAdmission(active.input)).status
  ).toBe("capture-partial");
}

function expectOneFlushedCandidate(active: ActiveFixture): Candidate {
  const intakeRoot = join(active.input.destination, "operator/email-intake");
  const found = stages(intakeRoot);
  expect(found).toHaveLength(1);
  const stage = found[0]!;
  const info = lstatSync(stage);
  expect(info.isFile()).toBe(true);
  expect(info.nlink).toBe(1);
  return {
    stage,
    target: targetForStage(stage),
    bytes: readFileSync(stage),
    dev: info.dev,
    ino: info.ino,
  };
}

function expectedCandidate(
  active: ActiveFixture,
  kind: "raw" | "source" | "receipt" | "manifest" | "approval",
  snapshot: JournalSnapshot
): { target: string; bytes?: Buffer; sha256?: string } {
  const sourceRow = sourceRowForMessageIn(snapshot, "b1");
  if (!sourceRow) throw new Error("Missing journaled b1 source evidence");
  const receipt = JSON.parse(
    Buffer.from(sourceRow.bytes, "base64").toString("utf8")
  ) as CapturedReceipt;
  const body = join(
    active.input.destination,
    "operator/email-intake",
    receipt.accountSha256,
    "bodies",
    sourceRow.id
  );
  const message = join(
    active.input.destination,
    "operator/email-intake",
    receipt.accountSha256,
    "messages",
    sha256(receipt.messageId)
  );
  switch (kind) {
    case "raw":
      return {
        target: join(message, "message.eml"),
        sha256: receipt.rawSha256,
      };
    case "source":
      return {
        target: join(body, "source.txt"),
        sha256: receipt.sourceSha256,
      };
    case "receipt":
      return {
        target: join(body, "receipt.json"),
        bytes: Buffer.from(sourceRow.bytes, "base64"),
      };
    case "manifest":
      return {
        target: join(message, "capture.json"),
        bytes: Buffer.from(
          canonicalJson({
            schemaVersion: 1,
            messageId: receipt.messageId,
            accountSha256: receipt.accountSha256,
            rawSha256: receipt.rawSha256,
            sourceSha256: receipt.sourceSha256,
            receiptId: receipt.receiptId,
            receivedAtEpochMs: receipt.receivedAtEpochMs,
          }) + "\n"
        ),
      };
    case "approval": {
      const approval = snapshot.intakeEvidence.find(
        (row) =>
          row.kind === "correction" &&
          row.scope === sourceRow.scope &&
          row.id === sourceRow.id
      );
      if (!approval) throw new Error("Missing journaled correction evidence");
      return {
        target: join(body, "correction-approval.json"),
        bytes: Buffer.from(approval.bytes, "base64"),
      };
    }
  }
}

function expectCandidateMatches(
  candidate: Candidate,
  expected: { target: string; bytes?: Buffer; sha256?: string }
): void {
  expect(candidate.target).toBe(expected.target);
  if (expected.bytes) expect(candidate.bytes).toEqual(expected.bytes);
  if (expected.sha256) expect(sha256(candidate.bytes)).toBe(expected.sha256);
}

function expectPublishedCandidate(candidate: Candidate): void {
  const stageInfo = lstatSync(candidate.stage);
  const targetInfo = lstatSync(candidate.target);
  expect(readFileSync(candidate.target)).toEqual(candidate.bytes);
  expect(readFileSync(candidate.stage)).toEqual(candidate.bytes);
  expect(stageInfo.dev).toBe(candidate.dev);
  expect(stageInfo.ino).toBe(candidate.ino);
  expect(targetInfo.dev).toBe(candidate.dev);
  expect(targetInfo.ino).toBe(candidate.ino);
  expect(stageInfo.nlink).toBe(2);
  expect(targetInfo.nlink).toBe(2);
}

function assertActiveFixture(
  active: ActiveFixture | undefined
): asserts active is ActiveFixture {
  if (!active) throw new Error("Missing retained runtime fixture");
}

function expectPinnedJournal(
  input: RecoveryGmailCaptureInput,
  before: ReturnType<typeof journal>
): void {
  const now = journal(input);
  expect(now.runState).toEqual(before.runState);
  expect(now.stageArtifacts).toEqual(before.stageArtifacts);
}

describe.sequential("canonical retained Gmail capture file checkpoints", () => {
  let active: ActiveFixture | undefined;
  let failure = false;
  let priorPublished: Candidate | undefined;
  let journalBefore: ReturnType<typeof journal>;
  let originals = new Map<string, Buffer>();
  let ledgerBefore: Buffer;
  let sourceBytes = "";
  let firstObservedAtEpochMs = 0;

  beforeAll(async () => {
    try {
      active = await createActiveFixture();
      journalBefore = preparedJournal(active.input);
      originals = originalIntakeFiles(active.input);
      ledgerBefore = readFileSync(
        join(active.input.destination, "operator/ledger.sqlite")
      );
    } catch (error) {
      failure = true;
      throw error;
    }
  }, 180_000);

  afterAll(() => {
    if (!active) return;
    if (failure)
      console.error(
        `Preserved failed canonical-file fixture at ${active.fixture.base}`
      );
    active.fixture.cleanup(failure);
  });

  for (let index = 0; index < orderedCapturePoints.length; index += 1) {
    const point = orderedCapturePoints[index]!;
    it(
      point,
      async ({ skip }) => {
        if (failure || !active) skip();
        assertActiveFixture(active);
        try {
          if (point.endsWith("stage-flushed")) {
            const previous = priorPublished;
            await interrupt(active, point);
            if (previous) {
              expect(existsSync(previous.stage)).toBe(false);
              expect(lstatSync(previous.target).nlink).toBe(1);
            }
            const candidate = expectOneFlushedCandidate(active);
            expect(existsSync(candidate.target)).toBe(false);
            const currentJournal = journal(active.input);
            const source = sourceRowForMessageIn(currentJournal, "b1");
            if (!source) throw new Error("Missing committed b1 source receipt");
            expectCandidateMatches(
              candidate,
              expectedCandidate(active, pointKinds[point], currentJournal)
            );
            if (!sourceBytes) {
              sourceBytes = source.bytes;
              const parsed = JSON.parse(
                Buffer.from(source.bytes, "base64").toString("utf8")
              ) as { firstObservedAtEpochMs: number };
              firstObservedAtEpochMs = parsed.firstObservedAtEpochMs;
            }
            priorPublished = candidate;
          } else {
            const candidate = priorPublished;
            if (!candidate)
              throw new Error("Missing matching flushed candidate");
            await interrupt(active, point);
            expectPublishedCandidate(candidate);
            priorPublished = candidate;
          }
          expectPinnedJournal(active.input, journalBefore);
          expectOriginalFilesPreserved(active.input, originals);
          expect(
            readFileSync(
              join(active.input.destination, "operator/ledger.sqlite")
            )
          ).toEqual(ledgerBefore);
          if (sourceBytes) {
            const source = sourceRowForMessage(active.input, "b1");
            expect(source?.bytes).toBe(sourceBytes);
            const parsed = JSON.parse(
              Buffer.from(source!.bytes, "base64").toString("utf8")
            ) as { firstObservedAtEpochMs: number };
            expect(parsed.firstObservedAtEpochMs).toBe(firstObservedAtEpochMs);
          }
        } catch (error) {
          failure = true;
          throw error;
        }
      },
      180_000
    );
  }

  it("completes capture and replays without a new lease or file change", async ({
    skip,
  }) => {
    if (failure || !active) skip();
    assertActiveFixture(active);
    try {
      const previous = priorPublished;
      const report = await resumeOperatorRecoveryGmailBatch(active.input);
      if (previous) {
        expect(existsSync(previous.stage)).toBe(false);
        expect(lstatSync(previous.target).nlink).toBe(1);
      }
      expect(report.status).toBe("capture-complete");
      expect(report.receipts).toHaveLength(2);
      expect(
        report.receipts.every((receipt) => receipt.disposition === "ready")
      ).toBe(true);
      expect(
        stages(join(active.input.destination, "operator/email-intake"))
      ).toEqual([]);
      expectPinnedJournal(active.input, journalBefore);
      expectOriginalFilesPreserved(active.input, originals);
      const beforeReplay = journal(active.input);
      expect(await resumeOperatorRecoveryGmailBatch(active.input)).toEqual(
        report
      );
      expect(journal(active.input)).toEqual(beforeReplay);
    } catch (error) {
      failure = true;
      throw error;
    }
  }, 180_000);
});

describe.sequential("canonical approval evidence capture checkpoints", () => {
  let active: ActiveFixture | undefined;
  let failure = false;
  let candidate: Candidate | undefined;
  let baseline: ReturnType<typeof journal>;
  let originalFiles = new Map<string, Buffer>();
  let ledgerBefore: Buffer;
  let reviewSourceBytes = "";
  let reviewFirstObservedAtEpochMs = 0;
  let approvalBytes = "";
  let approvedAtEpochMs: number | undefined;

  beforeAll(async () => {
    try {
      active = await createActiveFixture(true);
      baseline = preparedJournal(active.input);
      originalFiles = originalIntakeFiles(active.input);
      ledgerBefore = readFileSync(
        join(active.input.destination, "operator/ledger.sqlite")
      );
      const review = sourceRowForMessageIn(baseline, "b1");
      if (!review)
        throw new Error("Missing retained review-required b1 receipt");
      reviewSourceBytes = review.bytes;
      const reviewReceipt = JSON.parse(
        Buffer.from(review.bytes, "base64").toString("utf8")
      ) as { disposition: string; firstObservedAtEpochMs: number };
      expect(reviewReceipt.disposition).toBe("review-required");
      reviewFirstObservedAtEpochMs = reviewReceipt.firstObservedAtEpochMs;
      expect(
        baseline.intakeEvidence.some(
          (row) => row.kind === "correction" && row.id === review.id
        )
      ).toBe(false);
    } catch (error) {
      failure = true;
      throw error;
    }
  }, 180_000);

  afterAll(() => {
    if (!active) return;
    if (failure)
      console.error(
        `Preserved failed approval-checkpoint fixture at ${active.fixture.base}`
      );
    active.fixture.cleanup(failure);
  });

  it("approval stage flushed", async ({ skip }) => {
    if (failure || !active) skip();
    assertActiveFixture(active);
    try {
      await interrupt(active, "intake-approval-stage-flushed");
      candidate = expectOneFlushedCandidate(active);
      expect(existsSync(candidate.target)).toBe(false);
      const currentJournal = journal(active.input);
      expectCandidateMatches(
        candidate,
        expectedCandidate(active, "approval", currentJournal)
      );
      const approval = currentJournal.intakeEvidence.find(
        (row) => row.kind === "correction"
      );
      expect(approval).toBeDefined();
      approvalBytes = approval!.bytes;
      const parsed = JSON.parse(
        Buffer.from(approvalBytes, "base64").toString("utf8")
      ) as { approvedAtEpochMs: number };
      approvedAtEpochMs = parsed.approvedAtEpochMs;
    } catch (error) {
      failure = true;
      throw error;
    }
  }, 180_000);

  it("approval stage is linked to the canonical path", async ({ skip }) => {
    if (failure || !active) skip();
    assertActiveFixture(active);
    try {
      if (!candidate) throw new Error("Missing flushed approval candidate");
      await interrupt(active, "intake-approval-published");
      expectPublishedCandidate(candidate);
      const approval = journal(active.input).intakeEvidence.find(
        (row) => row.kind === "correction"
      );
      expect(approval?.bytes).toBe(approvalBytes);
      const parsed = JSON.parse(
        Buffer.from(approval!.bytes, "base64").toString("utf8")
      ) as { approvedAtEpochMs: number };
      expect(parsed.approvedAtEpochMs).toBe(approvedAtEpochMs);
      const review = sourceRowForMessage(active.input, "b1");
      expect(review?.bytes).toBe(reviewSourceBytes);
      const reviewReceipt = JSON.parse(
        Buffer.from(review!.bytes, "base64").toString("utf8")
      ) as { firstObservedAtEpochMs: number };
      expect(reviewReceipt.firstObservedAtEpochMs).toBe(
        reviewFirstObservedAtEpochMs
      );
      expectPinnedJournal(active.input, baseline);
      expectOriginalFilesPreserved(active.input, originalFiles);
      expect(
        readFileSync(join(active.input.destination, "operator/ledger.sqlite"))
      ).toEqual(ledgerBefore);
    } catch (error) {
      failure = true;
      throw error;
    }
  }, 180_000);

  it("completes approval capture and replays without changing its receipt", async ({
    skip,
  }) => {
    if (failure || !active) skip();
    assertActiveFixture(active);
    try {
      const previous = candidate;
      const report = await resumeOperatorRecoveryGmailBatch(active.input);
      if (previous) {
        expect(existsSync(previous.stage)).toBe(false);
        expect(lstatSync(previous.target).nlink).toBe(1);
      }
      expect(report.status).toBe("capture-complete");
      expect(report.receipts).toHaveLength(2);
      expect(
        report.receipts.every((receipt) => receipt.disposition === "ready")
      ).toBe(true);
      expect(
        stages(join(active.input.destination, "operator/email-intake"))
      ).toEqual([]);
      const approval = journal(active.input).intakeEvidence.find(
        (row) => row.kind === "correction"
      );
      expect(approval?.bytes).toBe(approvalBytes);
      expect(sourceRowForMessage(active.input, "b1")?.bytes).toBe(
        reviewSourceBytes
      );
      const review = sourceRowForMessage(active.input, "b1");
      const reviewReceipt = JSON.parse(
        Buffer.from(review!.bytes, "base64").toString("utf8")
      ) as { firstObservedAtEpochMs: number };
      expect(reviewReceipt.firstObservedAtEpochMs).toBe(
        reviewFirstObservedAtEpochMs
      );
      expectPinnedJournal(active.input, baseline);
      expectOriginalFilesPreserved(active.input, originalFiles);
      expect(
        readFileSync(join(active.input.destination, "operator/ledger.sqlite"))
      ).toEqual(ledgerBefore);
      const beforeReplay = journal(active.input);
      expect(await resumeOperatorRecoveryGmailBatch(active.input)).toEqual(
        report
      );
      expect(journal(active.input)).toEqual(beforeReplay);
    } catch (error) {
      failure = true;
      throw error;
    }
  }, 180_000);
});
