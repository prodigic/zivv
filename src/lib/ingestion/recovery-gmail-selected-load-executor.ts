import { prepareNextSelectedLoadResumeSuccessor } from "./recovery-gmail-selected-load-next-successors.js";
import {
  readNextSelectedLoadCompletionEvidence,
  replayRecoveredGmailNextSelectedLoad,
} from "./recovery-gmail-selected-load-next-replay.js";
import { observeNextSelectedLoadBackupStage } from "./recovery-gmail-selected-load-next-backup.js";
import { readNextSelectedLoadInterruptionEvidence } from "./recovery-gmail-selected-load-next-gap.js";
import {
  nextSelectedLoadResumeIntentFilename,
  signNextSelectedLoadResumeIntent,
  verifyNextSelectedLoadResumeIntent,
} from "./recovery-gmail-selected-load-next-resume-intent.js";
import {
  observeSelectedLoadAdmissionTail,
  selectedLoadAdmissionTailPaths,
  type SelectedLoadAdmissionTail,
} from "./recovery-gmail-selected-load-admission-tail.js";
import {
  readNextSelectedLoadAdmissionForInstallation,
  readNextSelectedLoadAdmissionRunId,
} from "./recovery-gmail-selected-load-next-admission.js";
import type { RecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import { prepareSelectedLoadCompletionSeal } from "./recovery-gmail-selected-load-completion-plan.js";
import { assertSelectedLoadSettlementTransition } from "./recovery-gmail-selected-settlement-transition.js";
import { DatabaseSync } from "node:sqlite";
import { signSelectedLoadCompletionIntent } from "./recovery-gmail-selected-load-completion-intent.js";
import { selectedLoadCompletionIntentFilename } from "./recovery-gmail-selected-load-paths.js";
import { prepareSelectedLoadIntentSuccessor } from "./recovery-gmail-selected-successor-preparation.js";
import {
  describeResumeSnapshot,
  resumeSnapshotChunkSize,
} from "./recovery-gmail-selected-resume-snapshot-evidence.js";
import {
  readSelectedLoadInterruptionEvidence,
  type SelectedLoadInterruptionEvidence,
} from "./recovery-gmail-selected-load-interruption-inspection.js";
import {
  observeSelectedLoadCompletionIntentFile,
  observeSelectedLoadCompletionPrefix,
} from "./recovery-gmail-selected-load-completion-prefix.js";
import { verifySelectedLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import {
  signSelectedLoadExecutionBaseline,
  signSelectedNextLoadExecutionBaseline,
} from "./recovery-gmail-execution-baseline.js";
import { selectedLoadTemporaryTarget } from "./recovery-gmail-selected-load-paths.js";
import { createRecoveryGmailSelectedLoadEvidence } from "./recovery-gmail-selected-load-evidence.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import {
  existsSync,
  readFileSync,
  lstatSync,
  readdirSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
  fsyncSync,
  renameSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IngestionLedger } from "../../types/ingestion.js";
import {
  canonicalJson,
  ledgerDigest,
  withCanonicalStoreTransaction,
} from "./sqlite-store.js";
import {
  openPreparedRuntimeForAdmission,
  type RecoveryRuntimeEntry,
  type RecoveryRuntimeInput,
} from "./recovery-runtime.js";
import {
  readRecoveryGmailHostForLoadInstallation,
  assertNoRecoveredGmailCapture,
  type CaptureJournalEffect,
} from "./recovery-gmail-capture-admission.js";
import {
  assertNoSelectedLoadInstallation,
  inspectInstalledRecoveryGmailSelectedLoadEvidence,
  type RecoveryGmailSelectedLoadInstallationInput,
} from "./recovery-gmail-selected-load-installation.js";
import {
  encodeRecoveryGmailSelectedLoadFrame,
  decodeRecoveryGmailSelectedLoadFrame,
} from "./recovery-gmail-selected-load-framing.js";
import { readThirdSelectedLoadAdmissionForInstallation } from "./recovery-gmail-selected-load-third-admission.js";
import { readThirdSelectedLoadStartForInstallation } from "./recovery-gmail-selected-load-third-start.js";
import {
  decodeThirdSelectedLoadStartFrame,
  encodeThirdSelectedLoadStartFrame,
  type RecoveryGmailThirdSelectedLoadStartFrameInput,
} from "./recovery-gmail-selected-load-third-start-framing.js";
import { observeThirdSelectedLoadStartTail } from "./recovery-gmail-selected-load-third-start-tail.js";
import {
  decodeRecoveryGmailThirdSelectedLoadFrame,
  encodeRecoveryGmailThirdSelectedLoadFrame,
  type RecoveryGmailThirdSelectedLoadFrameInput,
} from "./recovery-gmail-selected-load-third-framing.js";
import { proveRecoveryGmailSelectedLoadBaseline } from "./recovery-gmail-selected-load-proof.js";
import {
  createSelectedGmailLoadEffectPlan,
  assertSelectedGmailLoadCatalog,
  assertSelectedGmailLoadArtifact,
  selectedGmailLoadEvidence,
  type SelectedGmailLoadEffectPlan,
} from "./recovery-gmail-selected-load-effects.js";
import {
  installRecoveryIntent,
  secureOperatorDirectory,
  inspectRecoveryInstalledFile,
  installRecoveredBackupKey,
  loadBackupKey,
  validateRecoveredBackupKeyBytes,
  decryptLedgerSnapshot,
} from "./encrypted-backup.js";
import { runWeeklyImport } from "./weekly-import-runner.js";
import { projectLedgerLocation } from "./store-location.js";
import {
  parseWeeklyRunState,
  type WeeklyRunState,
} from "./weekly-run-state.js";
import {
  readGuardedWeeklyCatalogLease,
  validateWeeklyJournalRecoverySnapshot,
  readWeeklyJournalRecoverySnapshotReadOnly,
  readWeeklyJournalRecoverySnapshotInTransaction,
  type WeeklyRunLease,
  type WeeklyJournalRecoverySnapshot,
} from "./weekly-run-journal.js";
import { sha256 } from "./steve-preflight.js";

export const recoveryGmailSelectedLoadExecutorVersion = 1;
export const recoveryGmailThirdSelectedLoadInstallerVersion = 1;
export const recoveryGmailThirdSelectedLoadExecutorVersion = 1;
export const recoveryGmailThirdStartInstallerVersion = 1;
const production = "prodigic/zivv/production";
const sqlFiles = /^operator\/(?:ledger|weekly-runs)\.sqlite(?:-wal|-shm)?$/;
const keyName =
  process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin";
type Baseline = ReturnType<typeof proveRecoveryGmailSelectedLoadBaseline>;
export type SelectedLoadJournalOperation =
  | { kind: "create"; state: WeeklyRunState; raw?: Buffer }
  | { kind: "save"; state: WeeklyRunState }
  | { kind: "artifact"; runId: string; stage: string; bytes: Buffer }
  | { kind: "check" };
interface Scope {
  chunkPauseTest?:
    | "linked"
    | "partial"
    | "intent-linked"
    | "lease-acquired"
    | "successor-linked"
    | "successor-flushed"
    | "catalog-before-commit"
    | "catalog-committed"
    | "rollback-catalog-committed"
    | "backup-flushed"
    | "backup-settled-before-intent"
    | "history-first-chunk"
    | "completion-before-intent"
    | "completion-intent-partial";
  evidenceGuard?: boolean;
  fixedEvidence?: { target: string; stage: string; bytes: Buffer };
  successor?: { path: string };
  incompleteSnapshot?: {
    path: string;
    bytes: Buffer;
    dev: number;
    ino: number;
  };
  resume?: {
    observedJournal: WeeklyJournalRecoverySnapshot;
    previousOwner: WeeklyRunLease;
    gateComplete: boolean;
    precommitRollback?: boolean;
  };
  finish?: (state: WeeklyRunState, snapshot: Buffer) => Promise<void>;
  assertCompletionFiles?: () => void;
  active: boolean;
  deadline: number;
  startedAt: number;
  root: string;
  operator: string;
  directory: string;
  key: Buffer;
  phase: "evidence" | "key" | "run" | "result";
  historyTargets?: Set<string>;
  completionRepair?: true;
  priorLoadFamilySha256?: string;
  source: Baseline["source"];
  run: Baseline["runState"];
  initialRun: Baseline["initialState"];
  raw: Buffer;
  plan: SelectedGmailLoadEffectPlan;
  original: IngestionLedger;
  ledger: IngestionLedger;
  generation: number;
  pending?: IngestionLedger;
  owner: string;
  fence: number;
  journal: WeeklyJournalRecoverySnapshot;
  files: Map<string, Buffer>;
  directories: Set<string>;
  transients: Map<string, Buffer>;
  readonlyFiles: Map<string, Buffer>;
  previousFiles: Map<string, Buffer>;
  keyStage: string;
  originalEntries: Map<string, RecoveryRuntimeEntry>;
  assertCurrent: () => void;
}
const scopes = new AsyncLocalStorage<Scope>();
function fail(): never {
  throw Error("RECOVERY_GMAIL_SELECTED_LOAD_SCOPE_EXCEEDED");
}
function current(): Scope | undefined {
  const scope = scopes.getStore();
  if (scope && (!scope.active || Date.now() >= scope.deadline)) fail();
  return scope;
}
export function hasSelectedGmailLoadExecution(): boolean {
  return current() !== undefined;
}
export function assertNoSelectedGmailLoadExecution(): void {
  if (scopes.getStore()) fail();
}
function same(a: unknown, b: unknown) {
  if (canonicalJson(a) !== canonicalJson(b)) fail();
}
export function selectedGmailLoadCurrent(): boolean {
  const scope = current();
  if (!scope) return false;
  scope.assertCurrent();
  return true;
}
export function selectedGmailLoadAuthority(directory: string): boolean {
  const scope = current();
  if (!scope) return false;
  if (resolve(directory) !== scope.operator || scope.phase !== "run") fail();
  scope.assertCurrent();
  return true;
}
export function selectedGmailLoadWriter(
  directory: string,
  operation?: string
): boolean {
  const scope = current();
  if (!scope) return false;
  if (
    resolve(directory) !== scope.operator ||
    !(
      ["key", "run", "result"].includes(scope.phase) ||
      (scope.phase === "evidence" &&
        scope.evidenceGuard &&
        operation === undefined)
    ) ||
    (operation !== undefined && operation !== "capture-journal") ||
    (operation === "capture-journal" && scope.phase !== "run")
  )
    fail();
  scope.assertCurrent();
  return true;
}
export function selectedGmailLoadInvocation(input: object): boolean {
  const scope = current();
  if (!scope) return false;
  const value = input as {
    root: string;
    source?: {
      editionId: string;
      deliveryId: string;
      raw: Buffer;
      importObservedAtEpochMs: number;
    };
    stopAfter?: string;
  };
  same(Reflect.ownKeys(input).sort(), ["root", "source", "stopAfter"]);
  if (
    resolve(value.root) !== scope.root ||
    value.stopAfter !== "load" ||
    !value.source ||
    !Buffer.isBuffer(value.source.raw) ||
    !value.source.raw.equals(scope.raw)
  )
    fail();
  same(
    { ...value.source, raw: undefined },
    {
      editionId: scope.source.editionId,
      deliveryId: scope.source.deliveryId,
      importObservedAtEpochMs: scope.source.importObservedAtEpochMs,
      raw: undefined,
    }
  );
  scope.assertCurrent();
  return true;
}
export function selectedGmailLoadStoreBaseline(path: string) {
  const scope = current();
  if (!scope) return undefined;
  if (
    resolve(path) !== join(scope.operator, "ledger.sqlite") ||
    !(
      scope.phase === "run" ||
      (scope.phase === "evidence" && scope.evidenceGuard)
    )
  )
    fail();
  scope.assertCurrent();
  return {
    generation: scope.generation,
    ledger: structuredClone(scope.ledger),
  };
}
export function selectedGmailLoadStoreOpen(
  path: string,
  operation?: "read" | "transaction" | "write"
): void {
  const scope = current();
  if (!scope) return;
  if (
    !operation ||
    operation === "write" ||
    resolve(path) !== join(scope.operator, "ledger.sqlite") ||
    !(
      scope.phase === "run" ||
      (scope.phase === "evidence" &&
        scope.evidenceGuard &&
        operation === "transaction")
    )
  )
    fail();
  scope.assertCurrent();
}
export function selectedGmailLoadCatalogRead(
  path: string,
  ledger: IngestionLedger,
  generation: number
): void {
  const scope = current();
  if (!scope) return;
  if (resolve(path) !== join(scope.operator, "ledger.sqlite")) fail();
  if (
    generation === scope.generation &&
    canonicalJson(ledger) === canonicalJson(scope.ledger)
  )
    return;
  if (
    scope.pending &&
    generation === scope.generation + 1 &&
    canonicalJson(ledger) === canonicalJson(scope.pending)
  )
    return;
  fail();
}
function assertGuardedCatalogLease(scope: Scope): void {
  const observed = readGuardedWeeklyCatalogLease(
    join(scope.operator, "weekly-runs.sqlite")
  );
  if (
    !observed ||
    observed.lease.scope !== production ||
    observed.lease.owner !== scope.owner ||
    observed.lease.fence !== scope.fence
  )
    fail();
  allowedJournal(scope, observed.snapshot);
  const snapshot = validateWeeklyJournalRecoverySnapshot(observed.snapshot);
  const row = snapshot.runState.find((item) => item.id === scope.run.runId);
  if (
    !row ||
    parseWeeklyRunState(JSON.parse(row.payload)).stages.find(
      (item) => item.stage === "load"
    )?.status !== "running"
  )
    fail();
}
/** Recheck actual fenced ownership immediately before the canonical SQL commit. */
export function selectedGmailLoadCatalogBeforeCommit(path: string): void {
  const scope = current();
  if (!scope || !scope.pending) return;
  if (resolve(path) !== join(scope.operator, "ledger.sqlite")) fail();
  assertGuardedCatalogLease(scope);
  if (scope.chunkPauseTest === "catalog-before-commit") {
    process.stdout.write("SELECTED_LOAD_TEST_CATALOG_BEFORE_COMMIT\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
  }
}
/** Called only at the normal runner's fenced completion barrier. No writer handle escapes. */
export async function completeSelectedGmailLoad(
  state: WeeklyRunState
): Promise<void> {
  const scope = current();
  if (!scope?.finish || scope.phase !== "run") fail();
  const observed = readGuardedWeeklyCatalogLease(
    join(scope.operator, "weekly-runs.sqlite")
  );
  if (
    !observed ||
    observed.lease.scope !== production ||
    observed.lease.owner !== scope.owner ||
    observed.lease.fence !== scope.fence
  )
    fail();
  allowedJournal(scope, observed.snapshot);
  const row = validateWeeklyJournalRecoverySnapshot(
    observed.snapshot
  ).runState.find((item) => item.id === state.runId);
  if (
    !row ||
    state.runId !== scope.run.runId ||
    state.stages.find((item) => item.stage === "load")?.status !== "succeeded"
  )
    fail();
  same(parseWeeklyRunState(JSON.parse(row.payload)), state);
  await scope.finish(state, observed.snapshot);
  scope.finish = undefined;
}
export function selectedGmailLoadCatalogWrite(
  path: string,
  ledger: IngestionLedger,
  initialize: boolean,
  canonical: boolean
): void {
  const scope = current();
  if (!scope) return;
  if (
    initialize ||
    !canonical ||
    resolve(path) !== join(scope.operator, "ledger.sqlite") ||
    scope.phase !== "run"
  )
    fail();
  scope.assertCurrent();
  assertGuardedCatalogLease(scope);
  assertSelectedGmailLoadCatalog(
    scope.plan,
    scope.original,
    ledger,
    scope.startedAt
  );
  if (canonicalJson(ledger) !== canonicalJson(scope.ledger))
    scope.pending = structuredClone(ledger);
}
export function selectedGmailLoadCatalogCommit(
  path: string,
  committed: boolean
): void {
  const scope = current();
  if (!scope) return;
  if (resolve(path) !== join(scope.operator, "ledger.sqlite")) fail();
  if (committed && scope.pending) {
    scope.ledger = scope.pending;
    scope.generation++;
    if (
      scope.priorLoadFamilySha256 &&
      scope.chunkPauseTest === "catalog-committed"
    ) {
      process.stdout.write("SELECTED_LOAD_TEST_CATALOG_COMMITTED\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
    }
    if (
      scope.resume?.precommitRollback &&
      scope.chunkPauseTest === "rollback-catalog-committed"
    ) {
      process.stdout.write("SELECTED_LOAD_TEST_ROLLBACK_CATALOG_COMMITTED\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
    }
  }
  scope.pending = undefined;
}
function allowedState(scope: Scope, state: WeeklyRunState) {
  same(state.source, scope.source);
  if (state.runId !== scope.run.runId) fail();
  if (canonicalJson(state) === canonicalJson(scope.run)) return;
  for (let index = 0; index < state.stages.length; index++) {
    const item = state.stages[index]!;
    if (index >= 4) {
      same(item, scope.run.stages[index]);
      continue;
    }
    if (item.status === "succeeded")
      same(
        item.evidence,
        selectedGmailLoadEvidence(
          scope.plan,
          scope.source,
          item.stage,
          scope.ledger
        )
      );
  }
}
function allowedJournal(scope: Scope, bytes: Buffer) {
  const now = validateWeeklyJournalRecoverySnapshot(bytes),
    old = scope.journal;
  same(now.intakeEvidence, old.intakeEvidence);
  same(
    now.ownership.filter((row) => row.scope !== production),
    old.ownership.filter((row) => row.scope !== production)
  );
  const owner = now.ownership.find((row) => row.scope === production),
    prior = old.ownership.find((row) => row.scope === production);
  if (!owner) fail();
  if (
    canonicalJson(owner) !== canonicalJson(prior) &&
    canonicalJson(owner) !== canonicalJson(scope.resume?.previousOwner) &&
    (owner.owner !== scope.owner ||
      owner.fence !== scope.fence ||
      owner.expiresAtEpochMs > scope.deadline)
  )
    fail();
  const oldRuns = new Map(old.runState.map((row) => [row.id, row]));
  for (const row of now.runState) {
    if (row.id === scope.run.runId) {
      if (row.scope !== production) fail();
      allowedState(scope, parseWeeklyRunState(JSON.parse(row.payload)));
    } else same(row, oldRuns.get(row.id));
  }
  for (const row of old.runState)
    if (!now.runState.some((next) => next.id === row.id)) fail();
  const oldArtifacts = new Map(
    old.stageArtifacts.map((row) => [
      row.runId + ":" + row.stage + ":" + row.attempt,
      row,
    ])
  );
  for (const row of now.stageArtifacts) {
    const key = row.runId + ":" + row.stage + ":" + row.attempt,
      prior = oldArtifacts.get(key);
    if (prior) same(row, prior);
    else {
      if (row.runId !== scope.run.runId) fail();
      assertSelectedGmailLoadArtifact(
        scope.plan,
        row.stage,
        Buffer.from(row.bytes, "base64"),
        scope.raw,
        scope.ledger
      );
    }
  }
  for (const row of old.stageArtifacts)
    if (
      !now.stageArtifacts.some(
        (next) =>
          next.runId === row.runId &&
          next.stage === row.stage &&
          next.attempt === row.attempt
      )
    )
      fail();
  return now;
}
export function selectedGmailLoadLeaseOwner(): string | undefined {
  const scope = current();
  return scope?.phase === "run" ? scope.owner : undefined;
}
export function selectedGmailLoadLeaseTtl(value: number): number {
  const scope = current();
  if (!scope) return value;
  const ttl = Math.min(value, scope.deadline - Date.now());
  if (ttl < 1000) fail();
  return ttl;
}
function assertResumeJournalUnchanged(scope: Scope, bytes: Buffer): void {
  if (!scope.resume || scope.resume.gateComplete) return;
  const observed = validateWeeklyJournalRecoverySnapshot(bytes),
    previous = scope.resume.observedJournal;
  const {
    digest: _digest,
    ownership: observedOwners,
    ...observedBody
  } = observed;
  const {
    digest: _priorDigest,
    ownership: previousOwners,
    ...previousBody
  } = previous;
  same(observedBody, previousBody);
  same(
    observedOwners.filter((row) => row.scope !== production),
    previousOwners.filter((row) => row.scope !== production)
  );
  const actual = observedOwners.find((row) => row.scope === production);
  if (!actual) fail();
  if (
    canonicalJson(actual) !== canonicalJson(scope.resume.previousOwner) &&
    (actual.owner !== scope.owner ||
      actual.fence !== scope.fence ||
      actual.expiresAtEpochMs > scope.deadline)
  )
    fail();
}
/** The normal runner invokes this only within the actual fenced journal guard. */
export async function verifySelectedLoadResumeBarrier(): Promise<void> {
  const scope = current();
  if (!scope?.resume || scope.resume.gateComplete || scope.phase !== "run")
    fail();
  const observed = readGuardedWeeklyCatalogLease(
    join(scope.operator, "weekly-runs.sqlite")
  );
  if (
    !observed ||
    observed.lease.owner !== scope.owner ||
    observed.lease.fence !== scope.fence ||
    observed.lease.scope !== production
  )
    fail();
  if (scope.chunkPauseTest === "lease-acquired") {
    process.stdout.write("SELECTED_LOAD_TEST_LEASE_ACQUIRED\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
  }
  assertResumeJournalUnchanged(scope, observed.snapshot);
  await withCanonicalStoreTransaction(
    join(scope.operator, "ledger.sqlite"),
    { generation: scope.generation, ledger: scope.ledger },
    async () => {
      scope.assertCurrent();
    }
  );
  scope.resume.gateComplete = true;
}
export function hasGuardedNextSelectedLoadAcquisition(): boolean {
  const scope = current();
  return (
    !!scope?.priorLoadFamilySha256 &&
    !!scope.resume &&
    !scope.resume.gateComplete
  );
}

export function hasPendingSelectedLoadResume(): boolean {
  const scope = current();
  return !!scope?.resume && !scope.resume.gateComplete;
}
/** Only the authenticated selected-load resume may replay a rolled-back load. */
export function selectedGmailLoadAllowsRollbackReplay(): boolean {
  const scope = current();
  return (
    !!scope?.resume?.precommitRollback &&
    scope.resume.gateComplete &&
    scope.phase === "run"
  );
}
export function selectedGmailLoadJournal(input: {
  path: string;
  effect: CaptureJournalEffect;
  snapshot?: Buffer;
  lease?: WeeklyRunLease;
  operation?: SelectedLoadJournalOperation;
}): boolean {
  const scope = current();
  if (!scope) return false;
  if (
    scope.phase !== "run" ||
    resolve(input.path) !== join(scope.operator, "weekly-runs.sqlite") ||
    input.effect === "source" ||
    input.effect === "correction"
  )
    fail();
  scope.assertCurrent();
  if (input.snapshot) {
    assertResumeJournalUnchanged(scope, input.snapshot);
    allowedJournal(scope, input.snapshot);
  }
  if (
    input.lease &&
    (input.lease.scope !== production ||
      input.lease.owner !== scope.owner ||
      input.lease.fence !== scope.fence ||
      input.lease.expiresAtEpochMs > scope.deadline)
  )
    fail();
  if (input.effect === "deny") {
    const operation = input.operation;
    if (!operation) fail();
    if (operation.kind === "create") {
      same(operation.state, scope.initialRun);
      if (operation.raw && !operation.raw.equals(scope.raw)) fail();
    } else if (operation.kind === "save") allowedState(scope, operation.state);
    else if (operation.kind === "artifact") {
      if (operation.runId !== scope.run.runId) fail();
      assertSelectedGmailLoadArtifact(
        scope.plan,
        operation.stage,
        operation.bytes,
        scope.raw,
        scope.ledger
      );
    }
  }
  return true;
}
export function selectedGmailLoadKey(directory: string, key?: Buffer): boolean {
  const scope = current();
  if (!scope) return false;
  if (
    resolve(directory) !== scope.operator ||
    (key !== undefined && (scope.phase !== "key" || !key.equals(scope.key))) ||
    (key === undefined && !["key", "run"].includes(scope.phase))
  )
    fail();
  scope.assertCurrent();
  return true;
}
export function selectedGmailLoadFile(
  path: string,
  bytes?: Buffer,
  effect: "write" | "directory" | "unlink" | "install" = "write"
): boolean {
  const scope = current();
  if (!scope) return false;
  scope.assertCurrent();
  const absolute = resolve(path);
  if (scope.fixedEvidence) {
    if (scope.phase !== "evidence" || !scope.evidenceGuard) return fail();
    const { target, stage, bytes: expected } = scope.fixedEvidence;
    if (effect === "directory") {
      if (!scope.directories.has(absolute)) return fail();
      return true;
    }
    const name = basename(absolute);
    const targetName = basename(target);
    const candidate =
      dirname(absolute) === stage &&
      name.startsWith(targetName + ".") &&
      /^(?:\.\d+\.[a-f0-9]{16}\.tmp){1,2}$/.test(name.slice(targetName.length));
    if (
      (!candidate && absolute !== target) ||
      !bytes?.equals(expected) ||
      (effect === "unlink" && !candidate)
    )
      return fail();
    if (candidate) scope.transients.set(absolute, expected);
    return true;
  }
  if (effect === "directory") {
    const permitted =
      scope.phase === "key"
        ? [scope.operator, scope.keyStage]
        : scope.phase === "run"
          ? [
              join(scope.root, "data/ingestion/backups"),
              join(scope.root, "data/ingestion/reports"),
            ]
          : [
              scope.directory,
              dirname(scope.directory),
              join(
                scope.directory,
                scope.phase === "evidence"
                  ? scope.resume
                    ? "resume-intent.json-stage"
                    : "execution-baseline.json-stage"
                  : "load-result.json-stage"
              ),
            ];
    const isSuccessorStage =
      scope.phase === "evidence" &&
      !!scope.evidenceGuard &&
      !!scope.resume &&
      !!scope.successor &&
      absolute === scope.successor.path + "-stage";
    const isSnapshotStage =
      scope.phase === "evidence" &&
      !!scope.resume &&
      /^resume-snapshot-[0-9]{3}\.bin-stage$/.test(
        absolute.slice(scope.directory.length + 1)
      ) &&
      dirname(absolute) === scope.directory;
    const isHistoryStage =
      scope.phase === "result" &&
      absolute.endsWith("-stage") &&
      scope.historyTargets?.has(absolute.slice(0, -6));
    if (
      !scope.directories.has(absolute) ||
      (!permitted.includes(absolute) &&
        !isSnapshotStage &&
        !isSuccessorStage &&
        !isHistoryStage)
    )
      fail();
    return true;
  }
  if (
    (scope.phase === "evidence" ||
      (scope.phase === "result" && scope.completionRepair)) &&
    scope.evidenceGuard &&
    effect === "install" &&
    scope.incompleteSnapshot &&
    absolute === scope.incompleteSnapshot.path &&
    bytes?.equals(scope.incompleteSnapshot.bytes)
  )
    return true;
  const report = join(
    scope.root,
    "data/ingestion/reports",
    sha256(scope.plan.result.report.runId) + ".json"
  );
  const target =
    scope.files.has(absolute) ||
    absolute === join(scope.operator, keyName) ||
    absolute === join(scope.root, "data/ingestion/backups/ledger.snapshot.enc")
      ? absolute
      : selectedLoadTemporaryTarget(absolute, {
          operator: scope.operator,
          directory: scope.directory,
          keyName,
          report,
          snapshot: join(
            scope.root,
            "data/ingestion/backups/ledger.snapshot.enc"
          ),
        });
  if (!target) fail();
  if (
    scope.phase === "key" &&
    target === join(scope.operator, keyName) &&
    bytes
  ) {
    validateRecoveredBackupKeyBytes(bytes, scope.key);
    if (!scope.files.has(target)) scope.files.set(target, Buffer.from(bytes));
  }
  if (
    scope.successor &&
    target === scope.successor.path &&
    (scope.phase !== "evidence" || !scope.evidenceGuard)
  )
    fail();
  const resumeIntentFile = join(scope.directory, "resume-intent.json"),
    executionFile = join(scope.directory, "execution-baseline.json"),
    resultFile = join(scope.directory, "load-result.json"),
    reportFile = join(
      scope.root,
      "data/ingestion/reports",
      sha256(scope.plan.result.report.runId) + ".json"
    );
  if (
    (/^resume-snapshot-[0-9]{3}\.bin$/.test(
      target.slice(scope.directory.length + 1)
    ) &&
      dirname(target) === scope.directory &&
      (!scope.resume || scope.phase !== "evidence")) ||
    (target === resumeIntentFile &&
      (!scope.resume || scope.phase !== "evidence")) ||
    (target === executionFile && scope.phase !== "evidence") ||
    ((target === resultFile || scope.historyTargets?.has(target)) &&
      scope.phase !== "result") ||
    (target === reportFile && scope.phase !== "run") ||
    (target === join(scope.operator, keyName) && scope.phase !== "key")
  )
    fail();
  const snapshot = join(
    scope.root,
    "data/ingestion/backups/ledger.snapshot.enc"
  );
  if (scope.phase === "run" && target === snapshot && bytes) {
    same(decryptLedgerSnapshot(bytes, scope.key), scope.ledger);
    const previous = scope.files.get(target);
    if (previous && !previous.equals(bytes))
      scope.previousFiles.set(target, Buffer.from(previous));
    scope.files.set(target, Buffer.from(bytes));
  }
  const expected = scope.files.get(target);
  if (
    !expected ||
    !bytes ||
    !bytes.equals(expected) ||
    (effect === "unlink" && absolute === target)
  )
    fail();
  if (scope.readonlyFiles.has(target)) fail();
  if (absolute !== target)
    scope.transients.set(absolute, Buffer.from(expected));
  return true;
}
/** Fixed test probe: write a prefix and pause the test worker only. */
export function selectedGmailLoadPartialWriteProbe(
  path: string,
  bytes: Buffer,
  fd: number
): boolean {
  const scope = current();
  if (!scope) return false;
  const intent = scope.chunkPauseTest === "completion-intent-partial";
  if (!intent && scope.chunkPauseTest !== "partial") return false;
  const absolute = resolve(path);
  const target = selectedLoadTemporaryTarget(absolute, {
    operator: scope.operator,
    directory: scope.directory,
    keyName,
    report: join(
      scope.root,
      "data/ingestion/reports",
      sha256(scope.plan.result.report.runId) + ".json"
    ),
    snapshot: join(scope.root, "data/ingestion/backups/ledger.snapshot.enc"),
  });
  if (
    target !==
    join(
      scope.directory,
      intent ? selectedLoadCompletionIntentFilename : "resume-snapshot-000.bin"
    )
  )
    return false;
  if (
    scope.phase !== (intent ? "result" : "evidence") ||
    (!intent && !scope.evidenceGuard) ||
    !scope.files.get(target)?.equals(bytes) ||
    bytes.length < 2
  )
    fail();
  scope.assertCurrent();
  const count = Math.min(32, bytes.length - 1);
  if (writeSync(fd, bytes, 0, count) !== count) fail();
  fsyncSync(fd);
  process.stdout.write(
    intent
      ? "SELECTED_LOAD_TEST_COMPLETION_INTENT_PARTIAL\n"
      : "SELECTED_LOAD_TEST_CHUNK_PARTIAL\n"
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
}
export function observeSelectedGmailLoadFile(
  path: string,
  point: "flushed" | "linked" | "published"
): boolean {
  const scope = current();
  if (!scope) return false;
  scope.assertCurrent();
  if (
    scope.chunkPauseTest === "backup-flushed" &&
    point === "flushed" &&
    scope.phase === "run" &&
    scope.generation === 3 &&
    resolve(path) ===
      join(scope.root, "data/ingestion/backups/ledger.snapshot.enc")
  ) {
    process.stdout.write("SELECTED_LOAD_TEST_BACKUP_FLUSHED\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
  }
  if (
    scope.chunkPauseTest === "linked" &&
    point === "linked" &&
    resolve(path) === join(scope.directory, "resume-snapshot-000.bin")
  ) {
    process.stdout.write("SELECTED_LOAD_TEST_CHUNK_LINKED\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
  }
  if (
    scope.chunkPauseTest === "intent-linked" &&
    point === "linked" &&
    resolve(path) === join(scope.directory, "resume-intent.json")
  ) {
    process.stdout.write("SELECTED_LOAD_TEST_INTENT_LINKED\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
  }
  if (
    scope.chunkPauseTest === "successor-flushed" &&
    point === "flushed" &&
    !!scope.successor &&
    dirname(resolve(path)) === scope.successor.path + "-stage" &&
    basename(path).startsWith(basename(scope.successor.path) + ".")
  ) {
    process.stdout.write("SELECTED_LOAD_TEST_SUCCESSOR_FLUSHED\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
  }
  if (
    scope.chunkPauseTest === "successor-linked" &&
    point === "linked" &&
    !!scope.successor &&
    resolve(path) === scope.successor.path
  ) {
    process.stdout.write("SELECTED_LOAD_TEST_SUCCESSOR_LINKED\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
  }
  if (point === "published") {
    const target = resolve(path),
      expected = scope.files.get(target);
    if (expected) {
      if (!readFileSync(target).equals(expected)) fail();
      scope.previousFiles.delete(target);
    }
  }
  return true;
}

/** Seal the exact guarded completion state before writing its signed result. */
async function installSelectedLoadCompletion(
  scope: Scope,
  state: WeeklyRunState,
  guardedJournal: Buffer,
  identity: {
    admissionSha256: string;
    executionBaselineSha256: string;
    successorSha256?: string;
  },
  inventory: () => RecoveryRuntimeEntry[]
) {
  if (current() !== scope || scope.phase !== "run") fail();
  await withCanonicalStoreTransaction(
    join(scope.operator, "ledger.sqlite"),
    { generation: scope.generation, ledger: scope.ledger },
    async () => {}
  );
  allowedJournal(scope, guardedJournal);
  if (
    state.stages.find((item) => item.stage === "load")?.status !== "succeeded"
  )
    fail();
  scope.assertCurrent();
  const encryptedCatalog = readFileSync(
    join(scope.root, "data/ingestion/backups/ledger.snapshot.enc")
  );
  same(decryptLedgerSnapshot(encryptedCatalog, scope.key), scope.ledger);
  const observed = inventory();
  const loadPrefix = "recovery-gmail-load/" + state.runId + "/";
  const completionPrefix = loadPrefix + selectedLoadCompletionIntentFilename;
  if (
    observed.some(
      (entry) =>
        entry.path.startsWith(loadPrefix + "history-") ||
        entry.path.startsWith(completionPrefix)
    ) ||
    scope.previousFiles.size ||
    [...scope.transients.keys()].some((path) => existsSync(path))
  )
    fail();
  const ledgerRevision = ledgerDigest(scope.ledger);
  const historyIdentity = {
    runId: state.runId,
    admissionSha256: identity.admissionSha256,
    executionBaselineSha256: identity.executionBaselineSha256,
    priorFamilySha256: scope.priorLoadFamilySha256 ?? sha256(canonicalJson([])),
    ledgerRevision,
    generation: scope.generation,
  };
  const history = prepareSelectedLoadCompletionSeal({
    identity: historyIdentity,
    guardedJournal,
    encryptedCatalog,
    entries: observed,
    runStateSha256: sha256(canonicalJson(state)),
    reportSha256: scope.plan.receipt.reportSha256,
    successorSha256: identity.successorSha256,
    key: scope.key,
  });
  if (
    history.intent.owner.owner !== scope.owner ||
    history.intent.owner.fence !== scope.fence
  )
    fail();
  const { result, releasedJournal, completionBytes } = history;
  const assertInstalled = (path: string, bytes: Buffer) => {
    const stage = path + "-stage";
    const stat = lstatSync(stage);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    const installed = inspectRecoveryInstalledFile(path, stage);
    if (
      installed.candidate ||
      !installed.target ||
      installed.target.nlink !== 1 ||
      !installed.target.bytes.equals(bytes)
    )
      fail();
  };
  const assertHistoryFiles = () => {
    for (const { name, bytes } of history.files)
      assertInstalled(join(scope.directory, name), bytes);
  };
  const completionPath = join(
    scope.directory,
    selectedLoadCompletionIntentFilename
  );
  const installEvidence = (path: string, bytes: Buffer) => {
    const stage = path + "-stage";
    if (scope.files.has(path) || scope.directories.has(stage)) fail();
    scope.files.set(path, bytes);
    scope.directories.add(stage);
    scope.historyTargets ??= new Set();
    scope.historyTargets.add(path);
    installRecoveryIntent(path, bytes, stage);
  };
  scope.phase = "result";
  try {
    if (scope.chunkPauseTest === "completion-before-intent") {
      process.stdout.write("SELECTED_LOAD_TEST_COMPLETION_BEFORE_INTENT\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
    }
    installEvidence(completionPath, completionBytes);
    assertInstalled(completionPath, completionBytes);
    for (const [index, { name, bytes }] of history.files.entries()) {
      installEvidence(join(scope.directory, name), bytes);
      if (index === 0 && scope.chunkPauseTest === "history-first-chunk") {
        process.stdout.write("SELECTED_LOAD_TEST_HISTORY_FIRST_CHUNK\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
        throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
      }
    }
    assertHistoryFiles();
    const resultPath = join(scope.directory, "load-result.json");
    scope.files.set(resultPath, result);
    installRecoveryIntent(resultPath, result, resultPath + "-stage");
    scope.assertCompletionFiles = () => {
      assertInstalled(completionPath, completionBytes);
      assertHistoryFiles();
      assertInstalled(resultPath, result);
    };
    scope.assertCurrent();
    scope.assertCompletionFiles();
    if (
      scope.previousFiles.size ||
      [...scope.transients.keys()].some((path) => existsSync(path))
    )
      fail();
    return { result, releasedJournal };
  } finally {
    scope.phase = "run";
  }
}

/** Finish only the already pinned physical candidate and exact planned suffix. */
function completeRetainedPrefixFile(
  incomplete: NonNullable<Scope["incompleteSnapshot"]>,
  full: Buffer
) {
  const fd = openSync(incomplete.path, "r+");
  try {
    const opened = fstatSync(fd),
      named = lstatSync(incomplete.path);
    if (
      !opened.isFile() ||
      named.isSymbolicLink() ||
      opened.nlink !== 1 ||
      named.nlink !== 1 ||
      opened.dev !== incomplete.dev ||
      opened.ino !== incomplete.ino ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      opened.size !== incomplete.bytes.length ||
      named.size !== opened.size
    )
      fail();
    const observed = Buffer.alloc(incomplete.bytes.length);
    let readOffset = 0;
    while (readOffset < observed.length) {
      const count = readSync(
        fd,
        observed,
        readOffset,
        observed.length - readOffset,
        readOffset
      );
      if (count <= 0) fail();
      readOffset += count;
    }
    if (!observed.equals(incomplete.bytes)) fail();
    let offset = observed.length;
    while (offset < full.length) {
      const written = writeSync(fd, full, offset, full.length - offset, offset);
      if (written <= 0) fail();
      offset += written;
    }
    fsyncSync(fd);
    const after = fstatSync(fd),
      currentName = lstatSync(incomplete.path);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.nlink !== 1 ||
      after.size !== full.length ||
      currentName.isSymbolicLink() ||
      currentName.dev !== opened.dev ||
      currentName.ino !== opened.ino ||
      currentName.nlink !== 1 ||
      currentName.size !== full.length
    )
      fail();
  } finally {
    closeSync(fd);
  }
}

function signed(value: unknown, key: Buffer, domain: string) {
  const body = canonicalJson(value),
    signature = createHmac("sha256", key)
      .update(domain + "\0")
      .update(body)
      .digest("hex");
  return Buffer.from(canonicalJson({ ...(value as object), signature }) + "\n");
}
function assertRetainedSelectedLoadExecutor(destination: string): void {
  const root = resolve(destination);
  const checkout = join(root, "checkout");
  const bootstrap = pathToFileURL(
    join(root, "bootstrap/module-boundary.mjs")
  ).href;
  const launch = ["--import", bootstrap, "--input-type=module", "--eval"];
  if (
    fileURLToPath(import.meta.url) !==
      join(
        checkout,
        "dist/lib/ingestion/recovery-gmail-selected-load-executor.js"
      ) ||
    process.cwd() !== checkout ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.execArgv.length !== launch.length + 1 ||
    launch.some((argument, index) => process.execArgv[index] !== argument)
  )
    throw Error("RECOVERY_GMAIL_SELECTED_LOAD_RETAINED_EXECUTOR_REQUIRED");
}

function prepareSelectedLoadFirst(
  input: RecoveryGmailSelectedLoadInstallationInput
) {
  const { selector, ...runtime } = input;
  const verifiedRuntime = openPreparedRuntimeForAdmission(runtime);
  const loadRoot = join(resolve(runtime.destination), "recovery-gmail-load");
  if (
    existsSync(loadRoot) &&
    readdirSync(loadRoot).some(
      (name) =>
        /^[a-f0-9]{64}$/.test(name) &&
        existsSync(join(loadRoot, name, "execution-baseline.json"))
    )
  )
    throw Error("RECOVERY_GMAIL_SELECTED_LOAD_REPLAY_REQUIRES_DELTA_PROOF");
  verifiedRuntime.assertRuntime();
  const installed = inspectInstalledRecoveryGmailSelectedLoadEvidence(input);
  const host = readRecoveryGmailHostForLoadInstallation(runtime),
    opened = openPreparedRuntimeForAdmission(runtime);
  if (
    !host.checkpoint.files.some(
      (file) =>
        file.area === "checkout" &&
        file.path ===
          "dist/lib/ingestion/recovery-gmail-selected-load-executor.js" &&
        file.bytes &&
        Buffer.from(file.bytes, "base64")
          .toString("utf8")
          .includes("recoveryGmailSelectedLoadExecutorVersion = 1")
    )
  )
    fail();
  const baselineInput = {
    checkpoint: host.checkpoint,
    recoveryKey: input.recoveryKey,
    completed: host.completed,
    unfinishedAdmissions: host.unfinishedAdmissions,
    current: host.current,
    currentLedger: host.checkpoint.ledger,
    currentRuntime: host.currentRuntime,
    priorLoads: [],
    selector,
    ...(host.ownProductionOwnership
      ? { ownProductionOwnership: host.ownProductionOwnership }
      : {}),
  };
  const proof = proveRecoveryGmailSelectedLoadBaseline(baselineInput);
  const root = join(resolve(runtime.destination), "checkout"),
    operator = join(resolve(runtime.destination), "operator"),
    directory = join(
      resolve(runtime.destination),
      "recovery-gmail-load",
      installed.runId
    );
  const location = projectLedgerLocation(root);
  if (
    location.backend !== "sqlite" ||
    resolve(location.path) !== join(operator, "ledger.sqlite")
  )
    fail();
  if (existsSync(join(directory, "execution-baseline.json")))
    throw Error("RECOVERY_GMAIL_SELECTED_LOAD_REPLAY_REQUIRES_DELTA_PROOF");
  const evidence = proof.selection.canonicalEvidence.find((file) =>
    file.path.endsWith("/bodies/" + selector.receiptId + "/source.txt")
  );
  if (!evidence) fail();
  const raw = readFileSync(join(operator, evidence.path));
  if (sha256(raw) !== proof.source.rawSha256) fail();
  const plan = createSelectedGmailLoadEffectPlan(host.checkpoint, proof, raw);
  const entries = opened.inventoryGmailLoadInstallation();
  if (
    sha256(
      canonicalJson(
        entries.filter(
          (entry) =>
            !/^operator\/weekly-runs\.sqlite(?:-wal|-shm)?$/.test(entry.path) &&
            entry.path !== "recovery-gmail-load" &&
            !entry.path.startsWith("recovery-gmail-load/")
        )
      )
    ) !== installed.physicalSnapshotSha256
  )
    fail();
  const savedAdmission = readFileSync(join(directory, "admission.json"));
  if (sha256(savedAdmission) !== installed.admissionSha256) fail();
  const packet = createRecoveryGmailSelectedLoadEvidence({
    baseline: baselineInput,
    binding: host.binding,
    physicalSnapshotSha256: installed.physicalSnapshotSha256,
    admission: savedAdmission,
  });
  const readonlyFiles = new Map<string, Buffer>([
    [join(directory, "admission.json"), savedAdmission],
    [join(directory, "baseline.json"), packet.manifest],
  ]);
  const readonlyDirectories = new Set([
    dirname(directory),
    directory,
    join(directory, "stages"),
    join(directory, "stages/baseline"),
    join(directory, "stages/admission"),
  ]);
  for (const chunk of packet.chunks) {
    readonlyFiles.set(
      join(directory, "chunks", chunk.id + ".bin"),
      chunk.bytes
    );
    readonlyDirectories.add(join(directory, "chunks"));
    readonlyDirectories.add(join(directory, "stages", chunk.id));
  }
  for (const [path, bytes] of readonlyFiles)
    if (!readFileSync(path).equals(bytes)) fail();
  const journal = Buffer.from(host.current.journal, "base64");
  return {
    kind: "first" as const,
    admissionSha256: installed.admissionSha256,
    evidenceSha256: installed.evidenceSha256,
    physicalSnapshotSha256: installed.physicalSnapshotSha256,
    proof,
    plan,
    raw,
    catalog: { ledger: host.checkpoint.ledger, generation: 1 as const },
    journal,
    entries,
    opened,
    directory,
    readonlyFiles,
    readonlyDirectories,
  };
}

interface NextSelectedLoadStart {
  selector: RecoveryGmailSelectedReceiptSelector;
  admission: Buffer;
}

function prepareSelectedLoadNext(
  input: RecoveryGmailSelectedLoadInstallationInput,
  next: NextSelectedLoadStart
) {
  const root = resolve(input.destination);
  const id = readNextSelectedLoadAdmissionRunId(
    next.admission,
    input.recoveryKey
  );
  const { directory, target, stage } = selectedLoadAdmissionTailPaths(root, id);
  if (
    existsSync(join(directory, "execution-baseline.json")) ||
    existsSync(join(directory, "execution-baseline.json-stage"))
  )
    throw Error("RECOVERY_GMAIL_SELECTED_LOAD_REPLAY_REQUIRES_DELTA_PROOF");
  const { record, tail, effective } =
    readNextSelectedLoadAdmissionForInstallation(
      input,
      next.selector,
      next.admission
    );
  const installed = observeSelectedLoadAdmissionTail(
    root,
    effective.entries,
    tail
  );
  if (
    record.runId !== id ||
    record.generation !== 2 ||
    effective.catalog.generation !== 2 ||
    !installed.observed.target ||
    installed.observed.candidate
  )
    return fail();

  return {
    kind: "next" as const,
    admissionSha256: sha256(next.admission),
    priorRunId: record.previousRunId,
    priorLoadFamilySha256: record.priorLoadFamilySha256,
    catalogSha256: record.catalogSha256,
    journalSha256: record.journalSha256,
    ...effective,
    directory,
    readonlyFiles: new Map([[target, Buffer.from(next.admission)]]),
    readonlyDirectories: new Set([
      dirname(directory),
      directory,
      dirname(stage),
      stage,
    ]),
    opened: openPreparedRuntimeForAdmission(input),
  };
}

interface ThirdSelectedLoadStart {
  input: RecoveryGmailThirdSelectedLoadFrameInput;
  executionBaseline: Buffer;
}

function prepareSelectedLoadThird(
  prior: RecoveryGmailSelectedLoadInstallationInput,
  request: ThirdSelectedLoadStart
) {
  const { input, executionBaseline } = request;
  const { baseline, record, tail, effective, presence } =
    readThirdSelectedLoadStartForInstallation(input, executionBaseline);
  if (
    presence !== "installed" ||
    effective.catalog.generation !== 3 ||
    baseline.generation !== 3 ||
    baseline.completedPrefixSha256 !== record.completedPrefixSha256 ||
    baseline.runId !== record.runId
  )
    return fail();
  const opened = openPreparedRuntimeForAdmission(prior);
  if (opened.receiptSha256 !== baseline.preparedReceiptSha256) return fail();
  const root = resolve(prior.destination);
  const entries = opened.inventoryGmailSelectedLoadExecution();
  const start = observeThirdSelectedLoadStartTail(
    root,
    entries,
    tail,
    executionBaseline,
    prior.recoveryKey
  );
  if (start.presence !== "installed") return fail();
  same(start.beforeStart, effective.entries);
  const { directory, stage, target, base } = selectedLoadAdmissionTailPaths(
    root,
    record.runId
  );
  const executionPath = join(directory, "execution-baseline.json");
  const predecessorPrefixes = baseline.entries
    .filter(
      ({ path, kind }) =>
        kind === "directory" &&
        /^recovery-gmail-load\/[a-f0-9]{64}$/.test(path) &&
        path !== base
    )
    .map(({ path }) => path);
  const reportPath =
    "checkout/data/ingestion/reports/" +
    sha256(effective.plan.receipt.importRunId) +
    ".json";
  if (
    predecessorPrefixes.length !== 2 ||
    baseline.entries.some(({ path }) => path === reportPath)
  )
    return fail();
  return {
    kind: "third" as const,
    ...effective,
    entries,
    opened,
    directory,
    executionBaseline,
    startedAtEpochMs: baseline.startedAtEpochMs,
    predecessorPrefixes,
    admissionSha256: baseline.admissionSha256,
    priorLoadFamilySha256: baseline.completedPrefixSha256,
    readonlyFiles: new Map([
      [target, Buffer.from(input.admission)],
      [executionPath, Buffer.from(executionBaseline)],
    ]),
    readonlyDirectories: new Set([
      dirname(directory),
      directory,
      dirname(stage),
      stage,
      executionPath + "-stage",
    ]),
  };
}

async function finishSelectedLoadWithWeeklyRunner(
  scope: Scope,
  opened: ReturnType<typeof openPreparedRuntimeForAdmission>,
  identity: {
    admissionSha256: string;
    executionBaselineSha256: string;
    successorSha256?: string;
  }
) {
  scope.phase = "run";
  let result: Buffer | undefined, expectedReleased: Buffer | undefined;
  scope.finish = async (state, snapshot) => {
    const sealed = await installSelectedLoadCompletion(
      scope,
      state,
      snapshot,
      identity,
      opened.inventoryGmailSelectedLoadExecution
    );
    result = sealed.result;
    expectedReleased = sealed.releasedJournal;
  };
  const state = await runWeeklyImport({
    root: scope.root,
    source: {
      editionId: scope.source.editionId,
      deliveryId: scope.source.deliveryId,
      raw: Buffer.from(scope.raw),
      importObservedAtEpochMs: scope.source.importObservedAtEpochMs,
    },
    stopAfter: "load",
  });
  if (
    !result ||
    !expectedReleased ||
    scope.finish !== undefined ||
    (scope.resume && !scope.resume.gateComplete)
  )
    return fail();
  const journal = readWeeklyJournalRecoverySnapshotReadOnly(
    join(scope.operator, "weekly-runs.sqlite")
  );
  if (!journal.equals(expectedReleased)) return fail();
  scope.assertCurrent();
  if (!scope.assertCompletionFiles) return fail();
  scope.assertCompletionFiles();
  return {
    status: "selected-load-complete" as const,
    activationAllowed: false as const,
    captureAllowed: false as const,
    loadAllowed: false as const,
    runId: state.runId,
    ledgerRevision: ledgerDigest(scope.ledger),
    generation: scope.generation,
    resultSha256: sha256(result),
    admissionSha256: identity.admissionSha256,
    accepted: scope.plan.result.report.acceptedEventIds.length,
  };
}

/** Start a freshly admitted load with the fixed runner and checked catalog.
 * Interrupted SQL effects require the separate original-baseline replay composer. */
async function executeSelectedLoad(
  supplied: RecoveryGmailSelectedLoadInstallationInput,
  testPause?:
    | "catalog-before-commit"
    | "catalog-committed"
    | "backup-flushed"
    | "history-first-chunk"
    | "completion-before-intent"
    | "completion-intent-partial",
  next?: NextSelectedLoadStart,
  third?: ThirdSelectedLoadStart
) {
  assertNoSelectedGmailLoadExecution();
  assertNoSelectedLoadInstallation();
  assertNoRecoveredGmailCapture();
  const wire = encodeRecoveryGmailSelectedLoadFrame(supplied),
    input = decodeRecoveryGmailSelectedLoadFrame(wire),
    { selector: _selector, ...runtime } = input;
  let scope: Scope | undefined;
  try {
    assertRetainedSelectedLoadExecutor(runtime.destination);
    if (next && third) return fail();
    const start = third
      ? prepareSelectedLoadThird(input, third)
      : next
        ? prepareSelectedLoadNext(input, next)
        : prepareSelectedLoadFirst(input);
    const {
      directory,
      opened,
      entries,
      readonlyFiles,
      readonlyDirectories,
      proof,
      plan,
      raw,
      admissionSha256,
    } = start;
    const journal = validateWeeklyJournalRecoverySnapshot(start.journal);
    const root = join(resolve(runtime.destination), "checkout"),
      operator = join(resolve(runtime.destination), "operator");
    const location = projectLedgerLocation(root);
    if (
      location.backend !== "sqlite" ||
      resolve(location.path) !== join(operator, "ledger.sqlite")
    )
      return fail();
    const previousOwner = journal.ownership.find(
      (row) => row.scope === production
    );
    if (start.kind !== "first" && previousOwner?.expiresAtEpochMs !== 0)
      return fail();
    const predecessorPrefixes =
      start.kind === "third"
        ? start.predecessorPrefixes
        : start.kind === "next"
          ? ["recovery-gmail-load/" + start.priorRunId]
          : [];
    const enteredAt = Date.now();
    const startedAt =
      start.kind === "third" ? start.startedAtEpochMs : enteredAt;
    const deadline = startedAt + 180_000;
    if (enteredAt >= deadline) return fail();
    const sqlIdentities = ["ledger.sqlite", "weekly-runs.sqlite"].map(
      (name) => {
        const path = join(operator, name),
          stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail();
        return { path, dev: stat.dev, ino: stat.ino };
      }
    );
    const ownerHash = sha256("selected-load/" + admissionSha256),
      owner = [
        ownerHash.slice(0, 8),
        ownerHash.slice(8, 12),
        ownerHash.slice(12, 16),
        ownerHash.slice(16, 20),
        ownerHash.slice(20, 32),
      ].join("-");
    const files = new Map<string, Buffer>();
    const execution =
      start.kind === "third"
        ? start.executionBaseline
        : start.kind === "first"
          ? signSelectedLoadExecutionBaseline(
              {
                admissionSha256,
                evidenceSha256: start.evidenceSha256,
                physicalSnapshotSha256: start.physicalSnapshotSha256,
                generation: 1,
                startedAtEpochMs: startedAt,
                entries,
              },
              input.recoveryKey
            )
          : signSelectedNextLoadExecutionBaseline(
              {
                admissionSha256,
                catalogSha256: start.catalogSha256,
                journalSha256: start.journalSha256,
                priorLoadFamilySha256: start.priorLoadFamilySha256,
                physicalSnapshotSha256: sha256(canonicalJson(entries)),
                generation: 2,
                startedAtEpochMs: startedAt,
                entries,
              },
              input.recoveryKey
            );
    files.set(join(directory, "execution-baseline.json"), execution);
    files.set(
      join(
        root,
        "data/ingestion/reports",
        sha256(plan.result.report.runId) + ".json"
      ),
      Buffer.from(JSON.stringify(plan.result.report, null, 2) + "\n")
    );
    const directories = new Set([
      operator,
      directory,
      dirname(directory),
      join(directory, "key-stage"),
      join(directory, "execution-baseline.json-stage"),
      join(directory, "load-result.json-stage"),
      join(root, "data/ingestion/backups"),
      join(root, "data/ingestion/reports"),
    ]);
    const originalEntries = new Map(
      entries.map((entry) => [entry.path, entry])
    );
    scope = {
      active: true,
      chunkPauseTest: testPause,
      deadline,
      startedAt,
      root,
      operator,
      directory,
      key: Buffer.from(input.recoveryKey),
      phase: "evidence",
      source: proof.source,
      run: proof.runState,
      initialRun: proof.initialState,
      raw,
      plan,
      original: structuredClone(start.catalog.ledger),
      ledger: structuredClone(start.catalog.ledger),
      generation: start.catalog.generation,
      priorLoadFamilySha256:
        start.kind !== "first" ? start.priorLoadFamilySha256 : undefined,
      owner,
      fence: (previousOwner?.fence ?? 0) + 1,
      journal,
      files,
      directories,
      transients: new Map(),
      readonlyFiles,
      previousFiles: new Map(),
      keyStage: join(directory, "key-stage"),
      originalEntries,
      assertCurrent: () => {
        for (const identity of sqlIdentities) {
          const stat = lstatSync(identity.path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.dev !== identity.dev ||
            stat.ino !== identity.ino
          )
            fail();
        }
        const actual = opened.inventoryGmailSelectedLoadExecution();
        for (const entry of actual) {
          const absolute = join(runtime.destination, entry.path),
            before = originalEntries.get(entry.path),
            expected = scope!.files.get(absolute);
          if (
            predecessorPrefixes.some(
              (prefix) =>
                entry.path === prefix || entry.path.startsWith(prefix + "/")
            )
          ) {
            if (!before || canonicalJson(before) !== canonicalJson(entry))
              fail();
            continue;
          }
          if (
            entry.path === "recovery-gmail-load" ||
            entry.path.startsWith("recovery-gmail-load/")
          ) {
            const readonly = readonlyFiles.get(absolute);
            if (readonly) {
              if (
                entry.kind !== "file" ||
                entry.size !== readonly.length ||
                entry.sha256 !== sha256(readonly)
              )
                fail();
              continue;
            }
            if (entry.kind === "directory" && readonlyDirectories.has(absolute))
              continue;
            if (
              !directories.has(absolute) &&
              !scope!.files.has(absolute) &&
              !scope!.transients.has(absolute)
            )
              fail();
          }
          if (
            !entry.path.startsWith("recovery-gmail-load/") &&
            before &&
            canonicalJson(before) === canonicalJson(entry)
          )
            continue;
          if (entry.kind === "directory" && directories.has(absolute)) continue;
          if (entry.kind === "file") {
            const previous = scope!.previousFiles.get(absolute);
            if (
              previous &&
              entry.size === previous.length &&
              entry.sha256 === sha256(previous)
            )
              continue;
            if (
              expected &&
              entry.size === expected.length &&
              entry.sha256 === sha256(expected)
            )
              continue;
            if (
              scope!.transients.has(absolute) &&
              (entry.size === 0 ||
                (entry.size === scope!.transients.get(absolute)!.length &&
                  entry.sha256 === sha256(scope!.transients.get(absolute)!)))
            )
              continue;
          }
          fail();
        }
        for (const entry of entries)
          if (
            !sqlFiles.test(entry.path) &&
            !actual.some((item) => item.path === entry.path)
          )
            fail();
      },
    };
    scope.assertCurrent();
    return await scopes.run(scope, async () => {
      const install = () =>
        installRecoveryIntent(
          join(directory, "execution-baseline.json"),
          execution,
          join(directory, "execution-baseline.json-stage")
        );
      if (start.kind !== "first") {
        const journalPath = join(operator, "weekly-runs.sqlite");
        const guard = new DatabaseSync(journalPath, { timeout: 10000 });
        scope!.evidenceGuard = true;
        try {
          guard.exec("BEGIN IMMEDIATE");
          if (
            !readWeeklyJournalRecoverySnapshotInTransaction(guard).equals(
              start.journal
            )
          )
            fail();
          await withCanonicalStoreTransaction(
            location.path,
            start.catalog,
            async () => {
              same(opened.inventoryGmailSelectedLoadExecution(), entries);
              scope!.assertCurrent();
              if (start.kind === "next") install();
            }
          );
          if (
            !readWeeklyJournalRecoverySnapshotInTransaction(guard).equals(
              start.journal
            )
          )
            fail();
          guard.exec("COMMIT");
        } catch (error) {
          if (guard.isTransaction) guard.exec("ROLLBACK");
          throw error;
        } finally {
          scope!.evidenceGuard = false;
          guard.close();
        }
      } else install();
      scope!.phase = "key";
      if (start.kind === "third") {
        const existingKey = loadBackupKey(operator);
        try {
          if (!existingKey.equals(input.recoveryKey)) return fail();
        } finally {
          existingKey.fill(0);
        }
      } else {
        installRecoveredBackupKey(operator, input.recoveryKey, {
          stagingDirectory: scope!.keyStage,
        });
      }
      scope!.assertCurrent();
      return finishSelectedLoadWithWeeklyRunner(scope!, opened, {
        admissionSha256,
        executionBaselineSha256: sha256(execution),
      });
    });
  } finally {
    if (scope) {
      scope.active = false;
      scope.key.fill(0);
    }
    input.recoveryKey.fill(0);
    wire.fill(0);
  }
}

/** First admitted source load; production never selects a test pause. */
export function executeRecoveredGmailSelectedLoad(
  input: RecoveryGmailSelectedLoadInstallationInput
) {
  return executeSelectedLoad(input);
}
/** Execute one settled, still-unmutated third start through the fixed runner. */
export async function executeRecoveredGmailThirdSelectedLoad(
  supplied: RecoveryGmailThirdSelectedLoadFrameInput,
  signedStart: Buffer
) {
  if (
    !Buffer.isBuffer(signedStart) ||
    !signedStart.length ||
    signedStart.length > 16 * 1024 * 1024
  )
    return fail();
  const executionBaseline = Buffer.from(signedStart);
  let wire: Buffer | undefined;
  let input: RecoveryGmailThirdSelectedLoadFrameInput | undefined;
  try {
    wire = encodeRecoveryGmailThirdSelectedLoadFrame(supplied);
    input = decodeRecoveryGmailThirdSelectedLoadFrame(wire);
    return await executeSelectedLoad(input.family.prior, undefined, undefined, {
      input,
      executionBaseline,
    });
  } finally {
    executionBaseline.fill(0);
    input?.family.prior.recoveryKey.fill(0);
    input?.family.admission.fill(0);
    input?.admission.fill(0);
    wire?.fill(0);
  }
}

/** Execute a distinct installed second receipt against the released first load. */
export function executeRecoveredGmailNextSelectedLoad(
  prior: RecoveryGmailSelectedLoadInstallationInput,
  selector: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer
) {
  if (!Buffer.isBuffer(admission) || admission.length > 65536) return fail();
  return executeSelectedLoad(prior, undefined, {
    selector,
    admission: Buffer.from(admission),
  });
}

/** Resume the exact second-load gap under a new fence after natural expiry. */
async function resumeNextSelectedLoad(
  supplied: RecoveryGmailSelectedLoadInstallationInput,
  next: RecoveryGmailSelectedReceiptSelector,
  signedAdmission: Buffer,
  testPause?:
    | "intent-linked"
    | "lease-acquired"
    | "rollback-catalog-committed"
    | "backup-flushed"
    | "backup-settled-before-intent",
  settledBackup?: NonNullable<
    ReturnType<typeof observeNextSelectedLoadBackupStage>
  >
): Promise<Awaited<ReturnType<typeof finishSelectedLoadWithWeeklyRunner>>> {
  assertNoSelectedGmailLoadExecution();
  assertNoSelectedLoadInstallation();
  assertNoRecoveredGmailCapture();
  if (!Buffer.isBuffer(signedAdmission) || signedAdmission.length > 65536)
    return fail();
  const admission = Buffer.from(signedAdmission);
  const wire = encodeRecoveryGmailSelectedLoadFrame(supplied);
  const input = decodeRecoveryGmailSelectedLoadFrame(wire);
  const { selector: _selector, ...runtime } = input;
  let scope: Scope | undefined;
  try {
    assertRetainedSelectedLoadExecutor(runtime.destination);
    const runId = readNextSelectedLoadAdmissionRunId(
      admission,
      input.recoveryKey
    );
    const loadDirectory = join(
      resolve(runtime.destination),
      "recovery-gmail-load",
      runId
    );
    const completionPath = join(
      loadDirectory,
      selectedLoadCompletionIntentFilename
    );
    const hasCompletionFiles =
      existsSync(completionPath) ||
      existsSync(completionPath + "-stage") ||
      existsSync(join(loadDirectory, "load-result.json"));
    const row =
      !hasCompletionFiles &&
      existsSync(join(loadDirectory, "execution-baseline.json"))
        ? validateWeeklyJournalRecoverySnapshot(
            readWeeklyJournalRecoverySnapshotReadOnly(
              join(resolve(runtime.destination), "operator/weekly-runs.sqlite")
            )
          ).runState.find((entry) => entry.id === runId)
        : undefined;
    if (
      hasCompletionFiles ||
      (row &&
        parseWeeklyRunState(JSON.parse(row.payload)).stages.find(
          (stage) => stage.stage === "load"
        )?.status === "succeeded")
    ) {
      const evidence = readNextSelectedLoadCompletionEvidence(
        input,
        next,
        admission
      );
      if (evidence.report.lease.status === "active")
        throw Error("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
      if (evidence.completionPending) {
        const { proof, plan, catalog } = evidence.effective;
        await settleSelectedLoadCompletion(
          runtime,
          evidence,
          proof,
          plan,
          catalog.ledger
        );
        return replayRecoveredGmailNextSelectedLoad(input, next, admission);
      }
      const { lease: _lease, ...result } = evidence.report;
      return { ...result, status: "selected-load-complete" as const };
    }
    const evidence = readNextSelectedLoadInterruptionEvidence(
      input,
      next,
      admission
    );
    const { owner, gap, effective, catalog, journal, entries, pendingBackup } =
      evidence;
    if (
      settledBackup &&
      (pendingBackup || !evidence.backup.equals(settledBackup.bytes))
    )
      return fail();
    const now = Date.now();
    if (owner.expiresAtEpochMs >= now)
      throw Error("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
    const { saved, latest, successors, acquired } = evidence;
    let retry: {
      filename: string;
      bytes: Buffer;
      intent: {
        owner: string;
        fence: number;
        startedAtEpochMs: number;
        deadlineEpochMs: number;
      };
    };
    if (saved && latest && acquired) {
      if (now < latest.intent.deadlineEpochMs)
        throw Error("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
      retry = prepareNextSelectedLoadResumeSuccessor({
        initial: saved,
        parent: latest,
        sequence: successors.length + 1,
        journal,
        previousOwner: owner,
        startedAtEpochMs: now,
        key: input.recoveryKey,
        committedRollback: evidence.committedRollback,
      });
    } else if (latest) {
      retry = {
        filename: basename(latest.path),
        bytes: latest.bytes,
        intent: latest.intent,
      };
    } else {
      const bytes = signNextSelectedLoadResumeIntent(
        gap,
        now,
        input.recoveryKey
      );
      retry = {
        filename: nextSelectedLoadResumeIntentFilename,
        bytes,
        intent: verifyNextSelectedLoadResumeIntent(bytes, input.recoveryKey),
      };
    }
    const { bytes, intent } = retry;
    if (intent.startedAtEpochMs > now || intent.deadlineEpochMs <= now)
      return fail();

    const destination = resolve(runtime.destination);
    const root = join(destination, "checkout"),
      operator = join(destination, "operator");
    const { directory } = selectedLoadAdmissionTailPaths(
      destination,
      gap.runId
    );
    const journalPath = join(operator, "weekly-runs.sqlite");
    const catalogPath = join(operator, "ledger.sqlite");
    const location = projectLedgerLocation(root);
    if (location.backend !== "sqlite" || resolve(location.path) !== catalogPath)
      return fail();
    const identities = [journalPath, catalogPath].map((path) => {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        return fail();
      return { path, dev: stat.dev, ino: stat.ino };
    });
    const opened = openPreparedRuntimeForAdmission(runtime);
    const { proof, plan, raw } = effective;
    const path = join(directory, retry.filename);
    const stage = path + "-stage";
    const retryPath = "recovery-gmail-load/" + gap.runId + "/" + retry.filename;
    const retryStage = retryPath + "-stage";
    const backup = join(root, "data/ingestion/backups/ledger.snapshot.enc");
    const report = join(
      root,
      "data/ingestion/reports",
      sha256(plan.receipt.importRunId) + ".json"
    );
    const files = new Map([
      [path, bytes],
      [backup, evidence.backup],
      [report, Buffer.from(JSON.stringify(plan.result.report, null, 2) + "\n")],
    ]);
    const directories = new Set([
      directory,
      dirname(directory),
      stage,
      join(directory, "load-result.json-stage"),
      dirname(backup),
      dirname(report),
    ]);
    const originalEntries = new Map(
      entries.map((entry) => [entry.path, entry])
    );
    if (originalEntries.size !== entries.length) return fail();
    const transients = new Map<string, Buffer>();
    const staged = evidence.saved?.observed.candidate;
    if (staged) transients.set(staged.path, bytes);
    let settling = false;
    let retrySettled = false;
    scope = {
      active: true,
      chunkPauseTest: testPause,
      ...(retry.filename === nextSelectedLoadResumeIntentFilename
        ? {}
        : { successor: { path } }),
      phase: "evidence",
      evidenceGuard: true,
      resume: {
        observedJournal: validateWeeklyJournalRecoverySnapshot(journal),
        previousOwner: owner,
        gateComplete: false,
        precommitRollback: evidence.report.status === "unchanged",
      },
      priorLoadFamilySha256: gap.priorLoadFamilySha256,
      deadline: intent.deadlineEpochMs,
      startedAt: evidence.execution.startedAtEpochMs,
      root,
      operator,
      directory,
      key: Buffer.from(input.recoveryKey),
      source: proof.source,
      run: proof.runState,
      initialRun: proof.initialState,
      raw,
      plan,
      original: effective.catalog.ledger,
      ledger: catalog.ledger,
      generation: catalog.generation,
      owner: intent.owner,
      fence: intent.fence,
      journal: validateWeeklyJournalRecoverySnapshot(effective.journal),
      files,
      directories,
      transients,
      readonlyFiles: new Map(),
      previousFiles: new Map(),
      keyStage: join(directory, "key-stage"),
      originalEntries,
      assertCurrent: () => {
        for (const identity of identities) {
          const stat = lstatSync(identity.path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.dev !== identity.dev ||
            stat.ino !== identity.ino
          )
            fail();
        }
        if (settledBackup) {
          const stat = lstatSync(backup);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.dev !== settledBackup.candidateIdentity.dev ||
            stat.ino !== settledBackup.candidateIdentity.ino
          )
            fail();
        }
        const actual = opened.inventoryGmailSelectedLoadExecution();
        const present = new Set<string>();
        for (const entry of actual) {
          if (retrySettled && entry.path.startsWith(retryStage + "/")) fail();
          present.add(entry.path);
          const absolute = join(destination, entry.path);
          const before = originalEntries.get(entry.path);
          if (before && canonicalJson(before) === canonicalJson(entry))
            continue;
          const expected = files.get(absolute);
          const temporary = transients.get(absolute);
          const previous = scope!.previousFiles.get(absolute);
          const matches = (value?: Buffer) =>
            !!value &&
            entry.kind === "file" &&
            entry.size === value.length &&
            entry.sha256 === sha256(value);
          if (
            (entry.kind === "directory" && directories.has(absolute)) ||
            matches(expected) ||
            matches(previous) ||
            (temporary &&
              (matches(temporary) ||
                (entry.kind === "file" && entry.size === 0)))
          )
            continue;
          fail();
        }
        for (const entry of originalEntries.values()) {
          if (present.has(entry.path)) continue;
          if (
            !settling ||
            !staged ||
            join(destination, entry.path) !== staged.path
          )
            fail();
          const target = lstatSync(path);
          if (
            !target.isFile() ||
            target.isSymbolicLink() ||
            target.nlink !== 1 ||
            target.dev !== staged.dev ||
            target.ino !== staged.ino ||
            !readFileSync(path).equals(bytes)
          )
            fail();
        }
      },
    };

    const result = await scopes.run(scope, async () => {
      const guard = new DatabaseSync(journalPath, { timeout: 10000 });
      try {
        guard.exec("BEGIN IMMEDIATE");
        if (
          !readWeeklyJournalRecoverySnapshotInTransaction(guard).equals(
            journal
          ) ||
          owner.expiresAtEpochMs >= Date.now()
        )
          return fail();
        await withCanonicalStoreTransaction(catalogPath, catalog, async () => {
          same(opened.inventoryGmailSelectedLoadExecution(), entries);
          scope!.assertCurrent();
          if (intent.deadlineEpochMs <= Date.now()) fail();
          if (pendingBackup) {
            const current = observeNextSelectedLoadBackupStage({
              root: destination,
              entries,
              catalog: catalog.ledger,
              key: scope!.key,
              inheritedBackup: true,
            });
            if (
              !current ||
              !current.bytes.equals(pendingBackup.bytes) ||
              !readFileSync(backup).equals(evidence.backup)
            )
              fail();
            same(current.entry, pendingBackup.entry);
            same(current.target, pendingBackup.target);
            same(current.candidateIdentity, pendingBackup.candidateIdentity);
            same(current.targetIdentity, pendingBackup.targetIdentity);
            const source = join(destination, pendingBackup.entry.path);
            renameSync(source, backup);
            if (process.platform !== "win32") {
              const handle = openSync(dirname(backup), "r");
              try {
                fsyncSync(handle);
              } finally {
                closeSync(handle);
              }
            }
            const installed = {
              ...pendingBackup.entry,
              path: pendingBackup.target.path,
            };
            const stat = lstatSync(backup);
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.nlink !== 1 ||
              stat.dev !== pendingBackup.candidateIdentity.dev ||
              stat.ino !== pendingBackup.candidateIdentity.ino ||
              !readFileSync(backup).equals(pendingBackup.bytes) ||
              lstatSync(source, { throwIfNoEntry: false })
            )
              fail();
            files.set(backup, pendingBackup.bytes);
            originalEntries.delete(pendingBackup.entry.path);
            originalEntries.set(installed.path, installed);
            scope!.assertCurrent();
            if (testPause === "backup-settled-before-intent") {
              process.stdout.write(
                "SELECTED_LOAD_TEST_BACKUP_SETTLED_BEFORE_INTENT\n"
              );
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                30000
              );
              throw Error("SELECTED_LOAD_TEST_PAUSE_EXPIRED");
            }
            return;
          }
          if (staged) {
            same(
              inspectRecoveryInstalledFile(path, stage, 8192),
              evidence.saved!.observed
            );
            settling = true;
          }
          installRecoveryIntent(path, bytes, stage);
          const settled = inspectRecoveryInstalledFile(path, stage, 8192);
          if (!settled.target?.bytes.equals(bytes) || settled.candidate) fail();
          originalEntries.set(retryPath, {
            path: retryPath,
            kind: "file",
            size: bytes.length,
            sha256: sha256(bytes),
          });
          originalEntries.set(retryStage, {
            path: retryStage,
            kind: "directory",
          });
          retrySettled = true;
          scope!.assertCurrent();
        });
        if (
          !readWeeklyJournalRecoverySnapshotInTransaction(guard).equals(journal)
        )
          return fail();
        guard.exec("COMMIT");
      } catch (error) {
        if (guard.isTransaction) guard.exec("ROLLBACK");
        throw error;
      } finally {
        scope!.evidenceGuard = false;
        guard.close();
      }
      if (pendingBackup) return undefined;
      return finishSelectedLoadWithWeeklyRunner(scope!, opened, {
        admissionSha256: gap.admissionSha256,
        executionBaselineSha256: gap.executionBaselineSha256,
        successorSha256: sha256(bytes),
      });
    });
    if (result) return result;
    scope!.active = false;
    scope!.key.fill(0);
    if (!pendingBackup) return fail();
    return await resumeNextSelectedLoad(
      input,
      next,
      admission,
      testPause,
      pendingBackup
    );
  } finally {
    if (scope) {
      scope.active = false;
      scope.key.fill(0);
    }
    input.recoveryKey.fill(0);
    wire.fill(0);
  }
}

/** Resume the exact second-load gap under a new fence after natural expiry. */
export function resumeRecoveredGmailNextSelectedLoad(
  prior: RecoveryGmailSelectedLoadInstallationInput,
  next: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer
) {
  return resumeNextSelectedLoad(prior, next, admission);
}

/** Fixed retry pauses for the retained test worker only. */
export function resumeRecoveredGmailNextSelectedLoadForTest(
  prior: RecoveryGmailSelectedLoadInstallationInput,
  next: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer,
  point:
    | "intent-linked"
    | "lease-acquired"
    | "rollback-catalog-committed"
    | "backup-flushed"
    | "backup-settled-before-intent"
) {
  if (
    point !== "intent-linked" &&
    point !== "lease-acquired" &&
    point !== "rollback-catalog-committed" &&
    point !== "backup-flushed" &&
    point !== "backup-settled-before-intent"
  )
    return fail();
  return resumeNextSelectedLoad(prior, next, admission, point);
}

/** Fixed second-load test pauses at guarded catalog and history boundaries. */
export function executeRecoveredGmailNextSelectedLoadForTest(
  prior: RecoveryGmailSelectedLoadInstallationInput,
  selector: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer,
  point:
    | "catalog-before-commit"
    | "catalog-committed"
    | "backup-flushed"
    | "history-first-chunk"
    | "completion-before-intent"
    | "completion-intent-partial"
) {
  if (
    !Buffer.isBuffer(admission) ||
    admission.length > 65536 ||
    (point !== "catalog-before-commit" &&
      point !== "catalog-committed" &&
      point !== "backup-flushed" &&
      point !== "history-first-chunk" &&
      point !== "completion-before-intent" &&
      point !== "completion-intent-partial")
  )
    return fail();
  return executeSelectedLoad(prior, point, {
    selector,
    admission: Buffer.from(admission),
  });
}

/** Fixed test-only pauses at durable boundaries of the retained worker. */
export function executeRecoveredGmailSelectedLoadForTest(
  input: RecoveryGmailSelectedLoadInstallationInput,
  point: "catalog-before-commit" | "history-first-chunk"
) {
  if (point !== "catalog-before-commit" && point !== "history-first-chunk")
    fail();
  return executeSelectedLoad(input, point);
}

/** Resume exactly one inspected committed first-attempt gap. Scope remains
 * private and quarantined; interruption of this retry requires later proof. */
/** Settle the observed file prefix under both writer locks without changing
 * the original catalog, journal, or ownership fence. */
type SelectedLoadAdmissionInstallationEvidence = Pick<
  ReturnType<typeof readNextSelectedLoadAdmissionForInstallation>["effective"],
  "proof" | "raw" | "plan" | "catalog" | "journal" | "entries"
>;

/** Mutate only the exact signed admission files while both local stores are guarded. */
async function installSelectedLoadFixedEvidenceWithGuards(
  runtime: RecoveryRuntimeInput,
  tail: SelectedLoadAdmissionTail,
  effective: SelectedLoadAdmissionInstallationEvidence,
  preparedReceiptSha256?: string,
  executionBaseline?: Buffer
): Promise<void> {
  const bytes = executionBaseline ?? tail.bytes;
  let scope: Scope | undefined;
  try {
    const destination = resolve(runtime.destination);
    const paths = selectedLoadAdmissionTailPaths(destination, tail.runId);
    const { directory, base } = paths;
    const target = executionBaseline
      ? join(directory, "execution-baseline.json")
      : paths.target;
    const stage = executionBaseline ? target + "-stage" : paths.stage;
    const stageRelative = base + "/execution-baseline.json-stage";
    const root = join(destination, "checkout"),
      operator = join(destination, "operator"),
      journalPath = join(operator, "weekly-runs.sqlite"),
      catalogPath = join(operator, "ledger.sqlite");
    const location = projectLedgerLocation(root);
    if (location.backend !== "sqlite" || resolve(location.path) !== catalogPath)
      return fail();

    const journal = validateWeeklyJournalRecoverySnapshot(effective.journal);
    const owner = journal.ownership.find((row) => row.scope === production);
    if (!owner || owner.expiresAtEpochMs !== 0) return fail();
    const identities = [journalPath, catalogPath].map((path) => {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        return fail();
      return { path, dev: stat.dev, ino: stat.ino };
    });
    const opened = openPreparedRuntimeForAdmission(runtime);
    if (
      preparedReceiptSha256 !== undefined &&
      opened.receiptSha256 !== preparedReceiptSha256
    )
      return fail();
    const initialEntries = opened.inventoryGmailSelectedLoadExecution();
    const observe = (entries: RecoveryRuntimeEntry[]) => {
      if (!executionBaseline)
        return observeSelectedLoadAdmissionTail(destination, entries, tail);
      const start = observeThirdSelectedLoadStartTail(
        destination,
        entries,
        tail,
        executionBaseline,
        runtime.recoveryKey
      );
      return {
        predecessorEntries: start.beforeStart,
        observed: start.observed,
      };
    };
    const before = observe(initialEntries);
    same(
      executionBaseline ? before.predecessorEntries : initialEntries,
      effective.entries
    );
    const initial = new Map(
      before.predecessorEntries.map((entry) => [entry.path, entry])
    );
    if (initial.size !== before.predecessorEntries.length) return fail();

    const directories = new Set(
      executionBaseline
        ? [directory, stage]
        : [directory, dirname(stage), stage]
    );
    const transients = new Map<string, Buffer>();
    if (before.observed.candidate)
      transients.set(before.observed.candidate.path, bytes);
    const evidenceSha256 = sha256(bytes);
    const startedAt = Date.now();
    scope = {
      active: true,
      phase: "evidence",
      evidenceGuard: true,
      fixedEvidence: { target, stage, bytes },
      deadline: startedAt + 180000,
      startedAt,
      root,
      operator,
      directory,
      key: Buffer.from(runtime.recoveryKey),
      source: effective.proof.source,
      run: effective.proof.runState,
      initialRun: effective.proof.initialState,
      raw: effective.raw,
      plan: effective.plan,
      original: effective.catalog.ledger,
      ledger: effective.catalog.ledger,
      generation: effective.catalog.generation,
      owner: owner.owner,
      fence: owner.fence,
      journal,
      files: new Map([[target, bytes]]),
      directories,
      transients,
      readonlyFiles: new Map(),
      previousFiles: new Map(),
      keyStage: join(directory, "key-stage"),
      originalEntries: initial,
      assertCurrent: () => {
        for (const identity of identities) {
          const stat = lstatSync(identity.path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.dev !== identity.dev ||
            stat.ino !== identity.ino
          )
            fail();
        }
        const entries = opened.inventoryGmailSelectedLoadExecution();
        const predecessor: RecoveryRuntimeEntry[] = [];
        for (const entry of entries) {
          const path = join(destination, entry.path);
          const withinEvidence = executionBaseline
            ? path === target ||
              path === stage ||
              entry.path.startsWith(stageRelative + "/")
            : path === directory || entry.path.startsWith(tailPrefix);
          if (!withinEvidence) predecessor.push(entry);
          else if (entry.kind === "directory" && directories.has(path))
            continue;
          else if (
            entry.kind !== "file" ||
            (path !== target && !transients.has(path)) ||
            (!(
              entry.size === bytes.length && entry.sha256 === evidenceSha256
            ) &&
              !(entry.size === 0 && writing && transients.has(path)))
          )
            fail();
        }
        same(predecessor, before.predecessorEntries);
      },
    };
    const tailPrefix = "recovery-gmail-load/" + tail.runId + "/";
    let writing = false;
    await scopes.run(scope, async () => {
      const guard = new DatabaseSync(journalPath, { timeout: 10000 });
      try {
        guard.exec("BEGIN IMMEDIATE");
        if (
          !readWeeklyJournalRecoverySnapshotInTransaction(guard).equals(
            effective.journal
          )
        )
          fail();
        await withCanonicalStoreTransaction(
          catalogPath,
          effective.catalog,
          async () => {
            // Both transactions already prove the exact admitted SQL state.
            // Use a fresh full enumeration instead of opening another catalog transaction.
            const entries = opened.inventoryGmailSelectedLoadExecution();
            same(entries, initialEntries);
            const locked = observe(entries);
            same(locked.observed, before.observed);
            scope!.assertCurrent();
            writing = true;
            try {
              if (!executionBaseline && !existsSync(directory))
                secureOperatorDirectory(directory);
              installRecoveryIntent(target, bytes, stage);
            } finally {
              writing = false;
            }
            scope!.assertCurrent();
            const settled = observe(
              opened.inventoryGmailSelectedLoadExecution()
            );
            if (!settled.observed.target || settled.observed.candidate) fail();
          }
        );
        if (
          !readWeeklyJournalRecoverySnapshotInTransaction(guard).equals(
            effective.journal
          )
        )
          fail();
        guard.exec("COMMIT");
      } catch (error) {
        if (guard.isTransaction) guard.exec("ROLLBACK");
        throw error;
      } finally {
        guard.close();
      }
    });
  } finally {
    if (scope) {
      scope.active = false;
      scope.key.fill(0);
    }
  }
}

/** Install only the next signed admission behind both prepared-host writer guards. */
export async function installRecoveredGmailNextSelectedLoadAdmission(
  supplied: RecoveryGmailSelectedLoadInstallationInput,
  next: RecoveryGmailSelectedReceiptSelector,
  signedAdmission: Buffer
) {
  assertNoSelectedGmailLoadExecution();
  assertNoSelectedLoadInstallation();
  assertNoRecoveredGmailCapture();
  if (!Buffer.isBuffer(signedAdmission) || signedAdmission.length > 65536)
    return fail();

  const bytes = Buffer.from(signedAdmission);
  const wire = encodeRecoveryGmailSelectedLoadFrame(supplied);
  const input = decodeRecoveryGmailSelectedLoadFrame(wire);
  const { selector: _selector, ...runtime } = input;
  try {
    assertRetainedSelectedLoadExecutor(runtime.destination);
    const { record, tail, effective } =
      readNextSelectedLoadAdmissionForInstallation(input, next, bytes);
    await installSelectedLoadFixedEvidenceWithGuards(runtime, tail, effective);
    return {
      status: "next-load-admission-installed" as const,
      runId: record.runId,
      admissionSha256: sha256(bytes),
      priorLoadFamilySha256: record.priorLoadFamilySha256,
      loadAllowed: false as const,
      captureAllowed: false as const,
      activationAllowed: false as const,
    };
  } finally {
    input.recoveryKey.fill(0);
    wire.fill(0);
  }
}

/** Install only the exact third admission. This grants no execution scope. */
export async function installRecoveredGmailThirdSelectedLoadAdmission(
  supplied: RecoveryGmailThirdSelectedLoadFrameInput
) {
  assertNoSelectedGmailLoadExecution();
  assertNoSelectedLoadInstallation();
  assertNoRecoveredGmailCapture();
  const wire = encodeRecoveryGmailThirdSelectedLoadFrame(supplied);
  let input: RecoveryGmailThirdSelectedLoadFrameInput | undefined;
  try {
    input = decodeRecoveryGmailThirdSelectedLoadFrame(wire);
    const { selector: _selector, ...runtime } = input.family.prior;
    assertRetainedSelectedLoadExecutor(runtime.destination);
    const { record, tail, effective } =
      readThirdSelectedLoadAdmissionForInstallation(
        input.family,
        input.third,
        input.admission
      );
    await installSelectedLoadFixedEvidenceWithGuards(
      runtime,
      tail,
      effective,
      record.preparedReceiptSha256
    );
    return {
      status: "third-load-admission-installed" as const,
      runId: record.runId,
      admissionSha256: sha256(tail.bytes),
      completedPrefixSha256: record.completedPrefixSha256,
      loadAllowed: false as const,
      captureAllowed: false as const,
      activationAllowed: false as const,
      freezeAllowed: false as const,
    };
  } finally {
    input?.family.prior.recoveryKey.fill(0);
    input?.family.admission.fill(0);
    input?.admission.fill(0);
    wire.fill(0);
  }
}

/** Install authenticated start evidence only. Catalog, journal and hold stay pinned. */
export async function installRecoveredGmailThirdSelectedLoadStart(
  supplied: RecoveryGmailThirdSelectedLoadStartFrameInput
) {
  assertNoSelectedGmailLoadExecution();
  assertNoSelectedLoadInstallation();
  assertNoRecoveredGmailCapture();
  const wire = encodeThirdSelectedLoadStartFrame(supplied);
  let decoded: RecoveryGmailThirdSelectedLoadStartFrameInput | undefined;
  try {
    decoded = decodeThirdSelectedLoadStartFrame(wire);
    const { input, executionBaseline } = decoded;
    const { selector: _selector, ...runtime } = input.family.prior;
    assertRetainedSelectedLoadExecutor(runtime.destination);
    const { baseline, tail, effective } =
      readThirdSelectedLoadStartForInstallation(input, executionBaseline);
    await installSelectedLoadFixedEvidenceWithGuards(
      runtime,
      tail,
      effective,
      baseline.preparedReceiptSha256,
      executionBaseline
    );
    return {
      status: "third-load-start-installed" as const,
      runId: baseline.runId,
      executionBaselineSha256: sha256(executionBaseline),
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
      freezeAllowed: false as const,
    };
  } finally {
    decoded?.input.family.prior.recoveryKey.fill(0);
    decoded?.input.family.admission.fill(0);
    decoded?.input.admission.fill(0);
    decoded?.executionBaseline.fill(0);
    wire.fill(0);
  }
}

async function settleSelectedLoadCompletion(
  runtime: Omit<RecoveryGmailSelectedLoadInstallationInput, "selector">,
  evidence: Pick<
    SelectedLoadInterruptionEvidence,
    "observedCatalog" | "observedJournal" | "physicalEntries" | "raw"
  > & {
    report: Pick<SelectedLoadInterruptionEvidence["report"], "lease">;
    completionPending?: Omit<
      NonNullable<SelectedLoadInterruptionEvidence["completionPending"]>,
      "intent"
    > & {
      intent:
        | ReturnType<typeof observeSelectedLoadCompletionIntentFile>
        | (Omit<
            ReturnType<typeof observeSelectedLoadCompletionIntentFile>,
            "state" | "candidate"
          > & { state: "absent"; candidate?: undefined });
    };
  },
  proof: Baseline,
  plan: SelectedGmailLoadEffectPlan,
  original: IngestionLedger
) {
  const completion = evidence.completionPending;
  if (!completion || evidence.report.lease.status === "active") fail();
  const destination = resolve(runtime.destination);
  const root = join(destination, "checkout");
  const operator = join(destination, "operator");
  const directory = join(
    destination,
    "recovery-gmail-load",
    proof.runState.runId
  );
  const location = projectLedgerLocation(root);
  if (
    location.backend !== "sqlite" ||
    resolve(location.path) !== join(operator, "ledger.sqlite")
  )
    fail();
  const opened = openPreparedRuntimeForAdmission(runtime);
  const initial = new Map(
    evidence.physicalEntries.map((entry) => [entry.path, entry])
  );
  if (initial.size !== evidence.physicalEntries.length) fail();
  const journal = validateWeeklyJournalRecoverySnapshot(
    evidence.observedJournal
  );
  const owner = journal.ownership.find((row) => row.scope === production);
  if (!owner || owner.expiresAtEpochMs > Date.now()) fail();
  const expectedIntent = signSelectedLoadCompletionIntent(
    completion.intent.fields,
    runtime.recoveryKey
  );
  if (sha256(expectedIntent) !== completion.intent.intentSha256) fail();
  const batch = [
    { name: selectedLoadCompletionIntentFilename, bytes: expectedIntent },
    ...completion.plan.files,
    { name: "load-result.json", bytes: completion.plan.result },
  ];
  const files = new Map(
    batch.map(({ name, bytes }) => [join(directory, name), bytes])
  );
  if (files.size !== batch.length) fail();
  const directories = new Set([
    directory,
    dirname(directory),
    ...[...files.keys()].map((path) => path + "-stage"),
  ]);
  const identities = ["ledger.sqlite", "weekly-runs.sqlite"].map((name) => {
    const path = join(operator, name),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail();
    return { path, dev: stat.dev, ino: stat.ino };
  });
  const removable = new Set<string>();
  const transients = new Map<string, Buffer>();
  const scope: Scope = {
    active: true,
    phase: "evidence",
    evidenceGuard: true,
    completionRepair: true,
    deadline: Date.now() + 180000,
    startedAt: Date.now(),
    root,
    operator,
    directory,
    key: Buffer.from(runtime.recoveryKey),
    source: proof.source,
    run: proof.runState,
    initialRun: proof.initialState,
    raw: evidence.raw,
    plan,
    original,
    ledger: evidence.observedCatalog.ledger,
    generation: evidence.observedCatalog.generation,
    owner: owner.owner,
    fence: owner.fence,
    journal,
    files,
    directories,
    transients,
    historyTargets: new Set(files.keys()),
    readonlyFiles: new Map(),
    previousFiles: new Map(),
    keyStage: join(directory, "key-stage"),
    originalEntries: initial,
    assertCurrent: () => {
      for (const identity of identities) {
        const stat = lstatSync(identity.path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.dev !== identity.dev ||
          stat.ino !== identity.ino
        )
          fail();
      }
      const entries = opened.inventoryGmailSelectedLoadExecution();
      const seen = new Set<string>();
      const matches = (entry: RecoveryRuntimeEntry, expected: Buffer) =>
        entry.kind === "file" &&
        entry.size === expected.length &&
        entry.sha256 === sha256(expected);
      for (const entry of entries) {
        seen.add(entry.path);
        const path = join(destination, entry.path);
        const before = initial.get(entry.path);
        if (before && canonicalJson(before) === canonicalJson(entry)) continue;
        const planned = files.get(path);
        const temporary = transients.get(path);
        if (
          (entry.kind === "directory" && directories.has(path)) ||
          (planned && matches(entry, planned)) ||
          (temporary &&
            (matches(entry, temporary) ||
              (entry.kind === "file" && entry.size === 0)))
        )
          continue;
        fail();
      }
      for (const entry of initial.keys())
        if (!seen.has(entry) && !removable.has(join(destination, entry)))
          fail();
    },
  };
  try {
    await scopes.run(scope, async () => {
      scope.assertCurrent();
      const journalGuard = new DatabaseSync(
        join(operator, "weekly-runs.sqlite"),
        { timeout: 10000 }
      );
      try {
        journalGuard.exec("BEGIN IMMEDIATE");
        if (
          !readWeeklyJournalRecoverySnapshotInTransaction(journalGuard).equals(
            evidence.observedJournal
          ) ||
          owner.expiresAtEpochMs > Date.now()
        )
          fail();
        await withCanonicalStoreTransaction(
          location.path,
          evidence.observedCatalog,
          async () => {
            const entries = opened.inventoryGmailSelectedLoadExecution();
            same(entries, evidence.physicalEntries);
            const intent =
              completion.intent.state === "absent"
                ? completion.intent
                : observeSelectedLoadCompletionIntentFile({
                    destination,
                    entries,
                    identity: completion.intent.fields.identity,
                    key: scope.key,
                    ...(completion.intent.state === "stage-only" ||
                    completion.intent.state === "partial"
                      ? { expectedBytes: expectedIntent }
                      : {}),
                  });
            const prefix = observeSelectedLoadCompletionPrefix({
              destination,
              entries,
              runId: proof.runState.runId,
              files: completion.plan.files,
              result: completion.plan.result,
            });
            same(intent, completion.intent);
            same(prefix, completion.prefix);
            const retainCandidate = (
              candidate: typeof intent.candidate,
              bytes: Buffer
            ) => {
              if (!candidate) return;
              transients.set(candidate.path, bytes);
              removable.add(candidate.path);
            };
            retainCandidate(intent.candidate, expectedIntent);
            const next = prefix.next;
            if (!next) fail();
            const nextBytes = files.get(join(directory, next.name));
            if (!nextBytes) fail();
            retainCandidate(next.candidate, nextBytes);
            scope.phase = "result";
            try {
              const finishPartial = (
                incomplete: typeof next.candidate,
                expected: Buffer
              ) => {
                if (
                  !incomplete ||
                  !expected
                    .subarray(0, incomplete.bytes.length)
                    .equals(incomplete.bytes)
                )
                  fail();
                scope.incompleteSnapshot = incomplete;
                selectedGmailLoadFile(
                  incomplete.path,
                  incomplete.bytes,
                  "install"
                );
                completeRetainedPrefixFile(incomplete, expected);
                scope.incompleteSnapshot = undefined;
                scope.assertCurrent();
              };
              if (intent.state === "partial")
                finishPartial(intent.candidate, expectedIntent);
              if (next.state === "partial")
                finishPartial(next.candidate, nextBytes);
              for (const { name, bytes } of batch) {
                const path = join(directory, name);
                installRecoveryIntent(path, bytes, path + "-stage");
              }
              scope.assertCurrent();
              const after = opened.inventoryGmailSelectedLoadExecution();
              if (
                observeSelectedLoadCompletionIntentFile({
                  destination,
                  entries: after,
                  identity: intent.fields.identity,
                  key: scope.key,
                }).state !== "settled" ||
                observeSelectedLoadCompletionPrefix({
                  destination,
                  entries: after,
                  runId: proof.runState.runId,
                  files: completion.plan.files,
                  result: completion.plan.result,
                }).next
              )
                fail();
            } finally {
              scope.phase = "evidence";
            }
          }
        );
        if (
          !readWeeklyJournalRecoverySnapshotInTransaction(journalGuard).equals(
            evidence.observedJournal
          )
        )
          fail();
        journalGuard.exec("COMMIT");
      } catch (error) {
        if (journalGuard.isTransaction) journalGuard.exec("ROLLBACK");
        throw error;
      } finally {
        journalGuard.close();
      }
    });
  } finally {
    scope.active = false;
    scope.key.fill(0);
  }
}

async function resumeSelectedLoadAttempt(
  supplied: RecoveryGmailSelectedLoadInstallationInput,
  chunkPauseTest:
    | "linked"
    | "partial"
    | "intent-linked"
    | "lease-acquired"
    | "successor-linked"
    | "successor-flushed"
    | "rollback-catalog-committed"
    | undefined
) {
  assertNoSelectedGmailLoadExecution();
  assertNoRecoveredGmailCapture();
  const wire = encodeRecoveryGmailSelectedLoadFrame(supplied),
    input = decodeRecoveryGmailSelectedLoadFrame(wire);
  const { selector: _selector, ...runtime } = input;
  let scope: Scope | undefined;
  try {
    assertRetainedSelectedLoadExecutor(runtime.destination);
    const evidence = readSelectedLoadInterruptionEvidence(input);
    if (
      ![
        "committed",
        "completed",
        "pending-intent",
        "unchanged",
        "completion-pending",
      ].includes(evidence.report.status)
    )
      throw Error("RECOVERY_GMAIL_SELECTED_LOAD_NOT_COMMITTED");
    if (evidence.report.lease.status === "active")
      throw Error("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
    const original = {
      ...evidence.originalBaseline,
      recoveryKey: input.recoveryKey,
    };
    const proof = proveRecoveryGmailSelectedLoadBaseline(original);
    const started = verifySelectedLoadExecutionBaseline(
      evidence.executionBaseline,
      input.recoveryKey
    );
    const plan = createSelectedGmailLoadEffectPlan(
      original.checkpoint,
      proof,
      evidence.raw
    );
    if (evidence.report.status === "completion-pending") {
      await settleSelectedLoadCompletion(
        runtime,
        evidence,
        proof,
        plan,
        original.checkpoint.ledger
      );
      return { settled: true as const };
    }
    if (evidence.report.status === "completed") {
      if (!evidence.completedResultSha256) fail();
      return {
        status: "selected-load-resumed" as const,
        activationAllowed: false as const,
        captureAllowed: false as const,
        loadAllowed: false as const,
        runId: proof.runState.runId,
        ledgerRevision: ledgerDigest(evidence.observedCatalog.ledger),
        generation: evidence.observedCatalog.generation,
        resultSha256: evidence.completedResultSha256,
        admissionSha256: evidence.admissionSha256,
        accepted: plan.result.report.acceptedEventIds.length,
      };
    }
    const pending = evidence.report.status === "pending-intent";
    if (
      pending &&
      (!evidence.pendingIntent?.settled ||
        (!evidence.pendingSuccessors?.lastSettled &&
          !evidence.pendingSuccessors?.unsettled) ||
        (evidence.pendingSuccessors.successorCount > 0 &&
          !evidence.pendingSuccessors.latestV2Successor))
    )
      throw Error("RECOVERY_GMAIL_SELECTED_LOAD_NOT_COMMITTED");
    if (
      pending &&
      Date.now() < evidence.pendingSuccessors!.effectiveDeadlineEpochMs
    )
      throw Error("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
    const precommitRollback =
      evidence.observedCatalog.generation === 1 &&
      canonicalJson(evidence.observedCatalog.ledger) ===
        canonicalJson(original.checkpoint.ledger);
    if (evidence.report.status === "unchanged" && !precommitRollback) fail();
    if (precommitRollback) {
      const journal = validateWeeklyJournalRecoverySnapshot(
        evidence.observedJournal
      );
      const row = journal.runState.find(
        (item) => item.id === proof.runState.runId
      );
      if (!row) fail();
      const state = parseWeeklyRunState(JSON.parse(row.payload));
      if (
        state.stages
          .slice(0, 3)
          .some((stage) => stage.status !== "succeeded") ||
        state.stages[3]?.stage !== "load" ||
        state.stages[3].status !== "running" ||
        journal.stageArtifacts.some(
          (item) => item.runId === state.runId && item.stage === "load"
        )
      )
        fail();
      const originalEntries = new Map(
        started.entries.map((entry) => [entry.path, entry])
      );
      const currentEntries = new Map(
        evidence.observedEntries.map((entry) => [entry.path, entry])
      );
      if (
        evidence.changedFiles.snapshot &&
        canonicalJson(
          decryptLedgerSnapshot(
            evidence.changedFiles.snapshot,
            input.recoveryKey
          )
        ) !== canonicalJson(original.checkpoint.ledger)
      )
        fail();
      const report =
        "checkout/data/ingestion/reports/" +
        sha256(plan.result.report.runId) +
        ".json";
      if (originalEntries.has(report)) fail();
      const observedReport = currentEntries.get(report);
      const expectedReport = Buffer.from(
        JSON.stringify(plan.result.report, null, 2) + "\n"
      );
      if (
        observedReport &&
        (observedReport.kind !== "file" ||
          observedReport.size !== expectedReport.length ||
          observedReport.sha256 !== sha256(expectedReport))
      )
        fail();
    }
    const settlingEvidence =
      pending && !evidence.pendingSuccessors!.lastSettled
        ? evidence.pendingSuccessors!.unsettled
        : undefined;
    if (
      settlingEvidence &&
      (!evidence.pendingSuccessors!.latestV2Successor ||
        sha256(evidence.observedJournal) !==
          evidence.pendingSuccessors!.latestV2Successor.journalSha256)
    )
      fail();
    const savedJournal = validateWeeklyJournalRecoverySnapshot(
      evidence.observedJournal
    );
    const previousOwner = savedJournal.ownership.find(
      (row) => row.scope === production
    );
    const row = savedJournal.runState.find(
      (item) => item.id === proof.runState.runId
    );
    if (
      !previousOwner ||
      !row ||
      previousOwner.expiresAtEpochMs > Date.now() ||
      parseWeeklyRunState(JSON.parse(row.payload)).stages.find(
        (item) => item.stage === "load"
      )?.status !== "running"
    )
      fail();
    const root = join(resolve(runtime.destination), "checkout"),
      operator = join(resolve(runtime.destination), "operator"),
      directory = join(
        resolve(runtime.destination),
        "recovery-gmail-load",
        proof.runState.runId
      );
    const location = projectLedgerLocation(root);
    if (
      location.backend !== "sqlite" ||
      resolve(location.path) !== join(operator, "ledger.sqlite")
    )
      fail();
    const opened = openPreparedRuntimeForAdmission(runtime),
      now = Date.now(),
      ownerHash = sha256("selected-load/" + evidence.admissionSha256),
      owner = [
        ownerHash.slice(0, 8),
        ownerHash.slice(8, 12),
        ownerHash.slice(12, 16),
        ownerHash.slice(16, 20),
        ownerHash.slice(20, 32),
      ].join("-");
    const fence = previousOwner.fence + 1,
      deadline = now + 180000;
    if (!Number.isSafeInteger(fence) || !Number.isSafeInteger(deadline)) fail();
    const snapshotEvidence = evidence.changedFiles.snapshot
      ? describeResumeSnapshot(evidence.changedFiles.snapshot)
      : null;
    const initialIntent = signed(
      {
        kind: "zivv-selected-load-resume-intent",
        version: precommitRollback ? 3 : 2,
        snapshotEvidence,
        admissionSha256: evidence.admissionSha256,
        executionBaselineSha256: sha256(evidence.executionBaseline),
        journalSha256: sha256(evidence.observedJournal),
        inventorySha256: evidence.report.inventorySha256,
        ledgerRevision: ledgerDigest(evidence.observedCatalog.ledger),
        generation: evidence.observedCatalog.generation,
        previousOwner,
        fence,
        owner,
        startedAtEpochMs: now,
        deadlineEpochMs: deadline,
      },
      input.recoveryKey,
      "zivv-selected-load-resume-intent/v1"
    );
    const readSuccessorInputs = () =>
      pending
        ? Array.from(
            { length: evidence.pendingSuccessors!.successorCount },
            (_, index) =>
              readFileSync(
                join(
                  directory,
                  `resume-successor-${String(index + 1).padStart(5, "0")}.json`
                )
              )
          )
        : [];
    const successorInputs = settlingEvidence ? [] : readSuccessorInputs();
    const successor =
      pending && !settlingEvidence
        ? prepareSelectedLoadIntentSuccessor({
            initial: evidence.pendingIntent!.intentBytes,
            successors: successorInputs,
            observedJournal: evidence.observedJournal,
            key: input.recoveryKey,
            nowEpochMs: now,
          })
        : undefined;
    const successorPath = successor
      ? join(
          directory,
          `resume-successor-${String(successor.sequence).padStart(5, "0")}.json`
        )
      : undefined;
    const settling = settlingEvidence
      ? {
          target: join(runtime.destination, settlingEvidence.target),
          stage: join(runtime.destination, settlingEvidence.stage),
          candidate: join(runtime.destination, settlingEvidence.candidate),
          bytes: Buffer.from(settlingEvidence.bytes),
          dev: settlingEvidence.dev,
          ino: settlingEvidence.ino,
          targetWasPresent: settlingEvidence.targetWasPresent,
          started: false,
        }
      : undefined;
    if (
      settling &&
      (dirname(settling.target) !== directory ||
        settling.stage !== settling.target + "-stage" ||
        dirname(settling.candidate) !== settling.stage)
    )
      fail();
    const intent = initialIntent;
    const baselineEntries = pending
      ? evidence.physicalEntries
      : evidence.observedEntries;
    const files = new Map<string, Buffer>(),
      readonlyFiles = new Map<string, Buffer>();
    const identities = ["ledger.sqlite", "weekly-runs.sqlite"].map((name) => {
      const path = join(operator, name),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail();
      return { path, dev: stat.dev, ino: stat.ino };
    });
    for (const entry of baselineEntries)
      if (
        entry.kind === "file" &&
        entry.path.startsWith("recovery-gmail-load/")
      ) {
        const path = join(runtime.destination, entry.path),
          bytes = readFileSync(path);
        if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
          fail();
        if (
          !settling ||
          (path !== settling.target && path !== settling.candidate)
        )
          readonlyFiles.set(path, bytes);
      }
    const keyPath = join(operator, keyName),
      snapshotPath = join(root, "data/ingestion/backups/ledger.snapshot.enc"),
      reportPath = join(
        root,
        "data/ingestion/reports",
        sha256(plan.result.report.runId) + ".json"
      ),
      intentPath = join(directory, "resume-intent.json");
    if (evidence.changedFiles.key)
      files.set(keyPath, evidence.changedFiles.key);
    if (evidence.changedFiles.snapshot)
      files.set(snapshotPath, evidence.changedFiles.snapshot);
    if (evidence.changedFiles.report)
      files.set(reportPath, evidence.changedFiles.report);
    else if (precommitRollback)
      files.set(
        reportPath,
        Buffer.from(JSON.stringify(plan.result.report, null, 2) + "\n")
      );
    if (settling) files.set(settling.target, settling.bytes);
    else if (successor && successorPath)
      files.set(successorPath, successor.bytes);
    else files.set(intentPath, intent);
    const snapshotChunks =
      (pending ? undefined : snapshotEvidence)?.chunks.map(({ index }) => {
        const name = `resume-snapshot-${String(index).padStart(3, "0")}.bin`;
        const path = join(directory, name);
        const bytes = Buffer.from(
          evidence.changedFiles.snapshot!.subarray(
            index * resumeSnapshotChunkSize,
            (index + 1) * resumeSnapshotChunkSize
          )
        );
        files.set(path, bytes);
        return { name, path, bytes };
      }) ?? [];
    const dirs = new Set([
      operator,
      directory,
      dirname(directory),
      join(directory, "key-stage"),
      join(directory, "resume-intent.json-stage"),
      join(directory, "load-result.json-stage"),
      join(root, "data/ingestion/backups"),
      join(root, "data/ingestion/reports"),
    ]);
    for (const chunk of snapshotChunks)
      dirs.add(join(directory, chunk.name + "-stage"));
    if (successorPath) dirs.add(successorPath + "-stage");
    if (settling) dirs.add(settling.stage);
    const originalEntries = new Map(
      baselineEntries.map((entry) => [entry.path, entry])
    );
    const stagedTransients = new Map<string, Buffer>();
    for (const stagedPath of evidence.stagedSnapshotPaths) {
      const absolute = join(runtime.destination, stagedPath);
      const target = selectedLoadTemporaryTarget(absolute, {
        operator,
        directory,
        keyName,
        report: reportPath,
        snapshot: snapshotPath,
      });
      if (target) {
        const bytes = files.get(target);
        if (!bytes) fail();
        stagedTransients.set(absolute, Buffer.from(bytes));
      }
    }
    if (settling) stagedTransients.set(settling.candidate, settling.bytes);
    scope = {
      active: true,
      chunkPauseTest,
      ...(settling ? { successor: { path: settling.target } } : {}),
      ...(successor && successorPath
        ? { successor: { path: successorPath } }
        : {}),
      ...(evidence.incompleteSnapshotCandidate
        ? {
            incompleteSnapshot: {
              ...evidence.incompleteSnapshotCandidate,
              path: join(
                runtime.destination,
                evidence.incompleteSnapshotCandidate.path
              ),
              bytes: Buffer.from(evidence.incompleteSnapshotCandidate.bytes),
            },
          }
        : {}),
      deadline,
      startedAt: started.startedAtEpochMs,
      root,
      operator,
      directory,
      key: Buffer.from(input.recoveryKey),
      phase: "evidence",
      source: proof.source,
      run: proof.runState,
      initialRun: proof.initialState,
      raw: Buffer.from(evidence.raw),
      plan,
      original: structuredClone(original.checkpoint.ledger),
      ledger: structuredClone(evidence.observedCatalog.ledger),
      generation: evidence.observedCatalog.generation,
      owner,
      fence,
      journal: validateWeeklyJournalRecoverySnapshot(
        Buffer.from(original.current.journal, "base64")
      ),
      files,
      directories: dirs,
      transients: stagedTransients,
      readonlyFiles,
      previousFiles: new Map(),
      keyStage: join(directory, "key-stage"),
      originalEntries,
      resume: {
        observedJournal: savedJournal,
        previousOwner,
        gateComplete: false,
        precommitRollback,
      },
      assertCurrent: () => {
        if (settling) {
          const candidate = existsSync(settling.candidate)
            ? lstatSync(settling.candidate)
            : undefined;
          const target = existsSync(settling.target)
            ? lstatSync(settling.target)
            : undefined;
          assertSelectedLoadSettlementTransition({
            candidate,
            target,
            dev: settling.dev,
            ino: settling.ino,
            targetWasPresent: settling.targetWasPresent,
            started: settling.started,
          });
        }
        for (const identity of identities) {
          const stat = lstatSync(identity.path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.dev !== identity.dev ||
            stat.ino !== identity.ino
          )
            fail();
        }
        const actual = opened.inventoryGmailSelectedLoadExecution();
        for (const entry of actual) {
          const absolute = join(runtime.destination, entry.path),
            before = originalEntries.get(entry.path),
            expected = scope!.files.get(absolute);
          if (
            before &&
            canonicalJson(before) === canonicalJson(entry) &&
            (!expected ||
              (entry.kind === "file" &&
                entry.size === expected.length &&
                entry.sha256 === sha256(expected)))
          )
            continue;
          if (entry.kind === "directory" && dirs.has(absolute) && !before)
            continue;
          if (entry.kind === "file") {
            const incomplete = scope!.incompleteSnapshot;
            if (
              incomplete &&
              absolute === incomplete.path &&
              entry.size === incomplete.bytes.length &&
              entry.sha256 === sha256(incomplete.bytes)
            ) {
              const stat = lstatSync(absolute);
              if (
                !stat.isFile() ||
                stat.isSymbolicLink() ||
                stat.nlink !== 1 ||
                stat.dev !== incomplete.dev ||
                stat.ino !== incomplete.ino
              )
                fail();
              continue;
            }
            const previous = scope!.previousFiles.get(absolute);
            if (
              previous &&
              entry.size === previous.length &&
              entry.sha256 === sha256(previous)
            )
              continue;
            if (
              expected &&
              entry.size === expected.length &&
              entry.sha256 === sha256(expected)
            )
              continue;
            const temporary = scope!.transients.get(absolute);
            if (
              temporary &&
              (entry.size === 0 ||
                (entry.size === temporary.length &&
                  entry.sha256 === sha256(temporary)))
            )
              continue;
          }
          fail();
        }
        for (const entry of baselineEntries)
          if (!actual.some((item) => item.path === entry.path)) {
            if (
              !settling ||
              join(runtime.destination, entry.path) !== settling.candidate
            )
              fail();
            const target = lstatSync(settling.target);
            if (
              !target.isFile() ||
              target.isSymbolicLink() ||
              target.dev !== settling.dev ||
              target.ino !== settling.ino ||
              target.nlink !== 1 ||
              !readFileSync(settling.target).equals(settling.bytes)
            )
              fail();
          }
      },
    };
    scope.assertCurrent();
    const outcome = await scopes.run(scope, async () => {
      // Serialize every evidence installer through the actual journal writer
      // lock, then pin the catalog under its own writer transaction.
      const journalGuard = new DatabaseSync(
        join(operator, "weekly-runs.sqlite"),
        { timeout: 10000 }
      );
      try {
        journalGuard.exec("BEGIN IMMEDIATE");
        const guardedJournal =
          readWeeklyJournalRecoverySnapshotInTransaction(journalGuard);
        if (
          !guardedJournal.equals(evidence.observedJournal) ||
          previousOwner.expiresAtEpochMs > Date.now()
        )
          fail();
        scope!.evidenceGuard = true;
        try {
          await withCanonicalStoreTransaction(
            location.path,
            { generation: scope!.generation, ledger: scope!.ledger },
            async () => {
              scope!.assertCurrent();
              const incomplete = scope!.incompleteSnapshot;
              if (incomplete) {
                selectedGmailLoadFile(
                  incomplete.path,
                  incomplete.bytes,
                  "install"
                );
                const full = scope!.transients.get(incomplete.path);
                if (
                  !full ||
                  full.length <= incomplete.bytes.length ||
                  !full
                    .subarray(0, incomplete.bytes.length)
                    .equals(incomplete.bytes)
                )
                  fail();
                completeRetainedPrefixFile(incomplete, full);
                scope!.incompleteSnapshot = undefined;
                scope!.assertCurrent();
              }
              for (const chunk of snapshotChunks)
                installRecoveryIntent(
                  chunk.path,
                  chunk.bytes,
                  join(directory, chunk.name + "-stage")
                );
              if (settling) {
                const current = inspectRecoveryInstalledFile(
                  settling.target,
                  settling.stage,
                  65536
                );
                if (
                  !current.candidate ||
                  !!current.target !== settling.targetWasPresent ||
                  current.candidate.path !== settling.candidate ||
                  current.candidate.dev !== settling.dev ||
                  current.candidate.ino !== settling.ino ||
                  !current.candidate.bytes.equals(settling.bytes) ||
                  (current.target &&
                    (!current.target.bytes.equals(settling.bytes) ||
                      current.target.dev !== settling.dev ||
                      current.target.ino !== settling.ino))
                )
                  fail();
                settling.started = true;
                installRecoveryIntent(
                  settling.target,
                  settling.bytes,
                  settling.stage
                );
              } else if (successor && successorPath) {
                const guardedSuccessor = prepareSelectedLoadIntentSuccessor({
                  initial: evidence.pendingIntent!.intentBytes,
                  successors: readSuccessorInputs(),
                  observedJournal: guardedJournal,
                  key: input.recoveryKey,
                  nowEpochMs: now,
                });
                if (!guardedSuccessor.bytes.equals(successor.bytes)) fail();
                installRecoveryIntent(
                  successorPath,
                  successor.bytes,
                  successorPath + "-stage"
                );
              } else {
                installRecoveryIntent(
                  intentPath,
                  intent,
                  join(directory, "resume-intent.json-stage")
                );
              }
              scope!.assertCurrent();
            }
          );
        } finally {
          scope!.evidenceGuard = false;
        }
        if (
          !readWeeklyJournalRecoverySnapshotInTransaction(journalGuard).equals(
            evidence.observedJournal
          )
        )
          fail();
        journalGuard.exec("COMMIT");
      } catch (error) {
        if (journalGuard.isTransaction) journalGuard.exec("ROLLBACK");
        throw error;
      } finally {
        journalGuard.close();
      }
      if (settling) return { settled: true as const };
      scope!.phase = "run";
      let result: Buffer | undefined, expectedReleased: Buffer | undefined;
      scope!.finish = async (state, snapshot) => {
        const sealed = await installSelectedLoadCompletion(
          scope!,
          state,
          snapshot,
          {
            admissionSha256: evidence.admissionSha256,
            executionBaselineSha256: sha256(evidence.executionBaseline),
            ...(successor
              ? { successorSha256: successor.successorSha256 }
              : {}),
          },
          opened.inventoryGmailSelectedLoadExecution
        );
        result = sealed.result;
        expectedReleased = sealed.releasedJournal;
      };
      const state = await runWeeklyImport({
        root,
        source: {
          editionId: proof.source.editionId,
          deliveryId: proof.source.deliveryId,
          raw: Buffer.from(evidence.raw),
          importObservedAtEpochMs: proof.source.importObservedAtEpochMs,
        },
        stopAfter: "load",
      });
      if (
        !result ||
        !expectedReleased ||
        scope!.finish !== undefined ||
        !scope!.resume?.gateComplete
      )
        fail();
      same(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(operator, "weekly-runs.sqlite")
        ).toString("base64"),
        expectedReleased.toString("base64")
      );
      scope!.assertCurrent();
      if (!scope!.assertCompletionFiles) fail();
      scope!.assertCompletionFiles();
      return {
        status: "selected-load-resumed" as const,
        activationAllowed: false as const,
        captureAllowed: false as const,
        loadAllowed: false as const,
        runId: state.runId,
        ledgerRevision: ledgerDigest(scope!.ledger),
        generation: scope!.generation,
        resultSha256: sha256(result),
        admissionSha256: evidence.admissionSha256,
        accepted: plan.result.report.acceptedEventIds.length,
      };
    });
    return outcome;
  } finally {
    if (scope) {
      scope.active = false;
      scope.key.fill(0);
    }
    input.recoveryKey.fill(0);
    wire.fill(0);
  }
}

/** Reinspect exactly once after the guarded evidence-only settlement scope closes. */
async function resumeSelectedLoad(
  supplied: RecoveryGmailSelectedLoadInstallationInput,
  chunkPauseTest:
    | "linked"
    | "partial"
    | "intent-linked"
    | "lease-acquired"
    | "successor-linked"
    | "successor-flushed"
    | "rollback-catalog-committed"
    | undefined
) {
  const first = await resumeSelectedLoadAttempt(supplied, chunkPauseTest);
  if (!("settled" in first)) return first;
  const second = await resumeSelectedLoadAttempt(supplied, undefined);
  if ("settled" in second) fail();
  return second;
}

/** Normal retry; no test interruption is selected. */
export function resumeRecoveredGmailSelectedLoad(
  input: RecoveryGmailSelectedLoadInstallationInput
) {
  return resumeSelectedLoad(input, undefined);
}
/** Fixed test-only pause during the first chunk write or link; grants no new authority. */
export function resumeRecoveredGmailSelectedLoadForTest(
  input: RecoveryGmailSelectedLoadInstallationInput,
  point:
    | "linked"
    | "partial"
    | "intent-linked"
    | "lease-acquired"
    | "successor-linked"
    | "successor-flushed"
    | "rollback-catalog-committed" = "linked"
) {
  if (
    point !== "linked" &&
    point !== "partial" &&
    point !== "intent-linked" &&
    point !== "lease-acquired" &&
    point !== "successor-linked" &&
    point !== "successor-flushed" &&
    point !== "rollback-catalog-committed"
  )
    fail();
  return resumeSelectedLoad(input, point);
}
