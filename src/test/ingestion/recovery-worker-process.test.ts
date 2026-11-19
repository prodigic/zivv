import { describe, expect, it } from "vitest";
import { runRecoveryWorkerProcess } from "../../lib/ingestion/recovery-worker-process.js";
import { withRecoveryWindowsJobRunner } from "../../lib/ingestion/recovery-windows-job-runner.js";

// Only ambient values needed to start Node and the reviewed Windows runner.
const env: NodeJS.ProcessEnv = {};
for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
const cwd = process.cwd();
const input = Buffer.from([0, 255, 13, 10, 128, 65]);

async function supervised<T>(
  run: (jobRunner?: string) => Promise<T>
): Promise<T> {
  return process.platform === "win32"
    ? withRecoveryWindowsJobRunner(run)
    : run();
}

describe("recovery worker process transport", () => {
  it("drains split stdout and stderr and preserves binary stdin", async () => {
    const script = [
      "const chunks=[];",
      "process.stdin.on('data',c=>chunks.push(c));",
      "process.stdin.on('end',()=>{",
      "process.stdout.write('first:');process.stderr.write('diag:');",
      "setImmediate(()=>{process.stdout.write(Buffer.concat(chunks).toString('hex'));process.stderr.write('end');});",
      "});",
    ].join("");
    const result = await supervised((jobRunner) =>
      runRecoveryWorkerProcess({
        cwd,
        env,
        nodeArgs: ["-e", script],
        input,
        deadlineMs: 10_000,
        jobRunner,
      })
    );
    expect(result).toEqual({
      status: "exited",
      code: 0,
      signal: null,
      stdout: Buffer.from(`first:${input.toString("hex")}`),
      stderr: Buffer.from("diag:end"),
    });
  }, 45_000);

  it("does not return over-limit output as a successful exit", async () => {
    const script =
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('x'.repeat(65537));});";
    const result = await supervised((jobRunner) =>
      runRecoveryWorkerProcess({
        cwd,
        env,
        nodeArgs: ["-e", script],
        input,
        deadlineMs: 5_000,
        jobRunner,
      })
    );
    expect(["transport-error", "stopped"]).toContain(result.status);
  }, 45_000);

  it("enforces the combined stdout and stderr cap", async () => {
    const script =
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('x'.repeat(32769));process.stderr.write('y'.repeat(32768));});";
    const result = await supervised((jobRunner) =>
      runRecoveryWorkerProcess({
        cwd,
        env,
        nodeArgs: ["-e", script],
        input,
        deadlineMs: 5_000,
        jobRunner,
      })
    );
    expect(["transport-error", "stopped"]).toContain(result.status);
  }, 45_000);
});

describe.skipIf(process.platform !== "win32")(
  "reviewed Windows job transport",
  () => {
    it("reports the native confirmed failed child exit 220", async () => {
      const result = await withRecoveryWindowsJobRunner((jobRunner) =>
        runRecoveryWorkerProcess({
          cwd,
          env,
          nodeArgs: [
            "-e",
            "process.stdin.resume();process.stdin.on('end',()=>{process.exitCode=7;});",
          ],
          input,
          deadlineMs: 10_000,
          jobRunner,
        })
      );
      expect(result).toMatchObject({
        status: "exited",
        code: 220,
        signal: null,
      });
    }, 45_000);

    it("reports a confirmed deadline stop", async () => {
      const result = await withRecoveryWindowsJobRunner((jobRunner) =>
        runRecoveryWorkerProcess({
          cwd,
          env,
          nodeArgs: ["-e", "process.stdin.resume();setInterval(()=>{},1000);"],
          input,
          deadlineMs: 1_000,
          jobRunner,
        })
      );
      expect(result).toEqual({ status: "stopped" });
    }, 45_000);
  }
);
