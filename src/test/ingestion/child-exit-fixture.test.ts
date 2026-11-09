import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { captureChildExit } from "./fixtures/child-exit-fixture.js";

// Issue #179 regression coverage: two-process recovery-key initialization
// children reported a settled exit before their captured stdout had drained,
// so one successful child could surface an empty digest. Settlement must
// treat process exit and stream drainage as separate conditions; output
// delivered after the "exit" event still has to be captured.
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
}

type Tracked = { done: boolean; outcome: Promise<unknown> };
function track(child: ChildProcess): Tracked {
  const outcome = captureChildExit(child).then(
    (value) => value,
    (error: unknown) => error
  );
  const state: Tracked = { done: false, outcome };
  void outcome.then(() => {
    state.done = true;
  });
  return state;
}

it("captures output that arrives only after the exit event", async () => {
  const digest = "a".repeat(64);
  const child = new FakeChild() as unknown as ChildProcess;
  const tracked = track(child);
  // The child exits 0 before its buffered digest is delivered to the
  // parent: exactly the previously racy ordering.
  child.emit("exit", 0, null);
  await nextTurn();
  expect(tracked.done).toBe(false);
  child.stdout.write(digest);
  child.stdout.end();
  await nextTurn();
  expect(tracked.done).toBe(false);
  child.stderr.end();
  expect(await tracked.outcome).toEqual({
    code: 0,
    signal: null,
    stdout: digest,
    stderr: "",
  });
  expect(tracked.done).toBe(true);
});

it("does not settle from exit while either captured pipe is undrained", async () => {
  const child = new FakeChild() as unknown as ChildProcess;
  const tracked = track(child);
  child.emit("exit", 1, null);
  await nextTurn();
  expect(tracked.done).toBe(false);
  child.stderr.end();
  await nextTurn();
  expect(tracked.done).toBe(false);
  child.stdout.end();
  expect(await tracked.outcome).toEqual({
    code: 1,
    signal: null,
    stdout: "",
    stderr: "",
  });
});

it("settles through the child close event without a prior exit", async () => {
  const child = new FakeChild() as unknown as ChildProcess;
  const tracked = track(child);
  child.stdout.end();
  child.stderr.end();
  await nextTurn();
  expect(tracked.done).toBe(false);
  child.emit("close", 1, "SIGKILL");
  expect(await tracked.outcome).toEqual({
    code: 1,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
  });
});

it("rejects on child spawn failures without resolving the close path", async () => {
  const child = new FakeChild() as unknown as ChildProcess;
  const tracked = track(child);
  child.emit("error", new Error("spawn ENOENT"));
  child.emit("close", 1, null);
  expect(await tracked.outcome).toEqual(new Error("spawn ENOENT"));
});

it("settles a real child whose output precedes its close", async () => {
  const real = spawn(
    process.execPath,
    ["--input-type=module", "-e", "console.log('settled-digest');"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  const settled = await captureChildExit(real);
  expect(settled).toMatchObject({
    code: 0,
    signal: null,
    stdout: "settled-digest\n",
  });
});
