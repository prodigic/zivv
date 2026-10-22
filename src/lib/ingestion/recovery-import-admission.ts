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
import {
  openRecoveryCandidateRemote,
  openRecoveryCandidateRemoteForTest,
  type RecoveryCandidateRemote,
} from "./recovery-candidate-remote.js";
import { createRecoveryCandidateLocations } from "./recovery-candidate-locations.js";
import type { WeeklyPublicationOptions } from "./weekly-publication.js";
import { parsePromotionControl } from "./promotion-control.js";

const recordName = "recovery-import.json";
const resultName = "recovery-import-result.json";
type RecoveryMode = "load" | "dispatch";
const scopes = new AsyncLocalStorage<{
  active: boolean;
  root: string;
  operator: string;
  runId: string;
  mode: RecoveryMode;
  candidate?: {
    publication: WeeklyPublicationOptions;
    repositoryRoot: string;
    mainHead: string;
    workDirectory: string;
    resolveDirectory(original: string): string;
  };
  assertCurrent(): void;
  assertRemote(): void;
}>();
export interface RecoveryImportInput extends RecoveryRuntimeInput {
  repositoryRoot: string;
  runId: string;
  credentials?: { token: string };
}
export interface RecoveryCandidateInput extends RecoveryImportInput {
  workflowCommit: string;
  githubToken: string;
}
export interface RecoveredImportReport {
  status: "load-complete";
  activationAllowed: false;
  runId: string;
  ledgerRevision: string;
  admissionSha256: string;
}
export interface RecoveredCandidateReport {
  status: "dispatch-observed" | "dispatch-pending";
  activationAllowed: false;
  runId: string;
  ledgerRevision: string;
  admissionSha256: string;
  candidateId: string;
  operationId: string | null;
}
interface TestOptions {
  bareDirectory: string;
  interruptAfterEffect?: boolean;
  crashAfterIntent?: boolean;
  alterBeforeLoad?: "dependency" | "retained-report";
  probeRestrictedConsumers?: boolean;
  pagesApiBaseUrl?: string;
  interruptAt?: "plan" | "claim" | "dispatch";
  enforcePublicationFlags?: boolean;
  alterDependencyAfterPlan?: boolean;
}
function candidateInput(input: RecoveryImportInput): RecoveryCandidateInput {
  const value = input as Partial<RecoveryCandidateInput>;
  if (
    typeof value.workflowCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.workflowCommit) ||
    typeof value.githubToken !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value.githubToken)
  )
    fail("INVALID_RECOVERY_CANDIDATE_INPUT");
  return input as RecoveryCandidateInput;
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
  reportPath: string,
  mode: RecoveryMode,
  runId: string
): boolean {
  const path = entry.path;
  const names = admissionNames(mode);
  if (mode === "dispatch") {
    const publication = "operator/weekly-publication/" + runId;
    if (!retained.has(path)) {
      if (
        entry.kind === "directory" &&
        [
          "operator/weekly-publication",
          publication,
          publication + "/dispatch",
        ].includes(path)
      )
        return true;
      if (entry.kind === "file") {
        for (const file of [
          publication + "/claim-plan.json",
          publication + "/dispatch/pages-dispatch.json",
        ]) {
          if (
            path === file ||
            (path.startsWith(file + ".") &&
              /^[1-9][0-9]*\.[a-f0-9]{16}\.tmp$/.test(
                path.slice(file.length + 1)
              ))
          )
            return true;
        }
      }
    }
  }
  if (
    retained.has(path) &&
    (path.startsWith("checkout/data/ingestion/reports") ||
      path.startsWith("checkout/data/ingestion/backups"))
  )
    return false;
  if (entry.kind === "directory")
    return (
      (mode === "load" && path === "checkout/data/ingestion/reports") ||
      path === "checkout/data/ingestion/backups"
    );
  if (entry.kind !== "file") return false;
  return (
    path === names.record ||
    path === names.result ||
    (path.startsWith(names.result + ".") &&
      /^[1-9][0-9]*\.[a-f0-9]{16}\.tmp$/.test(
        path.slice(names.result.length + 1)
      )) ||
    /^operator\/(?:ledger\.sqlite|weekly-runs\.sqlite)(?:-wal|-shm)?$/.test(
      path
    ) ||
    /^operator\/backup-key\.(?:bin|dpapi)$/.test(path) ||
    (mode === "load" &&
      (path === reportPath ||
        (path.startsWith(reportPath + ".") &&
          /^[a-f0-9-]{36}\.tmp$/.test(path.slice(reportPath.length + 1))))) ||
    /^checkout\/data\/ingestion\/backups\/ledger\.snapshot\.enc(?:\.[1-9][0-9]*\.[a-f0-9]{16}\.tmp)?$/.test(
      path
    )
  );
}
function immutableDigest(
  entries: RecoveryRuntimeEntry[],
  retained: ReadonlySet<string>,
  reportPath: string,
  mode: RecoveryMode,
  runId: string
): string {
  return sha256(
    canonicalJson(
      entries.filter(
        (entry) => !mutable(entry, retained, reportPath, mode, runId)
      )
    )
  );
}
function retainedRun(
  input: RecoveryImportInput,
  checkpoint: ReturnType<typeof openPreparedRuntimeForAdmission>["checkpoint"],
  mode: RecoveryMode
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
  if (mode === "dispatch") {
    if (
      run.stages.slice(0, 8).some((stage) => stage.status !== "succeeded") ||
      run.stages.slice(8).some((stage) => stage.status !== "pending")
    )
      fail("RECOVERY_VALIDATED_CANDIDATE_REQUIRED");
  } else if (
    run.stages[3].status !== "pending" ||
    run.stages.slice(0, 3).some((stage) => stage.status !== "succeeded") ||
    run.stages.slice(4).some((stage) => stage.status !== "pending")
  )
    fail("RECOVERY_IMPORT_BEFORE_LOAD_REQUIRED");
  return run;
}
function currentRun(
  operator: string,
  expected: WeeklyRunState,
  mode: RecoveryMode
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
    same(
      run.stages.slice(0, mode === "dispatch" ? 8 : 3),
      expected.stages.slice(0, mode === "dispatch" ? 8 : 3)
    );
    if (
      (mode === "dispatch" &&
        !["pending", "running"].includes(run.stages[8].status)) ||
      run.stages
        .slice(mode === "dispatch" ? 9 : 4)
        .some((stage) => stage.status !== "pending")
    )
      fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
    return run;
  } finally {
    db.close();
  }
}
function admissionNames(mode: RecoveryMode) {
  return mode === "load"
    ? { record: recordName, result: resultName }
    : {
        record: "recovery-candidate.json",
        result: "recovery-candidate-result.json",
      };
}
function ensureAdmission(
  input: RecoveryImportInput,
  test?: TestOptions,
  mode: RecoveryMode = "load"
) {
  if (mode === "dispatch") {
    if (
      (!test || test.enforcePublicationFlags) &&
      (process.env.ZIVV_CONTROLLED_PUBLISHING !== "enabled" ||
        process.env.ZIVV_MANUAL_PUBLISHER_JOINED !== "true")
    )
      fail("RECOVERY_PUBLICATION_NOT_ENABLED");
    if (test) {
      const url = new URL(String(test.pagesApiBaseUrl));
      if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        fail("RECOVERY_CANDIDATE_TEST_LOOPBACK_REQUIRED");
    }
  }
  const root = resolve(input.destination),
    operator = join(root, "operator"),
    opened = openPreparedRuntimeForAdmission(input),
    original = retainedRun(input, opened.checkpoint, mode);
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
  let workDirectory: string | undefined;
  if (mode === "dispatch") {
    const exported = journal.stageArtifacts.find(
      (artifact) =>
        artifact.runId === original.runId &&
        artifact.stage === "export" &&
        artifact.attempt === original.stages[6].attempt
    );
    if (!exported) fail("RECOVERY_VALIDATED_CANDIDATE_REQUIRED");
    const value: unknown = JSON.parse(
      Buffer.from(exported.bytes, "base64").toString("utf8")
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("workDirectory" in value) ||
      typeof value.workDirectory !== "string"
    )
      fail("RECOVERY_VALIDATED_CANDIDATE_REQUIRED");
    workDirectory = value.workDirectory;
  }
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
    immutableDigest(entries, retained, reportPath, mode, input.runId);
  const remoteInput =
    mode === "dispatch"
      ? {
          ...candidateInput(input),
          credentials: input.credentials ?? {
            token: candidateInput(input).githubToken,
          },
        }
      : undefined;
  const remote: RecoveryImportRemote | RecoveryCandidateRemote =
    mode === "dispatch"
      ? test
        ? openRecoveryCandidateRemoteForTest({
            ...remoteInput!,
            checkpoint: opened.checkpoint,
            bareDirectory: test.bareDirectory,
          })
        : openRecoveryCandidateRemote({
            ...remoteInput!,
            checkpoint: opened.checkpoint,
          })
      : test
        ? openRecoveryImportRemoteForTest({
            ...input,
            checkpoint: opened.checkpoint,
            bareDirectory: test.bareDirectory,
          })
        : openRecoveryImportRemote({ ...input, checkpoint: opened.checkpoint });
  const names = admissionNames(mode);
  const path = join(root, names.record),
    scratch = join(dirname(root), ".zivv-recovery-install-" + sha256(root));
  const fixed = {
    kind:
      mode === "load"
        ? "zivv-recovery-import-admission"
        : "zivv-recovery-candidate-admission",
    version: 1,
    scope:
      mode === "load"
        ? "one-retained-run-through-load"
        : "one-validated-run-through-dispatch",
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
    ...(mode === "dispatch"
      ? { workflowCommit: candidateInput(input).workflowCommit, workDirectory }
      : {}),
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
          mutable(entry, retained, reportPath, mode, input.runId)
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
  currentRun(operator, original, mode);
  if (mode === "dispatch")
    same(
      ledgerDigest(readSqliteLedger(join(operator, "ledger.sqlite"))),
      opened.checkpoint.ledgerRevision
    );
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
    candidate:
      mode === "dispatch" && "candidateBytes" in remote && workDirectory
        ? {
            remote,
            workDirectory,
            locations: createRecoveryCandidateLocations(
              opened.checkpoint,
              root
            ),
          }
        : undefined,
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
  controlledPublishing?: string;
  manualPublisherJoined?: string;
}): void {
  const scope = scopes.getStore();
  if (!scope?.active) return;
  if (
    resolve(input.root) !== scope.root ||
    input.runId !== scope.runId ||
    input.stopAfter !== scope.mode ||
    input.source ||
    input.candidateBuild ||
    (scope.mode === "load"
      ? input.publication !== undefined
      : input.publication !== scope.candidate?.publication ||
        input.controlledPublishing !== "enabled" ||
        input.manualPublisherJoined !== "true") ||
    input.verifiedDelivery ||
    input.freezeCutoffEpochMs !== undefined ||
    input.reuseFrozen !== undefined
  )
    fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  scope.assertCurrent();
}
/** Resolve only this admitted run's unchanged captured export role. */
export function resolveRecoveredCandidateWorkDirectory(
  original: string
): string {
  const scope = scopes.getStore();
  if (!scope?.active) return original;
  scope.assertCurrent();
  if (
    scope.mode !== "dispatch" ||
    !scope.candidate ||
    original !== scope.candidate.workDirectory
  )
    fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  return scope.candidate.resolveDirectory(original);
}
/** Retained files and authoritative Git operations have separately bound roots. */
export function recoveredPublicationRepository(defaultRoot: string): {
  root: string;
  mainHead?: string;
} {
  const scope = scopes.getStore();
  if (!scope?.active) return { root: defaultRoot };
  scope.assertCurrent();
  if (
    scope.mode !== "dispatch" ||
    !scope.candidate ||
    ![scope.root, scope.candidate.repositoryRoot].includes(resolve(defaultRoot))
  )
    fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  return {
    root: scope.candidate.repositoryRoot,
    mainHead: scope.candidate.mainHead,
  };
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
/** Revalidate the dispatch admission immediately before publication effects. */
export function assertRecoveredPublicationEffect(): void {
  const scope = scopes.getStore();
  if (!scope?.active) return;
  if (scope.mode !== "dispatch") fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  scope.assertCurrent();
  scope.assertRemote();
}

function execute(
  input: RecoveryImportInput,
  test?: TestOptions,
  mode?: "load"
): Promise<RecoveredImportReport>;
function execute(
  input: RecoveryCandidateInput,
  test: TestOptions | undefined,
  mode: "dispatch"
): Promise<RecoveredCandidateReport>;
async function execute(
  input: RecoveryImportInput,
  test?: TestOptions,
  mode: RecoveryMode = "load"
): Promise<RecoveredImportReport | RecoveredCandidateReport> {
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
  const admitted = ensureAdmission(input, test, mode);
  const candidate = admitted.candidate;
  const store =
    candidate && test?.interruptAt === "claim"
      ? {
          ...candidate.remote.store,
          compareAndAppend: ((append) => {
            const result = candidate.remote.store.compareAndAppend(append);
            if (
              result.status === "appended" &&
              parsePromotionControl(append.bytes).lastTransition.event.type ===
                "claim"
            )
              fail("RECOVERY_CANDIDATE_TEST_INTERRUPTION");
            return result;
          }) satisfies typeof candidate.remote.store.compareAndAppend,
        }
      : candidate?.remote.store;
  const publication: WeeklyPublicationOptions | undefined = candidate
    ? Object.freeze({
        store: store!,
        transport: candidate.remote.transport,
        candidate: Buffer.from(candidate.remote.candidateBytes),
        workflowCommit: candidateInput(input).workflowCommit,
        githubToken: candidateInput(input).githubToken,
        ...(test
          ? {
              testTransport: {
                kind: "local-test" as const,
                apiBaseUrl: String(test.pagesApiBaseUrl),
              },
            }
          : {}),
      })
    : undefined;
  const scope = {
    active: true,
    root: checkout,
    operator: admitted.operator,
    runId: input.runId,
    mode,
    ...(candidate && publication
      ? {
          candidate: {
            publication,
            repositoryRoot: realpathSync(input.repositoryRoot),
            mainHead: candidate.remote.binding.mainHead,
            workDirectory: candidate.workDirectory,
            resolveDirectory: candidate.locations.resolveExportWorkDirectory,
          },
        }
      : {}),
    assertCurrent: admitted.assertCurrent,
    assertRemote: () => {
      admitted.opened.assertRuntime();
      admitted.assertImmutable();
      admitted.remote.assertCurrent();
    },
  };
  if (scopes.getStore()?.active) fail("NESTED_RECOVERY_IMPORT");
  let dispatchObserved = false;
  try {
    return await scopes.run(scope, async () => {
      scope.assertCurrent();
      const state = await runWeeklyImport({
        root: checkout,
        runId: input.runId,
        stopAfter: mode,
        ...(publication
          ? {
              publication,
              controlledPublishing: "enabled",
              manualPublisherJoined: "true",
            }
          : {}),
        onProgress: async (event) => {
          if (event.stage === "deploy" && event.phase === "effect-committed")
            dispatchObserved = true;
          if (!test) return;
          if (
            mode === "dispatch" &&
            event.stage === "deploy" &&
            event.phase === "artifact-saved" &&
            test.alterDependencyAfterPlan
          ) {
            const dependency = join(
              checkout,
              "node_modules/postal-mime/package.json"
            );
            writeFileSync(
              dependency,
              Buffer.concat([
                readFileSync(dependency),
                Buffer.from("\nchanged after plan\n"),
              ])
            );
          }
          if (
            mode === "dispatch" &&
            event.stage === "deploy" &&
            event.phase === "started" &&
            test.probeRestrictedConsumers
          ) {
            const { assertOperatorNotQuarantined } =
              await import("./private-artifacts.js");
            let denied = false;
            try {
              assertOperatorNotQuarantined(admitted.operator);
            } catch (error) {
              if (
                !(error instanceof Error) ||
                error.message !== "RECOVERY_INSTALLATION_NOT_ACTIVATED"
              )
                throw error;
              denied = true;
            }
            if (!denied) fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
            for (const change of [
              { stopAfter: "verify" as const },
              { stopAfter: "acknowledge" as const },
              { runId: "another-run" },
              { publication: { ...publication! } },
            ]) {
              denied = false;
              try {
                await runWeeklyImport({
                  root: checkout,
                  runId: input.runId,
                  stopAfter: "dispatch",
                  publication,
                  controlledPublishing: "enabled",
                  manualPublisherJoined: "true",
                  ...change,
                });
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  error.message !== "RECOVERY_IMPORT_SCOPE_EXCEEDED"
                )
                  throw error;
                denied = true;
              }
              if (!denied) fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
            }
          }
          if (
            mode === "dispatch" &&
            event.stage === "deploy" &&
            ((test.interruptAt === "plan" &&
              event.phase === "artifact-saved") ||
              (test.interruptAt === "dispatch" &&
                event.phase === "effect-committed"))
          )
            fail("RECOVERY_CANDIDATE_TEST_INTERRUPTION");
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
        },
      });
      scope.assertCurrent();
      same(state.source, admitted.original.source);
      if (
        mode === "load" &&
        (state.stages[3].status !== "succeeded" ||
          state.stages.slice(4).some((stage) => stage.status !== "pending"))
      )
        fail();
      if (mode === "dispatch") {
        currentRun(admitted.operator, admitted.original, mode);
        same(
          ledgerDigest(
            readSqliteLedger(join(admitted.operator, "ledger.sqlite"))
          ),
          admitted.opened.checkpoint.ledgerRevision
        );
      }
      admitted.opened.assertRuntime();
      admitted.assertImmutable();
      const base = {
        activationAllowed: false as const,
        runId: state.runId,
        ledgerRevision: ledgerDigest(
          readSqliteLedger(join(admitted.operator, "ledger.sqlite"))
        ),
        admissionSha256: sha256(admitted.bytes),
      };
      let report: RecoveredImportReport | RecoveredCandidateReport;
      if (candidate) {
        const progress = candidate.remote.validateProgress(
          candidate.remote.binding.initialControlHead
        );
        report = {
          ...base,
          status:
            dispatchObserved ||
            (progress.phase &&
              [
                "admitted",
                "deployment-requested",
                "deployed",
                "verified",
              ].includes(progress.phase))
              ? "dispatch-observed"
              : "dispatch-pending",
          candidateId: candidate.remote.binding.candidateId,
          operationId: progress.operationId,
        };
      } else report = { ...base, status: "load-complete" };
      writeDurableFile(
        join(root, admissionNames(mode).result),
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
export const executeRecoveredCandidate = (input: RecoveryCandidateInput) =>
  execute(input, undefined, "dispatch");
export const executeRecoveredCandidateForTest = (
  input: RecoveryCandidateInput & TestOptions
) => execute(input, input, "dispatch");

function launch(
  input: RecoveryImportInput,
  test?: TestOptions,
  mode?: "load"
): Promise<RecoveredImportReport>;
function launch(
  input: RecoveryCandidateInput,
  test: TestOptions | undefined,
  mode: "dispatch"
): Promise<RecoveredCandidateReport>;
async function launch(
  supplied: RecoveryImportInput,
  test?: TestOptions,
  mode: RecoveryMode = "load"
): Promise<RecoveredImportReport | RecoveredCandidateReport> {
  const input = {
    ...supplied,
    archive: Buffer.from(supplied.archive),
    retirementReceipt: Buffer.from(supplied.retirementReceipt),
    recoveryKey: Buffer.from(supplied.recoveryKey),
  };
  // Parent validates the loader/module tree before any retained code is evaluated.
  ensureAdmission(input, test, mode);
  const root = resolve(input.destination),
    entry = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion/recovery-import-admission.js")
    ).href;
  const script = `
    const {${mode === "load" ? (test ? "executeRecoveredImportForTest" : "executeRecoveredImport") : test ? "executeRecoveredCandidateForTest" : "executeRecoveredCandidate"}:execute}=await import(${JSON.stringify(entry)});
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
  if (mode === "dispatch" && (!test || test.enforcePublicationFlags)) {
    env.ZIVV_CONTROLLED_PUBLISHING = process.env.ZIVV_CONTROLLED_PUBLISHING;
    env.ZIVV_MANUAL_PUBLISHER_JOINED = process.env.ZIVV_MANUAL_PUBLISHER_JOINED;
  }
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
        const report = result as
          | RecoveredImportReport
          | RecoveredCandidateReport;
        same(
          Object.keys(report).sort(),
          [
            "activationAllowed",
            "admissionSha256",
            "ledgerRevision",
            "runId",
            "status",
            ...(mode === "dispatch" ? ["candidateId", "operationId"] : []),
          ].sort()
        );
        if (
          (mode === "load"
            ? report.status !== "load-complete"
            : !["dispatch-observed", "dispatch-pending"].includes(
                report.status
              )) ||
          report.activationAllowed !== false ||
          report.runId !== input.runId ||
          !/^[a-f0-9]{64}$/.test(report.ledgerRevision) ||
          !/^[a-f0-9]{64}$/.test(report.admissionSha256)
        )
          fail();
        if (
          mode === "dispatch" &&
          (!("candidateId" in report) ||
            !/^[a-f0-9]{64}$/.test(report.candidateId) ||
            (report.operationId !== null &&
              !/^[a-f0-9]{64}$/.test(report.operationId)))
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
/** Explicit same-candidate dispatch; quarantine is not generally activated. */
export const resumeOperatorRecoveryCandidate = (
  input: RecoveryCandidateInput
) => launch(input, undefined, "dispatch");
/** Native Git and loopback HTTP fixture adapter, never selected by the CLI. */
export const resumeOperatorRecoveryCandidateForTest = (
  input: RecoveryCandidateInput & TestOptions
) => launch(input, input, "dispatch");
