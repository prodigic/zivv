import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { verifyOperatorRetirementEvidence } from "../../lib/ingestion/operator-recovery.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { inspectRecoveryGmailSelectedLoadAdmission } from "../../lib/ingestion/recovery-gmail-selected-load-inspector.js";
import {
  resumeOperatorRecoveryGmailBatch,
  resumeOperatorRecoveryGmailBatchForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { hasRecoveredImportAuthority } from "../../lib/ingestion/recovery-import-admission.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 600_000 });
it("observes an original ready receipt beside an actual interrupted unrelated capture, then validates the completed family without granting authority", async () => {
  console.error("SELECTED_LOAD_INSPECTION fixture-start", Date.now());
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    composedBatches: true,
    seedAuthorityControls: true,
  });
  let preserve = true;
  try {
    const composition = fixture.composition!;
    for (const name of [
      "original checkout",
      "original operator",
      "original npm",
    ])
      expect(existsSync(join(fixture.base, name))).toBe(false);
    const original = fixture.sourceReceipts[0]!.receipt;
    const selector = {
      batchId: composition.originalBatchId,
      messageId: original.messageId,
      rawSha256: original.rawSha256,
      receiptId: original.receiptId,
    };
    const opened = openPreparedRuntimeForAdmission(fixture.input);
    const before = opened.inventory();
    const initial = inspectRecoveryGmailSelectedLoadAdmission({
      ...fixture.input,
      selector,
    });
    expect(initial).toMatchObject({
      status: "inspected",
      preLoadOnly: true,
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
      physicalValidationRequired: true,
      catalogEvidence: "unchanged-prepared-file-tree",
      completedCaptures: 0,
      unfinishedCaptures: 0,
    });
    expect(opened.inventory()).toEqual(before);
    const prior = {
      ...fixture.input,
      batchId: composition.priorBatchId,
      correctionOfByMessageId: { b1: composition.receiptIds.a1 },
    };
    console.error("SELECTED_LOAD_INSPECTION capture-interrupt", Date.now());
    await expect(
      resumeOperatorRecoveryGmailBatchForTest(prior, "source-committed")
    ).rejects.toMatchObject({
      message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
      cause: { message: "RECOVERY_GMAIL_CAPTURE_TEST_INTERRUPTION" },
    });
    const journalPath = join(
      fixture.input.destination,
      "operator/weekly-runs.sqlite"
    );
    const journal = () =>
      validateWeeklyJournalRecoverySnapshot(
        readWeeklyJournalRecoverySnapshotReadOnly(journalPath)
      );
    // Pin a real read observer through both measurements. This avoids measuring
    // read-only SQLite SHM open/close bookkeeping as an inspector mutation.
    const observer = new DatabaseSync(journalPath, { readOnly: true });
    try {
      observer.prepare("SELECT COUNT(*) FROM intake_evidence").get();
      const baseline = opened.inventory(),
        logical = journal();
      const partial = inspectRecoveryGmailSelectedLoadAdmission({
        ...fixture.input,
        selector,
      });
      expect(partial.completedCaptures).toBe(0);
      expect(partial.unfinishedCaptures).toBe(1);
      expect(
        partial.obligations.find((row) => row.messageSha256 === sha256("a1"))
          ?.status
      ).toBe("ready");
      expect(
        partial.obligations.filter((row) => row.status === "capture-pending")
      ).toHaveLength(3);
      expect(partial.source.importObservedAtEpochMs).toBe(
        original.firstObservedAtEpochMs
      );
      expect(JSON.stringify(partial)).not.toContain('"messageId"');
      expect(opened.inventory()).toEqual(baseline);
      expect(journal()).toEqual(logical);
      expect(
        hasRecoveredImportAuthority(join(fixture.input.destination, "operator"))
      ).toBe(false);
      expect(() =>
        assertOperatorNotQuarantined(
          join(fixture.input.destination, "operator")
        )
      ).toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
    } finally {
      observer.close();
    }
    console.error("SELECTED_LOAD_INSPECTION capture-complete", Date.now());
    await resumeOperatorRecoveryGmailBatch(prior);
    const completed = inspectRecoveryGmailSelectedLoadAdmission({
      ...fixture.input,
      selector,
    });
    expect(completed.completedCaptures).toBe(1);
    expect(completed.unfinishedCaptures).toBe(0);
    expect(
      completed.obligations.filter((row) => row.status === "ready")
    ).toHaveLength(2);
    expect(
      completed.obligations.filter((row) => row.status === "capture-pending")
    ).toHaveLength(2);
    expect(completed.loadAllowed).toBe(false);
    const catalog = new DatabaseSync(
      join(fixture.input.destination, "operator/ledger.sqlite")
    );
    try {
      const old = catalog
        .prepare("SELECT generation,digest FROM metadata WHERE id=1")
        .get()!;
      catalog.exec(
        "BEGIN IMMEDIATE; UPDATE metadata SET generation=generation+1 WHERE id=1; COMMIT;"
      );
      const changed = catalog
        .prepare("SELECT generation,digest FROM metadata WHERE id=1")
        .get()!;
      expect(Number(changed.generation)).toBe(Number(old.generation) + 1);
      expect(changed.digest).toBe(old.digest);
    } finally {
      catalog.close();
    }
    const driftObserver = new DatabaseSync(journalPath, { readOnly: true });
    try {
      driftObserver.prepare("SELECT COUNT(*) FROM intake_evidence").get();
      const logical = journal(),
        physical = opened.inventory();
      expect(() =>
        inspectRecoveryGmailSelectedLoadAdmission({
          ...fixture.input,
          selector,
        })
      ).toThrow("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_INSPECTION");
      expect(opened.inventory()).toEqual(physical);
      expect(journal()).toEqual(logical);
    } finally {
      driftObserver.close();
    }
    console.error("SELECTED_LOAD_INSPECTION verified", Date.now());
    preserve = false;
  } finally {
    if (preserve)
      console.error(
        `Preserved selected-load inspection fixture at ${fixture.base}`
      );
    fixture.cleanup(preserve);
  }
});

it("refuses a genuinely captured runtime without the inspection entry before creating a destination", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    withoutSelectedLoadInspector: true,
  });
  let preserve = true;
  try {
    expect(fixture.prepared).toBe(false);
    const checkpoint = verifyOperatorRetirementEvidence(
      fixture.input
    ).checkpoint;
    expect(
      checkpoint.files.some(
        (file) =>
          file.path ===
          "dist/lib/ingestion/recovery-gmail-selected-load-inspector.js"
      )
    ).toBe(false);
    expect(existsSync(fixture.input.destination)).toBe(false);
    const snapshot = () =>
      readdirSync(fixture.base, { recursive: true, encoding: "utf8" }).map(
        (path) => {
          const stat = lstatSync(join(fixture.base, path));
          return {
            path,
            dev: stat.dev,
            ino: stat.ino,
            nlink: stat.nlink,
            mtimeMs: stat.mtimeMs,
            sha256: stat.isFile()
              ? sha256(readFileSync(join(fixture.base, path)))
              : null,
          };
        }
      );
    const before = snapshot(),
      receipt = fixture.sourceReceipts[0]!.receipt;
    expect(() =>
      inspectRecoveryGmailSelectedLoadAdmission({
        ...fixture.input,
        selector: {
          batchId: fixture.batchIds[0]!,
          messageId: receipt.messageId,
          rawSha256: receipt.rawSha256,
          receiptId: receipt.receiptId,
        },
      })
    ).toThrow("RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME");
    expect(existsSync(fixture.input.destination)).toBe(false);
    expect(snapshot()).toEqual(before);
    preserve = false;
  } finally {
    if (preserve)
      console.error(
        `Preserved unsupported selected-load fixture at ${fixture.base}`
      );
    fixture.cleanup(preserve);
  }
});

it("rejects unknown controls and selector accessors before opening a host", () => {
  const getter = vi.fn(() => "a1");
  const selector = Object.defineProperty(
    {
      batchId: "a".repeat(64),
      messageId: "a1",
      rawSha256: "b".repeat(64),
      receiptId: "c".repeat(64),
    },
    "messageId",
    { get: getter, enumerable: true }
  );
  const input = {
    archive: Buffer.from("not-opened"),
    retirementReceipt: Buffer.from("not-opened"),
    recoveryKey: Buffer.alloc(32),
    destination: "not-opened",
    npmCli: "not-opened",
    selector,
  };
  expect(() => inspectRecoveryGmailSelectedLoadAdmission(input)).toThrow(
    "INVALID_RECOVERY_GMAIL_SELECTED_LOAD_INSPECTION"
  );
  expect(getter).not.toHaveBeenCalled();
  const controlled = { ...input, activate: true };
  expect(() => inspectRecoveryGmailSelectedLoadAdmission(controlled)).toThrow(
    "INVALID_RECOVERY_GMAIL_SELECTED_LOAD_INSPECTION"
  );
});
