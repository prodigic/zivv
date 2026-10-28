import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyOperatorRetirementEvidence } from "./operator-recovery.js";
import { canonicalJson } from "./sqlite-store.js";
import {
  decodeRecoveryGmailSelectedLoadFrame,
  encodeRecoveryGmailSelectedLoadFrame,
  MAX_RECOVERY_GMAIL_SELECTED_LOAD_FRAME_BYTES,
} from "./recovery-gmail-selected-load-framing.js";
import {
  inspectInstalledRecoveryGmailSelectedLoadEvidence,
  RECOVERY_GMAIL_SELECTED_LOAD_INSTALLATION_INTERRUPTION_POINTS,
  type RecoveryGmailSelectedLoadInstallationInput,
  type RecoveryGmailSelectedLoadInstallationInterruption,
} from "./recovery-gmail-selected-load-installation.js";

const errorCode = "RECOVERY_GMAIL_SELECTED_LOAD_EXECUTION_FAILED";
type Report = ReturnType<
  typeof inspectInstalledRecoveryGmailSelectedLoadEvidence
>;
function failure(error: unknown): Error {
  const detail =
    error instanceof Error &&
    error.message === errorCode &&
    error.cause instanceof Error
      ? error.cause
      : error;
  const code =
    detail instanceof Error && /^[A-Z0-9_]{1,80}$/.test(detail.message)
      ? detail.message
      : errorCode;
  return new Error(errorCode, { cause: new Error(code) });
}
/** Run only the authenticated retained installation entry; child output is never authority. */
export function resumeOperatorRecoveryGmailSelectedLoadEvidence(
  input: RecoveryGmailSelectedLoadInstallationInput
): Promise<Report> {
  return launch(input);
}
/** Fixed interruption points only. No alternate executor, callback or process arguments. */
export function resumeOperatorRecoveryGmailSelectedLoadEvidenceForTest(
  input: RecoveryGmailSelectedLoadInstallationInput,
  point: RecoveryGmailSelectedLoadInstallationInterruption
): Promise<Report> {
  if (
    !RECOVERY_GMAIL_SELECTED_LOAD_INSTALLATION_INTERRUPTION_POINTS.includes(
      point
    )
  )
    return Promise.reject(
      failure(Error("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_INTERRUPTION"))
    );
  return launch(input, point);
}
async function launch(
  supplied: RecoveryGmailSelectedLoadInstallationInput,
  point?: RecoveryGmailSelectedLoadInstallationInterruption
): Promise<Report> {
  let wire: Buffer | undefined;
  let input:
    | ReturnType<typeof decodeRecoveryGmailSelectedLoadFrame>
    | undefined;
  try {
    wire = encodeRecoveryGmailSelectedLoadFrame(supplied);
    input = decodeRecoveryGmailSelectedLoadFrame(wire);
    const checkpoint = verifyOperatorRetirementEvidence(input).checkpoint;
    for (const [path, marker] of [
      [
        "recovery-gmail-selected-load-installation.js",
        "recoveryGmailSelectedLoadInstallationVersion = 2",
      ],
      [
        "recovery-gmail-selected-load-framing.js",
        "recoveryGmailSelectedLoadFramingVersion = 1",
      ],
    ])
      if (
        !checkpoint.files.some(
          (file) =>
            file.area === "checkout" &&
            file.path === "dist/lib/ingestion/" + path &&
            file.bytes &&
            Buffer.from(file.bytes, "base64").toString("utf8").includes(marker!)
        )
      )
        throw Error("RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME");
    try {
      return inspectInstalledRecoveryGmailSelectedLoadEvidence(input);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "RECOVERY_GMAIL_SELECTED_LOAD_NOT_INSTALLED"
      )
        throw error;
    }
    const root = resolve(input.destination);
    const entry = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-installation.js"
      )
    ).href;
    const framing = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-framing.js"
      )
    ).href;
    const script = `
      let input; let frame;
      try {
        const coordinator = await import(${JSON.stringify(entry)});
        const framing = await import(${JSON.stringify(framing)});
        if (coordinator.recoveryGmailSelectedLoadInstallationVersion !== 2 || framing.recoveryGmailSelectedLoadFramingVersion !== 1) throw Error('RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME');
        let size=0; const chunks=[];
        for await(const chunk of process.stdin) { if ((size+=chunk.length)>${MAX_RECOVERY_GMAIL_SELECTED_LOAD_FRAME_BYTES}) throw Error('INVALID_RECOVERY_GMAIL_SELECTED_LOAD_FRAME'); chunks.push(chunk); }
        frame=Buffer.concat(chunks,size); input=framing.decodeRecoveryGmailSelectedLoadFrame(frame);
        for(const chunk of chunks) chunk.fill(0);
        const report=coordinator.${point ? "installRecoveryGmailSelectedLoadEvidenceForTest" : "installRecoveryGmailSelectedLoadEvidence"}(input${point ? "," + JSON.stringify(point) : ""});
        console.log(JSON.stringify(report));
      } catch(error) {
        console.error(JSON.stringify({loadError:error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : '${errorCode}'})); process.exitCode=1;
      } finally { input?.recoveryKey.fill(0); frame?.fill(0); }
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
      let output = "",
        diagnostic = "",
        size = 0,
        settled = false,
        exited:
          | { code: number | null; signal: NodeJS.Signals | null }
          | undefined,
        stopped: Error | undefined;
      let termination: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (
          settled ||
          !exited ||
          !child.stdout.readableEnded ||
          !child.stderr.readableEnded ||
          !(child.stdin.writableFinished || (stopped && child.stdin.destroyed))
        )
          return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(termination);
        if (stopped) {
          reject(stopped);
          return;
        }
        if (exited.code !== 0 || exited.signal) {
          reject(
            failure(
              Error(
                /\{"loadError":"([A-Z0-9_]{1,80})"/.exec(diagnostic)?.[1] ??
                  errorCode
              )
            )
          );
          return;
        }
        try {
          accept(JSON.parse(output) as unknown);
        } catch {
          reject(failure(Error(errorCode)));
        }
      };
      const stop = () => {
        if (settled || stopped) return;
        stopped = failure(Error(errorCode));
        clearTimeout(timer);
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        child.stdin.destroy();
        termination = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(
              failure(
                Error("RECOVERY_GMAIL_SELECTED_LOAD_TERMINATION_UNCONFIRMED")
              )
            );
          }
        }, 10_000);
        finish();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if ((size += chunk.length) > 64 * 1024) stop();
        else output += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if ((size += chunk.length) > 64 * 1024) stop();
        else diagnostic += chunk.toString("utf8");
      });
      child.stdout.on("end", finish);
      child.stderr.on("end", finish);
      child.stdin.on("finish", finish);
      child.stdout.on("error", stop);
      child.stderr.on("error", stop);
      child.stdin.on("error", stop);
      child.on("exit", (code, signal) => {
        exited = { code, signal };
        finish();
      });
      child.on("error", () => {
        if (!child.pid) {
          settled = true;
          clearTimeout(timer);
          clearTimeout(termination);
          reject(failure(Error(errorCode)));
        } else stop();
      });
      child.on("close", finish);
      const timer = setTimeout(stop, 240_000);
      child.stdin.end(wire);
    });
    const completed = inspectInstalledRecoveryGmailSelectedLoadEvidence(input);
    if (canonicalJson(report) !== canonicalJson(completed))
      throw Error(errorCode);
    return completed;
  } catch (error) {
    throw failure(error);
  } finally {
    input?.recoveryKey.fill(0);
    wire?.fill(0);
  }
}
