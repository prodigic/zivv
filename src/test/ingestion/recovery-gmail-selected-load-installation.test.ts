import {
  resumeOperatorRecoveryGmailSelectedLoadEvidence,
  resumeOperatorRecoveryGmailSelectedLoadEvidenceForTest,
} from "../../lib/ingestion/recovery-gmail-selected-load-launcher.js";
import type { RecoveryGmailSelectedLoadInstallationInterruption } from "../../lib/ingestion/recovery-gmail-selected-load-installation.js";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";
import { resumeOperatorRecoveryGmailBatchForTest } from "../../lib/ingestion/recovery-gmail-capture.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { readWeeklyJournalRecoverySnapshotReadOnly } from "../../lib/ingestion/weekly-run-journal.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { installRecoveryGmailSelectedLoadEvidence } from "../../lib/ingestion/recovery-gmail-selected-load-installation.js";
vi.setConfig({ testTimeout: 600_000 });
it("durably installs only selected-run evidence through retained manifest/chunk/intent interruptions without key, catalog or journal effects", async () => {
  console.error("SELECTED_LOAD_INSTALL fixture", Date.now());
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    composedBatches: true,
    seedAuthorityControls: true,
  });
  let preserve = true;
  try {
    const original = fixture.sourceReceipts[0]!.receipt;
    const selector = {
      batchId: fixture.composition!.originalBatchId,
      messageId: original.messageId,
      rawSha256: original.rawSha256,
      receiptId: original.receiptId,
    };
    await expect(
      resumeOperatorRecoveryGmailBatchForTest(
        {
          ...fixture.input,
          batchId: fixture.composition!.priorBatchId,
          correctionOfByMessageId: { b1: fixture.composition!.receiptIds.a1 },
        },
        "source-committed"
      )
    ).rejects.toMatchObject({
      cause: { message: "RECOVERY_GMAIL_CAPTURE_TEST_INTERRUPTION" },
    });
    const root = fixture.input.destination,
      operator = join(root, "operator"),
      journalPath = join(operator, "weekly-runs.sqlite");
    const observer = new DatabaseSync(journalPath, { readOnly: true });
    try {
      observer.prepare("SELECT COUNT(*) FROM intake_evidence").get();
      const opened = openPreparedRuntimeForAdmission(fixture.input);
      const baseline = opened.inventoryGmailLoadInstallation();
      const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
      const native = async (
        point?: RecoveryGmailSelectedLoadInstallationInterruption
      ) => {
        try {
          const input = { ...fixture.input, selector };
          const result = point
            ? await resumeOperatorRecoveryGmailSelectedLoadEvidenceForTest(
                input,
                point
              )
            : await resumeOperatorRecoveryGmailSelectedLoadEvidence(input);
          return {
            status: 0,
            stdout: JSON.stringify(result) + "\n",
            stderr: "",
          };
        } catch (error) {
          const cause =
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : "UNEXPECTED";
          return { status: 1, stdout: "", stderr: cause };
        }
      };
      for (const point of [
        "manifest-stage-flushed",
        "manifest-installed",
        "chunks-installed",
        "intent-linked",
      ] as const) {
        console.error("SELECTED_LOAD_INSTALL", point, Date.now());
        const interrupted = await native(point);
        expect(interrupted.status).toBe(1);
        expect(interrupted.stderr).toContain(
          "RECOVERY_GMAIL_SELECTED_LOAD_INSTALLATION_INTERRUPTED"
        );
        expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
          journal
        );
        expect(
          opened
            .inventoryGmailLoadInstallation()
            .filter(
              (entry) =>
                entry.path !== "recovery-gmail-load" &&
                !entry.path.startsWith("recovery-gmail-load/")
            )
        ).toEqual(baseline);
      }
      const complete = await native();
      expect(complete.status).toBe(0);
      const report = JSON.parse(complete.stdout.trim()) as {
        runId: string;
        chunks: number;
        admissionSha256: string;
      };
      expect(report).toMatchObject({
        status: "load-evidence-installed",
        activationAllowed: false,
        captureAllowed: false,
        loadAllowed: false,
        physicalValidationRequired: true,
      });
      expect(report.chunks).toBeGreaterThan(0);
      expect((await native()).stdout).toBe(complete.stdout);
      const directory = join(root, "recovery-gmail-load", report.runId);
      const manifest = JSON.parse(
        readFileSync(join(directory, "baseline.json"), "utf8")
      ) as { admission: string };
      expect(readFileSync(join(directory, "admission.json"))).toEqual(
        Buffer.from(manifest.admission, "base64")
      );
      for (const name of readdirSync(join(directory, "stages")))
        expect(readdirSync(join(directory, "stages", name))).toHaveLength(0);
      expect(() => assertOperatorNotQuarantined(operator)).toThrow(
        "RECOVERY_INSTALLATION_NOT_ACTIVATED"
      );
      expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
        journal
      );
      const before = opened.inventoryGmailLoadInstallation();
      writeFileSync(join(directory, "unknown.json"), "{}\n");
      expect((await native()).status).toBe(1);
      expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
        journal
      );
      expect(
        opened
          .inventoryGmailLoadInstallation()
          .filter((entry) => !entry.path.endsWith("/unknown.json"))
      ).toEqual(before);
      expect(existsSync(join(fixture.base, "original checkout"))).toBe(false);
      preserve = false;
      console.error("SELECTED_LOAD_INSTALL verified", Date.now());
    } finally {
      observer.close();
    }
  } finally {
    if (preserve)
      console.error("SELECTED_LOAD_INSTALL preserved", fixture.base);
    else fixture.cleanup(false);
  }
});
it("refuses caller-controlled effects and accessors before opening a host", () => {
  const getter = vi.fn();
  expect(() =>
    installRecoveryGmailSelectedLoadEvidence(
      Object.defineProperty({}, "selector", { get: getter }) as never
    )
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("installs an original ready selection without creating a working key or changing original physical files", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture();
  let preserve = true;
  try {
    const original = fixture.sourceReceipts[0]!.receipt;
    const selector = {
      batchId: fixture.batchIds[0]!,
      messageId: original.messageId,
      rawSha256: original.rawSha256,
      receiptId: original.receiptId,
    };
    const root = fixture.input.destination;
    const key = join(
      root,
      "operator",
      process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
    );
    expect(existsSync(key)).toBe(false);
    const opened = openPreparedRuntimeForAdmission(fixture.input);
    const before = opened.inventoryGmailLoadInstallation();
    const input = {
      archive: fixture.input.archive,
      retirementReceipt: fixture.input.retirementReceipt,
      recoveryKey: fixture.input.recoveryKey,
      destination: root,
      npmCli: fixture.input.npmCli,
      selector,
    };
    const report = installRecoveryGmailSelectedLoadEvidence(input);
    expect(report).toMatchObject({
      status: "load-evidence-installed",
      chunks: 0,
      loadAllowed: false,
    });
    expect(installRecoveryGmailSelectedLoadEvidence(input)).toEqual(report);
    expect(existsSync(key)).toBe(false);
    expect(
      opened
        .inventoryGmailLoadInstallation()
        .filter(
          (entry) =>
            entry.path !== "recovery-gmail-load" &&
            !entry.path.startsWith("recovery-gmail-load/")
        )
    ).toEqual(before);
    expect(() =>
      installRecoveryGmailSelectedLoadEvidence({
        ...input,
        activate: true,
      } as never)
    ).toThrow();
    expect(fixture.input.recoveryKey.some((byte) => byte !== 0)).toBe(true);
    preserve = false;
  } finally {
    fixture.cleanup(preserve);
  }
});
