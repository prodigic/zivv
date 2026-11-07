import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startRecoveryGmailCaptureDriftProbeForTest } from "../../lib/ingestion/recovery-gmail-capture-drift-probe.js";
import {
  inspectRecoveryGmailCaptureAdmission,
  type RecoveryGmailCaptureInput,
  type RecoveryGmailCaptureReport,
} from "../../lib/ingestion/recovery-gmail-capture-admission.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../lib/ingestion/recovery-gmail-capture-admission.js", () => ({
  inspectRecoveryGmailCaptureAdmission: vi.fn(),
}));

// These tests cover parent event ordering, not retained-runtime authorization.
// Native protocol cases separately authenticate the actual worker and state delta.
class Child extends EventEmitter {
  stdin: Writable = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  connected = true;
  send = vi.fn((_message: string, done: (error: Error | null) => void) =>
    done(null)
  );
  kill = vi.fn(() => true);
  disconnect() {
    this.connected = false;
    this.emit("disconnect");
  }
}
const input: RecoveryGmailCaptureInput = {
  archive: Buffer.from("fixture"),
  retirementReceipt: Buffer.from("fixture"),
  recoveryKey: Buffer.alloc(32, 1),
  destination: "lifecycle-fixture",
  npmCli: "npm-cli.js",
  batchId: "a".repeat(64),
};
const pending = {
  status: "capture-pending" as const,
  activationAllowed: false as const,
  captureAllowed: false as const,
  batchId: input.batchId,
  receipts: [],
};
const complete: RecoveryGmailCaptureReport = {
  ...pending,
  status: "capture-complete",
  admissionSha256: "b".repeat(64),
  resultSha256: "c".repeat(64),
};
let child: Child;
let session:
  | Awaited<ReturnType<typeof startRecoveryGmailCaptureDriftProbeForTest>>
  | undefined;
let outcome: Promise<unknown>;
let settled: boolean;

beforeEach(() => {
  child = new Child();
  settled = false;
  session = undefined;
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>
  );
  vi.mocked(inspectRecoveryGmailCaptureAdmission).mockReturnValue(pending);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  child.emit("close", 1, null);
  await session?.stop();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
async function start() {
  session = await startRecoveryGmailCaptureDriftProbeForTest(input);
  outcome = session.result.then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      return error;
    }
  );
  child.emit("message", "ZIVV_GMAIL_CAPTURE_READY_V1");
  await session.paused;
  session.resume();
  await nextTurn();
}
async function endOutput() {
  child.stdout.end();
  child.stderr.end();
  await nextTurn();
}

it("settles a real exit with drained streams without requiring close", async () => {
  await start();
  child.disconnect();
  child.stderr.write(
    '{"captureError":"RECOVERY_GMAIL_CAPTURE_HANDSHAKE_INVALID"}'
  );
  await endOutput();
  child.emit("exit", 1, null);
  expect(await outcome).toMatchObject({
    cause: { message: "RECOVERY_GMAIL_CAPTURE_HANDSHAKE_INVALID" },
  });
  expect(child.listenerCount("close")).toBe(0);
});
it("does not settle from exit while either output stream is undrained", async () => {
  await start();
  child.disconnect();
  child.emit("exit", 1, null);
  await nextTurn();
  expect(settled).toBe(false);
  child.stderr.end();
  await nextTurn();
  expect(settled).toBe(false);
  child.stdout.end();
  await outcome;
  expect(settled).toBe(true);
});
it("does not confuse destroyed output with fully consumed output", async () => {
  await start();
  child.disconnect();
  child.stdout.destroy();
  child.stderr.end();
  child.emit("exit", 1, null);
  await nextTurn();
  expect(child.stdout.readableEnded).toBe(false);
  expect(settled).toBe(false);
});
it("requires an actual exit even after output and IPC have ended", async () => {
  await start();
  child.disconnect();
  await endOutput();
  expect(settled).toBe(false);
  child.emit("exit", 1, null);
  await outcome;
  expect(settled).toBe(true);
});
it("requires IPC disconnection in addition to exit and drained output", async () => {
  await start();
  await endOutput();
  child.emit("exit", 1, null);
  await nextTurn();
  expect(settled).toBe(false);
  child.disconnect();
  await outcome;
  expect(settled).toBe(true);
});
it("authenticates the completed report before accepting a drained zero exit", async () => {
  await start();
  vi.mocked(inspectRecoveryGmailCaptureAdmission).mockReturnValue(complete);
  child.stdout.write(JSON.stringify(complete));
  child.disconnect();
  await endOutput();
  child.emit("exit", 0, null);
  expect(await outcome).toEqual(complete);
  expect(inspectRecoveryGmailCaptureAdmission).toHaveBeenCalledTimes(2);
});
it("rejects unauthenticated output despite a drained zero exit", async () => {
  await start();
  child.stdout.write(JSON.stringify(complete));
  child.disconnect();
  await endOutput();
  child.emit("exit", 0, null);
  expect(await outcome).toMatchObject({
    message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
  });
});
it("preserves a nonzero exit even when output claims capture success", async () => {
  await start();
  vi.mocked(inspectRecoveryGmailCaptureAdmission).mockReturnValue(complete);
  child.stdout.write(JSON.stringify(complete));
  child.disconnect();
  await endOutput();
  child.emit("exit", 1, null);
  expect(await outcome).toMatchObject({
    message: "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED",
  });
  expect(inspectRecoveryGmailCaptureAdmission).toHaveBeenCalledTimes(1);
});

it("requires stdin to finish rather than assuming exit consumed its input", async () => {
  let release: (() => void) | undefined;
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      release = done;
    },
  });
  await start();
  child.disconnect();
  await endOutput();
  child.emit("exit", 1, null);
  await nextTurn();
  expect(settled).toBe(false);
  if (!release) throw new Error("No pending input write");
  release();
  await outcome;
  expect(settled).toBe(true);
});
