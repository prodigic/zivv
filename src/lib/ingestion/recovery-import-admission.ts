import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  openPreparedRuntimeForAdmission,
  verifyPreparedOperatorRuntime,
  type RecoveryRuntimeInput,
  type RecoveryRuntimeEntry,
} from "./recovery-runtime.js";
import {
  openRecoveryImportRemote,
  openRecoveryImportRemoteForTest,
  type RecoveryImportRemote,
} from "./recovery-import-remote.js";
import {
  installRecoveredBackupKey,
  installRecoveryIntent,
  readRecoveryInstalledFile,
  loadBackupKey,
  writeDurableFile,
} from "./encrypted-backup.js";
import { assertOperatorInstallationWritable } from "./operator-installation.js";
import { projectLedgerLocation } from "./store-location.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
} from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import {
  parseWeeklyRunState,
  type WeeklyRunState,
} from "./weekly-run-state.js";
import { runWeeklyImport } from "./weekly-import-runner.js";

const recordName = "recovery-import.json";
const resultName = "recovery-import-result.json";
const scopes = new AsyncLocalStorage<{
  active: boolean;
  root: string;
  operator: string;
  runId: string;
  assertCurrent(): void;
  assertRemote(): void;
}>();
export interface RecoveryImportInput extends RecoveryRuntimeInput {
  repositoryRoot: string;
  runId: string;
  credentials?: { token: string };
}
export interface RecoveredImportReport {
  status: "load-complete";
  activationAllowed: false;
  runId: string;
  ledgerRevision: string;
  admissionSha256: string;
}
interface TestOptions {
  bareDirectory: string;
  interruptAfterEffect?: boolean;
  crashAfterIntent?: boolean;
  alterBeforeLoad?: "dependency" | "retained-report";
  probeRestrictedConsumers?: boolean;
}
function fail(code = "INVALID_RECOVERY_IMPORT_ADMISSION"): never {
  throw new Error(code);
}
function same(a: unknown, b: unknown): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail();
}
function regular(path: string, limit = 16 * 1024 * 1024): Buffer {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    if (dirname(parent) === parent) break;
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit
  )
    fail();
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) fail();
  return bytes;
}
function signed(payload: unknown, key: Buffer): Buffer {
  return Buffer.from(
    canonicalJson({
      payload,
      signature: createHmac("sha256", key)
        .update(canonicalJson(payload))
        .digest("hex"),
    }) + "\n"
  );
}
function authenticated(bytes: Buffer, key: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  same(Object.keys(record).sort(), ["payload", "signature"]);
  if (
    !record.payload ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload) ||
    typeof record.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.signature)
  )
    fail();
  const expected = createHmac("sha256", key)
    .update(canonicalJson(record.payload))
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(record.signature, "hex"))) fail();
  return record.payload as Record<string, unknown>;
}
function mutable(
  entry: RecoveryRuntimeEntry,
  retained: ReadonlySet<string>,
  reportPath: string
): boolean {
  const path = entry.path;
  if (
    retained.has(path) &&
    (path.startsWith("checkout/data/ingestion/reports") ||
      path.startsWith("checkout/data/ingestion/backups"))
  )
    return false;
  if (entry.kind === "directory")
    return (
      path === "checkout/data/ingestion/reports" ||
      path === "checkout/data/ingestion/backups"
    );
  if (entry.kind !== "file") return false;
  return (
    path === recordName ||
    path === resultName ||
    /^recovery-import-result\.json\.[1-9][0-9]*\.[a-f0-9]{16}\.tmp$/.test(
      path
    ) ||
    /^operator\/(?:ledger\.sqlite|weekly-runs\.sqlite)(?:-wal|-shm)?$/.test(
      path
    ) ||
    /^operator\/backup-key\.(?:bin|dpapi)$/.test(path) ||
    path === reportPath ||
    (path.startsWith(reportPath + ".") &&
      /^[a-f0-9-]{36}\.tmp$/.test(path.slice(reportPath.length + 1))) ||
    /^checkout\/data\/ingestion\/backups\/ledger\.snapshot\.enc(?:\.[1-9][0-9]*\.[a-f0-9]{16}\.tmp)?$/.test(
      path
    )
  );
}
function immutableDigest(
  entries: RecoveryRuntimeEntry[],
  retained: ReadonlySet<string>,
  reportPath: string
): string {
  return sha256(
    canonicalJson(
      entries.filter((entry) => !mutable(entry, retained, reportPath))
    )
  );
}
function retainedRun(
  input: RecoveryImportInput,
  checkpoint: ReturnType<typeof openPreparedRuntimeForAdmission>["checkpoint"]
): WeeklyRunState {
  const snapshot = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(checkpoint.journal, "base64")
  );
  const row = snapshot.runState.find(
    (item) =>
      item.id === input.runId && item.scope === "prodigic/zivv/production"
  );
  if (!row) fail("RECOVERY_IMPORT_RUN_NOT_RETAINED");
  const run = parseWeeklyRunState(JSON.parse(row.payload));
  if (
    run.stages[3].status !== "pending" ||
    run.stages.slice(0, 3).some((stage) => stage.status !== "succeeded") ||
    run.stages.slice(4).some((stage) => stage.status !== "pending")
  )
    fail("RECOVERY_IMPORT_BEFORE_LOAD_REQUIRED");
  return run;
}
function currentRun(
  operator: string,
  expected: WeeklyRunState
): WeeklyRunState {
  const path = join(operator, "weekly-runs.sqlite");
  regular(path, 512 * 1024 * 1024);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT scope,payload FROM run_state WHERE id=?")
      .get(expected.runId);
    if (
      !row ||
      row.scope !== "prodigic/zivv/production" ||
      typeof row.payload !== "string"
    )
      fail();
    const run = parseWeeklyRunState(JSON.parse(row.payload));
    same(run.source, expected.source);
    same(run.stages.slice(0, 3), expected.stages.slice(0, 3));
    if (run.stages.slice(4).some((stage) => stage.status !== "pending"))
      fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
    return run;
  } finally {
    db.close();
  }
}
function ensureAdmission(input: RecoveryImportInput, test?: TestOptions) {
  const root = resolve(input.destination),
    operator = join(root, "operator"),
    opened = openPreparedRuntimeForAdmission(input),
    original = retainedRun(input, opened.checkpoint);
  if (test) {
    const offset = relative(realpathSync(tmpdir()), realpathSync(root));
    if (
      !offset ||
      offset === ".." ||
      offset.startsWith("../") ||
      offset.startsWith("..\\") ||
      isAbsolute(offset)
    )
      fail("RECOVERY_IMPORT_TEST_TEMPORARY_ROOT_REQUIRED");
  }
  const retained = new Set([
    ...opened.checkpoint.files
      .filter((file) => file.bytes !== null)
      .map((file) => file.area + "/" + file.path),
    ...opened.checkpoint.directories.map(
      (directory) => directory.area + "/" + directory.path
    ),
  ]);
  const journal = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(opened.checkpoint.journal, "base64")
  );
  const reviewed = journal.stageArtifacts.find(
    (artifact) =>
      artifact.runId === original.runId &&
      artifact.stage === "reconcile" &&
      artifact.attempt === original.stages[2].attempt
  );
  if (!reviewed) fail();
  const review: unknown = JSON.parse(
    Buffer.from(reviewed.bytes, "base64").toString("utf8")
  );
  if (
    !review ||
    typeof review !== "object" ||
    !("receipt" in review) ||
    !review.receipt ||
    typeof review.receipt !== "object" ||
    !("importRunId" in review.receipt) ||
    typeof review.receipt.importRunId !== "string"
  )
    fail();
  const reportPath =
    "checkout/data/ingestion/reports/" +
    sha256(review.receipt.importRunId) +
    ".json";
  const digest = (entries: RecoveryRuntimeEntry[]) =>
    immutableDigest(entries, retained, reportPath);
  const remote: RecoveryImportRemote = test
    ? openRecoveryImportRemoteForTest({
        ...input,
        checkpoint: opened.checkpoint,
        bareDirectory: test.bareDirectory,
      })
    : openRecoveryImportRemote({ ...input, checkpoint: opened.checkpoint });
  const path = join(root, recordName),
    scratch = join(dirname(root), ".zivv-recovery-install-" + sha256(root));
  const fixed = {
    kind: "zivv-recovery-import-admission",
    version: 1,
    scope: "one-retained-run-through-load",
    activationAllowed: false,
    root,
    operator,
    repositoryRoot: realpathSync(input.repositoryRoot),
    physicalNpmCli: resolve(input.npmCli),
    checkpointSha256: opened.report.checkpointSha256,
    archiveSha256: sha256(input.archive),
    retirementSha256: sha256(input.retirementReceipt),
    preparedReceiptSha256: opened.receiptSha256,
    runId: original.runId,
    source: original.source,
    reportPath,
    remote: remote.binding,
    transport: test
      ? {
          kind: "temporary-bare-test",
          directory: realpathSync(test.bareDirectory),
        }
      : { kind: "authoritative-https" },
  };
  if (!existsSync(path)) {
    verifyPreparedOperatorRuntime(input);
    const initial = opened.inventory();
    remote.assertCurrent();
    installRecoveryIntent(
      path,
      signed({ ...fixed, immutableSha256: digest(initial) }, input.recoveryKey),
      scratch
    );
  }
  const bytes = readRecoveryInstalledFile(path, scratch, (current) => {
      const saved = authenticated(current, input.recoveryKey);
      if (
        typeof saved.immutableSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(saved.immutableSha256)
      )
        fail();
      same(saved, { ...fixed, immutableSha256: saved.immutableSha256 });
    }),
    record = authenticated(bytes, input.recoveryKey);
  if (
    typeof record.immutableSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.immutableSha256)
  )
    fail();
  same(record, { ...fixed, immutableSha256: record.immutableSha256 });
  const keyPath = join(
    operator,
    process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
  );
  if (existsSync(keyPath))
    installRecoveredBackupKey(operator, input.recoveryKey, {
      stagingDirectory: scratch,
    });
  const assertImmutable = () => {
    const actual = sha256(
      canonicalJson(
        opened.inventoryImmutable((entry) =>
          mutable(entry, retained, reportPath)
        )
      )
    );
    if (actual !== record.immutableSha256)
      fail("RECOVERY_IMPORT_IMMUTABLE_EVIDENCE_CHANGED");
  };
  assertImmutable();
  if (test?.crashAfterIntent) fail("RECOVERY_IMPORT_TEST_AFTER_INTENT");
  // Key installation follows the durable admission intent, never the reverse.
  if (!existsSync(keyPath)) {
    try {
      installRecoveredBackupKey(operator, input.recoveryKey, {
        stagingDirectory: scratch,
      });
    } catch (error) {
      if (!existsSync(keyPath)) throw error;
    }
  }
  if (!loadBackupKey(operator).equals(input.recoveryKey))
    fail("RECOVERY_IMPORT_WORKING_KEY_MISMATCH");
  const keyBytes = regular(keyPath, 16 * 1024),
    markerBytes = regular(join(root, "recovery-state.json"), 2 * 1024 * 1024),
    preparedBytes = regular(join(root, "prepared-runtime.json"), 16 * 1024);
  const identity = {
    ledger: lstatSync(join(operator, "ledger.sqlite")),
    journal: lstatSync(join(operator, "weekly-runs.sqlite")),
  };
  const assertCurrent = () => {
    assertOperatorInstallationWritable(operator);
    same(regular(path).toString("base64"), bytes.toString("base64"));
    same(
      regular(join(root, "recovery-state.json"), 2 * 1024 * 1024).toString(
        "base64"
      ),
      markerBytes.toString("base64")
    );
    same(
      regular(join(root, "prepared-runtime.json"), 16 * 1024).toString(
        "base64"
      ),
      preparedBytes.toString("base64")
    );
    same(
      regular(keyPath, 16 * 1024).toString("base64"),
      keyBytes.toString("base64")
    );
    const location = projectLedgerLocation(join(root, "checkout"));
    if (location.backend !== "sqlite" || location.directory !== operator)
      fail("RECOVERY_IMPORT_LOCATION_CHANGED");
    for (const [name, old] of Object.entries(identity)) {
      const current = lstatSync(
        join(
          operator,
          name === "ledger" ? "ledger.sqlite" : "weekly-runs.sqlite"
        )
      );
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        current.dev !== old.dev ||
        current.ino !== old.ino
      )
        fail("RECOVERY_IMPORT_LOCATION_CHANGED");
    }
  };
  currentRun(operator, original);
  remote.assertCurrent();
  return {
    root,
    operator,
    original,
    opened,
    bytes,
    record,
    remote,
    assertCurrent,
    assertImmutable,
  };
}

/** Only the coordinator below can establish this scope; ordinary staging stays blocked. */
export function hasRecoveredImportAuthority(directory: string): boolean {
  const scope = scopes.getStore();
  if (!scope?.active || scope.operator !== resolve(directory)) return false;
  scope.assertCurrent();
  return true;
}
/** Reject widening an admitted run into intake, another run, freeze or publication. */
export function assertRecoveredImportInvocation(input: {
  root: string;
  runId?: string;
  stopAfter?: string;
  source?: unknown;
  candidateBuild?: unknown;
  publication?: unknown;
  verifiedDelivery?: unknown;
  freezeCutoffEpochMs?: number;
  reuseFrozen?: boolean;
}): void {
  const scope = scopes.getStore();
  if (!scope?.active) return;
  if (
    resolve(input.root) !== scope.root ||
    input.runId !== scope.runId ||
    input.stopAfter !== "load" ||
    input.source ||
    input.candidateBuild ||
    input.publication ||
    input.verifiedDelivery ||
    input.freezeCutoffEpochMs !== undefined ||
    input.reuseFrozen !== undefined
  )
    fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  scope.assertCurrent();
}
/** Recheck local admission during a worker's existing context checks. */
export function assertRecoveredImportCurrent(): void {
  const scope = scopes.getStore();
  if (scope?.active) scope.assertCurrent();
}
/** Observe unchanged canonical authority immediately around the import effect. */
export function assertRecoveredImportRemote(): void {
  const scope = scopes.getStore();
  if (scope?.active) {
    scope.assertCurrent();
    scope.assertRemote();
  }
}

async function execute(
  input: RecoveryImportInput,
  test?: TestOptions
): Promise<RecoveredImportReport> {
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
    fail("RECOVERY_IMPORT_RETAINED_EXECUTOR_REQUIRED");
  const admitted = ensureAdmission(input, test);
  const scope = {
    active: true,
    root: checkout,
    operator: admitted.operator,
    runId: input.runId,
    assertCurrent: admitted.assertCurrent,
    assertRemote: () => {
      admitted.opened.assertRuntime();
      admitted.assertImmutable();
      admitted.remote.assertCurrent();
    },
  };
  if (scopes.getStore()?.active) fail("NESTED_RECOVERY_IMPORT");
  try {
    return await scopes.run(scope, async () => {
      scope.assertCurrent();
      const state = await runWeeklyImport({
        root: checkout,
        runId: input.runId,
        stopAfter: "load",
        onProgress: test
          ? async (event) => {
              if (event.stage === "load" && event.phase === "started") {
                if (test.probeRestrictedConsumers) {
                  const { assertOperatorNotQuarantined } =
                    await import("./private-artifacts.js");
                  let denied = false;
                  try {
                    assertOperatorNotQuarantined(admitted.operator);
                  } catch (error) {
                    if (
                      error instanceof Error &&
                      error.message === "RECOVERY_INSTALLATION_NOT_ACTIVATED"
                    )
                      denied = true;
                    else throw error;
                  }
                  if (!denied) fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
                  for (const change of [
                    { stopAfter: "freeze" as const },
                    { runId: "another-run" },
                  ]) {
                    denied = false;
                    try {
                      await runWeeklyImport({
                        root: checkout,
                        runId: input.runId,
                        stopAfter: "load",
                        ...change,
                      });
                    } catch (error) {
                      if (
                        error instanceof Error &&
                        error.message === "RECOVERY_IMPORT_SCOPE_EXCEEDED"
                      )
                        denied = true;
                      else throw error;
                    }
                    if (!denied) fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
                  }
                }
                if (test.alterBeforeLoad) {
                  const target =
                    test.alterBeforeLoad === "dependency"
                      ? join(checkout, "node_modules/postal-mime/package.json")
                      : join(
                          checkout,
                          "data/ingestion/reports/retained-evidence.json"
                        );
                  writeFileSync(
                    target,
                    Buffer.concat([
                      readFileSync(target),
                      Buffer.from("\nchanged evidence\n"),
                    ])
                  );
                }
              }
              if (
                test.interruptAfterEffect &&
                event.stage === "load" &&
                event.phase === "effect-committed"
              )
                fail("RECOVERY_IMPORT_TEST_INTERRUPTION");
            }
          : undefined,
      });
      scope.assertCurrent();
      same(state.source, admitted.original.source);
      if (
        state.stages[3].status !== "succeeded" ||
        state.stages.slice(4).some((stage) => stage.status !== "pending")
      )
        fail();
      admitted.opened.assertRuntime();
      admitted.assertImmutable();
      const report: RecoveredImportReport = {
        status: "load-complete",
        activationAllowed: false,
        runId: state.runId,
        ledgerRevision: ledgerDigest(
          readSqliteLedger(join(admitted.operator, "ledger.sqlite"))
        ),
        admissionSha256: sha256(admitted.bytes),
      };
      writeDurableFile(
        join(root, resultName),
        signed(report, input.recoveryKey)
      );
      return report;
    });
  } finally {
    scope.active = false;
  }
}

/** Internal retained-worker entry. Every invocation authenticates admission anew. */
export const executeRecoveredImport = (input: RecoveryImportInput) =>
  execute(input);
/** Explicit native-fixture entry; never selected by the production CLI. */
export const executeRecoveredImportForTest = (
  input: RecoveryImportInput & TestOptions
) => execute(input, input);

async function launch(
  supplied: RecoveryImportInput,
  test?: TestOptions
): Promise<RecoveredImportReport> {
  const input = {
    ...supplied,
    archive: Buffer.from(supplied.archive),
    retirementReceipt: Buffer.from(supplied.retirementReceipt),
    recoveryKey: Buffer.from(supplied.recoveryKey),
  };
  // Parent validates the loader/module tree before any retained code is evaluated.
  ensureAdmission(input, test);
  const root = resolve(input.destination),
    entry = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion/recovery-import-admission.js")
    ).href;
  const script = `
    const {${test ? "executeRecoveredImportForTest" : "executeRecoveredImport"}:execute}=await import(${JSON.stringify(entry)});
    try {
      let size=0;const chunks=[];for await(const chunk of process.stdin){if((size+=chunk.length)>512*1024*1024)throw Error('RECOVERY_IMPORT_INPUT_TOO_LARGE');chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      for(const key of ['archive','retirementReceipt','recoveryKey'])value[key]=Buffer.from(value[key],'base64');
      console.log(JSON.stringify(await execute(value)));
    }catch(error){console.error(JSON.stringify({recoveryImportError:error instanceof Error&&/^[A-Z_]{1,64}$/.test(error.message)?error.message:'RECOVERY_IMPORT_EXECUTION_FAILED'}));process.exitCode=1;}
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
  const wire = JSON.stringify({
    ...input,
    ...test,
    archive: input.archive.toString("base64"),
    retirementReceipt: input.retirementReceipt.toString("base64"),
    recoveryKey: input.recoveryKey.toString("base64"),
  });
  if (Buffer.byteLength(wire) > 512 * 1024 * 1024)
    fail("RECOVERY_IMPORT_INPUT_TOO_LARGE");
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
      reject(new Error("RECOVERY_IMPORT_EXECUTION_FAILED"));
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
    child.stdin.on("error", () => stop());
    child.on("error", stop);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || stopped) {
        const match = /\{"recoveryImportError":"([A-Z_]{1,64})"\}/.exec(
          diagnostic
        );
        reject(
          new Error("RECOVERY_IMPORT_EXECUTION_FAILED", {
            cause: new Error(match?.[1] ?? "RECOVERY_IMPORT_CHILD_STOPPED"),
          })
        );
        return;
      }
      try {
        const result: unknown = JSON.parse(output);
        if (!result || typeof result !== "object" || Array.isArray(result))
          fail();
        const report = result as RecoveredImportReport;
        same(Object.keys(report).sort(), [
          "activationAllowed",
          "admissionSha256",
          "ledgerRevision",
          "runId",
          "status",
        ]);
        if (
          report.status !== "load-complete" ||
          report.activationAllowed !== false ||
          report.runId !== input.runId ||
          !/^[a-f0-9]{64}$/.test(report.ledgerRevision) ||
          !/^[a-f0-9]{64}$/.test(report.admissionSha256)
        )
          fail();
        resolveChild(report);
      } catch {
        reject(new Error("RECOVERY_IMPORT_EXECUTION_FAILED"));
      }
    });
    child.stdin.end(wire);
  });
}
/** Resume only the retained import through load; production admission is not implied. */
export const resumeOperatorRecoveryImport = (input: RecoveryImportInput) =>
  launch(input);
/** Isolated native fixture transport and fixed crash point; no production CLI flag. */
export const resumeOperatorRecoveryImportForTest = (
  input: RecoveryImportInput & TestOptions
) => launch(input, input);
