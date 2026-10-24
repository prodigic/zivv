import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  readlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  openPreparedRuntimeForAdmission,
  type RecoveryRuntimeInput,
  type RecoveryRuntimeEntry,
} from "./recovery-runtime.js";
import {
  authenticateRecoveryGmailCaptureAdmission,
  createRecoveryGmailCaptureAdmission,
  createRecoveryGmailCaptureResult,
  proveRecoveryGmailCaptureDelta,
  type RecoveryGmailCaptureAdmission,
  type RecoveryGmailCaptureBinding,
  type RecoveryGmailCaptureCompletedEvidence,
  type RecoveryGmailCaptureDeltaProof,
} from "./recovery-gmail-capture-admission-proof.js";
import { proveRecoveryGmailBatchInventory } from "./recovery-gmail-batch-proof.js";
import {
  captureSteveEmail,
  prepareSteveEmailCapture,
  selectSteveEmailPlaintext,
  type PreparedSteveEmailCapture,
  type SteveEmailCapturePreparationInput,
} from "./steve-email-intake.js";
import {
  installRecoveredBackupKey,
  installRecoveryIntent,
  repairRecoveredGmailCaptureFile,
  validateRecoveredBackupKeyBytes,
  inspectRecoveryInstalledFile,
  type RecoveryInstallationFile,
  type RecoveryInstallationObservation,
  writeDurableFile,
} from "./encrypted-backup.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
  type WeeklyRunLease,
  type WeeklyJournalRecoverySnapshot,
} from "./weekly-run-journal.js";
import { assertReadOnlySqliteFiles } from "./readonly-sqlite-files.js";
import { assertNoRecoveredImportScope } from "./recovery-import-admission.js";
import {
  assertOperatorInstallationWritable,
  assertNoOperatorRetirementScope,
} from "./operator-installation.js";
import { verifyOperatorRetirementEvidence } from "./operator-recovery.js";

export interface RecoveryGmailCaptureInput extends RecoveryRuntimeInput {
  batchId: string;
  correctionOfByMessageId?: Record<string, string>;
}
export interface RecoveryGmailCaptureReport {
  status: "capture-complete";
  activationAllowed: false;
  captureAllowed: false;
  batchId: string;
  admissionSha256: string;
  resultSha256: string;
  receipts: RecoveryGmailCaptureDeltaProof["receipts"];
}
export const RECOVERY_GMAIL_CAPTURE_INTERRUPTION_POINTS = [
  "admission-saved",
  "key-installed",
  "source-committed",
  "capture-files-written",
  "result-saved",
  "admission-stage-flushed",
  "admission-linked",
  "key-stage-flushed",
  "key-linked",
  "result-stage-flushed",
  "result-linked",
  "intake-stage-flushed",
  "intake-raw-stage-flushed",
  "intake-raw-published",
  "intake-source-stage-flushed",
  "intake-source-published",
  "intake-receipt-stage-flushed",
  "intake-receipt-published",
  "intake-approval-stage-flushed",
  "intake-approval-published",
  "intake-manifest-stage-flushed",
  "intake-manifest-published",
  "authority-negatives-before-source",
  "expire-after-admission",
  "authority-escaped-after-admission",
  "authority-nested-executor-after-admission",
  "lease-expires-before-source",
  "pause-before-key-guard",
] as const;
export type CaptureInterruption =
  (typeof RECOVERY_GMAIL_CAPTURE_INTERRUPTION_POINTS)[number];
export type RecoveryGmailCaptureInterruption = CaptureInterruption;
export const recoveryGmailCaptureExecutorVersion = 2;
const production = "prodigic/zivv/production";
const hash = /^[a-f0-9]{64}$/;
const journalPattern = /^operator\/weekly-runs\.sqlite(?:-wal|-shm)?$/;
const keyName =
  process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin";
type Opened = ReturnType<typeof openPreparedRuntimeForAdmission>;
type Inventory = Pick<
  Opened["checkpoint"],
  "files" | "directories" | "journal"
>;
type Ownership = WeeklyJournalRecoverySnapshot["ownership"][number];
type Family = {
  batchId: string;
  admission: Buffer;
  result?: Buffer;
  record: RecoveryGmailCaptureAdmission;
  admissionInstalled: boolean;
  resultCandidate?: Buffer;
  observations: RecoveryInstallationObservation[];
  stages: RecoveryInstallationFile[];
};
type CaptureStage = RecoveryInstallationFile & { target: string };
const intakeCaptureFileKinds: Readonly<
  Record<string, "raw" | "source" | "receipt" | "approval" | "manifest">
> = {
  "message.eml": "raw",
  "source.txt": "source",
  "receipt.json": "receipt",
  "correction-approval.json": "approval",
  "capture.json": "manifest",
};
interface Scope {
  active: boolean;
  deadline: number;
  operator: string;
  root: string;
  phase: "admission" | "key" | "capture" | "result";
  assertCurrent: (snapshot?: Buffer) => void;
  current?: PreparedSteveEmailCapture;
  input?: SteveEmailCapturePreparationInput & {
    operatorDirectory: string;
    correctionOf?: string;
  };
  files: Map<string, Buffer>;
  directories: Set<string>;
  lease?: WeeklyRunLease;
  owner: string;
  fence: number;
  key: Buffer;
  metadata: Map<string, Buffer>;
  ownership?: Ownership;
  previousOwnership?: Ownership;
  observedOwnership?: Ownership;
  transients: Map<string, Buffer>;
  transientIdentities: Map<string, { dev: number; ino: number }>;
  interruption?: CaptureInterruption;
  intakeStarted?: boolean;
}
const scopes = new AsyncLocalStorage<Scope>();
type EscapedTaskOutcome =
  | "refused"
  | "wrong-refusal"
  | "allowed"
  | "invalid-context";
interface EscapedTaskProof {
  kind: "escaped-after-admission";
  before: string;
  outcome: Promise<EscapedTaskOutcome>;
}
type CaptureOutcome = RecoveryGmailCaptureReport | EscapedTaskProof;

interface CapturePauseHandshake {
  waitForGo: Promise<void>;
  assertCurrent: () => void;
  close: () => void;
}

/** The fixed test transport controls timing only. Every resumed effect still
 * passes the same existing production guards, with the original deadline. */
function pauseBeforeKeyGuard(deadline: number): CapturePauseHandshake {
  if (
    typeof process.send !== "function" ||
    !process.connected ||
    !process.channel
  )
    fail("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_REQUIRED");
  const remaining = Math.min(20_000, deadline - Date.now());
  if (remaining <= 0) fail("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_TIMEOUT");
  let closed = false,
    resumed = false,
    failure: Error | undefined;
  const gate: { resolve?: () => void; reject?: (error: Error) => void } = {};
  const waitForGo = new Promise<void>((accept, reject) => {
    gate.resolve = accept;
    gate.reject = reject;
  });
  const refuse = (code: string) => {
    failure ??= new Error(code);
    if (!resumed) gate.reject?.(failure);
  };
  const timer = setTimeout(
    () => refuse("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_TIMEOUT"),
    remaining
  );
  const message = (value: unknown, handle: unknown) => {
    if (closed || failure) return;
    if (
      resumed ||
      value !== "ZIVV_GMAIL_CAPTURE_GO_V1" ||
      handle !== undefined
    ) {
      refuse("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_INVALID");
      return;
    }
    resumed = true;
    clearTimeout(timer);
    gate.resolve?.();
  };
  const disconnected = () => {
    if (!closed) refuse("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_DISCONNECTED");
  };
  process.on("message", message);
  process.on("disconnect", disconnected);
  process.on("error", disconnected);
  try {
    process.send("ZIVV_GMAIL_CAPTURE_READY_V1", (error) => {
      if (error) disconnected();
    });
  } catch {
    disconnected();
  }
  return {
    waitForGo,
    assertCurrent: () => {
      if (failure) throw failure;
    },
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      process.off("message", message);
      process.off("disconnect", disconnected);
      process.off("error", disconnected);
      if (process.connected) process.disconnect();
    },
  };
}

/** A complete read-only observation, including SQLite/WAL/SHM and the prepared
 * receipt. This is called only after durable admission, outside transactions. */
function escapedTaskSnapshot(root: string, journalPath: string): string {
  const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
  validateWeeklyJournalRecoverySnapshot(journal);
  const entries: unknown[] = [];
  let count = 0,
    total = 0;
  const unstable = () =>
    fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_ESCAPE_UNSTABLE");
  const walk = (directory: string, prefix: string) => {
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) unstable();
    entries.push({
      path: prefix,
      kind: "directory",
      dev: before.dev,
      ino: before.ino,
      nlink: before.nlink,
      mode: before.mode,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    });
    for (const name of readdirSync(directory).sort()) {
      if (++count > 50_000) unstable();
      const path = join(directory, name),
        relative = prefix + name,
        stat = lstatSync(path);
      const identity = {
        path: relative,
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      };
      if (stat.isSymbolicLink()) {
        entries.push({
          ...identity,
          kind: "symlink",
          target: readlinkSync(path),
        });
      } else if (stat.isDirectory()) {
        walk(path, relative + "/");
      } else {
        if (
          !stat.isFile() ||
          stat.nlink < 1 ||
          stat.nlink > 2 ||
          (total += stat.size) > 512 * 1024 * 1024
        )
          unstable();
        const fd = openSync(path, "r"),
          digest = createHash("sha256"),
          buffer = Buffer.alloc(64 * 1024);
        let size = 0;
        try {
          const opened = fstatSync(fd);
          if (
            opened.dev !== stat.dev ||
            opened.ino !== stat.ino ||
            opened.size !== stat.size ||
            opened.nlink !== stat.nlink
          )
            unstable();
          for (;;) {
            const length = readSync(fd, buffer, 0, buffer.length, null);
            if (!length) break;
            size += length;
            if (size > stat.size) unstable();
            digest.update(buffer.subarray(0, length));
          }
          const after = fstatSync(fd);
          if (
            after.dev !== stat.dev ||
            after.ino !== stat.ino ||
            after.size !== stat.size ||
            after.nlink !== stat.nlink ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs
          )
            unstable();
        } finally {
          closeSync(fd);
        }
        const after = lstatSync(path);
        if (
          size !== stat.size ||
          after.dev !== stat.dev ||
          after.ino !== stat.ino ||
          after.size !== stat.size ||
          after.nlink !== stat.nlink ||
          after.isSymbolicLink() ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          unstable();
        entries.push({
          ...identity,
          kind: "file",
          size,
          sha256: digest.digest("hex"),
        });
      }
    }
    const after = lstatSync(directory);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      unstable();
  };
  walk(root, "");
  return sha256(
    canonicalJson({ journal: journal.toString("base64"), entries })
  );
}

const genuineInterruptions = new WeakMap<Error, Scope>();
class CaptureTestInterruption extends Error {
  constructor() {
    super("RECOVERY_GMAIL_CAPTURE_TEST_INTERRUPTION");
  }
}
/** Only genuine fixed-point interruptions from this private invocation preserve
 * flushed stages; arbitrary caller errors cannot acquire this classification. */
export function isRecoveryGmailCaptureTestInterruption(
  error: unknown
): boolean {
  return (
    error instanceof CaptureTestInterruption &&
    genuineInterruptions.get(error) === scopes.getStore()
  );
}
export function observeRecoveredGmailCaptureFileCheckpoint(
  path: string,
  point: "flushed" | "linked" | "published"
): void {
  const scope = current();
  if (!scope?.interruption) return;
  const absolute = resolve(path);
  let selected: CaptureInterruption | undefined;
  if (
    absolute === join(scope.operator, keyName) ||
    absolute.startsWith(join(scope.root, "recovery-gmail-capture") + "/") ||
    absolute.startsWith(join(scope.root, "recovery-gmail-capture") + "\\")
  ) {
    if (point !== "published") {
      if (
        absolute.includes("key-stage") ||
        absolute === join(scope.operator, keyName)
      )
        selected = point === "flushed" ? "key-stage-flushed" : "key-linked";
      else if (
        absolute.includes("admission-stage") ||
        basename(absolute) === "admission.json"
      )
        selected =
          point === "flushed" ? "admission-stage-flushed" : "admission-linked";
      else if (
        absolute.includes("result-stage") ||
        basename(absolute) === "result.json"
      )
        selected =
          point === "flushed" ? "result-stage-flushed" : "result-linked";
    }
  } else if (scope.phase === "capture" && scope.files.has(absolute)) {
    const kind = intakeCaptureFileKinds[basename(absolute)];
    if (point === "flushed") {
      if (scope.interruption === "intake-stage-flushed")
        selected = "intake-stage-flushed";
      else if (kind)
        selected = `intake-${kind}-stage-flushed` as CaptureInterruption;
    } else {
      if (kind) selected = `intake-${kind}-published` as CaptureInterruption;
    }
  }
  if (selected === scope.interruption) {
    scope.assertCurrent();
    const error = new CaptureTestInterruption();
    genuineInterruptions.set(error, scope);
    throw error;
  }
}
function fail(code = "RECOVERY_GMAIL_CAPTURE_SCOPE_EXCEEDED"): never {
  throw new Error(code);
}
function same(a: unknown, b: unknown): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail();
}
function current(): Scope | undefined {
  const scope = scopes.getStore();
  if (!scope) return undefined;
  if (!scope.active || Date.now() >= scope.deadline)
    fail("RECOVERY_GMAIL_CAPTURE_EXPIRED");
  return scope;
}
/** Presence includes escaped/expired descendants, which must still fail closed. */
export function assertNoRecoveredGmailCapture(): void {
  if (scopes.getStore()) fail();
}
/** The operation is deliberately effect specific; it never grants import authority. */
export function assertRecoveredGmailCaptureWriter(
  directory: string,
  operation?: "steve-email-capture" | "capture-journal"
): void {
  const scope = current();
  if (!scope) return;
  if (
    resolve(directory) !== scope.operator ||
    !operation ||
    scope.phase !== "capture"
  )
    fail();
  scope.assertCurrent();
}
export function hasRecoveredGmailCaptureAuthority(directory: string): boolean {
  const scope = current();
  if (
    !scope ||
    scope.phase !== "capture" ||
    scope.operator !== resolve(directory) ||
    !scope.current
  )
    return false;
  scope.assertCurrent();
  return true;
}
/** Return only the closed executor's preselected production lease identity. */
export function recoveredGmailCaptureLeaseOwner(): string | undefined {
  return current()?.owner;
}
/** A fixed test selection only; this neither exposes nor establishes authority. */
export function recoveredGmailCaptureAuthorityProbeMode():
  | "authority-negatives-before-source"
  | undefined {
  const scope = current();
  return scope?.phase === "capture" &&
    scope.interruption === "authority-negatives-before-source"
    ? "authority-negatives-before-source"
    : undefined;
}
/** Fixed observation selection only; callers cannot supply a TTL or authority. */
export function recoveredGmailCaptureLeaseExpiryProbeMode():
  | "lease-expires-before-source"
  | undefined {
  const scope = current();
  return scope?.phase === "capture" &&
    scope.interruption === "lease-expires-before-source"
    ? "lease-expires-before-source"
    : undefined;
}
export function assertRecoveredGmailCaptureInvocation(
  input: SteveEmailCapturePreparationInput & {
    operatorDirectory: string;
    correctionOf?: string;
  },
  prepared?: PreparedSteveEmailCapture
): void {
  const scope = current();
  if (!scope) return;
  if (scope.phase !== "capture" || !scope.input || !scope.current) fail();
  if (input !== scope.input) fail();
  if (!prepared) {
    if (scope.intakeStarted) fail();
    scope.intakeStarted = true;
  } else if (!scope.intakeStarted) fail();
  same(input, scope.input);
  if (prepared) same(prepared, scope.current);
  scope.assertCurrent();
}
export type CaptureJournalEffect =
  | "open"
  | "read"
  | "acquire"
  | "renew"
  | "release"
  | "source"
  | "correction"
  | "guard"
  | "deny";
/** Called on both sides of every journal transaction and immediately before SQL. */
export function assertRecoveredGmailCaptureJournal(input: {
  path: string;
  effect: CaptureJournalEffect;
  snapshot?: Buffer;
  lease?: WeeklyRunLease;
  id?: string;
  bytes?: Buffer;
}): void {
  const scope = current();
  if (!scope) return;
  if (
    scope.phase !== "capture" ||
    resolve(input.path) !== join(scope.operator, "weekly-runs.sqlite") ||
    input.effect === "deny" ||
    !scope.current
  )
    fail();
  scope.assertCurrent(input.snapshot);
  if (input.effect === "open" || input.effect === "read") return;
  const lease = input.lease;
  if (
    !lease ||
    lease.scope !== production ||
    lease.owner !== scope.owner ||
    lease.fence !== scope.fence
  )
    fail("RECOVERY_GMAIL_CAPTURE_LEASE_IDENTITY");
  if (lease.expiresAtEpochMs > scope.deadline)
    fail("RECOVERY_GMAIL_CAPTURE_LEASE_DEADLINE");
  if (lease.expiresAtEpochMs <= Date.now())
    fail("RECOVERY_GMAIL_CAPTURE_LEASE_EXPIRED");
  if (input.effect === "acquire") {
    scope.lease = { ...lease };
    scope.previousOwnership = scope.ownership;
    scope.ownership = { ...lease };
    return;
  }
  if (
    !scope.lease ||
    lease.owner !== scope.lease.owner ||
    lease.fence !== scope.lease.fence
  )
    fail();
  if (input.effect === "renew") {
    scope.lease = { ...lease };
    scope.previousOwnership = scope.ownership;
    scope.ownership = { ...lease };
    return;
  }
  if (input.effect === "release") {
    scope.previousOwnership = scope.ownership;
    scope.ownership = { ...lease, expiresAtEpochMs: 0 };
    return;
  }
  if (input.effect === "source" || input.effect === "correction") {
    if (input.id !== scope.current.receiptId || !Buffer.isBuffer(input.bytes))
      fail();
    const value = JSON.parse(input.bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    same(input.bytes.toString("utf8"), canonicalJson(value) + "\n");
    if (input.effect === "source") {
      const p = scope.current;
      same(value, {
        schemaVersion: 1,
        receiptId: p.receiptId,
        accountSha256: p.accountSha256,
        editionId: p.editionId,
        deliveryId: p.deliveryId,
        messageId: p.messageId,
        rawSha256: p.rawSha256,
        sourceSha256: p.sourceSha256,
        receivedAtEpochMs: p.receivedAtEpochMs,
        firstObservedAtEpochMs: value.firstObservedAtEpochMs,
        acquisitionObservedAtEpochMs: p.acquisitionObservedAtEpochMs,
        senderDate: p.senderDate,
        disposition: value.disposition,
        correctionOf: scope.input?.correctionOf ?? null,
        partPath: p.partPath,
        receiverProfile: p.receiverProfile,
      });
      if (
        !Number.isSafeInteger(value.firstObservedAtEpochMs) ||
        Number(value.firstObservedAtEpochMs) > Date.now()
      )
        fail();
    } else {
      same(value, {
        schemaVersion: 1,
        receiptId: scope.current.receiptId,
        correctionOf: scope.input?.correctionOf,
        approvedAtEpochMs: value.approvedAtEpochMs,
      });
      if (
        !scope.input?.correctionOf ||
        !Number.isSafeInteger(value.approvedAtEpochMs) ||
        Number(value.approvedAtEpochMs) > Date.now()
      )
        fail();
    }
    const body = join(
      scope.operator,
      "email-intake",
      scope.current.accountSha256,
      "bodies",
      scope.current.receiptId
    );
    if (!input.snapshot) fail();
    const state = validateWeeklyJournalRecoverySnapshot(input.snapshot);
    if (
      !state.intakeEvidence.some(
        (row) =>
          row.scope === production &&
          row.kind === input.effect &&
          row.id === input.id
      )
    ) {
      state.intakeEvidence.push({
        scope: production,
        kind: input.effect,
        id: input.id!,
        identity: sha256(input.bytes),
        bytes: input.bytes.toString("base64"),
      });
      state.intakeEvidence.sort((a, b) =>
        canonicalJson([a.scope, a.kind, a.id]).localeCompare(
          canonicalJson([b.scope, b.kind, b.id])
        )
      );
      const { digest: oldDigest, ...body } = state;
      void oldDigest;
      scope.assertCurrent(
        Buffer.from(
          canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
        )
      );
    }
    scope.files.set(
      join(
        body,
        input.effect === "source" ? "receipt.json" : "correction-approval.json"
      ),
      Buffer.from(input.bytes)
    );
  }
}
/** Inner durable boundaries use exact destinations and exact bytes, including tmp aliases. */
export function assertRecoveredGmailCaptureFile(
  path: string,
  bytes?: Buffer,
  effect: "write" | "directory" | "unlink" | "install" = "write"
): void {
  const scope = current();
  if (!scope) return;
  const absolute = resolve(path);
  scope.assertCurrent();
  if (scope.phase === "capture") {
    const lease = scope.lease,
      observed = scope.observedOwnership;
    if (
      !lease ||
      !observed ||
      observed.owner !== lease.owner ||
      observed.fence !== lease.fence ||
      observed.expiresAtEpochMs <= Date.now()
    )
      fail();
  }
  if (effect === "directory") {
    if (!scope.directories.has(absolute)) fail();
    return;
  }
  let canonical = absolute.replace(/(?:\.\d+\.[a-f0-9]{16}\.tmp)+$/, "");
  const suffix = absolute.slice(canonical.length);
  const suffixCount = suffix
    ? suffix.match(/\.\d+\.[a-f0-9]{16}\.tmp/g)!.length
    : 0;
  if (
    suffixCount >
    (canonical.startsWith(
      join(scope.operator, "email-intake") +
        (process.platform === "win32" ? "\\" : "/")
    )
      ? 1
      : 2)
  )
    fail();
  for (const [name, target] of [
    ["admission-stage", "admission.json"],
    ["result-stage", "result.json"],
    ["key-stage", keyName],
  ] as const) {
    const ownDirectory = [...scope.metadata.keys()].find(
      (path) =>
        path.endsWith("admission.json") &&
        dirname(canonical) === join(dirname(path), name)
    );
    if (
      ownDirectory &&
      dirname(canonical) === join(dirname(ownDirectory), name) &&
      basename(canonical) === target
    )
      canonical =
        name === "key-stage"
          ? join(scope.operator, keyName)
          : join(dirname(ownDirectory), target);
  }
  const expected = scope.files.get(canonical) ?? scope.metadata.get(canonical);
  if (scope.phase === "key" && canonical === join(scope.operator, keyName)) {
    if (bytes) {
      if (expected) {
        if (!expected.equals(bytes))
          fail("RECOVERY_GMAIL_CAPTURE_WORKING_KEY_MISMATCH");
      } else {
        validateRecoveredBackupKeyBytes(bytes, scope.key);
        scope.metadata.set(canonical, Buffer.from(bytes));
      }
      checkTransient(scope, absolute, canonical, bytes, effect);
    }
    return;
  }
  if (!expected || (bytes && !expected.equals(bytes))) fail();
  if (bytes) checkTransient(scope, absolute, canonical, bytes, effect);
  if (
    effect === "unlink" &&
    existsSync(absolute) &&
    !readFileSync(absolute).equals(expected)
  )
    fail();
}
export function assertRecoveredGmailCaptureRepair(
  path: string,
  bytes: Buffer
): void {
  const scope = current();
  if (
    !scope ||
    (scope.phase === "capture"
      ? !scope.files.get(resolve(path))?.equals(bytes)
      : scope.phase !== "result" ||
        !scope.metadata.get(resolve(path))?.equals(bytes))
  )
    fail();
  assertRecoveredGmailCaptureFile(path, bytes);
}
/** Own zero-length stages are valid only before their first write. Installation
 * requires the exact flushed bytes and the inode observed at stage creation. */
function checkTransient(
  scope: Scope,
  path: string,
  canonical: string,
  bytes: Buffer,
  effect: "write" | "directory" | "unlink" | "install"
): void {
  if (path === canonical) {
    if (effect === "install") fail();
    return;
  }
  scope.transients.set(path, Buffer.from(bytes));
  if (!existsSync(path)) {
    if (effect === "install") fail("RECOVERY_GMAIL_CAPTURE_STAGE_CHANGED");
    return;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 2)
    fail("RECOVERY_GMAIL_CAPTURE_STAGE_CHANGED");
  const known = scope.transientIdentities.get(path);
  if (known && (known.dev !== stat.dev || known.ino !== stat.ino))
    fail("RECOVERY_GMAIL_CAPTURE_STAGE_CHANGED");
  if (!known) {
    const renamed = [...scope.transientIdentities].some(
      ([prior, identity]) =>
        identity.dev === stat.dev &&
        identity.ino === stat.ino &&
        scope.transients.get(prior)?.equals(bytes)
    );
    if (stat.size !== 0 && !renamed)
      fail("RECOVERY_GMAIL_CAPTURE_STAGE_CHANGED");
    scope.transientIdentities.set(path, { dev: stat.dev, ino: stat.ino });
  }
  if (effect === "install") {
    if (stat.size !== bytes.length || !readFileSync(path).equals(bytes))
      fail("RECOVERY_GMAIL_CAPTURE_STAGE_CHANGED");
    const after = lstatSync(path);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.nlink !== stat.nlink ||
      after.size !== stat.size ||
      after.isSymbolicLink()
    )
      fail("RECOVERY_GMAIL_CAPTURE_STAGE_CHANGED");
  }
}
export function assertRecoveredGmailCaptureKey(
  directory: string,
  suppliedKey?: Buffer
): void {
  const scope = current();
  if (!scope) return;
  if (
    (suppliedKey && scope.phase !== "key") ||
    resolve(directory) !== scope.operator ||
    (suppliedKey && !scope.key.equals(suppliedKey))
  )
    fail();
  if (suppliedKey) scope.assertCurrent();
}
export function recoveredGmailCaptureLeaseTtl(defaultTtl: number): number {
  const scope = current();
  return scope
    ? Math.max(1000, Math.min(defaultTtl, scope.deadline - Date.now() - 1000))
    : defaultTtl;
}
/** Journal calls this only after a newly inserted source transaction committed. */
export function observeRecoveredGmailCaptureSourceCommit(): void {
  const scope = current();
  if (!scope) return;
  scope.assertCurrent();
  if (scope.interruption === "source-committed")
    fail("RECOVERY_GMAIL_CAPTURE_TEST_INTERRUPTION");
}
/** Finalize only a journal transaction whose known bookkeeping became visible. */
export function observeRecoveredGmailCaptureJournalCommit(
  snapshot: Buffer
): void {
  const scope = current();
  if (!scope) return;
  scope.assertCurrent(snapshot);
  same(scope.observedOwnership, scope.ownership);
  scope.previousOwnership = undefined;
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
  const fd = openSync(path, "r");
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size !== stat.size ||
      opened.nlink !== stat.nlink
    )
      fail();
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) fail();
    const after = fstatSync(fd);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.nlink !== stat.nlink
    )
      fail();
    bytes = buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
  if (bytes.length !== stat.size) fail();
  return bytes;
}
function copyInput(
  input: RecoveryGmailCaptureInput
): RecoveryGmailCaptureInput {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(input) as object | null
    )
  )
    fail();
  const names = Reflect.ownKeys(input);
  if (
    names.length > 7 ||
    names.some(
      (name) =>
        typeof name !== "string" ||
        ![
          "archive",
          "retirementReceipt",
          "recoveryKey",
          "destination",
          "npmCli",
          "batchId",
          "correctionOfByMessageId",
        ].includes(name) ||
        !Object.hasOwn(
          Object.getOwnPropertyDescriptor(input, name) ?? {},
          "value"
        )
    )
  )
    fail();
  if (
    !Buffer.isBuffer(input.archive) ||
    !input.archive.length ||
    input.archive.length > 256 * 1024 * 1024 * 1.4 ||
    !Buffer.isBuffer(input.retirementReceipt) ||
    !input.retirementReceipt.length ||
    input.retirementReceipt.length > 16384 ||
    !Buffer.isBuffer(input.recoveryKey) ||
    input.recoveryKey.length !== 32 ||
    !hash.test(input.batchId) ||
    typeof input.destination !== "string" ||
    input.destination.length > 4096 ||
    typeof input.npmCli !== "string" ||
    input.npmCli.length > 4096
  )
    fail();
  let corrections: Record<string, string> | undefined;
  if (input.correctionOfByMessageId !== undefined) {
    const map = input.correctionOfByMessageId;
    if (
      !map ||
      typeof map !== "object" ||
      ![Object.prototype, null].includes(
        Object.getPrototypeOf(map) as object | null
      ) ||
      Reflect.ownKeys(map).length > 100
    )
      fail();
    corrections = {};
    for (const name of Reflect.ownKeys(map)) {
      if (typeof name !== "string" || !/^[a-f0-9]{1,128}$/.test(name)) fail();
      const property = Object.getOwnPropertyDescriptor(map, name);
      if (
        !property?.enumerable ||
        !Object.hasOwn(property, "value") ||
        typeof property.value !== "string" ||
        !hash.test(property.value)
      )
        fail();
      corrections[name] = property.value;
    }
    if (Buffer.byteLength(canonicalJson(corrections)) > 32 * 1024) fail();
  }
  return {
    archive: Buffer.from(input.archive),
    retirementReceipt: Buffer.from(input.retirementReceipt),
    recoveryKey: Buffer.from(input.recoveryKey),
    destination: input.destination,
    npmCli: input.npmCli,
    batchId: input.batchId,
    ...(corrections ? { correctionOfByMessageId: corrections } : {}),
  };
}
function leaseOwner(
  admission: Buffer,
  messageId: string,
  fence: number
): string {
  const digest = sha256(
    canonicalJson([
      "zivv-recovery-gmail-capture-lease/v1",
      sha256(admission),
      messageId,
      fence,
    ])
  );
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
function family(root: string): Family[] {
  const path = join(root, "recovery-gmail-capture");
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const names = readdirSync(path);
  if (names.length > 1000) fail();
  let total = 0;
  const observe = (
    target: string,
    directory: string,
    limit: number
  ): RecoveryInstallationObservation => {
    const stageNames = existsSync(directory) ? readdirSync(directory) : [];
    if (stageNames.length > 1)
      fail("RECOVERY_GMAIL_CAPTURE_STAGE_REQUIRES_REPAIR");
    const prefix = basename(target) + ".";
    for (const name of stageNames)
      if (
        !name.startsWith(prefix) ||
        !/^\d+\.[a-f0-9]{16}\.tmp(?:\.\d+\.[a-f0-9]{16}\.tmp)?$/.test(
          name.slice(prefix.length)
        )
      )
        fail("RECOVERY_GMAIL_CAPTURE_STAGE_REQUIRES_REPAIR");
    for (const path of [
      target,
      ...stageNames.map((name) => join(directory, name)),
    ])
      if (existsSync(path)) {
        total += lstatSync(path).size;
        if (total > 512 * 1024 * 1024)
          fail("RECOVERY_GMAIL_CAPTURE_STAGE_CAPACITY");
      }
    const active = scopes.getStore(),
      stage = stageNames[0] ? join(directory, stageNames[0]) : undefined;
    // Only this invocation's already registered, newly opened stage may be zero
    // while its first write has not happened. A saved zero stage is never adopted.
    if (
      stage &&
      active?.active &&
      active.transients.has(stage) &&
      lstatSync(stage).size === 0
    ) {
      const stat = lstatSync(stage);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail();
      return {
        target: existsSync(target)
          ? {
              path: target,
              bytes: readAliased(target, limit),
              dev: lstatSync(target).dev,
              ino: lstatSync(target).ino,
              nlink: lstatSync(target).nlink,
            }
          : null,
        candidate: null,
      };
    }
    return inspectRecoveryInstalledFile(target, directory, limit);
  };
  return names
    .map((batchId) => {
      if (!hash.test(batchId)) fail();
      const directory = join(path, batchId),
        item = lstatSync(directory);
      if (!item.isDirectory() || item.isSymbolicLink()) fail();
      const entries = readdirSync(directory);
      const active = scopes.getStore();
      const own =
        active?.active &&
        active.metadata.has(join(directory, "admission.json"));
      if (
        entries.some(
          (name) =>
            ![
              "admission.json",
              "result.json",
              "admission-stage",
              "result-stage",
              "key-stage",
            ].includes(name)
        )
      )
        fail();
      for (const stage of ["admission-stage", "result-stage", "key-stage"]) {
        const directory = join(path, batchId, stage);
        if (existsSync(directory)) {
          if (
            !lstatSync(directory).isDirectory() ||
            lstatSync(directory).isSymbolicLink()
          )
            fail();
        }
      }
      const admissionObservation = observe(
        join(directory, "admission.json"),
        join(directory, "admission-stage"),
        64 * 1024
      );
      const resultObservation = observe(
        join(directory, "result.json"),
        join(directory, "result-stage"),
        16 * 1024 * 1024
      );
      const keyStage = join(directory, "key-stage");
      const keyObservation =
        existsSync(keyStage) && readdirSync(keyStage).length
          ? observe(join(root, "operator", keyName), keyStage, 16 * 1024)
          : undefined;
      const admission =
        admissionObservation.target?.bytes ??
        admissionObservation.candidate?.bytes ??
        (own
          ? active!.metadata.get(join(directory, "admission.json"))
          : undefined);
      if (!admission) fail();
      const record = JSON.parse(
        admission.toString("utf8")
      ) as RecoveryGmailCaptureAdmission;
      if (
        !record ||
        record.batchId !== batchId ||
        !Number.isSafeInteger(record.priorCompleted?.count)
      )
        fail();
      return {
        batchId,
        admission,
        record,
        admissionInstalled: Boolean(admissionObservation.target),
        ...(resultObservation.target
          ? { result: resultObservation.target.bytes }
          : {}),
        ...(resultObservation.candidate && !resultObservation.target
          ? { resultCandidate: resultObservation.candidate.bytes }
          : {}),
        observations: [
          admissionObservation,
          resultObservation,
          ...(keyObservation ? [keyObservation] : []),
        ],
        stages: [
          admissionObservation.candidate,
          resultObservation.candidate,
          keyObservation?.candidate,
        ].filter((stage): stage is RecoveryInstallationFile => Boolean(stage)),
      };
    })
    .sort(
      (a, b) => a.record.priorCompleted.count - b.record.priorCompleted.count
    );
}
function readAliased(path: string, limit = 16 * 1024 * 1024): Buffer {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    if (dirname(parent) === parent) break;
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink > 2 ||
    stat.size > limit
  )
    fail();
  const fd = openSync(path, "r");
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size !== stat.size ||
      opened.nlink !== stat.nlink
    )
      fail();
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) fail();
    const after = fstatSync(fd);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.nlink !== stat.nlink
    )
      fail();
    bytes = buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
  const after = lstatSync(path);
  if (
    bytes.length !== stat.size ||
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.size !== stat.size ||
    after.nlink !== stat.nlink ||
    after.isSymbolicLink()
  )
    fail();
  return bytes;
}
/** Only exact authenticated recipes with a durable source journal row may own
 * an intake stage. The detached delta proof still validates the complete recipe. */
function captureStages(
  root: string,
  entries: RecoveryRuntimeEntry[],
  all: Family[],
  batches: ReturnType<typeof proveRecoveryGmailBatchInventory>,
  journal: Buffer
): Map<string, CaptureStage> {
  const stages = new Map<string, CaptureStage>();
  const expected = new Map<string, Buffer>();
  const rows = validateWeeklyJournalRecoverySnapshot(journal).intakeEvidence;
  const add = (path: string, bytes: Buffer) => {
    const before = expected.get(path);
    if (before && !before.equals(bytes)) fail();
    expected.set(path, bytes);
  };
  for (const item of all) {
    const directory = join(root, "recovery-gmail-capture", item.batchId);
    const targets = [
      join(directory, "admission.json"),
      join(directory, "result.json"),
      join(root, "operator", keyName),
    ];
    for (let index = 0; index < item.observations.length; index++) {
      const candidate = item.observations[index]!.candidate;
      if (candidate)
        stages.set(candidate.path, { ...candidate, target: targets[index]! });
    }
    if (!item.admissionInstalled) continue;
    const batch = batches.batches.find(
      ({ batch }) => batch.batchId === item.batchId
    )?.batch;
    if (!batch) fail();
    for (const snapshot of batch.snapshots) {
      let source: Buffer;
      try {
        source = selectSteveEmailPlaintext(snapshot.fullMessage.payload).source;
      } catch {
        continue;
      }
      const sourceSha256 = sha256(source);
      const receiptId = sha256(
        canonicalJson([
          batch.accountSha256,
          batch.expectedEditionId,
          sourceSha256,
        ])
      );
      const sourceRow = rows.find(
        (row) =>
          row.scope === production &&
          row.kind === "source" &&
          row.id === receiptId
      );
      if (!sourceRow) continue;
      const body = join(
        root,
        "operator",
        "email-intake",
        batch.accountSha256,
        "bodies",
        receiptId
      );
      const message = join(
        root,
        "operator",
        "email-intake",
        batch.accountSha256,
        "messages",
        sha256(snapshot.rawMessage.id)
      );
      add(join(body, "source.txt"), source);
      add(join(body, "receipt.json"), Buffer.from(sourceRow.bytes, "base64"));
      const approval = rows.find(
        (row) =>
          row.scope === production &&
          row.kind === "correction" &&
          row.id === receiptId
      );
      if (approval)
        add(
          join(body, "correction-approval.json"),
          Buffer.from(approval.bytes, "base64")
        );
      const raw = Buffer.from(snapshot.rawMessage.raw, "base64url");
      add(join(message, "message.eml"), raw);
      add(
        join(message, "capture.json"),
        Buffer.from(
          canonicalJson({
            schemaVersion: 1,
            messageId: snapshot.rawMessage.id,
            accountSha256: batch.accountSha256,
            rawSha256: sha256(raw),
            sourceSha256,
            receiptId,
            receivedAtEpochMs: snapshot.fullMessage.internal_date,
          }) + "\n"
        )
      );
    }
  }
  const grammar =
    /^(operator\/email-intake\/[a-f0-9]{64}\/(?:messages\/[a-f0-9]{64}\/(?:message\.eml|capture\.json)|bodies\/[a-f0-9]{64}\/(?:source\.txt|receipt\.json|correction-approval\.json)))\.\d+\.[a-f0-9]{16}\.tmp$/;
  const targets = new Set<string>();
  for (const entry of entries) {
    const match = grammar.exec(entry.path);
    if (!match) continue;
    const path = join(root, entry.path),
      target = join(root, match[1]!);
    const bytes = expected.get(target);
    if (!bytes || targets.has(target) || entry.kind !== "file")
      fail("RECOVERY_GMAIL_CAPTURE_STAGE_REQUIRES_REPAIR");
    targets.add(target);
    const active = scopes.getStore();
    if (active?.transients.has(path) && lstatSync(path).size === 0) continue;
    const observed = inspectRecoveryInstalledFile(
      target,
      dirname(target),
      8 * 1024 * 1024
    );
    if (
      !observed.candidate ||
      observed.candidate.path !== path ||
      !observed.candidate.bytes.equals(bytes) ||
      (observed.target && !observed.target.bytes.equals(bytes))
    )
      fail("RECOVERY_GMAIL_CAPTURE_STAGE_REQUIRES_REPAIR");
    stages.set(path, { ...observed.candidate, target });
  }
  return stages;
}
function checkpointInventory(
  opened: Opened,
  root: string,
  entries: RecoveryRuntimeEntry[],
  journal: Buffer,
  stages: Map<string, CaptureStage>
): Inventory {
  const originals = new Map(
    opened.checkpoint.files.map((file) => [file.area + "/" + file.path, file])
  );
  const originalDirectories = new Set(
    opened.checkpoint.directories.map((entry) => entry.area + "/" + entry.path)
  );
  const files = opened.checkpoint.files.map((file) => ({ ...file }));
  const directories = opened.checkpoint.directories.map((entry) => ({
    ...entry,
  }));
  for (const entry of entries) {
    if (
      stages.has(join(root, entry.path)) ||
      scopes.getStore()?.transients.has(join(root, entry.path))
    )
      continue;
    if (
      entry.path.startsWith("operator/email-intake/") ||
      entry.path === "operator/email-intake"
    ) {
      if (entry.kind === "symlink") fail();
      if (entry.kind === "directory" && !originalDirectories.has(entry.path))
        directories.push({ area: "operator", path: entry.path.slice(9) });
      if (entry.kind === "file" && !originals.has(entry.path))
        files.push({
          area: "operator",
          path: entry.path.slice(9),
          sha256: entry.sha256,
          bytes: readAliased(join(root, entry.path), 8 * 1024 * 1024).toString(
            "base64"
          ),
        });
    }
  }
  for (const file of files) {
    if (file.bytes !== null) {
      const entry = entries.find(
        (entry) => entry.path === file.area + "/" + file.path
      );
      if (!entry || entry.kind !== "file" || entry.sha256 !== file.sha256)
        fail();
    }
  }
  return { files, directories, journal: journal.toString("base64") };
}
function normalized(
  entries: RecoveryRuntimeEntry[],
  inventory: Inventory,
  checkpoint: Opened["checkpoint"],
  root: string,
  stages: Map<string, CaptureStage>
): string {
  const old = new Set([
    ...checkpoint.files.map((file) => file.area + "/" + file.path),
    ...checkpoint.directories.map((entry) => entry.area + "/" + entry.path),
  ]);
  const added = new Set(
    [
      ...inventory.files.map((file) => file.area + "/" + file.path),
      ...inventory.directories.map((entry) => entry.area + "/" + entry.path),
    ].filter((name) => !old.has(name))
  );
  return sha256(
    canonicalJson(
      entries.filter(
        (entry) =>
          !scopes
            .getStore()
            ?.transients.has(join(scopes.getStore()!.root, entry.path)) &&
          !stages.has(join(root, entry.path)) &&
          !journalPattern.test(entry.path) &&
          entry.path !== "operator/" + keyName &&
          !added.has(entry.path) &&
          entry.path !== "recovery-gmail-capture" &&
          !entry.path.startsWith("recovery-gmail-capture/")
      )
    )
  );
}
function open(input: RecoveryGmailCaptureInput) {
  const archived = verifyOperatorRetirementEvidence(input).checkpoint;
  const executor = archived.files.find(
    (file) =>
      file.area === "checkout" &&
      file.path === "dist/lib/ingestion/recovery-gmail-capture-admission.js"
  );
  if (
    archived.version !== 2 ||
    !executor?.bytes ||
    !Buffer.from(executor.bytes, "base64")
      .toString("utf8")
      .includes("recoveryGmailCaptureExecutorVersion = 2") ||
    !archived.files.some(
      (file) =>
        file.area === "checkout" &&
        file.path === "dist/lib/ingestion/recovery-gmail-capture-framing.js" &&
        file.bytes
    )
  )
    fail("RECOVERY_GMAIL_CAPTURE_UNSUPPORTED_RUNTIME");
  const root = resolve(input.destination),
    operator = join(root, "operator");
  assertNoOperatorRetirementScope();
  assertNoRecoveredImportScope();
  assertOperatorInstallationWritable(operator);
  if (scopes.getStore()) fail();
  const opened = openPreparedRuntimeForAdmission(input),
    all = family(root);
  let installedKeyBytes: Buffer | undefined;
  const assertWorkingKey = () => {
    const path = join(operator, keyName);
    if (!existsSync(path)) {
      if (installedKeyBytes)
        fail("RECOVERY_GMAIL_CAPTURE_WORKING_KEY_MISMATCH");
      return;
    }
    const bytes = readAliased(path, 16 * 1024),
      expected = scopes.getStore()?.metadata.get(path);
    if (
      (expected && !expected.equals(bytes)) ||
      (installedKeyBytes && !installedKeyBytes.equals(bytes))
    )
      fail("RECOVERY_GMAIL_CAPTURE_WORKING_KEY_MISMATCH");
    if (!installedKeyBytes) {
      validateRecoveredBackupKeyBytes(bytes, input.recoveryKey);
      installedKeyBytes = Buffer.from(bytes);
    }
  };
  assertWorkingKey();
  let initialJournalEntries: RecoveryRuntimeEntry[] | undefined;
  const checkpoint = opened.checkpoint;
  // The signed checkpoint remains bound by opened.report; the prepared journal's
  // specified restoration clears expiry fields before any admission is possible.
  const state = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(checkpoint.journal, "base64")
  );
  const { digest: ignoredDigest, ...baselineBody } = {
    ...state,
    ownership: state.ownership.map((row) => ({ ...row, expiresAtEpochMs: 0 })),
  };
  void ignoredDigest;
  checkpoint.journal = Buffer.from(
    canonicalJson({
      ...baselineBody,
      digest: sha256(canonicalJson(baselineBody)),
    }) + "\n"
  ).toString("base64");
  const batches = proveRecoveryGmailBatchInventory({
    checkpoint,
    recoveryKey: input.recoveryKey,
  });
  const selectedBatch = batches.batches.find(
    ({ batch }) => batch.batchId === input.batchId
  )?.batch;
  if (!selectedBatch) fail();
  const completed: RecoveryGmailCaptureCompletedEvidence[] = [];
  let unfinished: Family | undefined;
  for (let index = 0; index < all.length; index++) {
    const item = all[index]!;
    if (item.record.priorCompleted.count !== completed.length || unfinished)
      fail();
    authenticateRecoveryGmailCaptureAdmission({
      checkpoint,
      recoveryKey: input.recoveryKey,
      admission: item.admission,
      priorCompleted: completed,
      unfinishedAdmissions: [item.admission],
    });
    if (
      !item.admissionInstalled &&
      (item.result || item.resultCandidate || item.observations[2]?.candidate)
    )
      fail();
    for (const observation of item.observations.slice(2))
      if (observation.candidate)
        validateRecoveredBackupKeyBytes(
          observation.candidate.bytes,
          input.recoveryKey
        );
    if (item.result)
      completed.push({ admission: item.admission, result: item.result });
    else unfinished = item;
  }
  if (
    unfinished &&
    (unfinished.batchId !== input.batchId ||
      canonicalJson(unfinished.record.correctionOfByMessageId) !==
        canonicalJson(input.correctionOfByMessageId ?? {}))
  )
    fail("RECOVERY_GMAIL_CAPTURE_UNFINISHED_ADMISSION");
  const selected = all.find((entry) => entry.batchId === input.batchId);
  if (
    selected &&
    canonicalJson(selected.record.correctionOfByMessageId) !==
      canonicalJson(input.correctionOfByMessageId ?? {})
  )
    fail();
  const journalPath = join(operator, "weekly-runs.sqlite");
  let identity = assertReadOnlySqliteFiles(journalPath);
  const entries = opened.inventoryGmailCapture();
  const installedIntent = all.some((item) => item.admissionInstalled);
  if (!installedIntent) {
    // No canonical intent means SQLite has never been opened for capture. Bind
    // its physical files too; the active-capture inventory deliberately omits them.
    const untouched = opened
      .inventory()
      .filter(
        (entry) =>
          entry.path !== "recovery-gmail-capture" &&
          !entry.path.startsWith("recovery-gmail-capture/")
      );
    if (
      untouched.length !== opened.report.entryCount ||
      sha256(canonicalJson(untouched)) !== opened.report.treeSha256
    )
      fail();
    initialJournalEntries = untouched.filter((entry) =>
      journalPattern.test(entry.path)
    );
  }
  const journal = installedIntent
    ? readWeeklyJournalRecoverySnapshotReadOnly(journalPath)
    : Buffer.from(checkpoint.journal, "base64");
  const stages = captureStages(root, entries, all, batches, journal);
  const inventory = checkpointInventory(opened, root, entries, journal, stages);
  const binding: RecoveryGmailCaptureBinding = {
    capsuleSha256: sha256(input.archive),
    retirementSha256: sha256(input.retirementReceipt),
    checkpointSha256: opened.report.checkpointSha256,
    preparedReceiptSha256: opened.receiptSha256,
    preparedTreeSha256: opened.report.treeSha256,
    preparedImmutableTreeSha256: normalized(
      entries,
      inventory,
      checkpoint,
      root,
      stages
    ),
    physicalRoot: root,
    physicalOperatorDirectory: operator,
    physicalNpmPath: resolve(input.npmCli),
    keyId: sha256(input.recoveryKey),
  };
  if (all.length) same(binding, all[0]!.record.binding);
  else {
    same(inventory, {
      files: checkpoint.files,
      directories: checkpoint.directories,
      journal: inventory.journal,
    });
    const before = validateWeeklyJournalRecoverySnapshot(
        Buffer.from(checkpoint.journal, "base64")
      ),
      after = validateWeeklyJournalRecoverySnapshot(
        Buffer.from(inventory.journal, "base64")
      );
    same(
      {
        ...after,
        digest: undefined,
        ownership: after.ownership.map((row) => ({
          ...row,
          expiresAtEpochMs: 0,
        })),
      },
      {
        ...before,
        digest: undefined,
        ownership: before.ownership.map((row) => ({
          ...row,
          expiresAtEpochMs: 0,
        })),
      }
    );
  }
  const last = all.at(-1);
  let ownOwnership: Ownership | undefined;
  const delta = (snapshot?: Buffer) => {
    opened.assertRuntime();
    assertWorkingKey();
    for (const [path, expected] of scopes.getStore()?.transients ?? [])
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink > 2 ||
          (stat.size === 0 && stages.has(path)) ||
          (stat.size !== 0 &&
            !readAliased(path, expected.length).equals(expected)) ||
          (scopes.getStore()?.transientIdentities.has(path) &&
            (scopes.getStore()!.transientIdentities.get(path)!.dev !==
              stat.dev ||
              scopes.getStore()!.transientIdentities.get(path)!.ino !==
                stat.ino))
        )
          fail();
      }
    identity = assertReadOnlySqliteFiles(journalPath, {
      main: identity.main,
      wal: null,
      shm: null,
    });
    const actual = opened.inventoryGmailCapture();
    const observedFamily = family(root);
    let journal = snapshot;
    if (
      !journal &&
      observedFamily.some((item) =>
        existsSync(
          join(root, "recovery-gmail-capture", item.batchId, "admission.json")
        )
      )
    )
      journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    if (!journal) {
      if (!initialJournalEntries) fail();
      for (const suffix of ["", "-wal", "-shm"]) {
        const path = "operator/weekly-runs.sqlite" + suffix,
          entry = initialJournalEntries.find((entry) => entry.path === path);
        if (entry) {
          if (
            entry.kind !== "file" ||
            sha256(regular(join(root, path), 512 * 1024 * 1024)) !==
              entry.sha256
          )
            fail();
        } else if (existsSync(join(root, path))) fail();
      }
      journal = Buffer.from(checkpoint.journal, "base64");
    }
    const currentStages = captureStages(
      root,
      actual,
      observedFamily,
      batches,
      journal
    );
    for (const [path, stage] of currentStages) {
      const before = stages.get(path),
        own = scopes.getStore();
      if (before) {
        if (
          before.dev !== stage.dev ||
          before.ino !== stage.ino ||
          !before.bytes.equals(stage.bytes)
        )
          fail();
      } else if (!own?.transients.has(path)) fail();
    }
    const inventory = checkpointInventory(
      opened,
      root,
      actual,
      journal,
      currentStages
    );
    if (
      normalized(actual, inventory, checkpoint, root, currentStages) !==
      binding.preparedImmutableTreeSha256
    )
      fail();
    // Reenumerate the fixed family on every check; no arbitrary sibling admission is ignored.
    const observed = observedFamily;
    const own = scopes.getStore();
    if (
      observed.some(
        (item) =>
          !all.some((before) => before.batchId === item.batchId) &&
          !own?.metadata.has(
            join(root, "recovery-gmail-capture", item.batchId, "admission.json")
          )
      )
    )
      fail();
    for (const item of observed) {
      const admission = own?.metadata.get(
        join(root, "recovery-gmail-capture", item.batchId, "admission.json")
      );
      const result =
        own?.metadata.get(
          join(root, "recovery-gmail-capture", item.batchId, "result.json")
        ) ??
        all.find((before) => before.batchId === item.batchId)?.resultCandidate;
      if (admission && !item.admission.equals(admission)) fail();
      if (item.result && admission && (!result || !item.result.equals(result)))
        fail();
      if (
        item.resultCandidate &&
        (!result || !item.resultCandidate.equals(result))
      )
        fail();
    }
    for (const item of all) {
      const now = observed.find((value) => value.batchId === item.batchId);
      if (
        !now ||
        !now.admission.equals(item.admission) ||
        (item.result && !now.result?.equals(item.result)) ||
        (item.resultCandidate &&
          !(now.result ?? now.resultCandidate)?.equals(item.resultCandidate))
      )
        fail();
    }
    return inventory;
  };
  const proofFor = (
    item: Family,
    actual: Inventory,
    prior: RecoveryGmailCaptureCompletedEvidence[],
    ownership?: Ownership
  ) =>
    proveRecoveryGmailCaptureDelta({
      checkpoint,
      recoveryKey: input.recoveryKey,
      admission: item.admission,
      priorCompleted: prior,
      unfinishedAdmissions: [item.admission],
      current: actual,
      ownProductionOwnership: ownership,
    });
  if (last) {
    const prior = completed.slice(0, last.result ? -1 : undefined);
    const actualOwner = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(inventory.journal, "base64")
    ).ownership.find((row) => row.scope === production)!;
    if (!last.result) {
      const previous = completed.at(-1),
        baselineOwner = previous
          ? (JSON.parse(previous.result.toString("utf8"))
              .productionOwnership as Ownership)
          : validateWeeklyJournalRecoverySnapshot(
              Buffer.from(checkpoint.journal, "base64")
            ).ownership.find((row) => row.scope === production)!;
      if (
        canonicalJson(actualOwner) !== canonicalJson(baselineOwner) &&
        (actualOwner.fence <= baselineOwner.fence ||
          !selectedBatch.snapshots.some(
            (snapshot) =>
              actualOwner.owner ===
              leaseOwner(
                last.admission,
                snapshot.rawMessage.id,
                actualOwner.fence
              )
          ))
      )
        fail("RECOVERY_GMAIL_CAPTURE_UNRELATED_LEASE");
    }
    ownOwnership = actualOwner;
    proofFor(last, inventory, prior, actualOwner);
    if (last.result || last.resultCandidate)
      same(
        (last.result ?? last.resultCandidate)!.toString("base64"),
        createRecoveryGmailCaptureResult({
          checkpoint,
          recoveryKey: input.recoveryKey,
          admission: last.admission,
          priorCompleted: prior,
          unfinishedAdmissions: [last.admission],
          current: inventory,
          ownProductionOwnership: actualOwner,
        }).toString("base64")
      );
  }
  if (!selected)
    createRecoveryGmailCaptureAdmission({
      checkpoint,
      recoveryKey: input.recoveryKey,
      binding,
      batchId: input.batchId,
      correctionOfByMessageId: input.correctionOfByMessageId,
      admittedAtEpochMs: Date.now(),
      priorCompleted: completed,
      unfinishedAdmissions: [],
    });
  return {
    input,
    root,
    operator,
    opened,
    checkpoint,
    binding,
    all,
    completed,
    selected,
    selectedBatch,
    unfinished,
    inventory,
    delta,
    proofFor,
    ownOwnership,
    stages,
    needsRepair: stages.size > 0,
  };
}

/** Independently authenticate physical/runtime/family evidence. Performs no cleanup or writes. */
export function inspectRecoveryGmailCaptureAdmission(
  input: RecoveryGmailCaptureInput
): {
  status: "capture-pending" | "capture-partial" | "capture-complete";
  activationAllowed: false;
  captureAllowed: false;
  batchId: string;
  admissionSha256?: string;
  resultSha256?: string;
  receipts: RecoveryGmailCaptureDeltaProof["receipts"];
} {
  const opened = open(copyInput(input));
  const selected = opened.selected;
  const status =
    selected?.result && !opened.needsRepair
      ? "capture-complete"
      : selected
        ? "capture-partial"
        : "capture-pending";
  const rows = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(opened.inventory.journal, "base64")
  ).intakeEvidence;
  const receipts =
    selected?.result || selected?.resultCandidate
      ? opened.selectedBatch.snapshots
          .map((snapshot) => {
            const source = rows
              .filter((row) => row.kind === "source")
              .map(
                (row) =>
                  JSON.parse(
                    Buffer.from(row.bytes, "base64").toString("utf8")
                  ) as Record<string, unknown>
              )
              .find(
                (receipt) =>
                  receipt.accountSha256 ===
                    opened.selectedBatch.accountSha256 &&
                  receipt.editionId ===
                    opened.selectedBatch.expectedEditionId &&
                  receipt.sourceSha256 ===
                    sha256(
                      selectSteveEmailPlaintext(snapshot.fullMessage.payload)
                        .source
                    )
              );
            if (!source) return undefined;
            return {
              receiptId: String(source.receiptId),
              sourceSha256: String(source.sourceSha256),
              firstObservedAtEpochMs: Number(source.firstObservedAtEpochMs),
              disposition: rows.some(
                (row) =>
                  row.kind === "correction" && row.id === source.receiptId
              )
                ? ("ready" as const)
                : (source.disposition as "ready" | "review-required"),
            };
          })
          .filter(
            (
              value
            ): value is RecoveryGmailCaptureDeltaProof["receipts"][number] =>
              value !== undefined
          )
      : [];
  opened.delta();
  return {
    status,
    activationAllowed: false,
    captureAllowed: false,
    batchId: input.batchId,
    ...(selected ? { admissionSha256: sha256(selected.admission) } : {}),
    ...(selected?.result || selected?.resultCandidate
      ? { resultSha256: sha256((selected.result ?? selected.resultCandidate)!) }
      : {}),
    receipts,
  };
}

async function execute(
  input: RecoveryGmailCaptureInput,
  interruption?: CaptureInterruption
): Promise<RecoveryGmailCaptureReport> {
  input = copyInput(input);
  const root = resolve(input.destination),
    checkout = join(root, "checkout"),
    runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  if (
    runtimeRoot !== checkout ||
    process.cwd() !== checkout ||
    process.env.ZIVV_RECOVERY_GMAIL_CAPTURE_EXECUTOR !== "1" ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    !process.execArgv.includes(
      pathToFileURL(join(root, "bootstrap/module-boundary.mjs")).href
    )
  )
    fail("RECOVERY_GMAIL_CAPTURE_RETAINED_EXECUTOR_REQUIRED");
  if (
    interruption === "pause-before-key-guard" &&
    (typeof process.send !== "function" ||
      !process.connected ||
      !process.channel)
  )
    fail("RECOVERY_GMAIL_CAPTURE_HANDSHAKE_REQUIRED");
  const initial = open(input);
  if (initial.selected?.result && !initial.needsRepair) {
    const report = inspectRecoveryGmailCaptureAdmission(input);
    return {
      ...report,
      status: "capture-complete",
      admissionSha256: report.admissionSha256!,
      resultSha256: report.resultSha256!,
    };
  }
  const admission =
    initial.selected?.admission ??
    createRecoveryGmailCaptureAdmission({
      checkpoint: initial.checkpoint,
      recoveryKey: input.recoveryKey,
      binding: initial.binding,
      batchId: input.batchId,
      correctionOfByMessageId: input.correctionOfByMessageId,
      admittedAtEpochMs: Date.now(),
      priorCompleted: initial.completed,
      unfinishedAdmissions: [],
    });
  const prior = initial.selected
    ? initial.completed.slice(0, initial.selected.record.priorCompleted.count)
    : initial.completed;
  const repairReport =
    initial.selected?.result || initial.selected?.resultCandidate
      ? inspectRecoveryGmailCaptureAdmission(input)
      : undefined;
  const selected: Family = {
    batchId: input.batchId,
    admission,
    record: authenticateRecoveryGmailCaptureAdmission({
      checkpoint: initial.checkpoint,
      recoveryKey: input.recoveryKey,
      admission,
      priorCompleted: prior,
      unfinishedAdmissions: [admission],
    }),
    admissionInstalled: Boolean(initial.selected?.admissionInstalled),
    observations: [],
    stages: [],
  };
  const directory = join(root, "recovery-gmail-capture", input.batchId),
    admissionPath = join(directory, "admission.json"),
    resultPath = join(directory, "result.json");
  const scope: Scope = {
    active: true,
    deadline: Date.now() + 120000,
    operator: initial.operator,
    root,
    phase: "admission",
    assertCurrent: () => {},
    files: new Map(),
    directories: new Set([
      root,
      initial.operator,
      join(root, "recovery-gmail-capture"),
      directory,
      ...["admission-stage", "result-stage", "key-stage"].map((name) =>
        join(directory, name)
      ),
    ]),
    owner: randomUUID(),
    fence: 0,
    key: Buffer.from(input.recoveryKey),
    metadata: new Map([[admissionPath, admission]]),
    interruption,
    ownership:
      initial.ownOwnership ??
      validateWeeklyJournalRecoverySnapshot(
        Buffer.from(initial.inventory.journal, "base64")
      ).ownership.find((row) => row.scope === production),
    transients: new Map(),
    transientIdentities: new Map(),
  };
  for (const item of initial.all) {
    const path = join(root, "recovery-gmail-capture", item.batchId);
    scope.metadata.set(join(path, "admission.json"), item.admission);
    if (item.result || item.resultCandidate)
      scope.metadata.set(
        join(path, "result.json"),
        (item.result ?? item.resultCandidate)!
      );
    scope.directories.add(path);
    for (const stage of ["admission-stage", "result-stage", "key-stage"])
      scope.directories.add(join(path, stage));
  }
  for (const [path, stage] of initial.stages) {
    scope.transients.set(path, stage.bytes);
    scope.transientIdentities.set(path, { dev: stage.dev, ino: stage.ino });
    if (stage.target === join(initial.operator, keyName))
      scope.metadata.set(stage.target, stage.bytes);
    if (
      stage.target.startsWith(
        join(initial.operator, "email-intake") +
          (process.platform === "win32" ? "\\" : "/")
      ) &&
      existsSync(stage.target)
    ) {
      scope.metadata.set(stage.target, stage.bytes);
      scope.directories.add(dirname(stage.target));
    }
  }
  let ownership = scope.ownership;
  let handshake: CapturePauseHandshake | undefined;
  scope.assertCurrent = (snapshot) => {
    if (!scope.active || Date.now() >= scope.deadline)
      fail("RECOVERY_GMAIL_CAPTURE_EXPIRED");
    handshake?.assertCurrent();
    const actual = initial.delta(snapshot);
    // The known invocation lease may update only production bookkeeping.
    const observed = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(actual.journal, "base64")
    ).ownership.find((row) => row.scope === production);
    if (
      canonicalJson(observed) !== canonicalJson(scope.ownership) &&
      canonicalJson(observed) !== canonicalJson(scope.previousOwnership)
    )
      fail();
    ownership = observed;
    scope.observedOwnership = observed;
    const tail = initial.all.at(-1);
    initial.proofFor(
      repairReport && tail ? tail : selected,
      actual,
      repairReport && tail?.result ? initial.completed.slice(0, -1) : prior,
      ownership
    );
  };
  const stop = (point: CaptureInterruption) => {
    if (
      interruption === "expire-after-admission" &&
      point === "admission-saved"
    ) {
      scope.deadline = Math.min(scope.deadline, Date.now() - 1);
      return;
    }
    if (interruption === point)
      fail("RECOVERY_GMAIL_CAPTURE_TEST_INTERRUPTION");
  };
  const escapeGate: { release?: () => void } = {};
  // Kept outside Scope and the escaped task. A real readonly connection keeps
  // shared-memory bookkeeping stable while identical observation reads come
  // and go; no file or metadata is omitted from the physical comparison.
  const escapeObservation: { observer?: DatabaseSync } = {};
  const closeEscapeObservation = () => {
    const observer = escapeObservation.observer;
    delete escapeObservation.observer;
    observer?.close();
  };
  let completed: CaptureOutcome | undefined;
  let executionFailure: { error: unknown } | undefined;
  try {
    completed = await scopes.run(scope, async (): Promise<CaptureOutcome> => {
      scope.assertCurrent();
      for (const item of initial.all)
        installRecoveryIntent(
          join(root, "recovery-gmail-capture", item.batchId, "admission.json"),
          item.admission,
          join(root, "recovery-gmail-capture", item.batchId, "admission-stage")
        );
      installRecoveryIntent(
        admissionPath,
        admission,
        join(directory, "admission-stage")
      );
      stop("admission-saved");
      if (interruption === "authority-escaped-after-admission") {
        // Prove that these exact writer arguments are permitted while the real
        // private scope is active. The later call must differ only by revocation.
        assertRecoveredGmailCaptureFile(admissionPath, admission);
        const journalPath = join(initial.operator, "weekly-runs.sqlite");
        const observer = new DatabaseSync(journalPath, { readOnly: true });
        escapeObservation.observer = observer;
        observer.prepare("SELECT count(*) FROM sqlite_schema").get();
        escapedTaskSnapshot(root, journalPath);
        const before = escapedTaskSnapshot(root, journalPath);
        if (escapedTaskSnapshot(root, journalPath) !== before)
          fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_ESCAPE_UNSTABLE");
        if (
          !scope.active ||
          Date.now() >= scope.deadline ||
          scope.phase !== "admission" ||
          scope.lease
        )
          fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_ESCAPE_CONTEXT");
        const gate = new Promise<void>((release) => {
          escapeGate.release = release;
        });
        // Created inside scopes.run: the actual descendant retains this same
        // ALS object. It does no asynchronous work after its private gate opens.
        const outcome = (async (): Promise<EscapedTaskOutcome> => {
          await gate;
          if (
            scopes.getStore() !== scope ||
            scope.active ||
            scope.phase !== "admission" ||
            scope.lease ||
            scope.key.some((byte) => byte !== 0)
          )
            return "invalid-context";
          try {
            writeDurableFile(admissionPath, admission);
            return "allowed";
          } catch (error) {
            return error instanceof Error &&
              error.message === "RECOVERY_GMAIL_CAPTURE_EXPIRED"
              ? "refused"
              : "wrong-refusal";
          }
        })().then(
          (value) => value,
          (): EscapedTaskOutcome => "wrong-refusal"
        );
        return { kind: "escaped-after-admission", before, outcome };
      }
      if (interruption === "authority-nested-executor-after-admission") {
        // The nested call must take the genuine retained entry and encounter
        // the existing installation-writer preflight with this admission scope.
        assertRecoveredGmailCaptureFile(admissionPath, admission);
        const journalPath = join(initial.operator, "weekly-runs.sqlite");
        const observer = new DatabaseSync(journalPath, { readOnly: true });
        escapeObservation.observer = observer;
        try {
          observer.prepare("SELECT count(*) FROM sqlite_schema").get();
          escapedTaskSnapshot(root, journalPath);
          const before = escapedTaskSnapshot(root, journalPath);
          if (escapedTaskSnapshot(root, journalPath) !== before)
            fail("RECOVERY_GMAIL_CAPTURE_NESTED_EXECUTOR_UNSTABLE");
          if (
            !scope.active ||
            Date.now() >= scope.deadline ||
            scope.phase !== "admission" ||
            scope.lease
          )
            fail("RECOVERY_GMAIL_CAPTURE_NESTED_EXECUTOR_CONTEXT");
          try {
            await executeRecoveredGmailBatchCapture(input);
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== "RECOVERY_GMAIL_CAPTURE_SCOPE_EXCEEDED"
            )
              fail("RECOVERY_GMAIL_CAPTURE_NESTED_EXECUTOR_REFUSAL");
            if (escapedTaskSnapshot(root, journalPath) !== before)
              fail("RECOVERY_GMAIL_CAPTURE_NESTED_EXECUTOR_CHANGED");
            if (
              scopes.getStore() !== scope ||
              !scope.active ||
              scope.phase !== "admission" ||
              scope.lease
            )
              fail("RECOVERY_GMAIL_CAPTURE_NESTED_EXECUTOR_CONTEXT");
            fail("RECOVERY_GMAIL_CAPTURE_NESTED_EXECUTOR_VERIFIED");
          }
          fail("RECOVERY_GMAIL_CAPTURE_NESTED_EXECUTOR_ALLOWED");
        } finally {
          closeEscapeObservation();
        }
      }
      scope.phase = "key";
      if (interruption === "pause-before-key-guard") {
        scope.assertCurrent();
        handshake = pauseBeforeKeyGuard(scope.deadline);
        await handshake.waitForGo;
      }
      for (const item of initial.all)
        if (item.observations[2]?.candidate)
          installRecoveredBackupKey(initial.operator, input.recoveryKey, {
            stagingDirectory: join(
              root,
              "recovery-gmail-capture",
              item.batchId,
              "key-stage"
            ),
          });
      installRecoveredBackupKey(initial.operator, input.recoveryKey, {
        stagingDirectory: join(directory, "key-stage"),
      });
      scope.assertCurrent();
      stop("key-installed");
      scope.phase = "result";
      for (const item of initial.all)
        if (item.result || item.resultCandidate)
          installRecoveryIntent(
            join(root, "recovery-gmail-capture", item.batchId, "result.json"),
            (item.result ?? item.resultCandidate)!,
            join(root, "recovery-gmail-capture", item.batchId, "result-stage")
          );
      for (const stage of initial.stages.values())
        if (
          scope.metadata.has(stage.target) &&
          stage.target.startsWith(
            join(initial.operator, "email-intake") +
              (process.platform === "win32" ? "\\" : "/")
          )
        )
          repairRecoveredGmailCaptureFile(stage.target, stage.bytes);
      if (repairReport) {
        scope.assertCurrent();
        return {
          ...repairReport,
          status: "capture-complete",
          admissionSha256: repairReport.admissionSha256!,
          resultSha256: repairReport.resultSha256!,
        };
      }
      scope.phase = "capture";
      for (const snapshot of initial.selectedBatch.snapshots) {
        const intake = {
          operatorDirectory: initial.operator,
          accountId: initial.selectedBatch.accountId,
          expectedEditionId: initial.selectedBatch.expectedEditionId,
          rawMessage: structuredClone(snapshot.rawMessage),
          fullMessage: structuredClone(snapshot.fullMessage),
          observedAtEpochMs: snapshot.observedAtEpochMs,
          ...(input.correctionOfByMessageId?.[snapshot.rawMessage.id]
            ? {
                correctionOf:
                  input.correctionOfByMessageId[snapshot.rawMessage.id],
              }
            : {}),
        };
        scope.current = await prepareSteveEmailCapture(intake);
        scope.input = intake;
        scope.intakeStarted = false;
        const prepared = scope.current,
          body = join(
            initial.operator,
            "email-intake",
            prepared.accountSha256,
            "bodies",
            prepared.receiptId
          ),
          message = join(
            initial.operator,
            "email-intake",
            prepared.accountSha256,
            "messages",
            sha256(prepared.messageId)
          );
        scope.files = new Map([
          [join(body, "source.txt"), prepared.source],
          [join(message, "message.eml"), prepared.raw],
          [
            join(message, "capture.json"),
            Buffer.from(
              canonicalJson({
                schemaVersion: 1,
                messageId: prepared.messageId,
                accountSha256: prepared.accountSha256,
                rawSha256: prepared.rawSha256,
                sourceSha256: prepared.sourceSha256,
                receiptId: prepared.receiptId,
                receivedAtEpochMs: prepared.receivedAtEpochMs,
              }) + "\n"
            ),
          ],
        ]);
        const currentJournal = validateWeeklyJournalRecoverySnapshot(
          Buffer.from(initial.delta().journal, "base64")
        );
        const originalSources = new Set(
          validateWeeklyJournalRecoverySnapshot(
            Buffer.from(initial.checkpoint.journal, "base64")
          )
            .intakeEvidence.filter((row) => row.kind === "source")
            .map((row) => row.id)
        );
        const ownReceipt = currentJournal.intakeEvidence.find(
          (row) =>
            row.scope === production &&
            row.kind === "source" &&
            row.id === prepared.receiptId &&
            !originalSources.has(row.id)
        );
        if (ownReceipt) {
          const receipt = JSON.parse(
            Buffer.from(ownReceipt.bytes, "base64").toString("utf8")
          ) as Record<string, unknown>;
          if (receipt.messageId === prepared.messageId) {
            same(
              {
                rawSha256: receipt.rawSha256,
                receivedAtEpochMs: receipt.receivedAtEpochMs,
                acquisitionObservedAtEpochMs:
                  receipt.acquisitionObservedAtEpochMs,
                senderDate: receipt.senderDate,
                partPath: receipt.partPath,
                receiverProfile: receipt.receiverProfile,
              },
              {
                rawSha256: prepared.rawSha256,
                receivedAtEpochMs: prepared.receivedAtEpochMs,
                acquisitionObservedAtEpochMs:
                  prepared.acquisitionObservedAtEpochMs,
                senderDate: prepared.senderDate,
                partPath: prepared.partPath,
                receiverProfile: prepared.receiverProfile,
              }
            );
          }
        }
        for (const row of currentJournal.intakeEvidence.filter(
          (row) => row.scope === production && row.id === prepared.receiptId
        ))
          scope.files.set(
            join(
              body,
              row.kind === "source"
                ? "receipt.json"
                : "correction-approval.json"
            ),
            Buffer.from(row.bytes, "base64")
          );
        const sourceRow = currentJournal.intakeEvidence.find(
          (row) =>
            row.scope === production &&
            row.kind === "source" &&
            row.id === prepared.receiptId
        );
        if (sourceRow) {
          const receipt = JSON.parse(
            Buffer.from(sourceRow.bytes, "base64").toString("utf8")
          ) as { disposition: string; correctionOf: string | null };
          const approvalRow = currentJournal.intakeEvidence.find(
            (row) =>
              row.scope === production &&
              row.kind === "correction" &&
              row.id === prepared.receiptId
          );
          const approvedParent = approvalRow
            ? (
                JSON.parse(
                  Buffer.from(approvalRow.bytes, "base64").toString("utf8")
                ) as { correctionOf: string }
              ).correctionOf
            : undefined;
          const correctionMatches =
            !intake.correctionOf ||
            (receipt.disposition === "ready"
              ? receipt.correctionOf === intake.correctionOf
              : approvedParent === intake.correctionOf);
          // Preparation authenticates actual MIME/receiver fields; the exact
          // admission delta and these canonical bytes prove this message is
          // already complete. A journal-first or unapproved repair still runs
          // the ordinary intake path with a fresh bounded production lease.
          if (
            correctionMatches &&
            ![...initial.stages.values()].some(
              (stage) => scope.files.has(stage.target) && existsSync(stage.path)
            ) &&
            [...scope.files].every(
              ([path, bytes]) =>
                existsSync(path) && regular(path, 8 * 1024 * 1024).equals(bytes)
            )
          ) {
            scope.assertCurrent();
            continue;
          }
        }
        for (const path of scope.files.keys())
          for (
            let parent = dirname(path);
            parent !== initial.operator;
            parent = dirname(parent)
          )
            scope.directories.add(parent);
        const owner = currentJournal.ownership.find(
          (row) => row.scope === production
        );
        scope.fence = Number(owner?.fence ?? 0) + 1;
        scope.owner = leaseOwner(admission, prepared.messageId, scope.fence);
        scope.lease = undefined;
        await captureSteveEmail(intake);
        scope.assertCurrent();
      }
      stop("capture-files-written");
      scope.phase = "result";
      const actual = initial.delta(),
        result = createRecoveryGmailCaptureResult({
          checkpoint: initial.checkpoint,
          recoveryKey: input.recoveryKey,
          admission,
          priorCompleted: prior,
          unfinishedAdmissions: [admission],
          current: actual,
          ownProductionOwnership: ownership,
        });
      scope.metadata.set(resultPath, result);
      installRecoveryIntent(
        resultPath,
        result,
        join(directory, "result-stage")
      );
      scope.assertCurrent();
      stop("result-saved");
      const proof = initial.proofFor(
        selected,
        initial.delta(),
        prior,
        ownership
      );
      return {
        status: "capture-complete",
        activationAllowed: false,
        captureAllowed: false,
        batchId: input.batchId,
        admissionSha256: sha256(admission),
        resultSha256: sha256(result),
        receipts: proof.receipts,
      };
    });
  } catch (error) {
    executionFailure = { error };
  } finally {
    scope.active = false;
    scope.key.fill(0);
    escapeGate.release?.();
    handshake?.close();
  }
  if (executionFailure) {
    closeEscapeObservation();
    throw executionFailure.error;
  }
  if (!completed) {
    closeEscapeObservation();
    fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_ESCAPE_OUTCOME");
  }
  if ("kind" in completed) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: EscapedTaskOutcome;
    try {
      try {
        outcome = await Promise.race([
          completed.outcome,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error("RECOVERY_GMAIL_CAPTURE_AUTHORITY_ESCAPE_TIMEOUT")
                ),
              5000
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      // This continuation is outside the inherited, revoked ALS context. The
      // descendant's only post-gate work is synchronous and has now settled.
      if (
        scopes.getStore() ||
        scope.active ||
        scope.key.some((byte) => byte !== 0) ||
        outcome !== "refused"
      )
        fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_ESCAPE_REFUSAL");
      if (
        escapedTaskSnapshot(
          root,
          join(initial.operator, "weekly-runs.sqlite")
        ) !== completed.before
      )
        fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_ESCAPE_CHANGED");
    } finally {
      closeEscapeObservation();
    }
    fail("RECOVERY_GMAIL_CAPTURE_AUTHORITY_ESCAPE_VERIFIED");
  }
  closeEscapeObservation();
  return completed;
}
/** This closed retained entry independently authenticates every input before effects. */
export const executeRecoveredGmailBatchCapture = (
  input: RecoveryGmailCaptureInput
) => execute(input);
/** Fixed interruption points only: no injected callback, executor or permission. */
export function executeRecoveredGmailBatchCaptureForTest(
  input: RecoveryGmailCaptureInput,
  interruption: CaptureInterruption
): Promise<RecoveryGmailCaptureReport> {
  if (!RECOVERY_GMAIL_CAPTURE_INTERRUPTION_POINTS.includes(interruption))
    fail();
  return execute(input, interruption);
}
