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
import { runRecoveryWorkerProcess } from "./recovery-worker-process.js";
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
  const run = async (jobRunner?: string) => {
    const result = await runRecoveryWorkerProcess({
      nodeArgs,
      cwd,
      env,
      input: wire,
      deadlineMs: 240_000,
      ...(jobRunner ? { jobRunner } : {}),
    });
    if (result.status === "setup-refused")
      throw failure(Error("RECOVERY_WINDOWS_JOB_RUNNER_SETUP_REFUSED"));
    if (result.status === "termination-unconfirmed")
      throw failure(
        Error("RECOVERY_GMAIL_SELECTED_LOAD_TERMINATION_UNCONFIRMED")
      );
    if (result.status === "stopped")
      throw failure(Error("RECOVERY_WINDOWS_JOB_RUNNER_STOPPED"));
    if (result.status !== "exited") throw failure(Error(errorCode));
    if (result.code !== 0 || result.signal) {
      const text = result.stderr.toString("utf8");
      const code = /\{"loadError":"([A-Z0-9_]{1,80})"/.exec(text)?.[1];
      throw failure(Error(code ?? errorCode));
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
      ) as unknown;
    } catch {
      throw failure(Error(errorCode));
    }
  };
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
