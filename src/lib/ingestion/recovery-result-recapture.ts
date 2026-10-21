import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  admitRecoveryFrozenResultRecapture,
  inspectRecoveryFrozenResultRecapture,
  observeRecoveryFrozenResultRecapture,
  type RecoveryFrozenResultRecaptureInput,
} from "./recovery-import-admission.js";
import {
  captureRecoveryResultCheckpoint,
  encryptOperatorRecovery,
  observeRetiredOperatorRecoveryCheckpoint,
  type OperatorRecoveryCheckpoint,
} from "./operator-recovery.js";
import {
  createOperatorRetirementReceipt,
  withOperatorRetirementScope,
} from "./operator-installation.js";
import {
  installRecoveryIntent,
  readRecoveryInstalledFile,
} from "./encrypted-backup.js";
import {
  decryptRecoveryResultChain,
  encryptRecoveryResultChain,
  proveRecoveryResultChain,
  type RecoveryResultChainMembers,
} from "./recovery-result-chain.js";
import {
  createRecoveryResultPlan,
  installRecoveryResultPlan,
  publishRecoveryResultPlan,
  readRecoveryResultPlan,
  recoveryResultSourceFingerprint,
} from "./recovery-result-plan.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

export type RecoveryResultRecaptureInput = RecoveryFrozenResultRecaptureInput;
export interface RecoveryResultRecaptureReport {
  status: "result-handoff-complete";
  activationAllowed: false;
  chainId: string;
  runId: string;
  candidateId: string;
  chainSha256: string;
  receiptSha256: string;
}
interface TestOptions {
  bareDirectory: string;
  interruptAt?: "plan-saved" | "fence-written" | "handoff-published";
}
interface CaptureScope {
  active: boolean;
  checkout: string;
  operator: string;
  npmCli: string;
  finalizing: boolean;
  assertCurrent(): void;
  finalize(checkpoint: OperatorRecoveryCheckpoint): void;
}
const captures = new AsyncLocalStorage<CaptureScope>();
function fail(code: string): never {
  throw new Error("RECOVERY_RESULT_RECAPTURE_" + code);
}
function same(a: unknown, b: unknown): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail("PROVENANCE_MISMATCH");
}

/** Query only: the coordinator never exports an ALS mint or capture permission. */
export function assertRecoveryResultCaptureCurrent(input: {
  checkout: string;
  operator: string;
  npmCli?: string;
}): void {
  const scope = captures.getStore();
  if (
    !scope?.active ||
    scope.finalizing ||
    scope.checkout !== input.checkout ||
    scope.operator !== input.operator ||
    scope.npmCli !== input.npmCli
  )
    fail("CAPTURE_AUTHORITY_REQUIRED");
  scope.assertCurrent();
}

/** Called only by the specialized locked capture; no caller-supplied callback. */
export function finalizeRecoveryResultCapture(
  checkpoint: OperatorRecoveryCheckpoint
): void {
  const scope = captures.getStore();
  if (
    !scope?.active ||
    scope.finalizing ||
    checkpoint.originalCheckout !== scope.checkout ||
    checkpoint.originalOperatorDirectory !== scope.operator
  )
    fail("CAPTURE_AUTHORITY_REQUIRED");
  scope.assertCurrent();
  scope.finalizing = true;
  scope.finalize(checkpoint);
}

function hook(
  test: TestOptions | undefined,
  point: TestOptions["interruptAt"]
): void {
  if (test?.interruptAt === point) fail("TEST_INTERRUPTION");
}
function copied(
  input: RecoveryResultRecaptureInput
): RecoveryResultRecaptureInput {
  return {
    ...input,
    archive: Buffer.from(input.archive),
    retirementReceipt: Buffer.from(input.retirementReceipt),
    recoveryKey: Buffer.from(input.recoveryKey),
  };
}
function scratch(root: string): string {
  return join(dirname(root), ".zivv-recovery-install-" + sha256(root));
}
function readPlan(input: RecoveryResultRecaptureInput) {
  const selected = inspectRecoveryFrozenResultRecapture(input),
    planInput = { context: selected.context, recoveryKey: input.recoveryKey };
  try {
    const retained = readRecoveryResultPlan(planInput),
      proof = decryptRecoveryResultChain(retained.chain, input.recoveryKey);
    if (!existsSync(selected.selectionPath)) fail("SELECTION_REQUIRED");
    same(
      proof.members.originalArchive.toString("base64"),
      input.archive.toString("base64")
    );
    same(
      proof.members.originalRetirementReceipt.toString("base64"),
      input.retirementReceipt.toString("base64")
    );
    same(
      proof.members.preparedReceipt.toString("base64"),
      selected.preparedReceipt.toString("base64")
    );
    same(
      proof.members.admissionReceipt.toString("base64"),
      selected.admissionReceipt.toString("base64")
    );
    same(
      proof.members.resultReceipt.toString("base64"),
      selected.resultReceipt.toString("base64")
    );
    same(proof.certificate.sourceCommit, input.sourceCommit);
    // Canonical deterministic framing reproduces the retained plan, never a nonce.
    const bytes = createRecoveryResultPlan({
      ...planInput,
      chain: retained.chain,
    });
    return { ...planInput, bytes, retained, proof };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "RECOVERY_RESULT_PLAN_PLAN_MISSING"
    )
      return undefined;
    throw error;
  }
}
function assertSelected(input: RecoveryResultRecaptureInput): void {
  const selected = inspectRecoveryFrozenResultRecapture(input);
  if (!existsSync(selected.selectionPath)) fail("SELECTION_REQUIRED");
}

function retiredState(input: RecoveryResultRecaptureInput, test?: TestOptions) {
  assertSelected(input);
  const plan = readPlan(input);
  if (!plan) fail("PLAN_REQUIRED");
  const marker = join(
      plan.retained.metadata.context.operator,
      "operator-retired.json"
    ),
    expected = plan.proof.members.successorRetirementReceipt;
  // Repair only proven private staging aliases from a lost exclusive-link response.
  readRecoveryInstalledFile(
    marker,
    scratch(plan.retained.metadata.context.root),
    (bytes) => {
      if (!bytes.equals(expected)) fail("FENCE_MISMATCH");
    }
  );
  const admitted = observeRecoveryFrozenResultRecapture(input, test);
  const assertFenced = () => {
    admitted.assertCurrent();
    const actual = observeRetiredOperatorRecoveryCheckpoint({
      root: join(admitted.context.root, "checkout"),
      archive: plan.proof.members.successorArchive,
      retirementReceipt: expected,
      recoveryKey: input.recoveryKey,
      npmCli: input.npmCli,
    });
    same(
      recoveryResultSourceFingerprint(actual),
      plan.retained.sourceFingerprint
    );
    assertSelected(input);
  };
  assertFenced();
  return { plan, assertFenced };
}

function report(
  plan: NonNullable<ReturnType<typeof readPlan>>
): RecoveryResultRecaptureReport {
  return {
    status: "result-handoff-complete",
    activationAllowed: false,
    chainId: plan.retained.metadata.chainId,
    runId: plan.retained.metadata.runId,
    candidateId: plan.retained.metadata.candidateId,
    chainSha256: plan.retained.metadata.chainSha256,
    receiptSha256: sha256(plan.retained.portableReceipt),
  };
}

async function execute(
  input: RecoveryResultRecaptureInput,
  test?: TestOptions
): Promise<RecoveryResultRecaptureReport> {
  input = copied(input);
  const root = resolve(input.destination),
    checkout = join(root, "checkout"),
    runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  if (
    runtimeRoot !== checkout ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    !process.execArgv.includes(
      pathToFileURL(join(root, "bootstrap/module-boundary.mjs")).href
    )
  )
    fail("RETAINED_EXECUTOR_REQUIRED");
  if (captures.getStore()?.active) fail("NESTED_CAPTURE");
  const marker = join(root, "operator/operator-retired.json");
  if (!existsSync(marker)) {
    const existing = readPlan(input);
    // Result completion is mandatory; this never reruns import/build/validation.
    let admitted = admitRecoveryFrozenResultRecapture(input, test);
    installRecoveryIntent(
      admitted.selectionPath,
      admitted.selectionBytes,
      scratch(root)
    );
    admitted = admitRecoveryFrozenResultRecapture(input, test);
    await withOperatorRetirementScope(
      admitted.context.operator,
      async (permitOwnRetirement) => {
        const scope: CaptureScope = {
          active: true,
          checkout,
          operator: admitted.context.operator,
          npmCli: resolve(input.npmCli),
          finalizing: false,
          assertCurrent: admitted.assertCurrent,
          finalize(checkpoint) {
            admitted.assertCurrent();
            let plan = existing;
            if (plan) {
              same(
                recoveryResultSourceFingerprint(checkpoint),
                plan.retained.sourceFingerprint
              );
            } else {
              const successorArchive = encryptOperatorRecovery(
                  checkpoint,
                  input.recoveryKey
                ),
                successorRetirementReceipt = createOperatorRetirementReceipt(
                  {
                    checkpointSha256: sha256(canonicalJson(checkpoint)),
                    archiveSha256: sha256(successorArchive),
                    ledgerRevision: checkpoint.ledgerRevision,
                    originalOperatorDirectory:
                      checkpoint.originalOperatorDirectory,
                    installationId: randomUUID(),
                    retiredAtEpochMs: Date.now(),
                  },
                  input.recoveryKey
                ),
                members: RecoveryResultChainMembers = {
                  originalArchive: input.archive,
                  originalRetirementReceipt: input.retirementReceipt,
                  preparedReceipt: admitted.preparedReceipt,
                  admissionReceipt: admitted.admissionReceipt,
                  resultReceipt: admitted.resultReceipt,
                  successorArchive,
                  successorRetirementReceipt,
                };
              // Actual locked snapshot must satisfy the complete transition proof.
              proveRecoveryResultChain({
                members,
                recoveryKey: input.recoveryKey,
              });
              const chain = encryptRecoveryResultChain({
                  members,
                  recoveryKey: input.recoveryKey,
                }),
                bytes = createRecoveryResultPlan({
                  chain,
                  recoveryKey: input.recoveryKey,
                  context: admitted.context,
                });
              installRecoveryResultPlan({
                bytes,
                recoveryKey: input.recoveryKey,
                context: admitted.context,
              });
              plan = readPlan(input);
              if (!plan) fail("PLAN_REQUIRED");
            }
            admitted.assertCurrent();
            same(
              recoveryResultSourceFingerprint(checkpoint),
              plan.retained.sourceFingerprint
            );
            hook(test, "plan-saved");
            const receipt = plan.proof.members.successorRetirementReceipt;
            if (existsSync(marker)) fail("FENCE_CONFLICT");
            permitOwnRetirement(receipt);
            installRecoveryIntent(marker, receipt, scratch(root));
            hook(test, "fence-written");
          },
        };
        try {
          await captures.run(scope, () =>
            captureRecoveryResultCheckpoint({
              checkout,
              operator: admitted.context.operator,
              npmCli: resolve(input.npmCli),
            })
          );
        } finally {
          scope.active = false;
        }
      }
    );
  }
  // No writer scope, admission installation, new capture or nonce beyond the fence.
  const retired = retiredState(input, test);
  publishRecoveryResultPlan({
    ...retired.plan,
    assertFenced: retired.assertFenced,
  });
  hook(test, "handoff-published");
  retired.assertFenced();
  return report(retired.plan);
}

/** Retained-worker entry; capture authority is privately minted only after admission. */
export const executeRecoveredFrozenResultRecapture = (
  input: RecoveryResultRecaptureInput
) => execute(input);
export const executeRecoveredFrozenResultRecaptureForTest = (
  input: RecoveryResultRecaptureInput & TestOptions
) => execute(input, input);

async function launch(
  input: RecoveryResultRecaptureInput,
  test?: TestOptions
): Promise<RecoveryResultRecaptureReport> {
  input = copied(input);
  const root = resolve(input.destination),
    marker = join(root, "operator/operator-retired.json");
  // Authenticate the retained module/loader/dependency tree before evaluating it.
  if (existsSync(marker)) retiredState(input, test);
  else {
    readPlan(input);
    observeRecoveryFrozenResultRecapture(input, test).assertCurrent();
  }
  const entry = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion/recovery-result-recapture.js")
    ).href,
    name = test
      ? "executeRecoveredFrozenResultRecaptureForTest"
      : "executeRecoveredFrozenResultRecapture";
  const script = `
    try {
      const {${name}:execute}=await import(${JSON.stringify(entry)});
      let size=0;const chunks=[];for await(const chunk of process.stdin){if((size+=chunk.length)>512*1024*1024)throw Error('RECOVERY_RESULT_RECAPTURE_INPUT_TOO_LARGE');chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      for(const key of ['archive','retirementReceipt','recoveryKey'])value[key]=Buffer.from(value[key],'base64');
      console.log(JSON.stringify(await execute(value)));
    } catch(error) { console.error(JSON.stringify({recaptureError:error instanceof Error&&/^[A-Z_]{1,80}$/.test(error.message)?error.message:'RECOVERY_RESULT_RECAPTURE_EXECUTION_FAILED'}));process.exitCode=1; }
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
  env.ZIVV_RECOVERY_EXECUTOR = "1";
  const wire = JSON.stringify({
    ...input,
    ...test,
    archive: input.archive.toString("base64"),
    retirementReceipt: input.retirementReceipt.toString("base64"),
    recoveryKey: input.recoveryKey.toString("base64"),
  });
  if (Buffer.byteLength(wire) > 512 * 1024 * 1024) fail("INPUT_TOO_LARGE");
  return new Promise((resolveChild, reject) => {
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
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(new Error("RECOVERY_RESULT_RECAPTURE_EXECUTION_FAILED"));
    };
    const timer = setTimeout(stop, 15 * 60 * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      if ((size += chunk.length) > 24 * 1024) stop();
      else output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if ((size += chunk.length) > 24 * 1024) stop();
      else diagnostic += chunk.toString("utf8");
    });
    child.stdin.on("error", stop);
    child.on("error", stop);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || stopped) {
        const inner = /\{"recaptureError":"([A-Z_]{1,80})"\}/.exec(
          diagnostic
        )?.[1];
        reject(
          new Error("RECOVERY_RESULT_RECAPTURE_EXECUTION_FAILED", {
            cause: new Error(
              inner ?? "RECOVERY_RESULT_RECAPTURE_CHILD_STOPPED"
            ),
          })
        );
        return;
      }
      try {
        const value = JSON.parse(output) as RecoveryResultRecaptureReport;
        same(
          Object.keys(value).sort(),
          [
            "status",
            "activationAllowed",
            "chainId",
            "runId",
            "candidateId",
            "chainSha256",
            "receiptSha256",
          ].sort()
        );
        if (
          value.status !== "result-handoff-complete" ||
          value.activationAllowed !== false ||
          value.runId !== input.runId ||
          [
            value.chainId,
            value.candidateId,
            value.chainSha256,
            value.receiptSha256,
          ].some(
            (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)
          )
        )
          fail("INVALID_REPORT");
        const retired = retiredState(input, test);
        same(value, report(retired.plan));
        resolveChild(value);
      } catch {
        reject(new Error("RECOVERY_RESULT_RECAPTURE_EXECUTION_FAILED"));
      }
    });
    child.stdin.end(wire);
  });
}

/** Parent facade always evaluates the authenticated retained worker under its loader. */
export const recaptureOperatorRecoveryFrozenResult = (
  input: RecoveryResultRecaptureInput
) => launch(input);
export const recaptureOperatorRecoveryFrozenResultForTest = (
  input: RecoveryResultRecaptureInput & TestOptions
) => launch(input, input);
