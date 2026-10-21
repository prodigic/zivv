import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
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
import {
  openRecoveryFrozenRemote,
  openRecoveryFrozenRemoteForTest,
  type RecoveryFrozenRemote,
} from "./recovery-frozen-remote.js";
import {
  captureExportConfiguration,
  configurationDigest,
  type CandidateConfiguration,
} from "./export-configuration.js";
import {
  verifyCapturedSource,
  parseApplicationBuildReceipt,
  verifyBuildExecutionToolIdentity,
  verifyCompiledEtl,
  type CapturedSource,
} from "./source-build.js";
import type { WeeklyCandidateBuildOptions } from "./weekly-candidate-runner.js";
import { parseSavedPagesDispatch } from "./pages-dispatch-runner.js";
import type { PagesWorkflowDispatchReceipt } from "./pages-dispatch.js";

const recordName = "recovery-import.json";
const resultName = "recovery-import-result.json";
type RecoveryMode =
  | "load"
  | "dispatch"
  | "validate"
  | "reconcile"
  | "acknowledge";
function candidateMode(mode: RecoveryMode): boolean {
  return dispatchMode(mode) || mode === "acknowledge";
}
function dispatchMode(mode: RecoveryMode): boolean {
  return mode === "dispatch" || mode === "reconcile";
}
function stopStage(
  mode: RecoveryMode
): "load" | "dispatch" | "validate" | "acknowledge" {
  return mode === "reconcile" ? "dispatch" : mode;
}
const scopes = new AsyncLocalStorage<{
  active: boolean;
  root: string;
  operator: string;
  runId: string;
  mode: RecoveryMode;
  build?: {
    options: WeeklyCandidateBuildOptions;
    repositoryRoot: string;
    mainHead: string;
    configuration: CandidateConfiguration;
    parent: string;
    alterBuiltModule?: "module" | "manifest" | "manifest-addition";
    module?: {
      sourceRoot: string;
      files: ReadonlyMap<string, string>;
      manifests: ReadonlyMap<string, string | null>;
    };
  };
  candidate?: {
    publication?: WeeklyPublicationOptions;
    verifiedDelivery?: {
      store: RecoveryCandidateRemote["store"];
      candidate: Buffer;
    };
    repositoryRoot: string;
    mainHead: string;
    workDirectory: string;
    resolveDirectory(original: string): string;
    dispatchSelection?: {
      operationId: string;
      attemptId: string;
      runId?: string;
    };
    receiptSha256?: string;
    receiptObserved?: boolean;
    assertReceipt?(receipt: unknown): void;
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
export interface RecoveryVerifiedInput extends RecoveryImportInput {
  workflowCommit: string;
}
export interface RecoveredVerifiedReport {
  status: "acknowledgement-complete";
  activationAllowed: false;
  runId: string;
  ledgerRevision: string;
  admissionSha256: string;
  candidateId: string;
  operationId: string;
  acknowledgementId: string;
}
export interface RecoveryFrozenInput extends RecoveryImportInput {
  sourceCommit: string;
}
export interface RecoveredFrozenReport {
  status: "candidate-validated";
  activationAllowed: false;
  runId: string;
  ledgerRevision: string;
  admissionSha256: string;
  candidateId: string;
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
  interruptAt?:
    | "plan"
    | "claim"
    | "dispatch"
    | "acknowledge-intent-saved"
    | "acknowledge-intent-bound"
    | "acknowledge-cutoff-written"
    | "acknowledge-remote-completed";
  enforcePublicationFlags?: boolean;
  alterDependencyAfterPlan?: boolean;
  alterBuiltModule?: "module" | "manifest" | "manifest-addition";
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
function verifiedInput(input: RecoveryImportInput): RecoveryVerifiedInput {
  const value = input as Partial<RecoveryVerifiedInput>;
  if (
    typeof value.workflowCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.workflowCommit)
  )
    fail("INVALID_RECOVERY_VERIFIED_INPUT");
  return input as RecoveryVerifiedInput;
}
function frozenInput(input: RecoveryImportInput): RecoveryFrozenInput {
  const value = input as Partial<RecoveryFrozenInput>;
  if (
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit)
  )
    fail("INVALID_RECOVERY_FROZEN_INPUT");
  return input as RecoveryFrozenInput;
}
function buildNamespace(runId: string): string {
  // The full run identity is signed; this collision-refusing location is only
  // a compact physical role so Windows can spawn nested native build tools.
  return "operator/weekly-candidates/r-" + sha256(runId).slice(0, 16);
}
function buildParent(root: string, runId: string): string {
  return join(root, buildNamespace(runId));
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
  if (mode === "validate" && !retained.has(path)) {
    const parent = buildNamespace(runId);
    if (entry.kind === "directory" && path === "operator/weekly-candidates")
      return true;
    if (path === parent || path.startsWith(parent + "/")) return true;
  }
  if (mode === "acknowledge" && entry.kind === "file") {
    const weekly = "checkout/data/ingestion/weekly-editions.json";
    if (
      path === weekly ||
      (!retained.has(path) &&
        path.startsWith(weekly + ".") &&
        /^[1-9][0-9]*\.[a-f0-9]{16}\.tmp$/.test(path.slice(weekly.length + 1)))
    )
      return true;
  }
  if (dispatchMode(mode)) {
    const publication = "operator/weekly-publication/" + runId;
    if (mode === "reconcile" && entry.kind === "file") {
      const file = publication + "/dispatch/pages-dispatch.json";
      if (
        path === file ||
        (!retained.has(path) &&
          path.startsWith(file + ".") &&
          /^[1-9][0-9]*\.[a-f0-9]{16}\.tmp$/.test(path.slice(file.length + 1)))
      )
        return true;
    }
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
  if (candidateMode(mode) || mode === "validate") {
    const prefix = mode === "acknowledge" ? 10 : dispatchMode(mode) ? 8 : 5;
    if (
      mode === "acknowledge" &&
      snapshot.stageArtifacts.some(
        (a) => a.runId === run.runId && a.stage === "acknowledge"
      )
    )
      fail("RECOVERY_VERIFIED_CHECKPOINT_REQUIRED");
    if (
      run.stages
        .slice(0, prefix)
        .some((stage) => stage.status !== "succeeded") ||
      (mode === "reconcile"
        ? run.stages[8].status !== "running" ||
          run.stages.slice(9).some((stage) => stage.status !== "pending")
        : run.stages.slice(prefix).some((stage) => stage.status !== "pending"))
    )
      fail(
        dispatchMode(mode)
          ? "RECOVERY_VALIDATED_CANDIDATE_REQUIRED"
          : "RECOVERY_FROZEN_CHECKPOINT_REQUIRED"
      );
    if (
      mode === "validate" &&
      snapshot.stageArtifacts.some(
        (artifact) =>
          artifact.runId === run.runId &&
          [
            "enrich",
            "export",
            "validate",
            "deploy",
            "verify",
            "acknowledge",
          ].includes(artifact.stage)
      )
    )
      fail("RECOVERY_FROZEN_CHECKPOINT_REQUIRED");
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
  mode: RecoveryMode,
  database?: DatabaseSync
): WeeklyRunState {
  const path = join(operator, "weekly-runs.sqlite");
  regular(path, 512 * 1024 * 1024);
  const db = database ?? new DatabaseSync(path, { readOnly: true });
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
      run.stages.slice(
        0,
        mode === "acknowledge"
          ? 10
          : dispatchMode(mode)
            ? 8
            : mode === "validate"
              ? 5
              : 3
      ),
      expected.stages.slice(
        0,
        mode === "acknowledge"
          ? 10
          : dispatchMode(mode)
            ? 8
            : mode === "validate"
              ? 5
              : 3
      )
    );
    if (mode === "reconcile") same(run.stages[8], expected.stages[8]);
    if (
      mode === "acknowledge" &&
      !["pending", "running", "succeeded"].includes(run.stages[10].status)
    )
      fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
    if (
      (dispatchMode(mode) &&
        !["pending", "running"].includes(run.stages[8].status)) ||
      run.stages
        .slice(
          mode === "acknowledge"
            ? 11
            : dispatchMode(mode)
              ? 9
              : mode === "validate"
                ? 8
                : 4
        )
        .some((stage) => stage.status !== "pending")
    )
      fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
    return run;
  } finally {
    if (!database) db.close();
  }
}
function admissionNames(mode: RecoveryMode) {
  if (mode === "acknowledge")
    return {
      record: "recovery-verified.json",
      result: "recovery-verified-result.json",
    };
  if (mode === "reconcile")
    return {
      record: "recovery-dispatch.json",
      result: "recovery-dispatch-result.json",
    };
  return mode === "load"
    ? { record: recordName, result: resultName }
    : mode === "validate"
      ? {
          record: "recovery-frozen.json",
          result: "recovery-frozen-result.json",
        }
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
  if (candidateMode(mode)) {
    if (
      (!test || test.enforcePublicationFlags) &&
      (process.env.ZIVV_CONTROLLED_PUBLISHING !== "enabled" ||
        process.env.ZIVV_MANUAL_PUBLISHER_JOINED !== "true")
    )
      fail("RECOVERY_PUBLICATION_NOT_ENABLED");
    if (test && dispatchMode(mode)) {
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
  if (candidateMode(mode)) {
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
    mode === "acknowledge"
      ? { ...verifiedInput(input), profile: "verified" as const }
      : dispatchMode(mode)
        ? {
            ...candidateInput(input),
            ...(mode === "reconcile"
              ? { profile: "pending-dispatch" as const }
              : {}),
            credentials: input.credentials ?? {
              token: candidateInput(input).githubToken,
            },
          }
        : undefined;
  const remote:
    | RecoveryImportRemote
    | RecoveryCandidateRemote
    | RecoveryFrozenRemote =
    mode === "validate"
      ? test
        ? openRecoveryFrozenRemoteForTest({
            ...frozenInput(input),
            checkpoint: opened.checkpoint,
            bareDirectory: test.bareDirectory,
          })
        : openRecoveryFrozenRemote({
            ...frozenInput(input),
            checkpoint: opened.checkpoint,
          })
      : candidateMode(mode)
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
          : openRecoveryImportRemote({
              ...input,
              checkpoint: opened.checkpoint,
            });
  const names = admissionNames(mode);
  const configuration =
    mode === "validate"
      ? captureExportConfiguration(join(root, "checkout"))
      : undefined;
  const parent =
    mode === "validate" ? buildParent(root, input.runId) : undefined;
  if (parent && !existsSync(join(root, names.record)) && existsSync(parent))
    fail("RECOVERY_FROZEN_WORKSPACE_EXISTS");
  const path = join(root, names.record),
    scratch = join(dirname(root), ".zivv-recovery-install-" + sha256(root));
  const fixed = {
    kind:
      mode === "load"
        ? "zivv-recovery-import-admission"
        : mode === "validate"
          ? "zivv-recovery-frozen-admission"
          : mode === "reconcile"
            ? "zivv-recovery-dispatch-admission"
            : mode === "acknowledge"
              ? "zivv-recovery-verified-admission"
              : "zivv-recovery-candidate-admission",
    version: 1,
    scope:
      mode === "load"
        ? "one-retained-run-through-load"
        : mode === "validate"
          ? "one-frozen-run-through-validate"
          : mode === "reconcile"
            ? "one-retained-dispatch-reconciliation"
            : mode === "acknowledge"
              ? "one-verified-run-through-acknowledgement"
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
    ...(candidateMode(mode)
      ? { workflowCommit: verifiedInput(input).workflowCommit, workDirectory }
      : {}),
    ...(configuration && parent
      ? {
          sourceCommit: frozenInput(input).sourceCommit,
          configurationSha256: configurationDigest(configuration),
          buildParent: parent,
        }
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
    if (mode === "acknowledge") {
      if (!("verifiedDelivery" in remote) || !remote.verifiedDelivery)
        fail("RECOVERY_VERIFIED_CHECKPOINT_REQUIRED");
      remote.verifiedDelivery.assertWeekly(
        regular(join(root, "checkout/data/ingestion/weekly-editions.json"))
      );
    }
    if (mode === "reconcile") {
      if (!("pendingDispatch" in remote) || !remote.pendingDispatch)
        fail("RECOVERY_ACCEPTED_DISPATCH_REQUIRED");
      const dispatchPath = join(
        operator,
        "weekly-publication",
        input.runId,
        "dispatch/pages-dispatch.json"
      );
      const originalPath =
        "weekly-publication/" + input.runId + "/dispatch/pages-dispatch.json";
      const retainedDispatch = opened.checkpoint.files.find(
        (file) => file.area === "operator" && file.path === originalPath
      );
      if (existsSync(dispatchPath)) {
        const expected = parseSavedPagesDispatch(
          remote.pendingDispatch.savedBytes
        );
        const currentBytes = regular(dispatchPath, 2_000_000);
        const current = parseSavedPagesDispatch(currentBytes);
        same(current.schemaVersion, expected.schemaVersion);
        same(current.intent, expected.intent);
        same(current.pendingAppend, expected.pendingAppend);
        if (expected.receipt) same(current.receipt, expected.receipt);
        const currentScope = scopes.getStore()?.candidate;
        if (current.receipt) {
          remote.pendingDispatch.assertReceipt(current.receipt);
          const authorized = currentScope?.receiptSha256;
          if (authorized) {
            same(sha256(canonicalJson(current.receipt)), authorized);
            currentScope.receiptObserved = true;
          }
        } else if (currentScope?.receiptObserved) {
          fail("RECOVERY_DISPATCH_RECEIPT_REMOVED");
        }
        if (retainedDispatch?.bytes) {
          const original = parseSavedPagesDispatch(
            Buffer.from(retainedDispatch.bytes, "base64")
          );
          if (original.receipt)
            same(currentBytes.toString("base64"), retainedDispatch.bytes);
        }
      } else if (
        retainedDispatch?.bytes ||
        scopes.getStore()?.candidate?.receiptObserved
      )
        fail("RECOVERY_RETAINED_DISPATCH_MISSING");
    }
    const actual = sha256(
      canonicalJson(
        opened.inventoryImmutable(
          (entry) => mutable(entry, retained, reportPath, mode, input.runId),
          mode === "validate" ? buildNamespace(input.runId) : undefined
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
    if (mode === "acknowledge") {
      same(
        ledgerDigest(readSqliteLedger(join(operator, "ledger.sqlite"))),
        opened.checkpoint.ledgerRevision
      );
      const db = new DatabaseSync(join(operator, "weekly-runs.sqlite"), {
        readOnly: true,
      });
      try {
        db.exec("BEGIN");
        currentRun(operator, original, mode, db);
        const rows = db
          .prepare(
            "SELECT run_id AS runId,stage,attempt,identity,bytes FROM stage_artifact WHERE run_id=? AND stage!='acknowledge' ORDER BY stage,attempt"
          )
          .all(original.runId);
        same(
          rows.map((row) => ({
            ...row,
            bytes: Buffer.from(row.bytes as Uint8Array).toString("base64"),
          })),
          journal.stageArtifacts.filter(
            (row) => row.runId === original.runId && row.stage !== "acknowledge"
          )
        );
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    }
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
  if (candidateMode(mode) || mode === "validate")
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
      candidateMode(mode) && "candidateBytes" in remote && workDirectory
        ? {
            remote,
            workDirectory,
            locations: createRecoveryCandidateLocations(
              opened.checkpoint,
              root
            ),
          }
        : undefined,
    build:
      mode === "validate" && configuration && parent
        ? {
            options: Object.freeze({
              sourceCommit: frozenInput(input).sourceCommit,
              purpose: "release" as const,
              basePath: "/zivv/",
              npmCli: resolve(input.npmCli),
            }),
            repositoryRoot: realpathSync(input.repositoryRoot),
            mainHead: remote.binding.mainHead,
            configuration,
            parent,
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
    input.stopAfter !== stopStage(scope.mode) ||
    input.source ||
    (scope.mode === "validate"
      ? input.candidateBuild !== scope.build?.options
      : input.candidateBuild !== undefined) ||
    (!dispatchMode(scope.mode)
      ? input.publication !== undefined
      : input.publication !== scope.candidate?.publication ||
        input.controlledPublishing !== "enabled" ||
        input.manualPublisherJoined !== "true") ||
    (scope.mode === "acknowledge"
      ? input.verifiedDelivery !== scope.candidate?.verifiedDelivery ||
        input.controlledPublishing !== "enabled" ||
        input.manualPublisherJoined !== "true"
      : input.verifiedDelivery !== undefined) ||
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
  if (scope.mode === "validate" && scope.build) {
    const child = relative(scope.build.parent, resolve(original));
    if (!/^candidate-work-[A-Za-z0-9_-]+$/.test(child))
      fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
    return original;
  }
  if (
    !candidateMode(scope.mode) ||
    !scope.candidate ||
    original !== scope.candidate.workDirectory
  )
    fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  return scope.candidate.resolveDirectory(original);
}
/** Only a frozen admission may choose a new build context on the replacement host. */
export function recoveredCandidateBuildContext(defaultRoot: string): {
  repositoryRoot: string;
  mainHead?: string;
  configuration?: CandidateConfiguration;
} {
  const scope = scopes.getStore();
  if (!scope?.active) return { repositoryRoot: defaultRoot };
  scope.assertCurrent();
  if (
    scope.mode !== "validate" ||
    !scope.build ||
    ![scope.root, scope.build.repositoryRoot].includes(resolve(defaultRoot))
  )
    fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  return {
    repositoryRoot: scope.build.repositoryRoot,
    mainHead: scope.build.mainHead,
    configuration: Object.fromEntries(
      Object.entries(scope.build.configuration).map(([path, bytes]) => [
        path,
        bytes === null ? null : Buffer.from(bytes),
      ])
    ) as CandidateConfiguration,
  };
}
/** Keep new build outputs in one signed run-specific namespace. */
export function recoveredCandidateWorkParent(defaultParent: string): string {
  const scope = scopes.getStore();
  if (!scope?.active) return defaultParent;
  scope.assertCurrent();
  if (resolve(defaultParent) !== join(scope.operator, "weekly-candidates"))
    fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  return scope.mode === "validate" && scope.build
    ? scope.build.parent
    : defaultParent;
}
/** Bind the isolated recipe before it can capture source or execute npm. */
export function assertRecoveredCandidateBuild(input: {
  repositoryRoot: string;
  privateDirectory: string;
  sourceCommit: string;
  purpose: string;
  basePath: string;
  npmCli: string;
}): void {
  const scope = scopes.getStore();
  if (!scope?.active) return;
  if (scope.mode !== "validate" || !scope.build)
    fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  scope.assertCurrent();
  scope.assertRemote();
  if (
    ![scope.root, scope.build.repositoryRoot].includes(
      resolve(input.repositoryRoot)
    ) ||
    input.sourceCommit !== scope.build.options.sourceCommit ||
    input.purpose !== "release" ||
    input.basePath !== "/zivv/" ||
    resolve(input.npmCli) !== scope.build.options.npmCli ||
    !/^candidate-work-[A-Za-z0-9_-]+$/.test(
      relative(scope.build.parent, resolve(input.privateDirectory))
    )
  )
    fail("RECOVERY_BUILD_CONTEXT_CHANGED");
}
/** Grant the loader only the newly verified reviewed ETL tree, for this active run. */
export function authorizeRecoveredCandidateBuildModules(
  source: CapturedSource,
  bytes: Buffer
): void {
  const scope = scopes.getStore();
  if (!scope?.active) return;
  if (scope.mode !== "validate" || !scope.build)
    fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  scope.assertCurrent();
  scope.assertRemote();
  const suffix = relative(scope.build.parent, source.sourceRoot)
    .split("\\")
    .join("/");
  if (
    !/^candidate-work-[A-Za-z0-9_-]+\/source-build-[A-Za-z0-9_-]+\/source$/.test(
      suffix
    )
  )
    fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  const receipt = parseApplicationBuildReceipt(bytes);
  verifyCapturedSource(source);
  if (
    source.sourceCommit !== scope.build.options.sourceCommit ||
    source.purpose !== "release" ||
    receipt.schemaVersion !== 2 ||
    receipt.sourceCommit !== source.sourceCommit ||
    receipt.sourceTree !== source.sourceTree ||
    receipt.basePath !== "/zivv/" ||
    !regular(join(source.directory, "application-build.json")).equals(bytes)
  )
    fail("RECOVERY_BUILD_CONTEXT_CHANGED");
  verifyBuildExecutionToolIdentity(
    receipt,
    regular(join(source.directory, "execution-tools.json"))
  );
  verifyCompiledEtl(source.sourceRoot, receipt.etlInventorySha256);
  const files = new Map<string, string>();
  const manifests = new Map<string, string | null>();
  const recordManifest = (directory: string): void => {
    const path = join(directory, "package.json");
    manifests.set(path, existsSync(path) ? sha256(regular(path)) : null);
  };
  recordManifest(realpathSync(source.sourceRoot));
  let entries = 0,
    total = 0;
  for (const name of ["dist", "node_modules"]) {
    const base = join(realpathSync(source.sourceRoot), name);
    const walk = (directory: string): void => {
      recordManifest(directory);
      for (const child of readdirSync(directory)) {
        if (++entries > 50_000) fail("RECOVERY_BUILD_MODULE_LIMIT");
        const path = join(directory, child),
          stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          const suffix = relative(base, realpathSync(path));
          if (
            suffix === ".." ||
            suffix.startsWith("../") ||
            suffix.startsWith("..\\") ||
            isAbsolute(suffix)
          )
            fail("RECOVERY_BUILD_MODULE_LINK");
        } else if (stat.isDirectory()) walk(path);
        else {
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            (total += stat.size) > 512 * 1024 * 1024
          )
            fail("RECOVERY_BUILD_MODULE_LIMIT");
          files.set(
            realpathSync(path),
            sha256(regular(path, 512 * 1024 * 1024))
          );
        }
      }
    };
    walk(base);
  }
  scope.build.module = {
    sourceRoot: realpathSync(source.sourceRoot),
    files,
    manifests,
  };
  if (scope.build.alterBuiltModule) {
    const target =
      scope.build.alterBuiltModule === "module"
        ? join(source.sourceRoot, "dist/lib/etl/processor.js")
        : scope.build.alterBuiltModule === "manifest"
          ? join(source.sourceRoot, "package.json")
          : join(source.sourceRoot, "dist/package.json");
    const existing = existsSync(target)
      ? readFileSync(target)
      : Buffer.alloc(0);
    writeFileSync(
      target,
      scope.build.alterBuiltModule === "module"
        ? Buffer.concat([
            existing,
            Buffer.from("\n// changed after module authorization\n"),
          ])
        : scope.build.alterBuiltModule === "manifest"
          ? Buffer.concat([existing, Buffer.from("\n ")])
          : Buffer.from('{"type":"module"}\n')
    );
  }
}
/** Bind resolver metadata, including explicit absence, before resolving a build module. */
export function assertRecoveredBuildResolutionCurrent(): void {
  const scope = scopes.getStore();
  const build = scope?.build?.module;
  if (!scope?.active || scope.mode !== "validate" || !build) return;
  scope.assertCurrent();
  for (const [path, expected] of build.manifests) {
    const actual = existsSync(path) ? sha256(regular(path)) : null;
    if (actual !== expected) fail("RECOVERY_BUILD_MODULE_METADATA_CHANGED");
  }
}
/** Called by the retained module boundary; no active verified build grants no access. */
export function isRecoveredBuildModuleAllowed(path: string): boolean {
  const scope = scopes.getStore();
  const build = scope?.build?.module;
  if (!scope?.active || scope.mode !== "validate" || !build) return false;
  scope.assertCurrent();
  const suffix = relative(build.sourceRoot, realpathSync(path));
  if (
    !suffix ||
    isAbsolute(suffix) ||
    suffix === ".." ||
    suffix.startsWith("..\\") ||
    suffix.startsWith("../")
  )
    return false;
  if (
    !suffix.startsWith("dist/") &&
    !suffix.startsWith("dist\\") &&
    !suffix.startsWith("node_modules/") &&
    !suffix.startsWith("node_modules\\")
  )
    return false;
  const expected = build.files.get(realpathSync(path));
  if (expected === undefined) return false;
  if (sha256(regular(path, 512 * 1024 * 1024)) !== expected)
    fail("RECOVERY_BUILD_MODULE_CHANGED");
  return true;
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
    !candidateMode(scope.mode) ||
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
  if (!dispatchMode(scope.mode)) fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
  scope.assertCurrent();
  scope.assertRemote();
}
/** A captured accepted dispatch is GET-only; it never authorizes a fresh attempt. */
export function assertRecoveredFreshDispatchAllowed(): void {
  const scope = scopes.getStore();
  if (!scope?.active) return;
  if (scope.mode === "reconcile") fail("RECOVERY_DISPATCH_GET_ONLY");
  assertRecoveredPublicationEffect();
}
/** Select only the authenticated original receipt or canonical attempt, never mutable metadata. */
export function recoveredDispatchSelection():
  | { operationId: string; attemptId: string; runId?: string }
  | undefined {
  const scope = scopes.getStore();
  if (!scope?.active || scope.mode !== "reconcile") return undefined;
  scope.assertCurrent();
  if (!scope.candidate?.dispatchSelection)
    fail("RECOVERY_ACCEPTED_DISPATCH_REQUIRED");
  return { ...scope.candidate.dispatchSelection };
}
/** Pin only a receipt just proven by the dispatch transport's matching GET result. */
export function authorizeRecoveredDispatchReceipt(
  receipt: PagesWorkflowDispatchReceipt
): void {
  const scope = scopes.getStore();
  if (!scope?.active || scope.mode !== "reconcile") return;
  scope.assertCurrent();
  if (!scope.candidate?.assertReceipt)
    fail("RECOVERY_ACCEPTED_DISPATCH_REQUIRED");
  scope.candidate.assertReceipt(receipt);
  scope.candidate.receiptSha256 = sha256(canonicalJson(receipt));
}

function execute(
  input: RecoveryImportInput,
  test?: TestOptions,
  mode?: "load"
): Promise<RecoveredImportReport>;
function execute(
  input: RecoveryCandidateInput,
  test: TestOptions | undefined,
  mode: "dispatch" | "reconcile"
): Promise<RecoveredCandidateReport>;
function execute(
  input: RecoveryVerifiedInput,
  test: TestOptions | undefined,
  mode: "acknowledge"
): Promise<RecoveredVerifiedReport>;
function execute(
  input: RecoveryFrozenInput,
  test: TestOptions | undefined,
  mode: "validate"
): Promise<RecoveredFrozenReport>;
async function execute(
  input: RecoveryImportInput,
  test?: TestOptions,
  mode: RecoveryMode = "load"
): Promise<
  | RecoveredImportReport
  | RecoveredCandidateReport
  | RecoveredFrozenReport
  | RecoveredVerifiedReport
> {
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
    candidate && mode === "acknowledge"
      ? {
          ...candidate.remote.store,
          compareAndAppend: ((append) => {
            const verify = () => {
              admitted.assertCurrent();
              admitted.opened.assertRuntime();
              admitted.assertImmutable();
              candidate.remote.assertCurrent();
              candidate.remote.verifiedDelivery!.assertAppend(append);
              append.checkContext?.();
            };
            verify();
            return candidate.remote.store.compareAndAppend({
              ...append,
              checkContext: verify,
            });
          }) satisfies typeof candidate.remote.store.compareAndAppend,
        }
      : candidate && mode === "reconcile"
        ? {
            ...candidate.remote.store,
            compareAndAppend: () => fail("RECOVERY_DISPATCH_GET_ONLY"),
          }
        : candidate && test?.interruptAt === "claim"
          ? {
              ...candidate.remote.store,
              compareAndAppend: ((append) => {
                const result = candidate.remote.store.compareAndAppend(append);
                if (
                  result.status === "appended" &&
                  parsePromotionControl(append.bytes).lastTransition.event
                    .type === "claim"
                )
                  fail("RECOVERY_CANDIDATE_TEST_INTERRUPTION");
                return result;
              }) satisfies typeof candidate.remote.store.compareAndAppend,
            }
          : candidate?.remote.store;
  const verifiedDelivery =
    candidate && mode === "acknowledge"
      ? Object.freeze({
          store: store!,
          candidate: Buffer.from(candidate.remote.candidateBytes),
        })
      : undefined;
  const publication: WeeklyPublicationOptions | undefined =
    candidate && dispatchMode(mode)
      ? Object.freeze({
          store: store!,
          transport:
            mode === "reconcile"
              ? {
                  ...candidate.remote.transport,
                  append: () => fail("RECOVERY_DISPATCH_GET_ONLY"),
                }
              : candidate.remote.transport,
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
    ...(admitted.build
      ? {
          build: {
            ...admitted.build,
            ...(test?.alterBuiltModule
              ? { alterBuiltModule: test.alterBuiltModule }
              : {}),
          },
        }
      : {}),
    ...(candidate && (publication || verifiedDelivery)
      ? {
          candidate: {
            publication,
            verifiedDelivery,
            repositoryRoot: realpathSync(input.repositoryRoot),
            mainHead: candidate.remote.binding.mainHead,
            workDirectory: candidate.workDirectory,
            resolveDirectory: candidate.locations.resolveExportWorkDirectory,
            ...(mode === "reconcile" && candidate.remote.pendingDispatch
              ? {
                  dispatchSelection: {
                    operationId: candidate.remote.pendingDispatch.operationId,
                    attemptId: candidate.remote.pendingDispatch.attemptId,
                    runId: parseSavedPagesDispatch(
                      candidate.remote.pendingDispatch.savedBytes
                    ).receipt?.runId,
                  },
                  assertReceipt: candidate.remote.pendingDispatch.assertReceipt,
                }
              : {}),
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
  let acknowledgementEffects = 0;
  let dispatchObserved = false;
  let dispatchProbeCompleted = false;
  const probeDispatchConsumers = async () => {
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
    dispatchProbeCompleted = true;
  };
  try {
    return await scopes.run(scope, async () => {
      scope.assertCurrent();
      if (mode === "reconcile" && test?.probeRestrictedConsumers)
        await probeDispatchConsumers();
      if (mode === "acknowledge" && test?.probeRestrictedConsumers) {
        const { assertOperatorNotQuarantined } =
          await import("./private-artifacts.js");
        let quarantined = false;
        try {
          assertOperatorNotQuarantined(admitted.operator);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "RECOVERY_INSTALLATION_NOT_ACTIVATED"
          )
            throw error;
          quarantined = true;
        }
        if (!quarantined) fail("RECOVERY_IMPORT_SCOPE_EXCEEDED");
        for (const change of [
          { stopAfter: "verify" as const },
          { stopAfter: "dispatch" as const },
          { runId: "another-run" },
          { verifiedDelivery: { ...verifiedDelivery! } },
        ]) {
          let denied = false;
          try {
            await runWeeklyImport({
              root: checkout,
              runId: input.runId,
              stopAfter: "acknowledge",
              verifiedDelivery,
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
      const state = await runWeeklyImport({
        root: checkout,
        runId: input.runId,
        stopAfter: stopStage(mode),
        ...(admitted.build ? { candidateBuild: admitted.build.options } : {}),
        ...(verifiedDelivery
          ? {
              verifiedDelivery,
              controlledPublishing: "enabled",
              manualPublisherJoined: "true",
            }
          : {}),
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
          if (mode === "acknowledge" && event.stage === "acknowledge") {
            if (event.phase === "effect-committed") acknowledgementEffects++;
            const point =
              event.phase === "artifact-saved"
                ? "acknowledge-intent-saved"
                : event.phase === "effect-committed"
                  ? [
                      "acknowledge-intent-bound",
                      "acknowledge-cutoff-written",
                      "acknowledge-remote-completed",
                    ][acknowledgementEffects - 1]
                  : undefined;
            if (point && test.interruptAt === point)
              fail("RECOVERY_VERIFIED_TEST_INTERRUPTION");
          }
          if (
            mode === "validate" &&
            event.stage === "enrich" &&
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
              { runId: "another-run" },
              { stopAfter: "dispatch" as const },
              { candidateBuild: { ...admitted.build!.options } },
              { freezeCutoffEpochMs: Date.now() },
            ]) {
              denied = false;
              try {
                await runWeeklyImport({
                  root: checkout,
                  runId: input.runId,
                  stopAfter: "validate",
                  candidateBuild: admitted.build!.options,
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
            dispatchMode(mode) &&
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
            dispatchMode(mode) &&
            event.stage === "deploy" &&
            event.phase === "started" &&
            test.probeRestrictedConsumers
          ) {
            await probeDispatchConsumers();
          }
          if (
            dispatchMode(mode) &&
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
      if (
        mode === "reconcile" &&
        test?.probeRestrictedConsumers &&
        !dispatchProbeCompleted
      )
        fail("RECOVERY_DISPATCH_PROBE_NOT_EXECUTED");
      same(state.source, admitted.original.source);
      if (
        mode === "load" &&
        (state.stages[3].status !== "succeeded" ||
          state.stages.slice(4).some((stage) => stage.status !== "pending"))
      )
        fail();
      if (candidateMode(mode) || mode === "validate") {
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
      let report:
        | RecoveredImportReport
        | RecoveredCandidateReport
        | RecoveredFrozenReport
        | RecoveredVerifiedReport;
      if (mode === "acknowledge" && candidate) {
        const progress = candidate.remote.validateProgress(
          candidate.remote.binding.initialControlHead
        );
        const acknowledgementId = state.stages[10].evidence?.acknowledgementId;
        if (
          state.stages[10].status !== "succeeded" ||
          progress.acknowledgement !== "completed" ||
          !progress.operationId ||
          progress.operationId !==
            candidate.remote.verifiedDelivery?.operationId ||
          typeof acknowledgementId !== "string" ||
          !/^[a-f0-9]{64}$/.test(acknowledgementId)
        )
          fail("RECOVERY_ACKNOWLEDGEMENT_NOT_COMPLETED");
        report = {
          ...base,
          status: "acknowledgement-complete",
          candidateId: candidate.remote.binding.candidateId,
          operationId: progress.operationId,
          acknowledgementId,
        };
      } else if (mode === "validate") {
        const candidateId = state.stages[7].evidence?.candidateId;
        if (
          state.stages
            .slice(5, 8)
            .some((stage) => stage.status !== "succeeded") ||
          typeof candidateId !== "string" ||
          !/^[a-f0-9]{64}$/.test(candidateId)
        )
          fail("RECOVERY_CANDIDATE_NOT_VALIDATED");
        admitted.remote.assertCurrent();
        report = { ...base, status: "candidate-validated", candidateId };
      } else if (candidate) {
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
export const executeRecoveredDispatch = (input: RecoveryCandidateInput) =>
  execute(input, undefined, "reconcile");
export const executeRecoveredDispatchForTest = (
  input: RecoveryCandidateInput & TestOptions
) => execute(input, input, "reconcile");
export const executeRecoveredVerified = (input: RecoveryVerifiedInput) =>
  execute(input, undefined, "acknowledge");
export const executeRecoveredVerifiedForTest = (
  input: RecoveryVerifiedInput & TestOptions
) => execute(input, input, "acknowledge");
export const executeRecoveredFrozen = (input: RecoveryFrozenInput) =>
  execute(input, undefined, "validate");
export const executeRecoveredFrozenForTest = (
  input: RecoveryFrozenInput & TestOptions
) => execute(input, input, "validate");

function launch(
  input: RecoveryImportInput,
  test?: TestOptions,
  mode?: "load"
): Promise<RecoveredImportReport>;
function launch(
  input: RecoveryCandidateInput,
  test: TestOptions | undefined,
  mode: "dispatch" | "reconcile"
): Promise<RecoveredCandidateReport>;
function launch(
  input: RecoveryVerifiedInput,
  test: TestOptions | undefined,
  mode: "acknowledge"
): Promise<RecoveredVerifiedReport>;
function launch(
  input: RecoveryFrozenInput,
  test: TestOptions | undefined,
  mode: "validate"
): Promise<RecoveredFrozenReport>;
async function launch(
  supplied: RecoveryImportInput,
  test?: TestOptions,
  mode: RecoveryMode = "load"
): Promise<
  | RecoveredImportReport
  | RecoveredCandidateReport
  | RecoveredFrozenReport
  | RecoveredVerifiedReport
> {
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
    const {${mode === "acknowledge" ? (test ? "executeRecoveredVerifiedForTest" : "executeRecoveredVerified") : mode === "load" ? (test ? "executeRecoveredImportForTest" : "executeRecoveredImport") : mode === "validate" ? (test ? "executeRecoveredFrozenForTest" : "executeRecoveredFrozen") : mode === "reconcile" ? (test ? "executeRecoveredDispatchForTest" : "executeRecoveredDispatch") : test ? "executeRecoveredCandidateForTest" : "executeRecoveredCandidate"}:execute}=await import(${JSON.stringify(entry)});
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
  env.ZIVV_RECOVERY_EXECUTOR = "1";
  if (candidateMode(mode) && (!test || test.enforcePublicationFlags)) {
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
          | RecoveredCandidateReport
          | RecoveredFrozenReport
          | RecoveredVerifiedReport;
        same(
          Object.keys(report).sort(),
          [
            "activationAllowed",
            "admissionSha256",
            "ledgerRevision",
            "runId",
            "status",
            ...(candidateMode(mode) ? ["candidateId", "operationId"] : []),
            ...(mode === "acknowledge" ? ["acknowledgementId"] : []),
            ...(mode === "validate" ? ["candidateId"] : []),
          ].sort()
        );
        if (
          (mode === "load"
            ? report.status !== "load-complete"
            : mode === "validate"
              ? report.status !== "candidate-validated"
              : mode === "acknowledge"
                ? report.status !== "acknowledgement-complete"
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
          (candidateMode(mode) || mode === "validate") &&
          (!("candidateId" in report) ||
            !/^[a-f0-9]{64}$/.test(report.candidateId) ||
            ("operationId" in report &&
              report.operationId !== null &&
              !/^[a-f0-9]{64}$/.test(report.operationId)))
        )
          fail();
        if (
          mode === "acknowledge" &&
          (!("acknowledgementId" in report) ||
            !/^[a-f0-9]{64}$/.test(report.acknowledgementId) ||
            !("operationId" in report) ||
            report.operationId === null)
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
/** Build only the original frozen run through validation; never publish or acknowledge. */
export const resumeOperatorRecoveryFrozen = (input: RecoveryFrozenInput) =>
  launch(input, undefined, "validate");
export const resumeOperatorRecoveryFrozenForTest = (
  input: RecoveryFrozenInput & TestOptions
) => launch(input, input, "validate");
/** Explicit same-candidate dispatch; quarantine is not generally activated. */
export const resumeOperatorRecoveryCandidate = (
  input: RecoveryCandidateInput
) => launch(input, undefined, "dispatch");
/** Native Git and loopback HTTP fixture adapter, never selected by the CLI. */
export const resumeOperatorRecoveryCandidateForTest = (
  input: RecoveryCandidateInput & TestOptions
) => launch(input, input, "dispatch");
/** Reconcile only the original captured accepted attempt; never create a new one. */
export const resumeOperatorRecoveryDispatch = (input: RecoveryCandidateInput) =>
  launch(input, undefined, "reconcile");
export const resumeOperatorRecoveryDispatchForTest = (
  input: RecoveryCandidateInput & TestOptions
) => launch(input, input, "reconcile");

/** Finish only the original canonically verified release acknowledgement. */
export const resumeOperatorRecoveryVerified = (input: RecoveryVerifiedInput) =>
  launch(input, undefined, "acknowledge");
export const resumeOperatorRecoveryVerifiedForTest = (
  input: RecoveryVerifiedInput & TestOptions
) => launch(input, input, "acknowledge");
