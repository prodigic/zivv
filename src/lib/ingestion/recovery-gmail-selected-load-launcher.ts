import { withRecoveryWindowsJobRunner } from "./recovery-windows-job-runner.js";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyOperatorRetirementEvidence } from "./operator-recovery.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import {
  readSelectedLoadInterruptionEvidence,
  type SelectedLoadInterruptionEvidence,
} from "./recovery-gmail-selected-load-interruption-inspection.js";
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
type Operation = "install" | "execute" | "resume";
type CompletionReport = {
  status: "selected-load-complete" | "selected-load-resumed";
  activationAllowed: false;
  captureAllowed: false;
  loadAllowed: false;
  runId: string;
  ledgerRevision: string;
  generation: number;
  resultSha256: string;
  admissionSha256: string;
};

function completedReport(
  evidence: SelectedLoadInterruptionEvidence,
  operation: "execute" | "resume"
): CompletionReport {
  if (
    evidence.report.status !== "completed" ||
    evidence.report.lease.status !== "released" ||
    !evidence.completedResultSha256
  )
    throw Error("RECOVERY_GMAIL_SELECTED_LOAD_COMPLETION_NOT_VERIFIED");
  return {
    status:
      operation === "execute"
        ? "selected-load-complete"
        : "selected-load-resumed",
    activationAllowed: false,
    captureAllowed: false,
    loadAllowed: false,
    runId: evidence.report.runId,
    ledgerRevision: ledgerDigest(evidence.observedCatalog.ledger),
    generation: evidence.observedCatalog.generation,
    resultSha256: evidence.completedResultSha256,
    admissionSha256: evidence.admissionSha256,
  };
}

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
  return launch(input, "install");
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
  return launch(input, "install", point);
}
/** Execute only the installed first selected load in the authenticated retained worker. */
export function executeOperatorRecoveryGmailSelectedLoad(
  input: RecoveryGmailSelectedLoadInstallationInput
): Promise<CompletionReport> {
  return launch(input, "execute");
}

/** Reconcile only this first load, reusing a completed durable result when available. */
export function resumeOperatorRecoveryGmailSelectedLoad(
  input: RecoveryGmailSelectedLoadInstallationInput
): Promise<CompletionReport> {
  return launch(input, "resume");
}

function launch(
  input: RecoveryGmailSelectedLoadInstallationInput,
  operation: "install",
  point?: RecoveryGmailSelectedLoadInstallationInterruption
): Promise<Report>;
function launch(
  input: RecoveryGmailSelectedLoadInstallationInput,
  operation: "execute" | "resume"
): Promise<CompletionReport>;
async function launch(
  supplied: RecoveryGmailSelectedLoadInstallationInput,
  operation: Operation,
  point?: RecoveryGmailSelectedLoadInstallationInterruption
): Promise<Report | CompletionReport> {
  let wire: Buffer | undefined;
  let input:
    | ReturnType<typeof decodeRecoveryGmailSelectedLoadFrame>
    | undefined;
  try {
    wire = encodeRecoveryGmailSelectedLoadFrame(supplied);
    input = decodeRecoveryGmailSelectedLoadFrame(wire);
    const checkpoint = verifyOperatorRetirementEvidence(input).checkpoint;
    const coordinator =
      operation === "install"
        ? {
            file: "recovery-gmail-selected-load-installation.js",
            versionName: "recoveryGmailSelectedLoadInstallationVersion",
            version: 2,
            method: point
              ? "installRecoveryGmailSelectedLoadEvidenceForTest"
              : "installRecoveryGmailSelectedLoadEvidence",
          }
        : {
            file: "recovery-gmail-selected-load-executor.js",
            versionName: "recoveryGmailSelectedLoadExecutorVersion",
            version: 1,
            method:
              operation === "execute"
                ? "executeRecoveredGmailSelectedLoad"
                : "resumeRecoveredGmailSelectedLoad",
          };
    for (const [path, marker] of [
      [coordinator.file, coordinator.versionName + " = " + coordinator.version],
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

    if (operation === "install") {
      try {
        return inspectInstalledRecoveryGmailSelectedLoadEvidence(input);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "RECOVERY_GMAIL_SELECTED_LOAD_NOT_INSTALLED"
        )
          throw error;
      }
    } else if (operation === "execute") {
      inspectInstalledRecoveryGmailSelectedLoadEvidence(input);
    } else {
      const before = readSelectedLoadInterruptionEvidence(input);
      if (before.report.lease.status === "active")
        throw Error("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
      if (before.report.status === "completed")
        return completedReport(before, operation);
    }

    const root = resolve(input.destination);
    const entry = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion", coordinator.file)
    ).href;
    const framing = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-framing.js"
      )
    ).href;
    const script = `
      let input; let frame; const chunks=[];
      try {
        const coordinator = await import(${JSON.stringify(entry)});
        const framing = await import(${JSON.stringify(framing)});
        if (coordinator[${JSON.stringify(coordinator.versionName)}] !== ${coordinator.version} || framing.recoveryGmailSelectedLoadFramingVersion !== 1) throw Error('RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME');
        let size=0;
        for await(const chunk of process.stdin) { if ((size+=chunk.length)>${MAX_RECOVERY_GMAIL_SELECTED_LOAD_FRAME_BYTES}) throw Error('INVALID_RECOVERY_GMAIL_SELECTED_LOAD_FRAME'); chunks.push(chunk); }
        frame=Buffer.concat(chunks,size); input=framing.decodeRecoveryGmailSelectedLoadFrame(frame);
        for(const chunk of chunks) chunk.fill(0);
        const report=await coordinator[${JSON.stringify(coordinator.method)}](input${point ? "," + JSON.stringify(point) : ""});
        console.log(JSON.stringify(report));
      } catch(error) {
        console.error(JSON.stringify({loadError:error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : '${errorCode}'})); process.exitCode=1;
      } finally { input?.recoveryKey.fill(0); frame?.fill(0); for (const chunk of chunks) chunk.fill(0); }
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
    const nodeArgs = [
      "--import",
      pathToFileURL(join(root, "bootstrap/module-boundary.mjs")).href,
      "--input-type=module",
      "--eval",
      script,
    ];
    const cwd = join(root, "checkout");
    const deadline = 240_000;
    const run = (jobRunner?: string) =>
      new Promise<unknown>((accept, reject) => {
        const child = spawn(
          jobRunner ?? process.execPath,
          jobRunner
            ? [
                String(process.pid),
                String(deadline),
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
        const output: Buffer[] = [];
        const diagnostic: Buffer[] = [];
        let size = 0;
        let settled = false;
        let overLimit = false;
        let ioFailed = false;
        let stopRequested = false;
        let termination: ReturnType<typeof setTimeout> | undefined;
        let exited:
          | { code: number | null; signal: NodeJS.Signals | null }
          | undefined;
        const unconfirmed =
          "RECOVERY_GMAIL_SELECTED_LOAD_TERMINATION_UNCONFIRMED";

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
            // Native 223 proves that the worker did not start, even if stdin got EPIPE.
            if (!exited.signal && exited.code === 223) {
              reject(
                failure(Error("RECOVERY_WINDOWS_JOB_RUNNER_SETUP_REFUSED"))
              );
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
              reject(failure(Error(unconfirmed)));
              return;
            }
            if (exited.code === 221 || exited.code === 222) {
              reject(failure(Error("RECOVERY_WINDOWS_JOB_RUNNER_STOPPED")));
              return;
            }
          }
          if (
            stopRequested ||
            overLimit ||
            ioFailed ||
            !child.stdin.writableFinished
          ) {
            reject(failure(Error(errorCode)));
            return;
          }
          if (exited.code !== 0 || exited.signal) {
            const text = Buffer.concat(diagnostic).toString("utf8");
            const code = /\{"loadError":"([A-Z0-9_]{1,80})"/.exec(text)?.[1];
            reject(failure(Error(code ?? errorCode)));
            return;
          }
          try {
            accept(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  Buffer.concat(output)
                )
              ) as unknown
            );
          } catch {
            reject(failure(Error(errorCode)));
          }
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
            reject(failure(Error(unconfirmed)));
          }, 10_000);
          finish();
        }

        function collect(chunks: Buffer[], chunk: Buffer) {
          if (overLimit) return;
          size += chunk.length;
          if (size <= 64 * 1024) {
            chunks.push(chunk);
            return;
          }
          overLimit = true;
          // Keep draining bounded memory until the native deadline proves the
          // tree is empty. Forcibly exiting the helper would lose that proof.
          if (!jobRunner) stop();
        }

        function streamFailed() {
          ioFailed = true;
          if (!jobRunner) stop();
          finish();
        }

        child.stdout.on("data", (chunk: Buffer) => collect(output, chunk));
        child.stderr.on("data", (chunk: Buffer) => collect(diagnostic, chunk));
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
            reject(failure(Error(errorCode)));
          } else stop();
        });
        child.on("close", finish);
        const timer = setTimeout(stop, deadline + (jobRunner ? 20_000 : 0));
        child.stdin.end(wire);
      });
    const report =
      process.platform === "win32"
        ? await withRecoveryWindowsJobRunner(run)
        : await run();
    if (operation === "install") {
      const completed =
        inspectInstalledRecoveryGmailSelectedLoadEvidence(input);
      if (canonicalJson(report) !== canonicalJson(completed))
        throw Error(errorCode);
      return completed;
    }
    const completed = completedReport(
      readSelectedLoadInterruptionEvidence(input),
      operation
    );
    if (!report || typeof report !== "object" || Array.isArray(report))
      throw Error(errorCode);
    const { accepted, ...reported } = report as Record<string, unknown>;
    if (
      typeof accepted !== "number" ||
      !Number.isSafeInteger(accepted) ||
      accepted < 0 ||
      canonicalJson(reported) !== canonicalJson(completed)
    )
      throw Error(errorCode);
    return completed;
  } catch (error) {
    throw failure(error);
  } finally {
    input?.recoveryKey.fill(0);
    wire?.fill(0);
  }
}
