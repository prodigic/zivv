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
const lifecycleTraceLimit = 64;
type LifecycleTraceEvent =
  | "spawn"
  | "ready"
  | "action"
  | "disconnect"
  | "exit"
  | "close"
  | "exit-drained"
  | "stdout-ended"
  | "stderr-ended"
  | "stdin-finished"
  | "stdin-closed"
  | "overalltimer"
  | "pausetimer"
  | "disconnect-grace"
  | "requestStop"
  | "kill-result-true"
  | "kill-result-false"
  | "kill-result-threw"
  | "result-succeeded"
  | "result-rejected"
  | "stop-enter"
  | "stop-childclosed"
  | "stop-result-settled";

export interface RecoveryGmailCaptureDriftProbeSession {
  paused: Promise<void>;
  result: Promise<RecoveryGmailCaptureReport>;
  resume(): void;
  stop(): Promise<void>;
}

const protocolProbeModes = [
  "unexpected-before-go",
  "disconnect-before-go",
  "duplicate-go",
  "duplicate-go-racing",
] as const;
export type RecoveryGmailCaptureProtocolProbeMode =
  (typeof protocolProbeModes)[number];

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
export function startRecoveryGmailCaptureDriftProbeForTest(
  supplied: RecoveryGmailCaptureInput
): Promise<RecoveryGmailCaptureDriftProbeSession> {
  return startProbe(supplied);
}

/** Exercise one fixed child-side handshake refusal without exposing IPC. */
export function startRecoveryGmailCaptureProtocolProbeForTest(
  supplied: RecoveryGmailCaptureInput,
  mode: RecoveryGmailCaptureProtocolProbeMode
): Promise<RecoveryGmailCaptureDriftProbeSession> {
  if (!protocolProbeModes.includes(mode))
    throw new Error("RECOVERY_GMAIL_CAPTURE_PROTOCOL_MODE_INVALID");
  return startProbe(supplied, mode);
}

async function startProbe(
  supplied: RecoveryGmailCaptureInput,
  protocolMode?: RecoveryGmailCaptureProtocolProbeMode
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
      console.log(JSON.stringify(await execute(input, ${JSON.stringify(protocolMode === "duplicate-go" ? "pause-before-key-guard-duplicate" : "pause-before-key-guard")})));
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
  let traceCount = 0;
  const trace = (event: LifecycleTraceEvent) => {
    if (traceCount >= lifecycleTraceLimit) return;
    traceCount += 1;
    try {
      console.error(
        "ZIVV_GMAIL_CAPTURE_PROBE_TRACE",
        JSON.stringify({
          timestamp: Date.now(),
          mode: protocolMode ?? "drift",
          pid: child.pid ?? null,
          event,
        })
      );
    } catch {
      // Diagnostics never participate in admission, authority, or cleanup.
    }
  };
  trace("spawn");
  const childInput = child.stdin;
  const childOutput = child.stdout;
  const childDiagnostic = child.stderr;

  let output = "";
  let diagnostic = "";
  let outputBytes = 0;
  let ready = false;
  let resumed = false;
  let protocolActionIssued = false;
  let finalized = false;
  let ipcDisconnected = !child.connected;
  let inputFailure = false;
  let exited:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined;
  let stopError: Error | undefined;
  let protocolSendFailure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopPromise: Promise<void> | undefined;
  let terminateResolve!: () => void;
  const childTerminated = new Promise<void>((resolveTerminate) => {
    terminateResolve = resolveTerminate;
  });

  const clearTimers = () => {
    if (timer) clearTimeout(timer);
    if (pauseTimer) clearTimeout(pauseTimer);
    if (disconnectTimer) clearTimeout(disconnectTimer);
    timer = undefined;
    pauseTimer = undefined;
    disconnectTimer = undefined;
  };

  const killChild = () => {
    if (finalized) return;
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, "SIGKILL");
        trace("kill-result-true");
      } else {
        trace(child.kill("SIGKILL") ? "kill-result-true" : "kill-result-false");
      }
    } catch {
      trace("kill-result-threw");
      try {
        trace(child.kill("SIGKILL") ? "kill-result-true" : "kill-result-false");
      } catch {
        trace("kill-result-threw");
      }
    }
    childInput?.destroy();
  };

  const requestStop = (error: Error) => {
    if (finalized) return;
    trace("requestStop");
    stopError ??= error;
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = undefined;
    killChild();
  };

  const onMessage = (message: unknown, handle?: unknown) => {
    if (handle !== undefined || ready || message !== readyMessage) {
      requestStop(failure(handshakeError));
      return;
    }
    trace("ready");
    ready = true;
    paused.resolve(undefined);
    pauseTimer = setTimeout(() => {
      trace("pausetimer");
      requestStop(failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_TIMEOUT"));
    }, pauseTimeoutMs);
  };

  const onDisconnect = () => {
    trace("disconnect");
    ipcDisconnected = true;
    tryFinishExitDrained();
    if (resumed || protocolActionIssued || finalized) return;
    if (!ready) {
      requestStop(failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_DISCONNECTED"));
      return;
    }
    if (!disconnectTimer) {
      trace("disconnect-grace");
      disconnectTimer = setTimeout(() => {
        if (!finalized)
          requestStop(failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_DISCONNECTED"));
      }, 2000);
    }
  };

  const onOutputData = (chunk: Buffer) => {
    if (finalized) return;
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) {
      requestStop(failure("RECOVERY_GMAIL_CAPTURE_OUTPUT_LIMIT"));
      return;
    }
    output += chunk.toString("utf8");
  };
  const onDiagnosticData = (chunk: Buffer) => {
    if (finalized) return;
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) {
      requestStop(failure("RECOVERY_GMAIL_CAPTURE_OUTPUT_LIMIT"));
      return;
    }
    diagnostic += chunk.toString("utf8");
  };
  const onOutputEnd = () => {
    trace("stdout-ended");
    tryFinishExitDrained();
  };
  const onDiagnosticEnd = () => {
    trace("stderr-ended");
    tryFinishExitDrained();
  };
  const onInputFinish = () => {
    trace("stdin-finished");
    tryFinishExitDrained();
  };
  const onInputClose = () => {
    trace("stdin-closed");
    tryFinishExitDrained();
  };
  const onInputError = () => {
    inputFailure = true;
    requestStop(failure("RECOVERY_GMAIL_CAPTURE_INPUT_FAILED"));
  };
  const onOutputError = () =>
    requestStop(failure("RECOVERY_GMAIL_CAPTURE_OUTPUT_FAILED"));
  const onChildError = () =>
    requestStop(failure("RECOVERY_GMAIL_CAPTURE_CHILD_FAILED"));
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    trace("exit");
    exited = { code, signal };
    tryFinishExitDrained();
  };
  const detachListeners = () => {
    child.off("message", onMessage);
    child.off("disconnect", onDisconnect);
    child.off("error", onChildError);
    child.off("exit", onExit);
    child.off("close", onClose);
    childOutput?.off("data", onOutputData);
    childOutput?.off("end", onOutputEnd);
    childOutput?.off("error", onOutputError);
    childOutput?.off("close", onOutputClose);
    childDiagnostic?.off("data", onDiagnosticData);
    childDiagnostic?.off("end", onDiagnosticEnd);
    childDiagnostic?.off("error", onOutputError);
    childDiagnostic?.off("close", onDiagnosticClose);
    childInput?.off("error", onInputError);
    childInput?.off("finish", onInputFinish);
    childInput?.off("close", onInputClose);
  };
  const finish = (
    code: number | null,
    signal: NodeJS.Signals | null,
    provenance: "close" | "exit-drained"
  ) => {
    if (finalized) return;
    finalized = true;
    trace(provenance);
    clearTimers();
    detachListeners();
    terminateResolve();
    if (stopError) {
      if (!ready) paused.reject(stopError);
      trace("result-rejected");
      result.reject(stopError);
      return;
    }
    if (
      !ready ||
      (!resumed && !protocolActionIssued) ||
      code !== 0 ||
      signal !== null
    ) {
      const hasChildFailure = /\{"captureError":"[A-Z0-9_]{1,80}"/u.test(
        diagnostic
      );
      const error = !ready
        ? failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_NOT_READY")
        : hasChildFailure
          ? captureFailure(diagnostic)
          : protocolSendFailure
            ? protocolSendFailure
            : !resumed && !protocolActionIssued
              ? failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_NOT_RESUMED")
              : captureFailure(diagnostic);
      if (!ready) paused.reject(error);
      trace("result-rejected");
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
      trace("result-succeeded");
      result.resolve(completedReport(completed));
    })().catch((error: unknown) => {
      trace("result-rejected");
      result.reject(error instanceof Error ? error : new Error(executionError));
    });
  };
  const tryFinishExitDrained = () => {
    if (finalized || !exited) return;
    const inputDrained =
      childInput?.writableFinished === true ||
      ((stopError !== undefined || inputFailure) &&
        childInput?.destroyed === true);
    if (
      childOutput?.readableEnded === true &&
      childDiagnostic?.readableEnded === true &&
      inputDrained &&
      (ipcDisconnected || !child.connected)
    ) {
      finish(exited.code, exited.signal, "exit-drained");
    }
  };
  const onOutputClose = () => tryFinishExitDrained();
  const onDiagnosticClose = () => tryFinishExitDrained();
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    finish(code, signal, "close");
  };

  child.on("message", onMessage);
  child.on("disconnect", onDisconnect);
  child.on("error", onChildError);
  child.on("exit", onExit);
  child.on("close", onClose);
  childOutput?.on("data", onOutputData);
  childOutput?.on("end", onOutputEnd);
  childOutput?.on("error", onOutputError);
  childOutput?.on("close", onOutputClose);
  childDiagnostic?.on("data", onDiagnosticData);
  childDiagnostic?.on("end", onDiagnosticEnd);
  childDiagnostic?.on("error", onOutputError);
  childDiagnostic?.on("close", onDiagnosticClose);
  childInput?.on("error", onInputError);
  childInput?.on("finish", onInputFinish);
  childInput?.on("close", onInputClose);

  timer = setTimeout(() => {
    trace("overalltimer");
    requestStop(failure(executionError));
  }, childTimeoutMs);
  if (!childInput || !childOutput || !childDiagnostic) {
    requestStop(failure("RECOVERY_GMAIL_CAPTURE_CHILD_PIPE_UNAVAILABLE"));
  } else {
    childInput.end(wire);
  }

  const resume = () => {
    if (!ready || resumed || protocolActionIssued || finalized || stopError)
      throw new Error(handshakeError);
    trace("action");
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = undefined;
    if (protocolMode) {
      protocolActionIssued = true;
      if (protocolMode === "disconnect-before-go") {
        try {
          child.disconnect();
        } catch {
          requestStop(failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_SEND_FAILED"));
        }
        return;
      }
      const message =
        protocolMode === "unexpected-before-go"
          ? "ZIVV_GMAIL_CAPTURE_INVALID_V1"
          : goMessage;
      const duplicate =
        protocolMode === "duplicate-go" ||
        protocolMode === "duplicate-go-racing";
      if (duplicate) resumed = true;
      const send = () => {
        try {
          child.send(message, (error) => {
            if (error)
              protocolSendFailure ??= failure(
                "RECOVERY_GMAIL_CAPTURE_HANDSHAKE_SEND_FAILED"
              );
          });
        } catch {
          requestStop(failure("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_SEND_FAILED"));
        }
      };
      send();
      if (duplicate) send();
      return;
    }
    resumed = true;
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
    trace("stop-enter");
    const settled = childTerminated.then(async () => {
      trace("stop-childclosed");
      await Promise.all([
        paused.promise.catch(() => undefined),
        result.promise.catch(() => undefined),
      ]);
      trace("stop-result-settled");
    });
    if (finalized) return settled;
    if (!stopPromise) {
      requestStop(failure("RECOVERY_GMAIL_CAPTURE_PROBE_STOPPED"));
      stopPromise = settled;
    }
    return stopPromise;
  };

  return { paused: paused.promise, result: result.promise, resume, stop };
}
