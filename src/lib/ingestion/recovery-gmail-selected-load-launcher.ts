import { inspectThirdSelectedLoadCompletion } from "./recovery-gmail-selected-load-third-completion.js";
import { inspectInstalledThirdSelectedLoadExecutionBaseline } from "./recovery-gmail-selected-load-third-start.js";
import {
  decodeThirdSelectedLoadStartFrame,
  encodeThirdSelectedLoadStartFrame,
  maxThirdSelectedLoadStartFrameBytes,
  type RecoveryGmailThirdSelectedLoadStartFrameInput,
} from "./recovery-gmail-selected-load-third-start-framing.js";
import { inspectInstalledRecoveryGmailThirdSelectedLoadAdmission } from "./recovery-gmail-selected-load-third-admission.js";
import {
  decodeRecoveryGmailThirdSelectedLoadFrame,
  encodeRecoveryGmailThirdSelectedLoadFrame,
  MAX_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_FRAME_BYTES,
  type RecoveryGmailThirdSelectedLoadFrameInput,
} from "./recovery-gmail-selected-load-third-framing.js";
import { inspectRecoveryInstalledFile } from "./encrypted-backup.js";
import { selectedLoadAdmissionTailPaths } from "./recovery-gmail-selected-load-admission-tail.js";
import { readNextSelectedLoadAdmissionForInstallation } from "./recovery-gmail-selected-load-next-admission.js";
import {
  decodeRecoveryGmailNextSelectedLoadFrame,
  encodeRecoveryGmailNextSelectedLoadFrame,
  MAX_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_FRAME_BYTES,
  type RecoveryGmailNextSelectedLoadFrameInput,
} from "./recovery-gmail-selected-load-next-framing.js";
import { inspectNextSelectedLoadInterruption } from "./recovery-gmail-selected-load-next-gap.js";
import { inspectNextSelectedLoadCompletion } from "./recovery-gmail-selected-load-next-replay.js";
import { sha256 } from "./steve-preflight.js";
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
    verifyRetainedSelectedLoadCapabilities(input, [
      [coordinator.file, coordinator.versionName + " = " + coordinator.version],
      [
        "recovery-gmail-selected-load-framing.js",
        "recoveryGmailSelectedLoadFramingVersion = 1",
      ],
    ]);

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
    const report = await invokeRetainedSelectedLoadWorker(root, script, wire);
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

function invokeRetainedSelectedLoadWorker(
  root: string,
  script: string,
  wire: Buffer
): Promise<unknown> {
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
            reject(failure(Error("RECOVERY_WINDOWS_JOB_RUNNER_SETUP_REFUSED")));
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
  return process.platform === "win32"
    ? withRecoveryWindowsJobRunner(run)
    : run();
}

function verifyRetainedSelectedLoadCapabilities(
  input: RecoveryGmailSelectedLoadInstallationInput,
  capabilities: readonly (readonly [string, string])[]
): void {
  const { checkpoint } = verifyOperatorRetirementEvidence(input);
  for (const [path, marker] of capabilities)
    if (
      !checkpoint.files.some(
        (file) =>
          file.area === "checkout" &&
          file.path === "dist/lib/ingestion/" + path &&
          file.bytes &&
          Buffer.from(file.bytes, "base64").toString("utf8").includes(marker)
      )
    )
      throw Error("RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME");
}

function observeInstalledNextLoad({
  prior,
  next,
  admission,
}: RecoveryGmailNextSelectedLoadFrameInput) {
  const { record, tail } = readNextSelectedLoadAdmissionForInstallation(
    prior,
    next,
    admission
  );
  const { target, stage } = selectedLoadAdmissionTailPaths(
    prior.destination,
    tail.runId
  );
  const observed = inspectRecoveryInstalledFile(target, stage, 64 * 1024);
  if (!observed.target || observed.candidate) return undefined;
  if (!observed.target.bytes.equals(admission))
    throw Error("RECOVERY_GMAIL_NEXT_SELECTED_LOAD_ADMISSION_MISMATCH");
  return {
    status: "next-load-admission-installed" as const,
    runId: record.runId,
    admissionSha256: sha256(admission),
    priorLoadFamilySha256: record.priorLoadFamilySha256,
    loadAllowed: false as const,
    captureAllowed: false as const,
    activationAllowed: false as const,
  };
}

function observeNextLoadCompletion({
  prior,
  next,
  admission,
}: RecoveryGmailNextSelectedLoadFrameInput) {
  const { lease, ...report } = inspectNextSelectedLoadCompletion(
    prior,
    next,
    admission
  );
  if (lease.status === "active")
    throw Error("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
  if (report.status !== "selected-load-complete" || lease.status !== "released")
    return undefined;
  return { ...report, status: "selected-load-complete" as const };
}

/** Run the exact distinct successor with its original signed admission. */
export async function runOperatorRecoveryGmailNextSelectedLoad(
  operation: Operation,
  supplied: RecoveryGmailNextSelectedLoadFrameInput
) {
  let wire: Buffer | undefined;
  let input: RecoveryGmailNextSelectedLoadFrameInput | undefined;
  try {
    const methods = {
      install: "installRecoveredGmailNextSelectedLoadAdmission",
      execute: "executeRecoveredGmailNextSelectedLoad",
      resume: "resumeRecoveredGmailNextSelectedLoad",
    } as const;
    if (!Object.hasOwn(methods, operation)) throw Error(errorCode);
    wire = encodeRecoveryGmailNextSelectedLoadFrame(supplied);
    input = decodeRecoveryGmailNextSelectedLoadFrame(wire);
    const { prior, next, admission } = input;
    const executorPath = "recovery-gmail-selected-load-executor.js";
    const framingPath = "recovery-gmail-selected-load-next-framing.js";
    verifyRetainedSelectedLoadCapabilities(prior, [
      [executorPath, "recoveryGmailSelectedLoadExecutorVersion = 1"],
      [framingPath, "recoveryGmailNextSelectedLoadFramingVersion = 1"],
    ]);

    if (operation === "resume") {
      let complete;
      try {
        complete = observeNextLoadCompletion(input);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE"
        )
          throw error;
        const gap = inspectNextSelectedLoadInterruption(prior, next, admission);
        if (gap.lease.status === "active")
          throw Error("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
      }
      if (complete) return complete;
    } else {
      const installed = observeInstalledNextLoad(input);
      if (operation === "install" && installed) return installed;
      if (operation === "execute" && !installed)
        throw Error("RECOVERY_GMAIL_NEXT_SELECTED_LOAD_NOT_INSTALLED");
    }

    const root = resolve(prior.destination);
    const entry = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion", executorPath)
    ).href;
    const framing = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion", framingPath)
    ).href;
    const script = `
      let input; let frame; const chunks=[];
      try {
        const executor = await import(${JSON.stringify(entry)});
        const framing = await import(${JSON.stringify(framing)});
        if (executor.recoveryGmailSelectedLoadExecutorVersion !== 1 || framing.recoveryGmailNextSelectedLoadFramingVersion !== 1) throw Error('RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME');
        let size=0;
        for await(const chunk of process.stdin) { if ((size+=chunk.length)>${MAX_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_FRAME_BYTES}) throw Error('INVALID_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_FRAME'); chunks.push(chunk); }
        frame=Buffer.concat(chunks,size); input=framing.decodeRecoveryGmailNextSelectedLoadFrame(frame);
        for(const chunk of chunks) chunk.fill(0);
        const report=await executor[${JSON.stringify(methods[operation])}](input.prior,input.next,input.admission);
        console.log(JSON.stringify(report));
      } catch(error) {
        console.error(JSON.stringify({loadError:error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : '${errorCode}'})); process.exitCode=1;
      } finally { input?.prior.recoveryKey.fill(0); input?.admission.fill(0); frame?.fill(0); for (const chunk of chunks) chunk.fill(0); }
    `;
    const report = await invokeRetainedSelectedLoadWorker(root, script, wire);
    const verified =
      operation === "install"
        ? observeInstalledNextLoad(input)
        : observeNextLoadCompletion(input);
    if (!verified || canonicalJson(report) !== canonicalJson(verified))
      throw Error("RECOVERY_GMAIL_NEXT_SELECTED_LOAD_REPORT_MISMATCH");
    return verified;
  } catch (error) {
    throw failure(error);
  } finally {
    input?.prior.recoveryKey.fill(0);
    input?.admission.fill(0);
    wire?.fill(0);
  }
}

function observeInstalledThirdLoad(
  input: RecoveryGmailThirdSelectedLoadFrameInput
) {
  const {
    status: _observed,
    presence,
    ...evidence
  } = inspectInstalledRecoveryGmailThirdSelectedLoadAdmission(
    input.family,
    input.third,
    input.admission
  );
  if (presence !== "installed") return undefined;
  return { status: "third-load-admission-installed" as const, ...evidence };
}

/** Use the retained worker to install one signed third-admission file only. */
export async function runOperatorRecoveryGmailThirdSelectedLoadInstallation(
  supplied: RecoveryGmailThirdSelectedLoadFrameInput
) {
  let wire: Buffer | undefined;
  let input: RecoveryGmailThirdSelectedLoadFrameInput | undefined;
  try {
    wire = encodeRecoveryGmailThirdSelectedLoadFrame(supplied);
    input = decodeRecoveryGmailThirdSelectedLoadFrame(wire);
    const { prior } = input.family;
    const executorPath = "recovery-gmail-selected-load-executor.js";
    const framingPath = "recovery-gmail-selected-load-third-framing.js";
    verifyRetainedSelectedLoadCapabilities(prior, [
      [executorPath, "recoveryGmailThirdSelectedLoadInstallerVersion = 1"],
      [framingPath, "recoveryGmailThirdSelectedLoadFramingVersion = 1"],
    ]);
    const previous = observeInstalledThirdLoad(input);
    if (previous) return previous;

    const root = resolve(prior.destination);
    const entry = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion", executorPath)
    ).href;
    const framing = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion", framingPath)
    ).href;
    const script = `
      let input; let frame; const chunks = [];
      try {
        const executor = await import(${JSON.stringify(entry)});
        const framing = await import(${JSON.stringify(framing)});
        if (executor.recoveryGmailThirdSelectedLoadInstallerVersion !== 1 || framing.recoveryGmailThirdSelectedLoadFramingVersion !== 1) throw Error('RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME');
        let size = 0;
        for await (const chunk of process.stdin) { if ((size += chunk.length) > ${MAX_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_FRAME_BYTES}) throw Error('INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_FRAME'); chunks.push(chunk); }
        frame = Buffer.concat(chunks, size);
        input = framing.decodeRecoveryGmailThirdSelectedLoadFrame(frame);
        for (const chunk of chunks) chunk.fill(0);
        console.log(JSON.stringify(await executor.installRecoveredGmailThirdSelectedLoadAdmission(input)));
      } catch (error) {
        console.error(JSON.stringify({loadError:error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : '${errorCode}'}));
        process.exitCode = 1;
      } finally {
        input?.family.prior.recoveryKey.fill(0);
        input?.family.admission.fill(0);
        input?.admission.fill(0);
        frame?.fill(0);
        for (const chunk of chunks) chunk.fill(0);
      }
    `;
    const report = await invokeRetainedSelectedLoadWorker(root, script, wire);
    const verified = observeInstalledThirdLoad(input);
    if (!verified || canonicalJson(report) !== canonicalJson(verified))
      throw Error("RECOVERY_GMAIL_THIRD_SELECTED_LOAD_REPORT_MISMATCH");
    return verified;
  } catch (error) {
    throw failure(error);
  } finally {
    input?.family.prior.recoveryKey.fill(0);
    input?.family.admission.fill(0);
    input?.admission.fill(0);
    wire?.fill(0);
  }
}

/** Execute once from an exact installed start, or verify an already settled result. */
export async function runOperatorRecoveryGmailThirdSelectedLoadExecution(
  supplied: RecoveryGmailThirdSelectedLoadStartFrameInput
) {
  let wire: Buffer | undefined;
  let input: RecoveryGmailThirdSelectedLoadStartFrameInput | undefined;
  try {
    wire = encodeThirdSelectedLoadStartFrame(supplied);
    input = decodeThirdSelectedLoadStartFrame(wire);
    const { prior } = input.input.family;
    const executorPath = "recovery-gmail-selected-load-executor.js";
    const framingPath = "recovery-gmail-selected-load-third-start-framing.js";
    verifyRetainedSelectedLoadCapabilities(prior, [
      [executorPath, "recoveryGmailThirdSelectedLoadExecutorVersion = 1"],
      [framingPath, "recoveryGmailThirdStartFramingVersion = 1"],
    ]);
    try {
      return inspectThirdSelectedLoadCompletion(
        input.input,
        input.executionBaseline
      );
    } catch {
      const start = inspectInstalledThirdSelectedLoadExecutionBaseline(
        input.input,
        input.executionBaseline
      );
      if (start.presence !== "installed")
        throw Error("RECOVERY_GMAIL_THIRD_START_NOT_INSTALLED");
    }

    const root = resolve(prior.destination);
    const entry = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion", executorPath)
    ).href;
    const framing = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion", framingPath)
    ).href;
    const script = `
      let input; let frame; const chunks = [];
      try {
        const executor = await import(${JSON.stringify(entry)});
        const framing = await import(${JSON.stringify(framing)});
        if (executor.recoveryGmailThirdSelectedLoadExecutorVersion !== 1 || framing.recoveryGmailThirdStartFramingVersion !== 1) throw Error('RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME');
        let size = 0;
        for await (const chunk of process.stdin) { if ((size += chunk.length) > ${maxThirdSelectedLoadStartFrameBytes}) throw Error('INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_START_FRAME'); chunks.push(chunk); }
        frame = Buffer.concat(chunks, size);
        input = framing.decodeThirdSelectedLoadStartFrame(frame);
        for (const chunk of chunks) chunk.fill(0);
        console.log(JSON.stringify(await executor.executeRecoveredGmailThirdSelectedLoad(input.input, input.executionBaseline)));
      } catch (error) {
        console.error(JSON.stringify({loadError:error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : '${errorCode}'}));
        process.exitCode = 1;
      } finally {
        input?.input.family.prior.recoveryKey.fill(0);
        input?.input.family.admission.fill(0);
        input?.input.admission.fill(0);
        input?.executionBaseline.fill(0);
        frame?.fill(0);
        for (const chunk of chunks) chunk.fill(0);
      }
    `;
    const report = await invokeRetainedSelectedLoadWorker(root, script, wire);
    const verified = inspectThirdSelectedLoadCompletion(
      input.input,
      input.executionBaseline
    );
    if (canonicalJson(report) !== canonicalJson(verified))
      throw Error("RECOVERY_GMAIL_THIRD_EXECUTION_REPORT_MISMATCH");
    return verified;
  } catch (error) {
    throw failure(error);
  } finally {
    input?.input.family.prior.recoveryKey.fill(0);
    input?.input.family.admission.fill(0);
    input?.input.admission.fill(0);
    input?.executionBaseline.fill(0);
    wire?.fill(0);
  }
}

function observeInstalledThirdStart({
  input,
  executionBaseline,
}: RecoveryGmailThirdSelectedLoadStartFrameInput) {
  const {
    status: _observed,
    presence,
    ...report
  } = inspectInstalledThirdSelectedLoadExecutionBaseline(
    input,
    executionBaseline
  );
  if (presence !== "installed") return undefined;
  return { status: "third-load-start-installed" as const, ...report };
}

/** Use the retained worker to install only an authenticated third start baseline. */
export async function runOperatorRecoveryGmailThirdStartInstallation(
  supplied: RecoveryGmailThirdSelectedLoadStartFrameInput
) {
  let wire: Buffer | undefined;
  let input: RecoveryGmailThirdSelectedLoadStartFrameInput | undefined;
  try {
    wire = encodeThirdSelectedLoadStartFrame(supplied);
    input = decodeThirdSelectedLoadStartFrame(wire);
    const { prior } = input.input.family;
    const executorPath = "recovery-gmail-selected-load-executor.js";
    const framingPath = "recovery-gmail-selected-load-third-start-framing.js";
    verifyRetainedSelectedLoadCapabilities(prior, [
      [executorPath, "recoveryGmailThirdStartInstallerVersion = 1"],
      [framingPath, "recoveryGmailThirdStartFramingVersion = 1"],
    ]);
    const previous = observeInstalledThirdStart(input);
    if (previous) return previous;

    const root = resolve(prior.destination);
    const entry = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion", executorPath)
    ).href;
    const framing = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion", framingPath)
    ).href;
    const script = `
      let input; let frame; const chunks = [];
      try {
        const executor = await import(${JSON.stringify(entry)});
        const framing = await import(${JSON.stringify(framing)});
        if (executor.recoveryGmailThirdStartInstallerVersion !== 1 || framing.recoveryGmailThirdStartFramingVersion !== 1) throw Error('RECOVERY_GMAIL_SELECTED_LOAD_UNSUPPORTED_RUNTIME');
        let size = 0;
        for await (const chunk of process.stdin) { if ((size += chunk.length) > ${maxThirdSelectedLoadStartFrameBytes}) throw Error('INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_START_FRAME'); chunks.push(chunk); }
        frame = Buffer.concat(chunks, size);
        input = framing.decodeThirdSelectedLoadStartFrame(frame);
        for (const chunk of chunks) chunk.fill(0);
        console.log(JSON.stringify(await executor.installRecoveredGmailThirdSelectedLoadStart(input)));
      } catch (error) {
        console.error(JSON.stringify({loadError:error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : '${errorCode}'}));
        process.exitCode = 1;
      } finally {
        input?.input.family.prior.recoveryKey.fill(0);
        input?.input.family.admission.fill(0);
        input?.input.admission.fill(0);
        input?.executionBaseline.fill(0);
        frame?.fill(0);
        for (const chunk of chunks) chunk.fill(0);
      }
    `;
    const report = await invokeRetainedSelectedLoadWorker(root, script, wire);
    const verified = observeInstalledThirdStart(input);
    if (!verified || canonicalJson(report) !== canonicalJson(verified))
      throw Error("RECOVERY_GMAIL_THIRD_START_REPORT_MISMATCH");
    return verified;
  } catch (error) {
    throw failure(error);
  } finally {
    input?.input.family.prior.recoveryKey.fill(0);
    input?.input.family.admission.fill(0);
    input?.input.admission.fill(0);
    input?.executionBaseline.fill(0);
    wire?.fill(0);
  }
}
