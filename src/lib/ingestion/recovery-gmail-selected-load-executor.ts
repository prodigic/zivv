import {
  describeResumeSnapshot,
  resumeSnapshotChunkSize,
} from "./recovery-gmail-selected-resume-snapshot-evidence.js";
import { readSelectedLoadInterruptionEvidence } from "./recovery-gmail-selected-load-interruption-inspection.js";
import { verifySelectedLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import { signSelectedLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import { selectedLoadTemporaryTarget } from "./recovery-gmail-selected-load-paths.js";
import { createRecoveryGmailSelectedLoadEvidence } from "./recovery-gmail-selected-load-evidence.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { IngestionLedger } from "../../types/ingestion.js";
import {
  canonicalJson,
  ledgerDigest,
  withCanonicalStoreTransaction,
} from "./sqlite-store.js";
import {
  openPreparedRuntimeForAdmission,
  type RecoveryRuntimeEntry,
} from "./recovery-runtime.js";
import {
  readRecoveryGmailHostForLoadInstallation,
  assertNoRecoveredGmailCapture,
  type CaptureJournalEffect,
} from "./recovery-gmail-capture-admission.js";
import {
  inspectInstalledRecoveryGmailSelectedLoadEvidence,
  type RecoveryGmailSelectedLoadInstallationInput,
} from "./recovery-gmail-selected-load-installation.js";
import {
  encodeRecoveryGmailSelectedLoadFrame,
  decodeRecoveryGmailSelectedLoadFrame,
} from "./recovery-gmail-selected-load-framing.js";
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
  installRecoveredBackupKey,
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
  type WeeklyRunLease,
  type WeeklyJournalRecoverySnapshot,
} from "./weekly-run-journal.js";
import { sha256 } from "./steve-preflight.js";

export const recoveryGmailSelectedLoadExecutorVersion = 1;
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
  pauseForLinkedChunkTest?: boolean;
  resume?: {
    observedJournal: WeeklyJournalRecoverySnapshot;
    previousOwner: WeeklyRunLease;
    gateComplete: boolean;
  };
  finish?: (state: WeeklyRunState, snapshot: Buffer) => Promise<void>;
  active: boolean;
  deadline: number;
  startedAt: number;
  root: string;
  operator: string;
  directory: string;
  key: Buffer;
  phase: "evidence" | "key" | "run" | "result";
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
    !["key", "run", "result"].includes(scope.phase) ||
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
    scope.phase !== "run"
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
    scope.phase !== "run"
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
export function hasPendingSelectedLoadResume(): boolean {
  const scope = current();
  return !!scope?.resume && !scope.resume.gateComplete;
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
    const isSnapshotStage =
      scope.phase === "evidence" &&
      !!scope.resume &&
      /^resume-snapshot-[0-9]{3}\.bin-stage$/.test(
        absolute.slice(scope.directory.length + 1)
      ) &&
      dirname(absolute) === scope.directory;
    if (
      !scope.directories.has(absolute) ||
      (!permitted.includes(absolute) && !isSnapshotStage)
    )
      fail();
    return true;
  }
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
    (target === resultFile && scope.phase !== "result") ||
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
export function observeSelectedGmailLoadFile(
  path: string,
  point: "flushed" | "linked" | "published"
): boolean {
  const scope = current();
  if (!scope) return false;
  scope.assertCurrent();
  if (
    scope.pauseForLinkedChunkTest &&
    point === "linked" &&
    resolve(path) === join(scope.directory, "resume-snapshot-000.bin")
  ) {
    process.stdout.write("SELECTED_LOAD_TEST_CHUNK_LINKED\n");
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

function signed(value: unknown, key: Buffer, domain: string) {
  const body = canonicalJson(value),
    signature = createHmac("sha256", key)
      .update(domain + "\0")
      .update(body)
      .digest("hex");
  return Buffer.from(canonicalJson({ ...(value as object), signature }) + "\n");
}
/** First admitted source load only. No caller callback, run or catalog override.
 * Interrupted SQL effects require the separate original-baseline replay composer. */
export async function executeRecoveredGmailSelectedLoad(
  supplied: RecoveryGmailSelectedLoadInstallationInput
) {
  assertNoSelectedGmailLoadExecution();
  assertNoRecoveredGmailCapture();
  const wire = encodeRecoveryGmailSelectedLoadFrame(supplied),
    input = decodeRecoveryGmailSelectedLoadFrame(wire),
    { selector, ...runtime } = input;
  let scope: Scope | undefined;
  try {
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
    const startedAt = Date.now(),
      plan = createSelectedGmailLoadEffectPlan(host.checkpoint, proof, raw);
    const sqlIdentities = ["ledger.sqlite", "weekly-runs.sqlite"].map(
      (name) => {
        const path = join(operator, name),
          stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail();
        return { path, dev: stat.dev, ino: stat.ino };
      }
    );
    const entries = opened.inventoryGmailLoadInstallation();
    if (
      sha256(
        canonicalJson(
          entries.filter(
            (entry) =>
              !/^operator\/weekly-runs\.sqlite(?:-wal|-shm)?$/.test(
                entry.path
              ) &&
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
    const journal = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(host.current.journal, "base64")
    );
    const ownerHash = sha256("selected-load/" + installed.admissionSha256),
      owner = [
        ownerHash.slice(0, 8),
        ownerHash.slice(8, 12),
        ownerHash.slice(12, 16),
        ownerHash.slice(16, 20),
        ownerHash.slice(20, 32),
      ].join("-");
    const files = new Map<string, Buffer>();
    const execution = signSelectedLoadExecutionBaseline(
      {
        admissionSha256: installed.admissionSha256,
        evidenceSha256: installed.evidenceSha256,
        physicalSnapshotSha256: installed.physicalSnapshotSha256,
        generation: 1,
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
      deadline: startedAt + 180_000,
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
      original: structuredClone(host.checkpoint.ledger),
      ledger: structuredClone(host.checkpoint.ledger),
      generation: 1,
      owner,
      fence:
        (journal.ownership.find((row) => row.scope === production)?.fence ??
          0) + 1,
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
      installRecoveryIntent(
        join(directory, "execution-baseline.json"),
        execution,
        join(directory, "execution-baseline.json-stage")
      );
      scope!.phase = "key";
      installRecoveredBackupKey(operator, input.recoveryKey, {
        stagingDirectory: scope!.keyStage,
      });
      scope!.assertCurrent();
      scope!.phase = "run";
      let result: Buffer | undefined, expectedReleased: Buffer | undefined;
      scope!.finish = async (state, snapshot) => {
        await withCanonicalStoreTransaction(
          location.path,
          { generation: scope!.generation, ledger: scope!.ledger },
          async () => {}
        );
        allowedJournal(scope!, snapshot);
        const load = state.stages.find((item) => item.stage === "load");
        if (load?.status !== "succeeded") fail();
        scope!.assertCurrent();
        same(
          decryptLedgerSnapshot(
            readFileSync(
              join(root, "data/ingestion/backups/ledger.snapshot.enc")
            ),
            input.recoveryKey
          ),
          scope!.ledger
        );
        const released = validateWeeklyJournalRecoverySnapshot(snapshot);
        released.ownership.find(
          (row) => row.scope === production
        )!.expiresAtEpochMs = 0;
        const { digest: _digest, ...body } = released;
        expectedReleased = Buffer.from(
          canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
        );
        result = signed(
          {
            kind: "zivv-selected-load-result",
            version: 1,
            admissionSha256: installed.admissionSha256,
            executionBaselineSha256: sha256(execution),
            runId: state.runId,
            ledgerRevision: ledgerDigest(scope!.ledger),
            generation: scope!.generation,
            journalSha256: sha256(expectedReleased!),
            guardedJournalSha256: sha256(snapshot),
            runStateSha256: sha256(canonicalJson(state)),
            reportSha256: scope!.plan.receipt.reportSha256,
          },
          input.recoveryKey,
          "zivv-selected-load-result/v1"
        );
        scope!.phase = "result";
        try {
          scope!.files.set(join(directory, "load-result.json"), result);
          installRecoveryIntent(
            join(directory, "load-result.json"),
            result,
            join(directory, "load-result.json-stage")
          );
          scope!.assertCurrent();
          if (
            scope!.previousFiles.size ||
            [...scope!.transients.keys()].some((path) => existsSync(path))
          )
            fail();
        } finally {
          scope!.phase = "run";
        }
      };
      const state = await runWeeklyImport({
        root,
        source: {
          editionId: proof.source.editionId,
          deliveryId: proof.source.deliveryId,
          raw: Buffer.from(raw),
          importObservedAtEpochMs: proof.source.importObservedAtEpochMs,
        },
        stopAfter: "load",
      });
      if (!result || !expectedReleased || scope!.finish !== undefined) fail();
      same(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(operator, "weekly-runs.sqlite")
        ).toString("base64"),
        expectedReleased.toString("base64")
      );
      scope!.assertCurrent();
      return {
        status: "selected-load-complete" as const,
        activationAllowed: false as const,
        captureAllowed: false as const,
        loadAllowed: false as const,
        runId: state.runId,
        ledgerRevision: ledgerDigest(scope!.ledger),
        generation: scope!.generation,
        resultSha256: sha256(result),
        admissionSha256: installed.admissionSha256,
        accepted: plan.result.report.acceptedEventIds.length,
      };
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

/** Resume exactly one inspected committed first-attempt gap. Scope remains
 * private and quarantined; interruption of this retry requires later proof. */
async function resumeSelectedLoad(
  supplied: RecoveryGmailSelectedLoadInstallationInput,
  pauseForLinkedChunkTest: boolean
) {
  assertNoSelectedGmailLoadExecution();
  assertNoRecoveredGmailCapture();
  const wire = encodeRecoveryGmailSelectedLoadFrame(supplied),
    input = decodeRecoveryGmailSelectedLoadFrame(wire);
  const { selector: _selector, ...runtime } = input;
  let scope: Scope | undefined;
  try {
    const evidence = readSelectedLoadInterruptionEvidence(input);
    if (!["committed", "completed"].includes(evidence.report.status))
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
    const intent = signed(
      {
        kind: "zivv-selected-load-resume-intent",
        version: 2,
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
    const files = new Map<string, Buffer>(),
      readonlyFiles = new Map<string, Buffer>();
    const identities = ["ledger.sqlite", "weekly-runs.sqlite"].map((name) => {
      const path = join(operator, name),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail();
      return { path, dev: stat.dev, ino: stat.ino };
    });
    for (const entry of evidence.observedEntries)
      if (
        entry.kind === "file" &&
        entry.path.startsWith("recovery-gmail-load/")
      ) {
        const path = join(runtime.destination, entry.path),
          bytes = readFileSync(path);
        if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
          fail();
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
    files.set(intentPath, intent);
    const snapshotChunks =
      snapshotEvidence?.chunks.map(({ index }) => {
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
    const originalEntries = new Map(
      evidence.observedEntries.map((entry) => [entry.path, entry])
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
    scope = {
      active: true,
      pauseForLinkedChunkTest,
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
      },
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
        for (const entry of evidence.observedEntries)
          if (!actual.some((item) => item.path === entry.path)) fail();
      },
    };
    scope.assertCurrent();
    return await scopes.run(scope, async () => {
      for (const chunk of snapshotChunks)
        installRecoveryIntent(
          chunk.path,
          chunk.bytes,
          join(directory, chunk.name + "-stage")
        );
      installRecoveryIntent(
        intentPath,
        intent,
        join(directory, "resume-intent.json-stage")
      );
      scope!.phase = "run";
      let result: Buffer | undefined, expectedReleased: Buffer | undefined;
      scope!.finish = async (state, snapshot) => {
        await withCanonicalStoreTransaction(
          location.path,
          { generation: scope!.generation, ledger: scope!.ledger },
          async () => {}
        );
        allowedJournal(scope!, snapshot);
        if (
          state.stages.find((item) => item.stage === "load")?.status !==
          "succeeded"
        )
          fail();
        scope!.assertCurrent();
        same(
          decryptLedgerSnapshot(readFileSync(snapshotPath), input.recoveryKey),
          scope!.ledger
        );
        const released = validateWeeklyJournalRecoverySnapshot(snapshot);
        released.ownership.find(
          (item) => item.scope === production
        )!.expiresAtEpochMs = 0;
        const { digest: _digest, ...body } = released;
        expectedReleased = Buffer.from(
          canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
        );
        result = signed(
          {
            kind: "zivv-selected-load-result",
            version: 1,
            admissionSha256: evidence.admissionSha256,
            executionBaselineSha256: sha256(evidence.executionBaseline),
            runId: state.runId,
            ledgerRevision: ledgerDigest(scope!.ledger),
            generation: scope!.generation,
            journalSha256: sha256(expectedReleased),
            guardedJournalSha256: sha256(snapshot),
            runStateSha256: sha256(canonicalJson(state)),
            reportSha256: plan.receipt.reportSha256,
          },
          input.recoveryKey,
          "zivv-selected-load-result/v1"
        );
        scope!.phase = "result";
        try {
          scope!.files.set(join(directory, "load-result.json"), result);
          installRecoveryIntent(
            join(directory, "load-result.json"),
            result,
            join(directory, "load-result.json-stage")
          );
          scope!.assertCurrent();
          if (
            scope!.previousFiles.size ||
            [...scope!.transients.keys()].some((path) => existsSync(path))
          )
            fail();
        } finally {
          scope!.phase = "run";
        }
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
  } finally {
    if (scope) {
      scope.active = false;
      scope.key.fill(0);
    }
    input.recoveryKey.fill(0);
    wire.fill(0);
  }
}

/** Normal retry; no test interruption is selected. */
export function resumeRecoveredGmailSelectedLoad(
  input: RecoveryGmailSelectedLoadInstallationInput
) {
  return resumeSelectedLoad(input, false);
}
/** Fixed test-only pause after the first chunk link. It grants no new authority. */
export function resumeRecoveredGmailSelectedLoadForTest(
  input: RecoveryGmailSelectedLoadInstallationInput
) {
  return resumeSelectedLoad(input, true);
}
