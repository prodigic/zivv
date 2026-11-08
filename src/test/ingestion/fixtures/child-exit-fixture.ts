import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/** Captured output plus the settled exit of a piped child process. */
export interface SettledChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Resolve only after the child has exited AND its captured stream pipes have
 * fully drained. The "exit" event can precede the delivery of buffered pipe
 * chunks, so settling on "exit" alone can drop a child's final output
 * (issue #179). Resolution therefore waits for every readable to drain and
 * falls back to the child "close" event, which also fires after process exit
 * plus closed stdio streams. Output arriving after "exit" is still included.
 */
export function captureChildExit(
  child: ChildProcess
): Promise<SettledChildExit> {
  return new Promise<SettledChildExit>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let exited = false;
    let settled = false;
    type CapturedPipe = {
      readable: Readable;
      closed: boolean;
      data: (chunk: Buffer) => void;
      close: () => void;
    };
    const pipes: CapturedPipe[] = [];

    const drained = (): boolean =>
      pipes.every(
        (pipe) => pipe.closed || pipe.readable.readableEnded === true
      );
    const assign = (
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null
    ): void => {
      if (!exited) {
        code = exitCode;
        signal = exitSignal;
      }
      exited = true;
    };
    const finalize = (): void => {
      if (settled) return;
      settled = true;
      detach();
      resolve({ code, signal, stdout, stderr });
    };
    const settle = (): void => {
      if (exited && drained()) finalize();
    };
    function onExit(
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null
    ): void {
      assign(exitCode, exitSignal);
      settle();
    }
    function onClose(
      closeCode: number | null,
      closeSignal: NodeJS.Signals | null
    ): void {
      assign(closeCode, closeSignal);
      finalize();
    }
    function onError(error: Error): void {
      if (settled) return;
      detach();
      reject(error);
    }
    function detach(): void {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      for (const pipe of pipes) {
        pipe.readable.off("data", pipe.data);
        pipe.readable.off("close", pipe.close);
      }
    }

    child.on("error", onError);
    child.on("exit", onExit);
    child.on("close", onClose);
    attach(child.stdout, true);
    attach(child.stderr, false);

    function attach(readable: Readable | null, toStdout: boolean): void {
      if (readable === null) return;
      const pipe: CapturedPipe = {
        readable,
        closed: false,
        data: (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          if (toStdout) stdout += text;
          else stderr += text;
        },
        close: () => {
          pipe.closed = true;
          settle();
        },
      };
      pipes.push(pipe);
      readable.on("data", pipe.data);
      readable.once("close", pipe.close);
    }
  });
}
