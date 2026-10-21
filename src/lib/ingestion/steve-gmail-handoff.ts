import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { basename, join, posix, resolve, win32 } from "node:path";
import {
  loadBackupKey,
  secureOperatorDirectory,
  writeDurableFile,
} from "./encrypted-backup.js";
import {
  assertOperatorNotQuarantined,
  resolvePrivateCandidateDirectory,
} from "./private-artifacts.js";
import {
  captureSteveEmail,
  resolveRetainedSteveEmailMessages,
  selectSteveEmailPlaintext,
  type SteveEmailMessageResolution,
  type SteveEmailReceipt,
} from "./steve-email-intake.js";
import { readSteveGmailWindow } from "./steve-gmail-acquisition.js";
import {
  projectSteveGmailSnapshot,
  type SteveGmailSnapshot,
} from "./steve-gmail-projection.js";
import { sha256 } from "./steve-preflight.js";
import { canonicalJson } from "./sqlite-store.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
  WeeklyRunJournal,
} from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";
import { formatLosAngelesDate, localDateStartEpochMs } from "./weekly.js";

const productionScope = "prodigic/zivv/production";
const batchKind = "zivv-steve-gmail-batch";
const batchVersion = 1;
const signatureDomain = "zivv-steve-gmail-batch/v1\0";
const maxSnapshotsBytes = 32 * 1024 * 1024;
const maxBatchMetadataBytes = 64 * 1024;
const maxBatchBytes = maxSnapshotsBytes + maxBatchMetadataBytes;
const maxSnapshots = 100;
const maxBatchFiles = 1000;
// Bounded retained registry, including staging aliases; never prune automatically.
const maxRegistryBytes = 256 * 1024 * 1024;

interface UnsignedSteveGmailBatch {
  kind: typeof batchKind;
  version: typeof batchVersion;
  operatorDirectory: string;
  keyId: string;
  batchId: string;
  accountId: string;
  accountSha256: string;
  expectedEditionId: string;
  startEpochMs: number;
  endEpochMs: number;
  firstSavedAtEpochMs: number;
  snapshots: SteveGmailSnapshot[];
}

export interface SteveGmailHandoffBatch extends UnsignedSteveGmailBatch {
  signature: string;
}

export class SteveGmailHandoffError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function fail(code: string): never {
  throw new SteveGmailHandoffError(code);
}

function validWindow(start: number, end: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start
  )
    fail("INVALID_GMAIL_WINDOW");
}

function validEdition(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("INVALID_STEVE_EDITION");
  const start = localDateStartEpochMs(value);
  if (
    formatLosAngelesDate(start) !== value ||
    new Date(start).getUTCDay() !== 5
  )
    fail("INVALID_STEVE_EDITION");
}

function operatorPath(directory: string): string {
  try {
    const requested = resolve(directory);
    const actual = resolvePrivateCandidateDirectory(requested);
    if (actual !== requested) fail("UNSAFE_GMAIL_BATCH_DIRECTORY");
    return actual;
  } catch {
    return fail("UNSAFE_GMAIL_BATCH_DIRECTORY");
  }
}

function pathKind(path: string): "missing" | "directory" | "file" {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail("UNSAFE_GMAIL_BATCH_DIRECTORY");
    if (stat.isDirectory()) return "directory";
    if (stat.isFile() && stat.nlink === 1) return "file";
    return fail("UNSAFE_GMAIL_BATCH_DIRECTORY");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "missing";
    throw error;
  }
}

function safeDirectories(operatorDirectory: string): {
  acquisitionDirectory: string;
  batchDirectory: string;
  exists: boolean;
  empty: boolean;
} {
  const acquisitionDirectory = join(operatorDirectory, "email-acquisition");
  const batchDirectory = join(acquisitionDirectory, "batches");
  const acquisitionKind = pathKind(acquisitionDirectory);
  if (acquisitionKind === "file") fail("PENDING_STEVE_EMAIL_INTAKE");
  if (acquisitionKind === "missing")
    return { acquisitionDirectory, batchDirectory, exists: false, empty: true };
  const acquisitionEntries = readdirSync(acquisitionDirectory);
  if (acquisitionEntries.some((entry) => entry !== "batches"))
    fail("PENDING_STEVE_EMAIL_INTAKE");
  const batchKind = pathKind(batchDirectory);
  if (batchKind === "file") fail("PENDING_STEVE_EMAIL_INTAKE");
  if (batchKind === "missing")
    return {
      acquisitionDirectory,
      batchDirectory,
      exists: false,
      empty: acquisitionEntries.length === 0,
    };
  const entries = readdirSync(batchDirectory);
  return {
    acquisitionDirectory,
    batchDirectory,
    exists: true,
    empty: entries.length === 0,
  };
}

function keyPath(operatorDirectory: string): string {
  return join(
    operatorDirectory,
    process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
  );
}

function signingKey(operatorDirectory: string): Buffer {
  const path = keyPath(operatorDirectory);
  if (pathKind(path) !== "file") fail("PENDING_STEVE_EMAIL_INTAKE");
  try {
    return loadBackupKey(operatorDirectory, false);
  } catch {
    return fail("PENDING_STEVE_EMAIL_INTAKE");
  }
}

function apiPart(part: SteveGmailSnapshot["fullMessage"]["payload"]): unknown {
  const result: Record<string, unknown> = { mimeType: part.mime_type };
  if (part.filename !== undefined) result.filename = part.filename;
  if (part.headers !== undefined) result.headers = part.headers;
  if (part.body !== undefined) {
    const body: Record<string, unknown> = { size: part.body.size };
    if (part.body.base64_url_content !== undefined)
      body.data = part.body.base64_url_content;
    if (part.body.content !== undefined) body.content = part.body.content;
    result.body = body;
  }
  if (part.parts !== undefined) result.parts = part.parts.map(apiPart);
  return result;
}

function validateSnapshot(
  value: SteveGmailSnapshot,
  expectedAccountId: string
): SteveGmailSnapshot {
  try {
    const projected = projectSteveGmailSnapshot({
      expectedAccountId,
      profile: { emailAddress: value.accountId },
      messageId: value.rawMessage.id,
      rawMessage: value.rawMessage,
      fullMessage: {
        id: value.fullMessage.id,
        internalDate: String(value.fullMessage.internal_date),
        payload: apiPart(value.fullMessage.payload),
      },
      observedAtEpochMs: value.observedAtEpochMs,
    });
    if (canonicalJson(projected) !== canonicalJson(value))
      fail("INVALID_GMAIL_BATCH");
    return projected;
  } catch (error) {
    if (error instanceof SteveGmailHandoffError) throw error;
    return fail("INVALID_GMAIL_BATCH");
  }
}

function snapshotRawSha256(snapshot: SteveGmailSnapshot): string {
  return sha256(Buffer.from(snapshot.rawMessage.raw, "base64url"));
}

function batchIdFor(input: {
  accountSha256: string;
  expectedEditionId: string;
  startEpochMs: number;
  endEpochMs: number;
  snapshots: SteveGmailSnapshot[];
}): string {
  return sha256(
    canonicalJson([
      batchKind,
      batchVersion,
      input.accountSha256,
      input.expectedEditionId,
      input.startEpochMs,
      input.endEpochMs,
      input.snapshots.map((snapshot) => [
        snapshot.rawMessage.id,
        snapshotRawSha256(snapshot),
      ]),
    ])
  );
}

function validateSnapshots(
  values: SteveGmailSnapshot[],
  expectedAccountId: string,
  startEpochMs: number,
  endEpochMs: number
): SteveGmailSnapshot[] {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > maxSnapshots
  )
    fail("INVALID_GMAIL_BATCH");
  const snapshots = values.map((item) =>
    validateSnapshot(item, expectedAccountId)
  );
  let total = 0;
  const seen = new Set<string>();
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index]!;
    const received = snapshot.fullMessage.internal_date;
    if (received < startEpochMs || received >= endEpochMs)
      fail("INVALID_GMAIL_BATCH");
    if (seen.has(snapshot.rawMessage.id)) fail("INVALID_GMAIL_BATCH");
    seen.add(snapshot.rawMessage.id);
    if (index > 0) {
      const prior = snapshots[index - 1]!;
      if (
        prior.fullMessage.internal_date > received ||
        (prior.fullMessage.internal_date === received &&
          prior.rawMessage.id.localeCompare(snapshot.rawMessage.id) >= 0)
      )
        fail("INVALID_GMAIL_BATCH");
    }
    total += Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (total > maxSnapshotsBytes) fail("GMAIL_WINDOW_LIMIT");
  }
  return snapshots;
}

function unsigned(batch: SteveGmailHandoffBatch): UnsignedSteveGmailBatch {
  const { signature: _signature, ...value } = batch;
  return value;
}

function signature(
  unsignedBatch: UnsignedSteveGmailBatch,
  key: Buffer
): string {
  return createHmac("sha256", key)
    .update(signatureDomain)
    .update(canonicalJson(unsignedBatch))
    .digest("hex");
}

function signBatch(
  batch: UnsignedSteveGmailBatch,
  key: Buffer
): SteveGmailHandoffBatch {
  return { ...batch, signature: signature(batch, key) };
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("PENDING_STEVE_EMAIL_INTAKE");
}

function parseBatch(
  bytes: Buffer,
  path: string,
  operatorDirectory: string,
  key: Buffer
): SteveGmailHandoffBatch {
  if (!bytes.length || bytes.length > maxBatchBytes)
    fail("PENDING_STEVE_EMAIL_INTAKE");
  let text: string;
  let raw: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    raw = JSON.parse(text) as unknown;
  } catch {
    return fail("PENDING_STEVE_EMAIL_INTAKE");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    fail("PENDING_STEVE_EMAIL_INTAKE");
  const value = raw as Record<string, unknown>;
  exactKeys(value, [
    "kind",
    "version",
    "operatorDirectory",
    "keyId",
    "batchId",
    "accountId",
    "accountSha256",
    "expectedEditionId",
    "startEpochMs",
    "endEpochMs",
    "firstSavedAtEpochMs",
    "snapshots",
    "signature",
  ]);
  if (
    canonicalJson(value) + "\n" !== text ||
    value.kind !== batchKind ||
    value.version !== batchVersion ||
    value.operatorDirectory !== operatorDirectory ||
    value.keyId !== sha256(key) ||
    typeof value.batchId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.batchId) ||
    typeof value.accountId !== "string" ||
    typeof value.accountSha256 !== "string" ||
    value.accountSha256 !== sha256(value.accountId) ||
    typeof value.expectedEditionId !== "string" ||
    !Number.isSafeInteger(value.startEpochMs) ||
    !Number.isSafeInteger(value.endEpochMs) ||
    !Number.isSafeInteger(value.firstSavedAtEpochMs) ||
    typeof value.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.signature) ||
    !Array.isArray(value.snapshots)
  )
    fail("PENDING_STEVE_EMAIL_INTAKE");
  try {
    validEdition(value.expectedEditionId);
    validWindow(value.startEpochMs as number, value.endEpochMs as number);
    if (
      (value.firstSavedAtEpochMs as number) < 0 ||
      (value.firstSavedAtEpochMs as number) > Date.now()
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
    const snapshots = validateSnapshots(
      value.snapshots as SteveGmailSnapshot[],
      value.accountId,
      value.startEpochMs as number,
      value.endEpochMs as number
    );
    const parsed = value as unknown as SteveGmailHandoffBatch;
    if (
      snapshots.length !== parsed.snapshots.length ||
      batchIdFor(parsed) !== parsed.batchId ||
      !timingSafeEqual(
        Buffer.from(parsed.signature, "hex"),
        Buffer.from(signature(unsigned(parsed), key), "hex")
      ) ||
      !validBatchFilename(basename(path), parsed.batchId)
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
    return { ...parsed, snapshots };
  } catch (error) {
    if (error instanceof SteveGmailHandoffError) throw error;
    return fail("PENDING_STEVE_EMAIL_INTAKE");
  }
}

function validBatchFilename(name: string, batchId: string): boolean {
  return (
    name === `${batchId}.json` ||
    new RegExp(`^${batchId}\\.json\\.\\d+\\.[a-f0-9]{16}\\.tmp$`).test(name)
  );
}

/** Authenticate supplied canonical batch bytes, without reading the original root.
 * This proves saved acquisition provenance only; it grants no intake or write authority.
 */
export function authenticateSteveGmailBatchBytes(input: {
  bytes: Buffer;
  fileName: string;
  originalOperatorDirectory: string;
  recoveryKey: Buffer;
}): SteveGmailHandoffBatch {
  const root = input.originalOperatorDirectory;
  if (
    typeof root !== "string" ||
    root.length > 4096 ||
    [...root].some((character) => character.charCodeAt(0) < 32) ||
    root.startsWith("\\\\") ||
    root.startsWith("//") ||
    !Buffer.isBuffer(input.bytes) ||
    !Buffer.isBuffer(input.recoveryKey) ||
    input.recoveryKey.length !== 32 ||
    typeof input.fileName !== "string" ||
    !/^[a-f0-9]{64}\.json$/.test(input.fileName)
  )
    fail("INVALID_GMAIL_BATCH");
  const flavor = /^[A-Za-z]:\\/.test(root) ? win32 : posix;
  if (!flavor.isAbsolute(root) || flavor.resolve(root) !== root)
    fail("INVALID_GMAIL_BATCH");
  return parseBatch(input.bytes, input.fileName, root, input.recoveryKey);
}

function readBatchFile(
  path: string,
  operatorDirectory: string,
  key: Buffer,
  allowLinkAlias = false
): SteveGmailHandoffBatch {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.nlink !== 1 && !(allowLinkAlias && stat.nlink === 2)) ||
      stat.size > maxBatchBytes
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
    const bytes = readFileSync(path);
    const after = lstatSync(path);
    if (
      bytes.length !== stat.size ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.nlink !== stat.nlink
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
    return parseBatch(bytes, path, operatorDirectory, key);
  } catch (error) {
    if (error instanceof SteveGmailHandoffError) throw error;
    return fail("PENDING_STEVE_EMAIL_INTAKE");
  }
}

function sameDirectoryIdentity(
  path: string,
  identity: NonNullable<ReturnType<typeof lstatSync>>
): void {
  const current = lstatSync(path);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  )
    fail("PENDING_STEVE_EMAIL_INTAKE");
}

/** Check aggregate storage before allocating/parsing any batch payload. */
function registryEntries(
  directory: string,
  reserveBytes = 0,
  reserveFiles = 0
): string[] {
  const names = readdirSync(directory).sort();
  if (names.length + reserveFiles > maxBatchFiles)
    fail("GMAIL_BATCH_RETENTION_LIMIT");
  let total = reserveBytes;
  for (const name of names) {
    const stat = lstatSync(join(directory, name));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.nlink !== 1 && stat.nlink !== 2) ||
      stat.size > maxBatchBytes
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
    total += stat.size;
    if (!Number.isSafeInteger(total) || total > maxRegistryBytes)
      fail("GMAIL_BATCH_RETENTION_LIMIT");
  }
  return names;
}

/** Repair under the same lease as registration; capture never nests that lease. */
async function recoverSteveGmailBatchStaging(
  operatorDirectory: string
): Promise<void> {
  const dirs = safeDirectories(operatorDirectory);
  if (!dirs.exists || dirs.empty) return;
  const names = registryEntries(dirs.batchDirectory);
  if (
    !names.some((name) =>
      /^[a-f0-9]{64}\.json\.\d+\.[a-f0-9]{16}\.tmp$/.test(name)
    )
  )
    return;
  if (pathKind(join(operatorDirectory, "weekly-runs.sqlite")) !== "file")
    fail("PENDING_STEVE_EMAIL_INTAKE");
  assertOperatorNotQuarantined(operatorDirectory);
  const journal = new WeeklyRunJournal(operatorDirectory);
  let lease;
  try {
    lease = journal.acquire(productionScope);
    await journal.guardOperation(lease, async () =>
      recoverSteveGmailBatchStagingLocked(operatorDirectory)
    );
  } finally {
    try {
      if (lease) journal.release(lease);
    } finally {
      journal.close();
    }
  }
}

/** Recover only authenticated durable stages and exact hard-link aliases. */
function recoverSteveGmailBatchStagingLocked(operatorDirectory: string): void {
  const directories = safeDirectories(operatorDirectory);
  if (!directories.exists) return;
  const names = registryEntries(directories.batchDirectory);
  const stagePattern = /^([a-f0-9]{64})\.json\.(\d+)\.([a-f0-9]{16})\.tmp$/;
  const stages = names.filter((name) => stagePattern.test(name));
  if (stages.length === 0) return;
  if (
    names.some(
      (name) => !/^[a-f0-9]{64}\.json$/.test(name) && !stagePattern.test(name)
    ) ||
    new Set(stages.map((name) => name.match(stagePattern)?.[1])).size !==
      stages.length
  )
    fail("PENDING_STEVE_EMAIL_INTAKE");
  const databasePath = join(operatorDirectory, "weekly-runs.sqlite");
  if (pathKind(databasePath) !== "file") fail("PENDING_STEVE_EMAIL_INTAKE");
  const key = signingKey(operatorDirectory);
  const prepared = stages.map((name) => {
    const stagePath = join(directories.batchDirectory, name);
    const batch = readBatchFile(stagePath, operatorDirectory, key, true);
    return {
      stagePath,
      canonicalPath: join(directories.batchDirectory, `${batch.batchId}.json`),
      batch,
    };
  });
  assertOperatorNotQuarantined(operatorDirectory);
  const inspected = prepared.map((item) => {
    const stageStat = lstatSync(item.stagePath);
    if (
      stageStat.isSymbolicLink() ||
      !stageStat.isFile() ||
      (stageStat.nlink !== 1 && stageStat.nlink !== 2)
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
    const stageBatch = readBatchFile(
      item.stagePath,
      operatorDirectory,
      key,
      true
    );
    if (
      stageBatch.batchId !== item.batch.batchId ||
      !snapshotsStableEqual(stageBatch.snapshots, item.batch.snapshots)
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
    let canonicalExists = true;
    let canonicalStat;
    try {
      canonicalStat = lstatSync(item.canonicalPath);
      if (
        canonicalStat.isSymbolicLink() ||
        !canonicalStat.isFile() ||
        (canonicalStat.nlink !== 1 && canonicalStat.nlink !== 2)
      )
        fail("PENDING_STEVE_EMAIL_INTAKE");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        canonicalExists = false;
      else throw error;
    }
    if (!canonicalExists) {
      if (stageStat.nlink !== 1) fail("PENDING_STEVE_EMAIL_INTAKE");
    } else {
      const canonical = readBatchFile(
        item.canonicalPath,
        operatorDirectory,
        key,
        true
      );
      if (
        canonical.batchId !== item.batch.batchId ||
        !snapshotsStableEqual(canonical.snapshots, item.batch.snapshots) ||
        canonicalStat!.dev !== stageStat.dev ||
        canonicalStat!.ino !== stageStat.ino ||
        canonicalStat!.nlink !== 2 ||
        stageStat.nlink !== 2
      )
        fail("PENDING_STEVE_EMAIL_INTAKE");
    }
    return { ...item, canonicalExists };
  });
  for (const item of inspected) {
    if (!item.canonicalExists) {
      try {
        linkSync(item.stagePath, item.canonicalPath);
      } catch {
        // Concurrent changes remain pending unless the following inode proof succeeds.
      }
    }
    const finalStage = lstatSync(item.stagePath);
    const finalCanonical = lstatSync(item.canonicalPath);
    if (
      finalStage.isSymbolicLink() ||
      finalCanonical.isSymbolicLink() ||
      finalStage.dev !== finalCanonical.dev ||
      finalStage.ino !== finalCanonical.ino ||
      finalStage.nlink !== 2 ||
      finalCanonical.nlink !== 2
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
    unlinkSync(item.stagePath);
    if (lstatSync(item.canonicalPath).nlink !== 1)
      fail("PENDING_STEVE_EMAIL_INTAKE");
  }
  flushDirectory(directories.batchDirectory);
}

/** Authenticate the private registry without key creation, file repair, or journal writes. */
export function readAuthenticatedSteveGmailBatches(input: {
  operatorDirectory: string;
}): SteveGmailHandoffBatch[] {
  const operatorDirectory = operatorPath(input.operatorDirectory);
  const directories = safeDirectories(operatorDirectory);
  if (!directories.exists || directories.empty) return [];
  const names = registryEntries(directories.batchDirectory);
  if (names.some((name) => !/^[a-f0-9]{64}\.json$/.test(name)))
    fail("PENDING_STEVE_EMAIL_INTAKE");
  const acquisitionIdentity = lstatSync(directories.acquisitionDirectory);
  const batchIdentity = lstatSync(directories.batchDirectory);
  if (
    acquisitionIdentity.isSymbolicLink() ||
    !acquisitionIdentity.isDirectory() ||
    batchIdentity.isSymbolicLink() ||
    !batchIdentity.isDirectory()
  )
    fail("PENDING_STEVE_EMAIL_INTAKE");
  const key = signingKey(operatorDirectory);
  const batches = names.map((name) =>
    readBatchFile(
      join(directories.batchDirectory, name),
      operatorDirectory,
      key
    )
  );
  sameDirectoryIdentity(directories.acquisitionDirectory, acquisitionIdentity);
  sameDirectoryIdentity(directories.batchDirectory, batchIdentity);
  if (
    canonicalJson(readdirSync(directories.batchDirectory).sort()) !==
    canonicalJson(names)
  )
    fail("PENDING_STEVE_EMAIL_INTAKE");
  return batches;
}

function validateBatchIdentity(
  batch: SteveGmailHandoffBatch,
  expectedAccountId: string,
  expectedEditionId: string
): void {
  if (
    batch.accountSha256 !== sha256(expectedAccountId) ||
    batch.expectedEditionId !== expectedEditionId
  )
    fail("GMAIL_BATCH_IDENTITY_MISMATCH");
}

function messagePairs(batch: SteveGmailHandoffBatch) {
  return batch.snapshots.map((snapshot) => ({
    messageId: snapshot.rawMessage.id,
    rawSha256: snapshotRawSha256(snapshot),
  }));
}

function resolveBatchMessages(
  operatorDirectory: string,
  expectedAccountId: string,
  expectedEditionId: string,
  batch: SteveGmailHandoffBatch
): SteveEmailMessageResolution[] {
  validateBatchIdentity(batch, expectedAccountId, expectedEditionId);
  const resolved = resolveRetainedSteveEmailMessages({
    operatorDirectory,
    accountId: expectedAccountId,
    expectedEditionId,
    messages: messagePairs(batch),
  });
  return resolved.map((item, index) => {
    if (item.status !== "captured") return item;
    const snapshot = batch.snapshots[index]!;
    if (
      item.messageId !== snapshot.rawMessage.id ||
      item.captureReceivedAtEpochMs !== snapshot.fullMessage.internal_date ||
      !item.source.equals(
        selectSteveEmailPlaintext(snapshot.fullMessage.payload).source
      )
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
    return item;
  });
}

function runLoadExists(
  snapshotBytes: Buffer,
  receipts: SteveEmailReceipt[]
): Set<string> {
  const snapshot = validateWeeklyJournalRecoverySnapshot(snapshotBytes);
  const states = snapshot.runState
    .filter((row) => row.scope === productionScope)
    .map((row) => {
      const state = parseWeeklyRunState(JSON.parse(row.payload) as unknown);
      if (state.runId !== row.id || state.revision !== row.revision)
        fail("PENDING_STEVE_EMAIL_INTAKE");
      return state;
    });
  const loaded = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.disposition !== "ready") continue;
    if (
      states.some(
        (state) =>
          state.source.editionId === receipt.editionId &&
          state.source.deliveryId === receipt.deliveryId &&
          state.source.rawSha256 === receipt.sourceSha256 &&
          state.source.importObservedAtEpochMs ===
            receipt.firstObservedAtEpochMs &&
          state.stages.some(
            (stage) => stage.stage === "load" && stage.status === "succeeded"
          )
      )
    )
      loaded.add(receipt.receiptId);
  }
  return loaded;
}

export interface SteveGmailHandoffBatchStatus {
  batchId: string;
  firstSavedAtEpochMs: number;
  messageCount: number;
  capturedCount: number;
  capturePendingCount: number;
  loadPendingCount: number;
  status: "capture-pending" | "load-pending" | "complete";
}

export function readSteveGmailHandoffStatus(input: {
  operatorDirectory: string;
  expectedAccountId: string;
  expectedEditionId: string;
}): { batches: SteveGmailHandoffBatchStatus[] } {
  validEdition(input.expectedEditionId);
  const operatorDirectory = operatorPath(input.operatorDirectory);
  const batches = readAuthenticatedSteveGmailBatches({ operatorDirectory })
    .filter(
      (batch) =>
        batch.accountSha256 === sha256(input.expectedAccountId) &&
        batch.expectedEditionId === input.expectedEditionId
    )
    .sort(
      (left, right) =>
        left.firstSavedAtEpochMs - right.firstSavedAtEpochMs ||
        left.batchId.localeCompare(right.batchId)
    );
  const journalPath = join(operatorDirectory, "weekly-runs.sqlite");
  let journalSnapshot: Buffer | null = null;
  if (batches.length > 0 && existsSync(journalPath)) {
    try {
      journalSnapshot = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    } catch {
      fail("PENDING_STEVE_EMAIL_INTAKE");
    }
  }
  return {
    batches: batches.map((batch) => {
      let resolved: SteveEmailMessageResolution[];
      try {
        resolved = resolveBatchMessages(
          operatorDirectory,
          input.expectedAccountId,
          input.expectedEditionId,
          batch
        );
      } catch {
        // A partial or conflicting retained capture stays pending. Writable replay
        // will surface the safe intake refusal before any new window is fetched.
        return {
          batchId: batch.batchId,
          firstSavedAtEpochMs: batch.firstSavedAtEpochMs,
          messageCount: batch.snapshots.length,
          capturedCount: 0,
          capturePendingCount: batch.snapshots.length,
          loadPendingCount: 0,
          status: "capture-pending" as const,
        };
      }
      const captured = resolved.filter(
        (
          item
        ): item is Extract<
          SteveEmailMessageResolution,
          { status: "captured" }
        > => item.status === "captured"
      );
      const receipts = [
        ...new Map(
          captured.map((item) => [item.receipt.receiptId, item.receipt])
        ).values(),
      ];
      const loaded = journalSnapshot
        ? runLoadExists(journalSnapshot, receipts)
        : new Set<string>();
      const capturePendingCount = resolved.filter(
        (item) => item.status === "missing"
      ).length;
      const loadPendingCount = receipts.filter(
        (receipt) => !loaded.has(receipt.receiptId)
      ).length;
      return {
        batchId: batch.batchId,
        firstSavedAtEpochMs: batch.firstSavedAtEpochMs,
        messageCount: batch.snapshots.length,
        capturedCount: captured.length,
        capturePendingCount,
        loadPendingCount,
        status:
          capturePendingCount > 0
            ? "capture-pending"
            : loadPendingCount > 0
              ? "load-pending"
              : "complete",
      };
    }),
  };
}

function snapshotsStableEqual(
  left: SteveGmailSnapshot[],
  right: SteveGmailSnapshot[]
): boolean {
  const withoutObservation = (snapshot: SteveGmailSnapshot) => {
    const { observedAtEpochMs: _observedAtEpochMs, ...body } = snapshot;
    return body;
  };
  return (
    canonicalJson(left.map(withoutObservation)) ===
    canonicalJson(right.map(withoutObservation))
  );
}

function flushDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function installBatch(
  operatorDirectory: string,
  snapshots: SteveGmailSnapshot[],
  input: {
    expectedAccountId: string;
    expectedEditionId: string;
    startEpochMs: number;
    endEpochMs: number;
  }
): SteveGmailHandoffBatch {
  assertOperatorNotQuarantined(operatorDirectory);
  const key = signingKey(operatorDirectory);
  const dirs = safeDirectories(operatorDirectory);
  if (!dirs.exists) secureOperatorDirectory(dirs.batchDirectory);
  else secureOperatorDirectory(dirs.batchDirectory);
  const accountSha256 = sha256(input.expectedAccountId);
  const batchId = batchIdFor({
    accountSha256,
    expectedEditionId: input.expectedEditionId,
    startEpochMs: input.startEpochMs,
    endEpochMs: input.endEpochMs,
    snapshots,
  });
  const path = join(dirs.batchDirectory, `${batchId}.json`);
  if (existsSync(path)) {
    const existing = readBatchFile(path, operatorDirectory, key);
    if (
      existing.accountSha256 !== accountSha256 ||
      existing.expectedEditionId !== input.expectedEditionId ||
      existing.startEpochMs !== input.startEpochMs ||
      existing.endEpochMs !== input.endEpochMs ||
      !snapshotsStableEqual(existing.snapshots, snapshots)
    )
      fail("GMAIL_BATCH_CONFLICT");
    return existing;
  }
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0)
    fail("INVALID_GMAIL_OBSERVATION_TIME");
  const unsignedBatch: UnsignedSteveGmailBatch = {
    kind: batchKind,
    version: batchVersion,
    operatorDirectory,
    keyId: sha256(key),
    batchId,
    accountId: input.expectedAccountId,
    accountSha256,
    expectedEditionId: input.expectedEditionId,
    startEpochMs: input.startEpochMs,
    endEpochMs: input.endEpochMs,
    firstSavedAtEpochMs: now,
    snapshots,
  };
  const batch = signBatch(unsignedBatch, key);
  const bytes = Buffer.from(canonicalJson(batch) + "\n");
  if (bytes.length > maxBatchBytes) fail("GMAIL_WINDOW_LIMIT");
  registryEntries(dirs.batchDirectory, bytes.length * 2, 2);
  const stage = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeDurableFile(stage, bytes);
  let installedByThisAttempt = true;
  try {
    linkSync(stage, path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
    const existing = readBatchFile(path, operatorDirectory, key);
    if (!snapshotsStableEqual(existing.snapshots, snapshots))
      fail("GMAIL_BATCH_CONFLICT");
    installedByThisAttempt = false;
  }
  const installedStat = lstatSync(path);
  const stageStat = lstatSync(stage);
  if (
    installedStat.isSymbolicLink() ||
    stageStat.isSymbolicLink() ||
    (installedByThisAttempt &&
      (installedStat.dev !== stageStat.dev ||
        installedStat.ino !== stageStat.ino)) ||
    !readFileSync(stage).equals(bytes) ||
    (installedByThisAttempt && !readFileSync(path).equals(bytes))
  )
    fail("PENDING_STEVE_EMAIL_INTAKE");
  unlinkSync(stage);
  if (lstatSync(path).nlink !== 1) fail("PENDING_STEVE_EMAIL_INTAKE");
  flushDirectory(dirs.batchDirectory);
  return readBatchFile(path, operatorDirectory, key);
}

function validateCorrectionMap(
  batch: SteveGmailHandoffBatch,
  corrections: Record<string, string> | undefined
): void {
  if (!corrections) return;
  const ids = new Set(
    batch.snapshots.map((snapshot) => snapshot.rawMessage.id)
  );
  for (const [messageId, receiptId] of Object.entries(corrections))
    if (
      !ids.has(messageId) ||
      !/^[a-f0-9]{64}$/.test(receiptId) ||
      receiptId === ""
    )
      fail("INVALID_GMAIL_CORRECTION_SELECTION");
}

function summaries(receipts: SteveEmailReceipt[]) {
  return [
    ...new Map(
      receipts.map((receipt) => [receipt.receiptId, receipt])
    ).values(),
  ]
    .map((receipt) => ({
      receiptId: receipt.receiptId,
      sourceSha256: receipt.sourceSha256,
      firstObservedAtEpochMs: receipt.firstObservedAtEpochMs,
      disposition: receipt.disposition,
    }))
    .sort(
      (left, right) =>
        left.firstObservedAtEpochMs - right.firstObservedAtEpochMs ||
        left.receiptId.localeCompare(right.receiptId)
    );
}

async function captureBatchMessages(
  operatorDirectory: string,
  expectedAccountId: string,
  batch: SteveGmailHandoffBatch,
  corrections?: Record<string, string>
): Promise<SteveEmailReceipt[]> {
  validateCorrectionMap(batch, corrections);
  const receipts: SteveEmailReceipt[] = [];
  for (const snapshot of batch.snapshots) {
    const captured = await captureSteveEmail({
      operatorDirectory,
      accountId: expectedAccountId,
      rawMessage: snapshot.rawMessage,
      fullMessage: snapshot.fullMessage,
      expectedEditionId: batch.expectedEditionId,
      observedAtEpochMs: snapshot.observedAtEpochMs,
      ...(corrections?.[snapshot.rawMessage.id]
        ? { correctionOf: corrections[snapshot.rawMessage.id] }
        : {}),
    });
    receipts.push(captured.receipt);
  }
  return receipts;
}

/** Validate the whole repaired set after every selected batch has replayed. */
function verifyCapturedBatches(
  operatorDirectory: string,
  expectedAccountId: string,
  batches: SteveGmailHandoffBatch[]
): void {
  for (const batch of batches) {
    const resolved = resolveBatchMessages(
      operatorDirectory,
      expectedAccountId,
      batch.expectedEditionId,
      batch
    );
    if (
      resolved.length !== batch.snapshots.length ||
      resolved.some((item) => item.status !== "captured")
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
  }
}

function correctionsForBatch(
  batch: SteveGmailHandoffBatch,
  corrections: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!corrections) return undefined;
  const ids = new Set(
    batch.snapshots.map((snapshot) => snapshot.rawMessage.id)
  );
  const selected = Object.fromEntries(
    Object.entries(corrections).filter(([messageId]) => ids.has(messageId))
  );
  validateCorrectionMap(batch, selected);
  return selected;
}

function validateCorrectionsAcrossBatches(
  batches: SteveGmailHandoffBatch[],
  corrections: Record<string, string> | undefined
): void {
  if (!corrections) return;
  const ids = new Set(
    batches.flatMap((batch) =>
      batch.snapshots.map((snapshot) => snapshot.rawMessage.id)
    )
  );
  for (const [messageId, receiptId] of Object.entries(corrections))
    if (!ids.has(messageId) || !/^[a-f0-9]{64}$/.test(receiptId))
      fail("INVALID_GMAIL_CORRECTION_SELECTION");
}

export interface SteveGmailBatchResult {
  status: "missing" | "captured";
  replayed: boolean;
  batchIds: string[];
  messageCount: number;
  receipts: {
    receiptId: string;
    sourceSha256: string;
    firstObservedAtEpochMs: number;
    disposition: "ready" | "review-required";
  }[];
}

function publicFailure(error: unknown): never {
  if (error instanceof SteveGmailHandoffError) throw error;
  if (error instanceof Error && /^[A-Z0-9_]{3,96}$/.test(error.message))
    fail(error.message);
  fail("PENDING_STEVE_EMAIL_INTAKE");
}

export async function replaySteveGmailBatch(input: {
  operatorDirectory: string;
  batchId: string;
  expectedAccountId: string;
  expectedEditionId: string;
  correctionOfByMessageId?: Record<string, string>;
}): Promise<SteveGmailBatchResult> {
  try {
    if (!/^[a-f0-9]{64}$/.test(input.batchId)) fail("INVALID_GMAIL_BATCH_ID");
    validEdition(input.expectedEditionId);
    const operatorDirectory = operatorPath(input.operatorDirectory);
    await recoverSteveGmailBatchStaging(operatorDirectory);
    const batch = readAuthenticatedSteveGmailBatches({
      operatorDirectory,
    }).find((candidate) => candidate.batchId === input.batchId);
    if (!batch) fail("GMAIL_BATCH_NOT_FOUND");
    validateBatchIdentity(
      batch,
      input.expectedAccountId,
      input.expectedEditionId
    );
    const receipts = await captureBatchMessages(
      operatorDirectory,
      input.expectedAccountId,
      batch,
      input.correctionOfByMessageId
    );
    verifyCapturedBatches(operatorDirectory, input.expectedAccountId, [batch]);
    return {
      status: "captured",
      replayed: true,
      batchIds: [batch.batchId],
      messageCount: batch.snapshots.length,
      receipts: summaries(receipts),
    };
  } catch (error) {
    return publicFailure(error);
  }
}

async function replayPendingGmailBatches(input: {
  operatorDirectory: string;
  expectedAccountId: string;
  expectedEditionId: string;
  correctionOfByMessageId?: Record<string, string>;
}): Promise<SteveGmailBatchResult | null> {
  const operatorDirectory = input.operatorDirectory;
  const pending = readSteveGmailHandoffStatus({
    operatorDirectory,
    expectedAccountId: input.expectedAccountId,
    expectedEditionId: input.expectedEditionId,
  }).batches.filter((batch) => batch.capturePendingCount > 0);
  if (pending.length > 0) {
    const all = readAuthenticatedSteveGmailBatches({ operatorDirectory });
    const ids = new Set(pending.map((batch) => batch.batchId));
    const work = all
      .filter((batch) => ids.has(batch.batchId))
      .sort(
        (left, right) =>
          left.firstSavedAtEpochMs - right.firstSavedAtEpochMs ||
          left.batchId.localeCompare(right.batchId)
      );
    validateCorrectionsAcrossBatches(work, input.correctionOfByMessageId);
    const receipts: SteveEmailReceipt[] = [];
    let messageCount = 0;
    for (const batch of work) {
      receipts.push(
        ...(await captureBatchMessages(
          operatorDirectory,
          input.expectedAccountId,
          batch,
          correctionsForBatch(batch, input.correctionOfByMessageId)
        ))
      );
      messageCount += batch.snapshots.length;
    }
    verifyCapturedBatches(operatorDirectory, input.expectedAccountId, work);
    return {
      status: "captured",
      replayed: true,
      batchIds: work.map((batch) => batch.batchId),
      messageCount,
      receipts: summaries(receipts),
    };
  }

  return null;
}

export async function captureSteveGmailWindow(input: {
  operatorDirectory: string;
  expectedAccountId: string;
  expectedEditionId: string;
  startEpochMs: number;
  endEpochMs: number;
  getAccessToken?: () => Promise<string>;
  fetcher?: typeof fetch;
  correctionOfByMessageId?: Record<string, string>;
}): Promise<SteveGmailBatchResult> {
  try {
    validEdition(input.expectedEditionId);
    validWindow(input.startEpochMs, input.endEpochMs);
    const operatorDirectory = operatorPath(input.operatorDirectory);
    await recoverSteveGmailBatchStaging(operatorDirectory);
    const replay = await replayPendingGmailBatches({
      ...input,
      operatorDirectory,
    });
    if (replay) return replay;

    const window = await readSteveGmailWindow({
      expectedAccountId: input.expectedAccountId,
      startEpochMs: input.startEpochMs,
      endEpochMs: input.endEpochMs,
      getAccessToken:
        input.getAccessToken ??
        (() => Promise.reject(new Error("GMAIL_AUTH_REQUIRED"))),
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    });
    if (window.status === "missing") {
      await recoverSteveGmailBatchStaging(operatorDirectory);
      const lateReplay = await replayPendingGmailBatches({
        ...input,
        operatorDirectory,
      });
      if (lateReplay) return lateReplay;
      return {
        status: "missing",
        replayed: false,
        batchIds: [],
        messageCount: 0,
        receipts: [],
      };
    }
    const snapshots = validateSnapshots(
      window.snapshots,
      input.expectedAccountId,
      input.startEpochMs,
      input.endEpochMs
    );
    const keyPathName = keyPath(operatorDirectory);
    if (pathKind(keyPathName) !== "file") fail("PENDING_STEVE_EMAIL_INTAKE");
    assertOperatorNotQuarantined(operatorDirectory);
    const journal = new WeeklyRunJournal(operatorDirectory);
    let lease;
    let saved: SteveGmailHandoffBatch;
    try {
      lease = journal.acquire(productionScope);
      saved = await journal.guardOperation(lease, async () => {
        recoverSteveGmailBatchStagingLocked(operatorDirectory);
        readAuthenticatedSteveGmailBatches({ operatorDirectory });
        return installBatch(operatorDirectory, snapshots, input);
      });
    } finally {
      if (lease) {
        try {
          journal.release(lease);
        } finally {
          journal.close();
        }
      } else journal.close();
    }
    const status = readSteveGmailHandoffStatus({
      operatorDirectory,
      expectedAccountId: input.expectedAccountId,
      expectedEditionId: input.expectedEditionId,
    });
    const batchIds = status.batches
      .filter(
        (batch) =>
          batch.capturePendingCount > 0 || batch.batchId === saved.batchId
      )
      .map((batch) => batch.batchId);
    const all = readAuthenticatedSteveGmailBatches({ operatorDirectory });
    const ids = new Set(batchIds);
    const work = all
      .filter((batch) => ids.has(batch.batchId))
      .sort(
        (left, right) =>
          left.firstSavedAtEpochMs - right.firstSavedAtEpochMs ||
          left.batchId.localeCompare(right.batchId)
      );
    validateCorrectionsAcrossBatches(work, input.correctionOfByMessageId);
    const receipts: SteveEmailReceipt[] = [];
    let messageCount = 0;
    for (const batch of work) {
      receipts.push(
        ...(await captureBatchMessages(
          operatorDirectory,
          input.expectedAccountId,
          batch,
          correctionsForBatch(batch, input.correctionOfByMessageId)
        ))
      );
      messageCount += batch.snapshots.length;
    }
    verifyCapturedBatches(operatorDirectory, input.expectedAccountId, work);
    return {
      status: "captured",
      replayed: false,
      batchIds: work.map((batch) => batch.batchId),
      messageCount,
      receipts: summaries(receipts),
    };
  } catch (error) {
    return publicFailure(error);
  }
}
