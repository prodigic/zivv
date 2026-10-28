import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createRecoveryGmailCaptureAdmission,
  createRecoveryGmailCaptureResult,
  proveRecoveryGmailSelectedReceipt,
  type RecoveryGmailCaptureAdmissionInput,
  type RecoveryGmailCaptureFamilyInput,
  type RecoveryGmailCaptureDeltaInput,
} from "../../lib/ingestion/recovery-gmail-capture-admission-proof.js";
import { proveRecoveryGmailBatchInventory } from "../../lib/ingestion/recovery-gmail-batch-proof.js";
import { selectSteveEmailPlaintext } from "../../lib/ingestion/steve-email-intake.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureAdmissionFixture,
  type RecoveryGmailCaptureAdmissionFixture,
} from "./fixtures/recovery-gmail-capture-admission-fixture.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });
let fixture: RecoveryGmailCaptureAdmissionFixture;
function intent(
  f: RecoveryGmailCaptureAdmissionFixture,
  review = false
): RecoveryGmailCaptureAdmissionInput {
  return {
    checkpoint: f.checkpoint,
    recoveryKey: f.recoveryKey,
    binding: {
      capsuleSha256: "1".repeat(64),
      retirementSha256: "2".repeat(64),
      checkpointSha256: "3".repeat(64),
      preparedReceiptSha256: "4".repeat(64),
      preparedTreeSha256: "5".repeat(64),
      preparedImmutableTreeSha256: "6".repeat(64),
      physicalRoot: f.physicalRoot,
      physicalOperatorDirectory: f.physicalOperatorDirectory,
      physicalNpmPath:
        f.physicalRoot +
        (f.physicalRoot.includes("\\")
          ? "\\npm\\npm-cli.js"
          : "/npm/npm-cli.js"),
      keyId: sha256(f.recoveryKey),
    },
    batchId: f.batchIds[0],
    ...(review ? {} : { correctionOfByMessageId: f.correctionOfByMessageId }),
    admittedAtEpochMs: f.admittedAtEpochMs,
    unfinishedAdmissions: [],
  };
}
function owner(current: RecoveryGmailCaptureFamilyInput["current"]) {
  return validateWeeklyJournalRecoverySnapshot(
    Buffer.from(current.journal, "base64")
  ).ownership.find((row) => row.scope === "prodigic/zivv/production")!;
}
function family(
  f = fixture,
  current: RecoveryGmailCaptureFamilyInput["current"] = f.checkpoint
): RecoveryGmailCaptureFamilyInput {
  return {
    checkpoint: f.checkpoint,
    recoveryKey: f.recoveryKey,
    completed: [],
    unfinishedAdmissions: [],
    current,
  };
}
function selector(f: RecoveryGmailCaptureAdmissionFixture, messageId: string) {
  const batch = proveRecoveryGmailBatchInventory({
    checkpoint: f.checkpoint,
    recoveryKey: f.recoveryKey,
  }).batches.find((item) =>
    item.batch.snapshots.some(
      (snapshot) => snapshot.rawMessage.id === messageId
    )
  )!.batch;
  const snapshot = batch.snapshots.find(
    (item) => item.rawMessage.id === messageId
  )!;
  return {
    batchId: batch.batchId,
    messageId,
    rawSha256: sha256(Buffer.from(snapshot.rawMessage.raw, "base64url")),
    receiptId: sha256(
      canonicalJson([
        batch.accountSha256,
        batch.expectedEditionId,
        sha256(selectSteveEmailPlaintext(snapshot.fullMessage.payload).source),
      ])
    ),
  };
}
function completed(f = fixture, review = false) {
  const admission = createRecoveryGmailCaptureAdmission(intent(f, review));
  const delta: RecoveryGmailCaptureDeltaInput = {
    checkpoint: f.checkpoint,
    recoveryKey: f.recoveryKey,
    admission,
    unfinishedAdmissions: [admission],
    current: f.currentAfterFirstCapture,
    ownProductionOwnership: owner(f.currentAfterFirstCapture),
  };
  return { admission, result: createRecoveryGmailCaptureResult(delta) };
}
beforeAll(async () => {
  fixture = await createRecoveryGmailCaptureAdmissionFixture({
    duplicateOriginal: true,
  });
});
afterAll(() => fixture?.cleanup());

it("selects an original ready receipt and retains all other pending batch obligations", () => {
  const result = proveRecoveryGmailSelectedReceipt({
    ...family(),
    selector: selector(fixture, "a1"),
  });
  expect(result).toMatchObject({
    activationAllowed: false,
    captureAllowed: false,
    loadAllowed: false,
    physicalValidationRequired: true,
    source: {
      editionId: "2026-10-16",
      deliveryId: "gmail-" + result.receipt.receiptId,
      importObservedAtEpochMs: result.receipt.firstObservedAtEpochMs,
    },
  });
  expect(
    result.obligations
      .filter((item) => item.status === "capture-pending")
      .map((item) => item.messageId)
      .sort()
  ).toEqual(["b1", "c1"]);
  expect(result.source.sourceSha256).not.toBe(result.selector.rawSha256);
  expect(result.selectionSha256).toBe(
    proveRecoveryGmailSelectedReceipt({
      ...family(),
      selector: selector(fixture, "a1"),
    }).selectionSha256
  );
});
it("binds a duplicate's own RAW and manifest while preserving the primary canonical receipt", () => {
  const first = proveRecoveryGmailSelectedReceipt({
    ...family(),
    selector: selector(fixture, "a1"),
  });
  const duplicate = proveRecoveryGmailSelectedReceipt({
    ...family(),
    selector: selector(fixture, "a2"),
  });
  expect(duplicate.receipt).toEqual(first.receipt);
  expect(duplicate.source).toEqual(first.source);
  expect(duplicate.selector.rawSha256).not.toBe(first.selector.rawSha256);
  expect(duplicate.selectionSha256).not.toBe(first.selectionSha256);
  expect(
    duplicate.canonicalEvidence.some((item) => item.path.includes(sha256("a2")))
  ).toBe(true);
});
it("selects a later corrected receipt only with the exact complete family and canonical ancestor files", () => {
  const result = proveRecoveryGmailSelectedReceipt({
    ...family(fixture, fixture.currentAfterFirstCapture),
    completed: [completed()],
    selector: selector(fixture, "b1"),
  });
  expect(result.receipt.correctionOf).toBe(selector(fixture, "a1").receiptId);
  expect(
    result.canonicalEvidence.filter((item) =>
      item.path.endsWith("/receipt.json")
    )
  ).toHaveLength(2);
  expect(
    result.obligations.find((item) => item.messageId === "c1")?.status
  ).toBe("capture-pending");
  expect(() =>
    proveRecoveryGmailSelectedReceipt({
      ...family(fixture, fixture.currentAfterFirstCapture),
      selector: selector(fixture, "b1"),
    })
  ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_RECEIPT_PROOF");
});
it("selects the final authenticated batch after validating both completed predecessors", () => {
  const first = completed();
  const admission = createRecoveryGmailCaptureAdmission({
    ...intent(fixture),
    batchId: fixture.batchIds[1],
    correctionOfByMessageId: undefined,
    admittedAtEpochMs: fixture.secondAdmittedAtEpochMs,
    priorCompleted: [first],
  });
  const result = createRecoveryGmailCaptureResult({
    checkpoint: fixture.checkpoint,
    recoveryKey: fixture.recoveryKey,
    admission,
    priorCompleted: [first],
    unfinishedAdmissions: [admission],
    current: fixture.currentAfterCapture,
    ownProductionOwnership: owner(fixture.currentAfterCapture),
  });
  const selected = proveRecoveryGmailSelectedReceipt({
    ...family(fixture, fixture.currentAfterCapture),
    completed: [first, { admission, result }],
    selector: selector(fixture, "c1"),
  });
  expect(selected.selector.messageId).toBe("c1");
  expect(selected.obligations).toHaveLength(4);
  expect(selected.obligations.every((item) => item.status === "ready")).toBe(
    true
  );
  expect(selected.receipt.accountSha256).not.toBe(
    proveRecoveryGmailSelectedReceipt({
      ...family(),
      selector: selector(fixture, "a1"),
    }).receipt.accountSha256
  );
});

it("keeps journal-first missing canonical files pending while allowing an unrelated original ready receipt", () => {
  const admission = createRecoveryGmailCaptureAdmission(intent(fixture));
  const args = {
    ...family(fixture, fixture.sourceJournalOnly),
    unfinishedAdmissions: [admission],
    ownProductionOwnership: owner(fixture.sourceJournalOnly),
  };
  const result = proveRecoveryGmailSelectedReceipt({
    ...args,
    selector: selector(fixture, "a1"),
  });
  expect(
    result.obligations.find((item) => item.messageId === "b1")?.status
  ).toBe("capture-pending");
  expect(() =>
    proveRecoveryGmailSelectedReceipt({
      ...args,
      selector: selector(fixture, "b1"),
    })
  ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_RECEIPT_PROOF");
});
it("refuses wrong batch/message/RAW/receipt, plaintext substituted for RAW, and unknown selector controls", () => {
  const valid = selector(fixture, "a1");
  for (const change of [
    { batchId: fixture.batchIds[0] },
    { messageId: "b1" },
    { rawSha256: "f".repeat(64) },
    { receiptId: "f".repeat(64) },
    {
      rawSha256: proveRecoveryGmailSelectedReceipt({
        ...family(),
        selector: valid,
      }).source.sourceSha256,
    },
    { runId: "caller-run" },
  ]) {
    expect(() =>
      proveRecoveryGmailSelectedReceipt({
        ...family(),
        selector: { ...valid, ...change },
      })
    ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_RECEIPT_PROOF");
  }
});
it("rejects selector accessors without invoking them and rejects symbol controls", () => {
  const read = vi.fn(() => "a1");
  const accessor = Object.defineProperty(
    { ...selector(fixture, "a1") },
    "messageId",
    { get: read, enumerable: true }
  );
  expect(() =>
    proveRecoveryGmailSelectedReceipt({ ...family(), selector: accessor })
  ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_RECEIPT_PROOF");
  expect(read).not.toHaveBeenCalled();
  const symbols = { ...selector(fixture, "a1"), [Symbol("authority")]: true };
  expect(() =>
    proveRecoveryGmailSelectedReceipt({ ...family(), selector: symbols })
  ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_RECEIPT_PROOF");
});

it("refuses source drift and returns detached selection and obligation data", () => {
  const args = {
    ...family(fixture, fixture.currentAfterFirstCapture),
    completed: [completed()],
    selector: selector(fixture, "b1"),
  };
  const drift = structuredClone(args.current);
  const source = drift.files.find((file) => file.path.endsWith("/source.txt"))!;
  source.bytes = Buffer.from("changed").toString("base64");
  source.sha256 = sha256("changed");
  expect(() =>
    proveRecoveryGmailSelectedReceipt({ ...args, current: drift })
  ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_RECEIPT_PROOF");
  const clockDrift = structuredClone(args.current);
  const snapshot = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(clockDrift.journal, "base64")
  );
  const row = snapshot.intakeEvidence.find(
    (row) => row.kind === "source" && row.id === args.selector.receiptId
  )!;
  const evidence = JSON.parse(
    Buffer.from(row.bytes, "base64").toString("utf8")
  ) as { firstObservedAtEpochMs: number };
  evidence.firstObservedAtEpochMs += 1;
  const changed = Buffer.from(canonicalJson(evidence) + "\n");
  row.bytes = changed.toString("base64");
  row.identity = sha256(changed);
  const { digest, ...body } = snapshot;
  void digest;
  clockDrift.journal = Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  ).toString("base64");
  expect(() =>
    proveRecoveryGmailSelectedReceipt({ ...args, current: clockDrift })
  ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_RECEIPT_PROOF");
  const result = proveRecoveryGmailSelectedReceipt(args);
  result.selector.messageId = "changed";
  result.obligations.length = 0;
  expect(args.selector.messageId).toBe("b1");
  expect(
    proveRecoveryGmailSelectedReceipt(args).obligations.length
  ).toBeGreaterThan(0);
});
it("refuses an unapproved correction without losing its review obligation", async () => {
  const review = await createRecoveryGmailCaptureAdmissionFixture({
    reviewFirstCorrection: true,
    approveReviewBeforeCheckpoint: true,
  });
  try {
    const args = {
      ...family(review, review.currentAfterFirstCapture),
      completed: [completed(review, true)],
    };
    const result = proveRecoveryGmailSelectedReceipt({
      ...args,
      selector: selector(review, "a1"),
    });
    expect(
      result.obligations.find((item) => item.messageId === "b1")?.status
    ).toBe("review-required");
    expect(() =>
      proveRecoveryGmailSelectedReceipt({
        ...args,
        selector: selector(review, "b1"),
      })
    ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_RECEIPT_PROOF");
    expect(review.approvedCheckpoint).toBeDefined();
    const checkpoint = review.approvedCheckpoint!;
    const approved = proveRecoveryGmailSelectedReceipt({
      checkpoint,
      recoveryKey: review.recoveryKey,
      completed: [],
      unfinishedAdmissions: [],
      current: checkpoint,
      selector: selector(review, "b1"),
    });
    expect(approved.receipt.disposition).toBe("ready");
    expect(approved.receipt.correctionOf).toBe(
      selector(review, "a1").receiptId
    );
    expect(
      approved.canonicalEvidence.some((file) =>
        file.path.endsWith("/correction-approval.json")
      )
    ).toBe(true);
    const originalRow = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(review.currentAfterFirstCapture.journal, "base64")
    ).intakeEvidence.find(
      (row) =>
        row.kind === "source" && row.id === selector(review, "b1").receiptId
    )!;
    const original = JSON.parse(
      Buffer.from(originalRow.bytes, "base64").toString("utf8")
    ) as { firstObservedAtEpochMs: number };
    expect(approved.source.importObservedAtEpochMs).toBe(
      original.firstObservedAtEpochMs
    );
  } finally {
    review.cleanup();
  }
});
