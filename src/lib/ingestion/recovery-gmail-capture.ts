import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectRecoveryGmailCaptureAdmission,
  RECOVERY_GMAIL_CAPTURE_INTERRUPTION_POINTS,
  type CaptureInterruption,
  type RecoveryGmailCaptureInput,
  type RecoveryGmailCaptureReport,
} from "./recovery-gmail-capture-admission.js";
import {
  decodeRecoveryGmailCaptureFrame,
  encodeRecoveryGmailCaptureFrame,
  MAX_RECOVERY_GMAIL_CAPTURE_FRAME_BYTES,
} from "./recovery-gmail-capture-framing.js";
import { canonicalJson } from "./sqlite-store.js";

export { startRecoveryGmailCaptureDriftProbeForTest } from "./recovery-gmail-capture-drift-probe.js";

type Interruption = CaptureInterruption;
const errorCode = "RECOVERY_GMAIL_CAPTURE_EXECUTION_FAILED";

function completedReport(
  value: Awaited<ReturnType<typeof inspectRecoveryGmailCaptureAdmission>>
): RecoveryGmailCaptureReport {
  if (
    value.status !== "capture-complete" ||
    !value.admissionSha256 ||
    !/^[a-f0-9]{64}$/.test(value.admissionSha256) ||
    !value.resultSha256 ||
    !/^[a-f0-9]{64}$/.test(value.resultSha256)
  )
    throw new Error(errorCode);
  return {
    ...value,
    status: "capture-complete",
    admissionSha256: value.admissionSha256,
    resultSha256: value.resultSha256,
  };
}

/** Run only the authenticated retained worker; no caller-supplied code or credentials. */
export function resumeOperatorRecoveryGmailBatch(
  input: RecoveryGmailCaptureInput
): Promise<RecoveryGmailCaptureReport> {
  return launch(input);
}

/** Fixed crash points for isolated acceptance fixtures; production CLI has no such flag. */
export function resumeOperatorRecoveryGmailBatchForTest(
  input: RecoveryGmailCaptureInput,
  interruption: Interruption
): Promise<RecoveryGmailCaptureReport> {
  if (!RECOVERY_GMAIL_CAPTURE_INTERRUPTION_POINTS.includes(interruption))
    throw new Error("INVALID_RECOVERY_GMAIL_CAPTURE_INTERRUPTION");
  return launch(input, interruption);
}

async function launch(
  supplied: RecoveryGmailCaptureInput,
  interruption?: Interruption
): Promise<RecoveryGmailCaptureReport> {
  // Own all bytes and metadata before the first asynchronous boundary.
  const wire = encodeRecoveryGmailCaptureFrame(supplied);
  const input = decodeRecoveryGmailCaptureFrame(wire);
  const observed = await inspectRecoveryGmailCaptureAdmission(input);
  if (observed.status === "capture-complete") return completedReport(observed);
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
      const execute = coordinator.${interruption ? "executeRecoveredGmailBatchCaptureForTest" : "executeRecoveredGmailBatchCapture"};
      if (coordinator.recoveryGmailCaptureExecutorVersion !== 2 || typeof execute !== 'function' || typeof decode !== 'function') throw Error('RECOVERY_GMAIL_CAPTURE_UNSUPPORTED_RUNTIME');
      let size = 0; const chunks = [];
      for await (const chunk of process.stdin) {
        if ((size += chunk.length) > ${MAX_RECOVERY_GMAIL_CAPTURE_FRAME_BYTES}) throw Error('INVALID_RECOVERY_GMAIL_CAPTURE_FRAME');
        chunks.push(chunk);
      }
      const input = decode(Buffer.concat(chunks, size));
      console.log(JSON.stringify(await execute(input${interruption ? ", " + JSON.stringify(interruption) : ""})));
    } catch(error) {
      const captureFrames = ${interruption ? "true" : "false"} && error instanceof Error
        ? (error.stack ?? '').split('\\n').slice(1).flatMap(line => {
            const match = /([A-Za-z0-9-]+\\.js):(\\d+):(\\d+)/.exec(line);
            return match ? [match[1] + ':' + match[2] + ':' + match[3]] : [];
          }).slice(0, 8)
        : [];
      console.error(JSON.stringify({captureError:error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : '${errorCode}', captureFrames}));
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
  const report = await new Promise<unknown>((accept, reject) => {
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
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      }
    );
    let size = 0,
      output = "",
      diagnostic = "",
      stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      child.stdin.destroy();
      reject(new Error(errorCode));
    };
    // The closed invocation expires after two minutes; allow a bounded cleanup
    // grace before terminating a child that did not return its refusal.
    const timer = setTimeout(stop, 150_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if ((size += chunk.length) > 64 * 1024) stop();
      else output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if ((size += chunk.length) > 64 * 1024) stop();
      else diagnostic += chunk.toString("utf8");
    });
    child.stdin.on("error", stop);
    child.on("error", stop);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped) return;
      if (code !== 0) {
        const cause = /\{"captureError":"([A-Z0-9_]{1,80})"/.exec(
          diagnostic
        )?.[1];
        const frames = interruption
          ? diagnostic.match(/[A-Za-z0-9-]+\.js:\d+:\d+/g)?.slice(0, 8)
          : undefined;
        reject(
          new Error(errorCode, {
            cause: new Error(cause ?? errorCode, { cause: frames }),
          })
        );
        return;
      }
      try {
        accept(JSON.parse(output) as unknown);
      } catch {
        reject(new Error(errorCode));
      }
    });
    child.stdin.end(wire);
  });
  // Child output is not authority. Reauthenticate the physical completion and its
  // durable result, then require the report to match that independently observed state.
  const completed = await inspectRecoveryGmailCaptureAdmission(input);
  if (
    completed.status !== "capture-complete" ||
    canonicalJson(report) !== canonicalJson(completed)
  )
    throw new Error(errorCode);
  return completedReport(completed);
}
