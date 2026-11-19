import { spawn } from "node:child_process";

export type RecoveryWorkerProcessResult =
  | {
      status: "exited";
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: Buffer;
      stderr: Buffer;
    }
  | {
      status:
        | "setup-refused"
        | "stopped"
        | "termination-unconfirmed"
        | "transport-error";
    };

interface RecoveryWorkerProcessInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  nodeArgs: readonly string[];
  input: Buffer;
  deadlineMs: number;
  jobRunner?: string;
}

const maxOutputBytes = 64 * 1024;

/** Wait for the actual child exit and drain all three bounded pipes. */
export function runRecoveryWorkerProcess({
  cwd,
  env,
  nodeArgs,
  input,
  deadlineMs,
  jobRunner,
}: RecoveryWorkerProcessInput): Promise<RecoveryWorkerProcessResult> {
  return new Promise((settle) => {
    const child = spawn(
      jobRunner ?? process.execPath,
      jobRunner
        ? [
            String(process.pid),
            String(deadlineMs),
            process.execPath,
            cwd,
            ...nodeArgs,
          ]
        : nodeArgs,
      {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: Boolean(jobRunner) || process.platform !== "win32",
      }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    let overLimit = false;
    let ioFailed = false;
    let stopRequested = false;
    let termination: ReturnType<typeof setTimeout> | undefined;
    let exited:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;

    function finish() {
      if (
        settled ||
        !exited ||
        !(child.stdout.readableEnded || child.stdout.destroyed) ||
        !(child.stderr.readableEnded || child.stderr.destroyed) ||
        !(child.stdin.writableFinished || child.stdin.destroyed)
      )
        return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(termination);

      if (jobRunner) {
        // Native setup refusal proves the child never started, even with EPIPE.
        if (!exited.signal && exited.code === 223) {
          settle({ status: "setup-refused" });
          return;
        }
        if (
          stopRequested ||
          exited.signal ||
          (exited.code !== 0 &&
            exited.code !== 220 &&
            exited.code !== 221 &&
            exited.code !== 222)
        ) {
          settle({ status: "termination-unconfirmed" });
          return;
        }
        if (exited.code === 221 || exited.code === 222) {
          settle({ status: "stopped" });
          return;
        }
      }
      if (
        stopRequested ||
        overLimit ||
        ioFailed ||
        !child.stdin.writableFinished
      ) {
        settle({ status: "transport-error" });
        return;
      }
      settle({
        status: "exited",
        ...exited,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    }

    function stop() {
      if (settled || stopRequested) return;
      stopRequested = true;
      clearTimeout(timer);
      try {
        if (!jobRunner && process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      child.stdin.destroy();
      termination = setTimeout(() => {
        if (settled) return;
        settled = true;
        settle({ status: "termination-unconfirmed" });
      }, 10_000);
      finish();
    }

    function collect(chunks: Buffer[], chunk: Buffer) {
      if (overLimit) return;
      size += chunk.length;
      if (size <= maxOutputBytes) {
        chunks.push(chunk);
        return;
      }
      overLimit = true;
      // Native supervision must confirm an empty job even after pipe overflow.
      if (!jobRunner) stop();
    }

    function streamFailed() {
      ioFailed = true;
      if (!jobRunner) stop();
      finish();
    }

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdout.on("end", finish);
    child.stderr.on("end", finish);
    child.stdin.on("finish", finish);
    child.stdout.on("error", streamFailed);
    child.stderr.on("error", streamFailed);
    child.stdin.on("error", streamFailed);
    child.stdout.on("close", finish);
    child.stderr.on("close", finish);
    child.stdin.on("close", finish);
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      finish();
    });
    child.on("error", () => {
      if (!child.pid) {
        settled = true;
        clearTimeout(timer);
        clearTimeout(termination);
        settle({ status: "transport-error" });
      } else stop();
    });
    child.on("close", finish);
    const timer = setTimeout(stop, deadlineMs + (jobRunner ? 20_000 : 0));
    child.stdin.end(input);
  });
}
