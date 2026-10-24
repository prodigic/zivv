import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectRecoveryGmailCaptureAdmission,
  type CaptureInterruption,
  type RecoveryGmailCaptureInput,
} from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import type { RecoveryGmailCaptureAdmission } from "../../lib/ingestion/recovery-gmail-capture-admission-proof.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import {
  resumeOperatorRecoveryGmailBatch,
  resumeOperatorRecoveryGmailBatchForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureRuntimeFixture,
  type RecoveryGmailCaptureRuntimeFixture,
} from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

// Every launcher retains its own 150-second hard stop. These cases deliberately
// compose several short launches against one newly captured compatible worker.
vi.setConfig({ testTimeout: 360_000, hookTimeout: 180_000 });
let fixture: RecoveryGmailCaptureRuntimeFixture | undefined;
afterEach(({ task }) => {
  if (fixture && task.result?.state !== "pass")
    console.error(`Preserved failed stage-repair fixture at ${fixture.base}`);
  fixture?.cleanup(task.result?.state !== "pass");
  fixture = undefined;
});

function stages(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? stages(path)
      : entry.name.endsWith(".tmp")
        ? [path]
        : [];
  });
}

async function setup(): Promise<RecoveryGmailCaptureInput> {
  fixture = await createRecoveryGmailCaptureRuntimeFixture();
  return {
    ...fixture.input,
    batchId: fixture.batchIds[0]!,
    correctionOfByMessageId: {
      b1: fixture.sourceReceipts[0]!.receipt.receiptId,
    },
  };
}

async function interrupt(
  input: RecoveryGmailCaptureInput,
  point: CaptureInterruption
): Promise<void> {
  await expect(
    resumeOperatorRecoveryGmailBatchForTest(input, point)
  ).rejects.toMatchObject({
    message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
    cause: { message: "RECOVERY_GMAIL_CAPTURE_TEST_INTERRUPTION" },
  });
  expect((await inspectRecoveryGmailCaptureAdmission(input)).status).toBe(
    "capture-partial"
  );
}

function journal(input: RecoveryGmailCaptureInput) {
  return validateWeeklyJournalRecoverySnapshot(
    readWeeklyJournalRecoverySnapshotReadOnly(
      join(input.destination, "operator/weekly-runs.sqlite")
    )
  );
}

describe.sequential(
  "authenticated stage repair through a retained worker",
  () => {
    it("adopts flushed intent/key/intake/result stages without regenerating signed bytes or replaying the lease", async () => {
      const input = await setup();
      const family = join(
        input.destination,
        "recovery-gmail-capture",
        input.batchId
      );
      const admission = join(family, "admission.json");
      const result = join(family, "result.json");

      await interrupt(input, "admission-stage-flushed");
      expect(existsSync(admission)).toBe(false);
      const admissionStages = stages(join(family, "admission-stage"));
      expect(admissionStages).toHaveLength(1);
      const admissionBytes = readFileSync(admissionStages[0]!);

      // Neither invalid signed bytes nor two byte-identical candidates grant
      // permission to install a canonical intent or acquire a capture lease.
      const signedAdmission = JSON.parse(
        admissionBytes.toString("utf8")
      ) as RecoveryGmailCaptureAdmission;
      const conflicting = Buffer.from(
        canonicalJson({
          ...signedAdmission,
          admittedAtEpochMs: signedAdmission.admittedAtEpochMs + 1,
        }) + "\n"
      );
      writeFileSync(admissionStages[0]!, conflicting);
      expect(() => inspectRecoveryGmailCaptureAdmission(input)).toThrow();
      expect(readFileSync(admissionStages[0]!)).toEqual(conflicting);
      expect(existsSync(admission)).toBe(false);
      writeFileSync(admissionStages[0]!, admissionBytes);
      const ambiguous = join(
        family,
        "admission-stage",
        `admission.json.${process.pid}.${"e".repeat(16)}.tmp`
      );
      writeFileSync(ambiguous, admissionBytes, { flag: "wx", mode: 0o600 });
      expect(() => inspectRecoveryGmailCaptureAdmission(input)).toThrow();
      expect(readFileSync(ambiguous)).toEqual(admissionBytes);
      expect(readFileSync(admissionStages[0]!)).toEqual(admissionBytes);
      expect(existsSync(admission)).toBe(false);
      unlinkSync(ambiguous);

      await interrupt(input, "key-stage-flushed");
      expect(readFileSync(admission)).toEqual(admissionBytes);
      expect(stages(join(family, "admission-stage"))).toEqual([]);
      const keyStages = stages(join(family, "key-stage"));
      expect(keyStages).toHaveLength(1);
      const keyBytes = readFileSync(keyStages[0]!);

      await interrupt(input, "intake-stage-flushed");
      const keyName =
        process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin";
      expect(
        readFileSync(join(input.destination, "operator", keyName))
      ).toEqual(keyBytes);
      expect(stages(join(family, "key-stage"))).toEqual([]);
      expect(
        stages(join(input.destination, "operator/email-intake"))
      ).toHaveLength(1);

      await interrupt(input, "result-stage-flushed");
      expect(stages(join(input.destination, "operator/email-intake"))).toEqual(
        []
      );
      expect(existsSync(result)).toBe(false);
      const resultStages = stages(join(family, "result-stage"));
      expect(resultStages).toHaveLength(1);
      const resultBytes = readFileSync(resultStages[0]!);
      const beforeRepair = journal(input);

      const report = await resumeOperatorRecoveryGmailBatch(input);
      expect(report.status).toBe("capture-complete");
      expect(report.receipts).toHaveLength(2);
      expect(readFileSync(admission)).toEqual(admissionBytes);
      expect(readFileSync(result)).toEqual(resultBytes);
      expect(stages(family)).toEqual([]);
      expect(journal(input)).toEqual(beforeRepair);
      expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(report);
      expect(journal(input)).toEqual(beforeRepair);
    });

    it("cleans only exact canonical hard-link aliases and returns a saved result without a new lease", async () => {
      const input = await setup();
      const family = join(
        input.destination,
        "recovery-gmail-capture",
        input.batchId
      );
      for (const [point, name, stageDirectory] of [
        ["admission-linked", "admission.json", "admission-stage"],
        [
          "key-linked",
          process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin",
          "key-stage",
        ],
        ["result-linked", "result.json", "result-stage"],
      ] as const) {
        await interrupt(input, point);
        const canonical = join(
          point === "key-linked" ? join(input.destination, "operator") : family,
          name
        );
        const stage = stages(join(family, stageDirectory));
        expect(stage).toHaveLength(1);
        expect(statSync(stage[0]!).ino).toBe(statSync(canonical).ino);
        expect(statSync(canonical).nlink).toBe(2);
      }
      const saved = readFileSync(join(family, "result.json"));
      const beforeRepair = journal(input);
      const report = await resumeOperatorRecoveryGmailBatch(input);
      expect(report.status).toBe("capture-complete");
      expect(readFileSync(join(family, "result.json"))).toEqual(saved);
      expect(stages(family)).toEqual([]);
      expect(statSync(join(family, "result.json")).nlink).toBe(1);
      expect(journal(input)).toEqual(beforeRepair);
    });
  }
);
