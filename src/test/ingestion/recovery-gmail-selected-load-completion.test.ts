import { lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";
import {
  installRecoveryGmailSelectedLoadEvidenceForTest,
  inspectInstalledRecoveryGmailSelectedLoadEvidence,
} from "../../lib/ingestion/recovery-gmail-selected-load-installation.js";
import {
  resumeOperatorRecoveryGmailSelectedLoadEvidence,
  resumeOperatorRecoveryGmailSelectedLoadEvidenceForTest,
} from "../../lib/ingestion/recovery-gmail-selected-load-launcher.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
vi.setConfig({ testTimeout: 300_000 });
it("observes a genuine linked intent without adopting or flushing it, then lets only the retained launcher finish", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture();
  let preserve = true;
  try {
    const receipt = fixture.sourceReceipts[0]!.receipt;
    const input = {
      ...fixture.input,
      selector: {
        batchId: fixture.batchIds[0]!,
        messageId: receipt.messageId,
        rawSha256: receipt.rawSha256,
        receiptId: receipt.receiptId,
      },
    };
    const opened = openPreparedRuntimeForAdmission(fixture.input);
    const original = opened.inventoryGmailLoadInstallation();
    expect(() =>
      installRecoveryGmailSelectedLoadEvidenceForTest(input, "intent-linked")
    ).toThrow("RECOVERY_GMAIL_SELECTED_LOAD_INSTALLATION_INTERRUPTED");
    const observe = () =>
      opened.inventoryGmailLoadInstallation().map((entry) => {
        const stat = lstatSync(join(input.destination, entry.path));
        // Read access time is not a write/adoption observation. Preserve identities,
        // links, permissions and mutation timestamps across the read-only check.
        return {
          entry,
          dev: stat.dev,
          ino: stat.ino,
          nlink: stat.nlink,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        };
      });
    const before = observe();
    expect(
      before.some(
        (item) =>
          item.entry.path.startsWith("recovery-gmail-load/") && item.nlink === 2
      )
    ).toBe(true);
    expect(() =>
      inspectInstalledRecoveryGmailSelectedLoadEvidence(input)
    ).toThrow("RECOVERY_GMAIL_SELECTED_LOAD_NOT_INSTALLED");
    expect(observe()).toEqual(before);
    const report = await resumeOperatorRecoveryGmailSelectedLoadEvidence(input);
    const complete = observe();
    expect(inspectInstalledRecoveryGmailSelectedLoadEvidence(input)).toEqual(
      report
    );
    expect(observe()).toEqual(complete);
    expect(
      await resumeOperatorRecoveryGmailSelectedLoadEvidence(input)
    ).toEqual(report);
    expect(observe()).toEqual(complete);
    expect(
      opened
        .inventoryGmailLoadInstallation()
        .filter(
          (entry) =>
            entry.path !== "recovery-gmail-load" &&
            !entry.path.startsWith("recovery-gmail-load/")
        )
    ).toEqual(original);
    preserve = false;
  } finally {
    fixture.cleanup(preserve);
  }
});

it("refuses a genuine capsule missing framing before preparation or launching effects", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    withoutSelectedLoadFraming: true,
  });
  let preserve = true;
  try {
    expect(fixture.prepared).toBe(false);
    expect(existsSync(fixture.input.destination)).toBe(false);
    const receipt = fixture.sourceReceipts[0]!.receipt;
    await expect(
      resumeOperatorRecoveryGmailSelectedLoadEvidence({
        ...fixture.input,
        selector: {
          batchId: fixture.batchIds[0]!,
          messageId: receipt.messageId,
          rawSha256: receipt.rawSha256,
          receiptId: receipt.receiptId,
        },
      })
    ).rejects.toMatchObject({
      message: "RECOVERY_GMAIL_SELECTED_LOAD_EXECUTION_FAILED",
      cause: { message: "RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME" },
    });
    expect(existsSync(fixture.input.destination)).toBe(false);
    preserve = false;
  } finally {
    fixture.cleanup(preserve);
  }
});

it("recovers a lost response after canonical intent installation through independent read-only completion", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture();
  let preserve = true;
  try {
    const receipt = fixture.sourceReceipts[0]!.receipt;
    const input = {
      ...fixture.input,
      selector: {
        batchId: fixture.batchIds[0]!,
        messageId: receipt.messageId,
        rawSha256: receipt.rawSha256,
        receiptId: receipt.receiptId,
      },
    };
    await expect(
      resumeOperatorRecoveryGmailSelectedLoadEvidenceForTest(
        input,
        "intent-installed"
      )
    ).rejects.toMatchObject({
      message: "RECOVERY_GMAIL_SELECTED_LOAD_EXECUTION_FAILED",
      cause: {
        message: "RECOVERY_GMAIL_SELECTED_LOAD_INSTALLATION_INTERRUPTED",
      },
    });
    const opened = openPreparedRuntimeForAdmission(fixture.input);
    const before = opened.inventoryGmailLoadInstallation();
    const expected = inspectInstalledRecoveryGmailSelectedLoadEvidence(input);
    expect(
      await resumeOperatorRecoveryGmailSelectedLoadEvidence(input)
    ).toEqual(expected);
    expect(opened.inventoryGmailLoadInstallation()).toEqual(before);
    expect(expected.loadAllowed).toBe(false);
    preserve = false;
  } finally {
    fixture.cleanup(preserve);
  }
});
