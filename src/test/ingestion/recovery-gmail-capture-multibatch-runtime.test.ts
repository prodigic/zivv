import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  resumeOperatorRecoveryGmailBatch,
  resumeOperatorRecoveryGmailBatchForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import { inspectRecoveryGmailCaptureAdmission } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import type { RecoveryGmailCaptureAdmission } from "../../lib/ingestion/recovery-gmail-capture-admission-proof.js";
import { inspectOperatorRecoveryGmailBatches } from "../../lib/ingestion/recovery-gmail-inspector.js";
import { proveRecoveryGmailCaptureSelection } from "../../lib/ingestion/recovery-gmail-capture-selection.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import type { SteveEmailReceipt } from "../../lib/ingestion/steve-email-intake.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 600_000 });

it("composes original, interrupted prior and prospective own batches after deleting the original host", async () => {
  console.error("CAPTURE_MULTIBATCH fixture-start", Date.now());
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    composedBatches: true,
    seedAuthorityControls: true,
  });
  console.error("CAPTURE_MULTIBATCH fixture-ready", Date.now());
  let preserve = true;
  try {
    const composition = fixture.composition;
    if (!composition) throw new Error("Missing genuine composition fixture");
    for (const name of [
      "original checkout",
      "original operator",
      "original npm",
    ])
      expect(existsSync(join(fixture.base, name))).toBe(false);
    const opened = openPreparedRuntimeForAdmission(fixture.input);
    const before = opened.inventory();
    const baseline = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(opened.checkpoint.journal, "base64")
    );
    const inspection = inspectOperatorRecoveryGmailBatches(fixture.input);
    expect(inspection).toMatchObject({
      activationAllowed: false,
      captureAllowed: false,
    });
    expect(inspection.batches).toHaveLength(3);
    expect(new Set(inspection.batches.map((b) => b.accountSha256)).size).toBe(
      1
    );
    expect(
      inspection.batches
        .find((b) => b.batchId === composition.originalBatchId)
        ?.messages.map((m) => m.status)
    ).toEqual(["load-pending"]);
    expect(
      inspection.batches
        .find((b) => b.batchId === composition.priorBatchId)
        ?.messages.map((m) => m.status)
    ).toEqual(["capture-pending"]);
    expect(
      inspection.batches
        .find((b) => b.batchId === composition.ownBatchId)
        ?.messages.map((m) => m.status)
    ).toEqual(["capture-pending", "capture-pending"]);
    const prior = {
      ...fixture.input,
      batchId: composition.priorBatchId,
      correctionOfByMessageId: { b1: composition.receiptIds.a1 },
    };
    const own = {
      ...fixture.input,
      batchId: composition.ownBatchId,
      correctionOfByMessageId: { d1: composition.receiptIds.c1 },
    };
    const selection = proveRecoveryGmailCaptureSelection({
      checkpoint: opened.checkpoint,
      recoveryKey: own.recoveryKey,
      batchId: own.batchId,
      correctionOfByMessageId: own.correctionOfByMessageId,
    });
    expect(
      selection.messages.map((m) => [
        m.messageId,
        m.existingReceiptId,
        m.prospectiveParentMessageId,
      ])
    ).toEqual([
      ["c1", null, null],
      ["d1", null, "c1"],
    ]);
    const familyPath = (batchId: string, name: string) =>
      join(own.destination, "recovery-gmail-capture", batchId, name);
    const journal = () =>
      validateWeeklyJournalRecoverySnapshot(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(own.destination, "operator/weekly-runs.sqlite")
        )
      );
    const receipt = (snapshot: ReturnType<typeof journal>, id: string) => {
      const row = snapshot.intakeEvidence.find(
        (r) => r.kind === "source" && r.id === id
      );
      if (!row) throw new Error("Missing authenticated source receipt");
      return JSON.parse(
        Buffer.from(row.bytes, "base64").toString("utf8")
      ) as SteveEmailReceipt;
    };
    const priorStarted = Date.now();
    console.error("CAPTURE_MULTIBATCH prior-start", priorStarted);
    await expect(
      resumeOperatorRecoveryGmailBatchForTest(prior, "source-committed")
    ).rejects.toMatchObject({
      message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
      cause: { message: "RECOVERY_GMAIL_CAPTURE_TEST_INTERRUPTION" },
    });
    expect(inspectRecoveryGmailCaptureAdmission(prior).status).toBe(
      "capture-partial"
    );
    const priorAdmission = readFileSync(
      familyPath(prior.batchId, "admission.json")
    );
    console.error("CAPTURE_MULTIBATCH prior-interrupted", Date.now());
    const firstObservation = receipt(
      journal(),
      composition.receiptIds.b1
    ).firstObservedAtEpochMs;
    expect(firstObservation).toBeGreaterThanOrEqual(priorStarted);
    const priorReport = await resumeOperatorRecoveryGmailBatch(prior);
    expect(priorReport).toMatchObject({
      status: "capture-complete",
      activationAllowed: false,
      captureAllowed: false,
    });
    expect(priorReport.receipts).toMatchObject([
      {
        receiptId: composition.receiptIds.b1,
        firstObservedAtEpochMs: firstObservation,
        disposition: "ready",
      },
    ]);
    console.error("CAPTURE_MULTIBATCH prior-complete", Date.now());
    const priorResult = readFileSync(familyPath(prior.batchId, "result.json"));
    expect(readFileSync(familyPath(prior.batchId, "admission.json"))).toEqual(
      priorAdmission
    );
    expect(inspectRecoveryGmailCaptureAdmission(own).status).toBe(
      "capture-pending"
    );
    expect(existsSync(familyPath(own.batchId, "admission.json"))).toBe(false);
    const ownStarted = Date.now();
    console.error("CAPTURE_MULTIBATCH own-start", ownStarted);
    const ownReport = await resumeOperatorRecoveryGmailBatch(own);
    const ownFinished = Date.now();
    console.error("CAPTURE_MULTIBATCH own-complete", ownFinished);
    expect(ownReport).toMatchObject({
      status: "capture-complete",
      activationAllowed: false,
      captureAllowed: false,
    });
    expect(ownReport.receipts.map((r) => [r.receiptId, r.disposition])).toEqual(
      [
        [composition.receiptIds.c1, "ready"],
        [composition.receiptIds.d1, "ready"],
      ]
    );
    const ownAdmission = readFileSync(
      familyPath(own.batchId, "admission.json")
    );
    const signedOwn = JSON.parse(
      ownAdmission.toString("utf8")
    ) as RecoveryGmailCaptureAdmission;
    expect(signedOwn.priorCompleted).toEqual({
      count: 1,
      sha256: sha256(
        canonicalJson([
          {
            admissionSha256: sha256(priorAdmission),
            resultSha256: sha256(priorResult),
          },
        ])
      ),
    });
    expect(signedOwn.admittedAtEpochMs).toBeGreaterThanOrEqual(ownStarted);
    const completed = journal();
    expect(receipt(completed, composition.receiptIds.c1)).toMatchObject({
      disposition: "ready",
      correctionOf: null,
    });
    expect(receipt(completed, composition.receiptIds.d1)).toMatchObject({
      disposition: "ready",
      correctionOf: composition.receiptIds.c1,
    });
    for (const messageId of ["c1", "d1"] as const) {
      const observed = receipt(completed, composition.receiptIds[messageId]);
      const snapshot = selection.messages.find(
        (m) => m.messageId === messageId
      )!;
      expect(observed.acquisitionObservedAtEpochMs).toBe(
        snapshot.observedAtEpochMs
      );
      expect(observed.firstObservedAtEpochMs).toBeGreaterThanOrEqual(
        signedOwn.admittedAtEpochMs
      );
      expect(observed.firstObservedAtEpochMs).toBeLessThanOrEqual(ownFinished);
      expect(observed.firstObservedAtEpochMs).toBeGreaterThan(
        observed.acquisitionObservedAtEpochMs
      );
    }
    expect(
      receipt(completed, composition.receiptIds.c1).firstObservedAtEpochMs
    ).toBeLessThanOrEqual(
      receipt(completed, composition.receiptIds.d1).firstObservedAtEpochMs
    );
    expect(
      receipt(completed, composition.receiptIds.b1).firstObservedAtEpochMs
    ).toBe(firstObservation);
    expect(
      completed.intakeEvidence.filter((r) => r.kind === "source")
    ).toHaveLength(4);
    for (const row of baseline.intakeEvidence)
      expect(completed.intakeEvidence).toContainEqual(row);
    expect(completed.runState).toEqual(baseline.runState);
    expect(completed.stageArtifacts).toEqual(baseline.stageArtifacts);
    const after = opened.inventory();
    const journalFiles = new Set([
      "operator/weekly-runs.sqlite",
      "operator/weekly-runs.sqlite-wal",
      "operator/weekly-runs.sqlite-shm",
    ]);
    for (const entry of before)
      if (!journalFiles.has(entry.path))
        expect(after.find((r) => r.path === entry.path)).toEqual(entry);
    expect(readFileSync(familyPath(prior.batchId, "admission.json"))).toEqual(
      priorAdmission
    );
    expect(readFileSync(familyPath(prior.batchId, "result.json"))).toEqual(
      priorResult
    );
    expect(await resumeOperatorRecoveryGmailBatch(own)).toEqual(ownReport);
    expect(await resumeOperatorRecoveryGmailBatch(prior)).toEqual(priorReport);
    expect(journal()).toEqual(completed);
    expect(readFileSync(familyPath(own.batchId, "admission.json"))).toEqual(
      ownAdmission
    );
    console.error("CAPTURE_MULTIBATCH replay-complete", Date.now());
    preserve = false;
  } finally {
    if (preserve)
      console.error(`Preserved composed Gmail fixture at ${fixture.base}`);
    fixture.cleanup(preserve);
  }
});
