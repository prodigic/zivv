import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectRecoveryGmailCaptureAdmission,
  type RecoveryGmailCaptureInput,
  type RecoveryGmailCaptureReport,
} from "./recovery-gmail-capture-admission.js";
import {
  decodeRecoveryGmailCaptureFrame,
  encodeRecoveryGmailCaptureFrame,
  MAX_RECOVERY_GMAIL_CAPTURE_FRAME_BYTES,
} from "./recovery-gmail-capture-framing.js";
import { canonicalJson } from "./sqlite-store.js";

const executionError = "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED";
const handshakeError = "RECOVERY_GMAIL_CAPTURE_HANDSHAKE_PROTOCOL_ERROR";
const readyMessage = "ZIVV_GMAIL_CAPTURE_READY_V1";
const goMessage = "ZIVV_GMAIL_CAPTURE_GO_V1";
const outputLimit = 64 * 1024;
const childTimeoutMs = 150_000;
const pauseTimeoutMs = 20_000;

export interface RecoveryGmailCaptureDriftProbeSession {
  paused: Promise<void>;
  result: Promise<RecoveryGmailCaptureReport>;
  resume(): void;
  stop(): Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function failure(code: string, frames?: string[]): Error {
  const cause = new Error(code, frames?.length ? { cause: frames } : undefined);
  return new Error(executionError, { cause });
}

function captureFailure(diagnostic: string): Error {
  const code = /\{"captureError":"([A-Z0-9_]{1,80})"/u.exec(diagnostic)?.[1];
  const frames = diagnostic.match(/[A-Za-z0-9-]+\.js:\d+:\d+/gu)?.slice(0, 8);
  return failure(code ?? executionError, frames);
}

function completedReport(
  value: Awaited<ReturnType<typeof inspectRecoveryGmailCaptureAdmission>>
): RecoveryGmailCaptureReport {
  if (
    value.status !== "capture-complete" ||
    !value.admissionSha256 ||
    !/^[a-f0-9]{64}$/u.test(value.admissionSha256) ||
    !value.resultSha256 ||
    !/^[a-f0-9]{64}$/u.test(value.resultSha256)
  )
    throw new Error(executionError);
  return {
    ...value,
    status: "capture-complete",
    admissionSha256: value.admissionSha256,
    resultSha256: value.resultSha256,
  };
}

/**
 * Start one fixed retained-worker pause for test-owned drift mutation.
 * The only accepted IPC command is the literal GO token after the READY token.
 */
export async function startRecoveryGmailCaptureDriftProbeForTest(
  supplied: RecoveryGmailCaptureInput
): Promise<RecoveryGmailCaptureDriftProbeSession> {
  const wire = encodeRecoveryGmailCaptureFrame(supplied);
  const input = decodeRecoveryGmailCaptureFrame(Buffer.from(wire));
  const observed = await inspectRecoveryGmailCaptureAdmission(input);
  if (observed.status === "capture-complete")
    throw new Error("RECOVERY_GMAIL_CAPTURE_DRIFT_PROBE_NOT_PENDING");

  const root = resolve(input.destination);
  const entry = pathToFileURL(
    join(
      root,
      "checkout/dist/lib/ingestion/recovery-gmail-capture-admission.js"
    )
  ).href;
  const framing = pathToFileURL(
    join(root, "checkout/dist/lib/ingestion/recovery-gmail-capture-framing.js")
  ).href;
  const script = `
    try {
      const coordinator = await import(${JSON.stringify(entry)});
      const {decodeRecoveryGmailCaptureFrame: decode} = await import(${JSON.stringify(framing)});
      const execute = coordinator.executeRecoveredGmailBatchCaptureForTest;
      if (coordinator.recoveryGmailCaptureExecutorVersion !== 2 || typeof execute !== 'function' || typeof decode !== 'function') throw Error('RECOVERY_GMAIL_CAPTURE_UNSUPPORTED_RUNTIME');
      let size = 0; const chunks = [];
      for await (const chunk of process.stdin) {
        if ((size += chunk.length) > ${MAX_RECOVERY_GMAIL_CAPTURE_FRAME_BYTES}) throw Error('INVALID_RECOVERY_GMAIL_CAPTURE_FRAME');
        chunks.push(chunk);
      }
      const input = decode(Buffer.concat(chunks, size));
      console.log(JSON.stringify(await execute(input, 'pause-before-key-guard')));
    } catch(error) {
      const captureFrames = error instanceof Error
        ? (error.stack ?? '').split('\\n').slice(1).flatMap(line => {
            const match = /([A-Za-z0-9-]+\\.js):(\\d+):(\\d+)/.exec(line);
            return match ? [match[1] + ':' + match[2] + ':' + match[3]] : [];
          }).slice(0, 8)
        : [];
      console.error(JSON.stringify({captureError:error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : '${executionError}', captureFrames}));
      process.exitCode = 1;
    }
  `;
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  env.ZIVV_LEDGER_HOME = join(root, "operator");
  env.ZIVV_RECOVERY_GMAIL_CAPTURE_EXECUTOR = "1";

  const paused = deferred<void>();
  const result = deferred<RecoveryGmailCaptureReport>();
  // The public session may not be consumed immediately; prevent early rejected
  // promises from becoming process-level unhandled rejections.
  void paused.promise.catch(() => undefined);
  void result.promise.catch(() => undefined);

  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(root, "bootstrap/module-boundary.mjs")).href,
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: join(root, "checkout"),
      env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
    }
  );
  const childInput = child.stdin;
  const childOutput = child.stdout;
  const childDiagnostic = child.stderr;

  let output = "";
  let diagnostic = "";
  let outputBytes = 0;
  let ready = false;
  let resumed = false;
  let closed = false;
  let stopError: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  let stopPromise: Promise<void> | undefined;
  let closeResolve!: () => void;
  const childClosed = new Promise<void>((resolveClose) => {
    closeResolve = resolveClose;
  });

  const clearTimers = () => {
    if (timer) clearTimeout(timer);
    if (pauseTimer) clearTimeout(pauseTimer);
    timer = undefined;
    pauseTimer = undefined;
  };

  const killChild = () => {
    if (closed) return;
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    childInput?.destroy();
  };

  const requestStop = (error: Error) => {
    stopError ??= error;
    killChild();
  };

  const onMessage = (message: unknown, handle?: unknown) => {
    if (handle !== undefined || ready || message !== readyMessage) {
      requestStop(failure(handshakeError));
      return;
    }
    ready = true;
    paused.resolve(undefined);
    pauseTimer = setTimeout(
      () => requestStop(failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_TIMEOUT")),
      pauseTimeoutMs
    );
  };

  const onDisconnect = () => {
    if (!resumed && !closed)
      requestStop(failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_DISCONNECTED"));
  };

  child.on("message", onMessage);
  child.on("disconnect", onDisconnect);
  childOutput?.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) {
      requestStop(failure("RECOVERY_GMAIL_CAPTURE_OUTPUT_LIMIT"));
      return;
    }
    output += chunk.toString("utf8");
  });
  childDiagnostic?.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) {
      requestStop(failure("RECOVERY_GMAIL_CAPTURE_OUTPUT_LIMIT"));
      return;
    }
    diagnostic += chunk.toString("utf8");
  });
  childInput?.on("error", () =>
    requestStop(failure("RECOVERY_GMAIL_CAPTURE_INPUT_FAILED"))
  );
  child.on("error", () =>
    requestStop(failure("RECOVERY_GMAIL_CAPTURE_CHILD_FAILED"))
  );
  child.on("close", (code, signal) => {
    closed = true;
    clearTimers();
    child.off("message", onMessage);
    child.off("disconnect", onDisconnect);
    closeResolve();
    if (stopError) {
      if (!ready) paused.reject(stopError);
      result.reject(stopError);
      return;
    }
    if (!ready || !resumed || code !== 0 || signal !== null) {
      const error = !ready
        ? failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_NOT_READY")
        : !resumed
          ? failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_NOT_RESUMED")
          : captureFailure(diagnostic);
      if (!ready) paused.reject(error);
      result.reject(error);
      return;
    }
    void (async () => {
      let reported: unknown;
      try {
        reported = JSON.parse(output) as unknown;
      } catch {
        throw new Error(executionError);
      }
      const completed = await inspectRecoveryGmailCaptureAdmission(input);
      if (
        completed.status !== "capture-complete" ||
        canonicalJson(reported) !== canonicalJson(completed)
      )
        throw new Error(executionError);
      result.resolve(completedReport(completed));
    })().catch((error: unknown) => {
      result.reject(error instanceof Error ? error : new Error(executionError));
    });
  });

  timer = setTimeout(
    () => requestStop(failure(executionError)),
    childTimeoutMs
  );
  if (!childInput || !childOutput || !childDiagnostic) {
    requestStop(failure("RECOVERY_GMAIL_CAPTURE_CHILD_PIPE_UNAVAILABLE"));
  } else {
    childInput.end(wire);
  }

  const resume = () => {
    if (!ready || resumed || closed || stopError)
      throw new Error(handshakeError);
    resumed = true;
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = undefined;
    try {
      child.send(goMessage, (error) => {
        if (error)
          requestStop(failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_SEND_FAILED"));
      });
    } catch {
      requestStop(failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_SEND_FAILED"));
    }
  };

  const stop = (): Promise<void> => {
    const settled = childClosed.then(async () => {
      await Promise.all([
        paused.promise.catch(() => undefined),
        result.promise.catch(() => undefined),
      ]);
    });
    if (closed) return settled;
    if (!stopPromise) {
      requestStop(failure("RECOVERY_GMAIL_CAPTURE_PROBE_STOPPED"));
      stopPromise = settled;
    }
    return stopPromise;
  };

  return { paused: paused.promise, result: result.promise, resume, stop };
}
