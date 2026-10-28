import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  resumeOperatorRecoveryGmailBatch,
  startRecoveryGmailCaptureDriftProbeForTest,
  startRecoveryGmailCaptureProtocolProbeForTest,
} from "../../lib/ingestion/recovery-gmail-capture.js";
import {
  inspectRecoveryGmailCaptureAdmission,
  type RecoveryGmailCaptureInput,
} from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
  type WeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureRuntimeFixture,
  type RecoveryGmailCaptureRuntimeFixture,
} from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 540_000, hookTimeout: 180_000 });

type Session = Awaited<
  ReturnType<typeof startRecoveryGmailCaptureDriftProbeForTest>
>;
type ProtocolMode = Parameters<
  typeof startRecoveryGmailCaptureProtocolProbeForTest
>[1];
type CaseMode = ProtocolMode | "no-go" | "invalid-mode";
type Phase =
  | "case-start"
  | "case-complete"
  | "inventory-before"
  | "inventory-after"
  | "start-probe"
  | "started"
  | "await-paused"
  | "paused"
  | "resume"
  | "await-result"
  | "result"
  | "stop"
  | "stopped"
  | "journal-before"
  | "journal-after"
  | "inspector-before"
  | "inspector-after"
  | "retry-before"
  | "retry-after"
  | "replay-before"
  | "replay-after";
type Inventory = ReturnType<
  ReturnType<typeof openPreparedRuntimeForAdmission>["inventory"]
>;
type Outcome =
  | { status: "resolved"; value: Awaited<Session["result"]> }
  | { status: "rejected"; error: unknown };

let fixture: RecoveryGmailCaptureRuntimeFixture | undefined;
let input: RecoveryGmailCaptureInput;
let opened: ReturnType<typeof openPreparedRuntimeForAdmission>;
let initialInventory: Inventory;
let baselineJournal: WeeklyJournalRecoverySnapshot;
let originalIdentities: Map<
  string,
  { dev: number; ino: number; nlink: number; mtimeMs: number }
>;
let admissionBytes: Buffer | undefined;
let failed = false;
let preserve = true;
let activeCase: CaseMode | undefined;
const completedCases = new Set<CaseMode>();
const keyName =
  process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin";

function phase(mode: CaseMode, step: Phase) {
  console.error(`CAPTURE_PROTOCOL_TEST ${mode} ${step} ${Date.now()}`);
}

function beginCase(mode: CaseMode) {
  if (failed || activeCase !== undefined) {
    failed = true;
    throw new Error("Earlier protocol failure preserved the fixture");
  }
  activeCase = mode;
  phase(mode, "case-start");
}

function completeCase(mode: CaseMode) {
  if (failed || activeCase !== mode)
    throw new Error("Protocol case completion did not match its active case");
  completedCases.add(mode);
  activeCase = undefined;
  phase(mode, "case-complete");
}

function captureOutcome(promise: Session["result"]): Promise<Outcome> {
  return promise.then(
    (value) => ({ status: "resolved", value }),
    (error: unknown) => ({ status: "rejected", error })
  );
}

function logical(snapshot: WeeklyJournalRecoverySnapshot) {
  const { digest, ...body } = snapshot;
  void digest;
  return body;
}

function currentJournal() {
  return validateWeeklyJournalRecoverySnapshot(
    readWeeklyJournalRecoverySnapshotReadOnly(
      join(input.destination, "operator/weekly-runs.sqlite")
    )
  );
}

function familyPath(name: string) {
  return join(input.destination, "recovery-gmail-capture", input.batchId, name);
}

function assertOriginalFiles(inventory: Inventory) {
  for (const entry of initialInventory) {
    expect(inventory.find((observed) => observed.path === entry.path)).toEqual(
      entry
    );
    const identity = originalIdentities.get(entry.path);
    if (identity) {
      const stat = lstatSync(join(input.destination, entry.path));
      expect({
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
        mtimeMs: stat.mtimeMs,
      }).toEqual(identity);
    }
  }
}

/** Enumerate the complete admission-only physical delta after refusal. */
function assertAdmissionDelta(inventory: Inventory) {
  assertOriginalFiles(inventory);
  const originalPaths = new Set(initialInventory.map((entry) => entry.path));
  const expected: { path: string; kind: string }[] = [
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
  ];
  expect(existsSync(familyPath("key-stage"))).toBe(false);
  expect(existsSync(join(input.destination, "operator", keyName))).toBe(false);
  const order = (a: { path: string }, b: { path: string }) =>
    a.path.localeCompare(b.path);
  expect(
    inventory
      .filter((entry) => !originalPaths.has(entry.path))
      .map(({ path, kind }) => ({ path, kind }))
      .sort(order)
  ).toEqual(expected.sort(order));
  expect(
    readFileSync(join(input.destination, "operator/weekly-runs.sqlite-wal"))
  ).toHaveLength(0);
  expect(
    inventory.find((entry) => entry.path === "operator/weekly-runs.sqlite-shm")
  ).toMatchObject({ kind: "file", size: 32_768 });
  expect(readdirSync(familyPath("admission-stage"))).toEqual([]);
  expect(existsSync(familyPath("result.json"))).toBe(false);
  expect(existsSync(familyPath("result-stage"))).toBe(false);
  const saved = readFileSync(familyPath("admission.json"));
  if (admissionBytes) expect(saved).toEqual(admissionBytes);
  else admissionBytes = saved;
}

async function refuse(mode: ProtocolMode | "no-go", cause: string) {
  if (failed) throw new Error("Earlier protocol failure preserved the fixture");
  phase(mode, "inventory-before");
  const beforeLaunch = opened.inventory();
  phase(mode, "inventory-after");
  const hadAdmission = existsSync(familyPath("admission.json"));
  let session: Session | undefined;
  let outcome: Outcome | undefined;
  try {
    phase(mode, "start-probe");
    session =
      mode === "no-go"
        ? await startRecoveryGmailCaptureDriftProbeForTest(input)
        : await startRecoveryGmailCaptureProtocolProbeForTest(input, mode);
    phase(mode, "started");
    // Attach rejection handling immediately, before awaiting any readiness.
    const result = captureOutcome(session.result);
    phase(mode, "await-paused");
    await session.paused;
    phase(mode, "paused");
    if (mode !== "no-go") {
      phase(mode, "resume");
      session.resume();
    }
    // No-resume deliberately exercises the real bounded 20-second timeout.
    // Either child or parent may win; the test does not claim which timer did.
    phase(mode, "await-result");
    outcome = await result;
    phase(mode, "result");
  } finally {
    if (session) {
      phase(mode, "stop");
      await session.stop();
      phase(mode, "stopped");
    }
  }
  if (!outcome)
    throw new Error("Protocol probe did not reach its terminal state");
  expect(outcome.status).toBe("rejected");
  if (outcome.status !== "rejected")
    throw new Error("Protocol probe unexpectedly completed");
  expect(outcome.error).toMatchObject({
    message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
    cause: { message: cause },
  });
  // Inspect only after joined stop. Hash inventories avoid treating ordinary
  // readonly SHM timestamp churn as a content change; no file is omitted.
  phase(mode, "inventory-before");
  const after = opened.inventory();
  assertAdmissionDelta(after);
  phase(mode, "inventory-after");
  if (hadAdmission) expect(after).toEqual(beforeLaunch);
  phase(mode, "journal-before");
  expect(logical(currentJournal())).toEqual(logical(baselineJournal));
  phase(mode, "journal-after");
  phase(mode, "inspector-before");
  expect(inspectRecoveryGmailCaptureAdmission(input)).toMatchObject({
    status: "capture-partial",
    activationAllowed: false,
    captureAllowed: false,
  });
  phase(mode, "inspector-after");
}

beforeAll(async () => {
  try {
    fixture = await createRecoveryGmailCaptureRuntimeFixture();
    const original = fixture.sourceReceipts.find(
      (item) => item.receipt.messageId === "a1"
    );
    if (!original) throw new Error("Missing retained original receipt a1");
    input = {
      ...fixture.input,
      batchId: fixture.batchIds[0]!,
      correctionOfByMessageId: { b1: original.receipt.receiptId },
    };
    // Signed evidence supplies this baseline before test-side SQL or admission.
    opened = openPreparedRuntimeForAdmission(input);
    initialInventory = opened.inventory();
    baselineJournal = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(opened.checkpoint.journal, "base64")
    );
    baselineJournal.ownership = baselineJournal.ownership.map((row) => ({
      ...row,
      expiresAtEpochMs: 0,
    }));
    originalIdentities = new Map(
      initialInventory
        .filter((entry) => entry.kind === "file")
        .map((entry) => {
          const stat = lstatSync(join(input.destination, entry.path));
          return [
            entry.path,
            {
              dev: stat.dev,
              ino: stat.ino,
              nlink: stat.nlink,
              mtimeMs: stat.mtimeMs,
            },
          ];
        })
    );
  } catch (error) {
    failed = true;
    throw error;
  }
});

afterAll(() => {
  if ((preserve || failed || activeCase !== undefined) && fixture)
    console.error(`Preserved protocol-negative fixture at ${fixture.base}`);
  fixture?.cleanup(preserve || failed || activeCase !== undefined);
});

describe.sequential("fixed retained Gmail capture protocol refusals", () => {
  it("rejects a runtime-invalid protocol mode before admission or SQL", () => {
    try {
      beginCase("invalid-mode");
      phase("invalid-mode", "start-probe");
      expect(() =>
        Reflect.apply(
          startRecoveryGmailCaptureProtocolProbeForTest,
          undefined,
          [input, "not-a-protocol-mode"]
        )
      ).toThrow("RECOVERY_GMAIL_CAPTURE_PROTOCOL_MODE_INVALID");
      phase("invalid-mode", "result");
      phase("invalid-mode", "inventory-before");
      expect(opened.inventory()).toEqual(initialInventory);
      expect(existsSync(familyPath("admission.json"))).toBe(false);
      phase("invalid-mode", "inventory-after");
      completeCase("invalid-mode");
    } catch (error) {
      failed = true;
      throw error;
    }
  });

  it("rejects an actual unexpected command before GO with admission-only effects", async () => {
    try {
      beginCase("unexpected-before-go");
      await refuse(
        "unexpected-before-go",
        "RECOVERY_GMAIL_CAPTURE_HANDSHAKE_INVALID"
      );
      completeCase("unexpected-before-go");
    } catch (error) {
      failed = true;
      throw error;
    }
  });

  it("rejects actual parent disconnection before GO with admission-only effects", async () => {
    try {
      beginCase("disconnect-before-go");
      await refuse(
        "disconnect-before-go",
        "RECOVERY_GMAIL_CAPTURE_HANDSHAKE_DISCONNECTED"
      );
      completeCase("disconnect-before-go");
    } catch (error) {
      failed = true;
      throw error;
    }
  });

  it("times out a genuinely unresumed pause with admission-only effects", async () => {
    try {
      beginCase("no-go");
      await refuse("no-go", "RECOVERY_GMAIL_CAPTURE_HANDSHAKE_TIMEOUT");
      completeCase("no-go");
    } catch (error) {
      failed = true;
      throw error;
    }
  });

  it("rejects an already delivered duplicate GO before key effects, then captures and replays", async () => {
    try {
      beginCase("duplicate-go");
      await refuse("duplicate-go", "RECOVERY_GMAIL_CAPTURE_HANDSHAKE_INVALID");
      phase("duplicate-go", "retry-before");
      const report = await resumeOperatorRecoveryGmailBatch(input);
      phase("duplicate-go", "retry-after");
      expect(report).toMatchObject({
        status: "capture-complete",
        activationAllowed: false,
        captureAllowed: false,
      });
      expect(report.receipts).toHaveLength(2);
      expect(
        report.receipts.every((receipt) => receipt.disposition === "ready")
      ).toBe(true);
      expect(readFileSync(familyPath("admission.json"))).toEqual(
        admissionBytes
      );
      phase("duplicate-go", "journal-before");
      const completed = currentJournal();
      phase("duplicate-go", "journal-after");
      expect(completed.runState).toEqual(baselineJournal.runState);
      expect(completed.stageArtifacts).toEqual(baselineJournal.stageArtifacts);
      for (const row of baselineJournal.intakeEvidence)
        expect(completed.intakeEvidence).toContainEqual(row);
      expect(
        completed.intakeEvidence.filter((row) => row.kind === "source")
      ).toHaveLength(2);
      phase("duplicate-go", "replay-before");
      expect(await resumeOperatorRecoveryGmailBatch(input)).toEqual(report);
      phase("duplicate-go", "replay-after");
      phase("duplicate-go", "journal-before");
      expect(currentJournal()).toEqual(completed);
      phase("duplicate-go", "journal-after");
      completeCase("duplicate-go");
      // Selected subsets stay preserved; cleanup requires the entire suite.
      preserve = completedCases.size !== 5;
    } catch (error) {
      failed = true;
      throw error;
    }
  });
});
