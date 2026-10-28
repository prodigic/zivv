import { createHmac, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import {
  validateRecoveryPreparedHostBinding,
  type RecoveryPreparedHostBinding,
} from "./recovery-host-binding.js";
import { proveRecoveryGmailBatchInventory } from "./recovery-gmail-batch-proof.js";
import { proveRecoveryGmailCaptureSelection } from "./recovery-gmail-capture-selection.js";
import {
  selectSteveEmailPlaintext,
  type SteveEmailReceipt,
} from "./steve-email-intake.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { localDateStartEpochMs } from "./weekly.js";
import {
  validateWeeklyJournalRecoverySnapshot,
  type WeeklyJournalRecoverySnapshot,
} from "./weekly-run-journal.js";

type Checkpoint = Parameters<
  typeof proveRecoveryGmailCaptureSelection
>[0]["checkpoint"];
type Inventory = Pick<Checkpoint, "files" | "directories" | "journal">;
type Evidence = WeeklyJournalRecoverySnapshot["intakeEvidence"][number];
type Ownership = WeeklyJournalRecoverySnapshot["ownership"][number];
type FileCommitment = Pick<
  Checkpoint["files"][number],
  "area" | "path" | "sha256"
>;
const production = "prodigic/zivv/production";
const admissionDomain = "zivv-recovery-gmail-capture-admission/v1\0";
const resultDomain = "zivv-recovery-gmail-capture-result/v1\0";
const maxAdmission = 64 * 1024,
  maxResult = 16 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;

/** Detached commitments only. The retained coordinator must authenticate physical
 * runtime/receipt/tree identities separately, before every effect. */
export type RecoveryGmailCaptureBinding = RecoveryPreparedHostBinding;
export interface RecoveryGmailCaptureCompletedEvidence {
  admission: Buffer;
  result: Buffer;
}
export interface RecoveryGmailCaptureAdmissionInput {
  checkpoint: Checkpoint;
  recoveryKey: Buffer;
  binding: RecoveryGmailCaptureBinding;
  batchId: string;
  correctionOfByMessageId?: Record<string, string>;
  admittedAtEpochMs: number;
  priorCompleted?: readonly RecoveryGmailCaptureCompletedEvidence[];
  /** Complete detached unfinished family. Physical enumeration is still required. */
  unfinishedAdmissions: readonly Buffer[];
}
export interface RecoveryGmailCaptureAdmission {
  kind: "zivv-recovery-gmail-capture-admission";
  version: 1;
  binding: RecoveryGmailCaptureBinding;
  originalInventorySha256: string;
  batchId: string;
  batchSha256: string;
  accountSha256: string;
  editionId: string;
  firstSavedAtEpochMs: number;
  startEpochMs: number;
  endEpochMs: number;
  admittedAtEpochMs: number;
  selectionSha256: string;
  orderedRecipeSha256: string;
  correctionOfByMessageId: Record<string, string>;
  /** Ordered completed-prefix commitment; each supplied pair is still revalidated. */
  priorCompleted: { count: number; sha256: string };
}
interface Delta {
  files: FileCommitment[];
  directories: Checkpoint["directories"];
  intakeEvidence: Evidence[];
}
interface Result {
  kind: "zivv-recovery-gmail-capture-result";
  version: 1;
  admissionSha256: string;
  projectionSha256: string;
  own: Delta;
  productionOwnership: Ownership;
}
export interface RecoveryGmailCaptureDeltaInput {
  checkpoint: Checkpoint;
  recoveryKey: Buffer;
  admission: Buffer;
  priorCompleted?: readonly RecoveryGmailCaptureCompletedEvidence[];
  /** Every unfinished admission observed in the fixed prepared-root family. */
  unfinishedAdmissions: readonly Buffer[];
  current: Inventory;
  /** Exact observed bookkeeping from the closed coordinator's own lease operations.
   * This is evidence, not permission; callers cannot establish capture authority. */
  ownProductionOwnership?: Ownership;
}
export interface RecoveryGmailCaptureDeltaProof {
  activationAllowed: false;
  captureAllowed: false;
  physicalValidationRequired: true;
  status: "capture-pending" | "capture-partial" | "capture-complete";
  admissionSha256: string;
  projectionSha256: string;
  missingFiles: string[];
  receipts: {
    receiptId: string;
    sourceSha256: string;
    firstObservedAtEpochMs: number;
    disposition: "ready" | "review-required";
  }[];
}
function fail(): never {
  throw new Error("INVALID_RECOVERY_GMAIL_CAPTURE_ADMISSION_PROOF");
}
function same(a: unknown, b: unknown): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail();
}
function integer(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= Date.now();
}
function key(value: Buffer): void {
  if (!Buffer.isBuffer(value) || value.length !== 32) fail();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function signed(
  value: unknown,
  recoveryKey: Buffer,
  domain: string,
  limit: number
): Buffer {
  key(recoveryKey);
  const signature = createHmac("sha256", recoveryKey)
    .update(domain)
    .update(canonicalJson(value))
    .digest("hex");
  const bytes = Buffer.from(
    canonicalJson({ ...object(value), signature }) + "\n"
  );
  if (bytes.length > limit) fail();
  return bytes;
}
function authenticated<T>(
  bytes: Buffer,
  recoveryKey: Buffer,
  domain: string,
  limit: number
): T {
  key(recoveryKey);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limit) fail();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = object(JSON.parse(text) as unknown);
  if (
    !bytes.equals(Buffer.from(canonicalJson(value) + "\n")) ||
    typeof value.signature !== "string" ||
    !hashPattern.test(value.signature)
  )
    fail();
  const { signature, ...body } = value;
  const expected = createHmac("sha256", recoveryKey)
    .update(domain)
    .update(canonicalJson(body))
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) fail();
  return body as T;
}
function path(value: string): void {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 4096 ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    fail();
}
function binding(
  value: RecoveryGmailCaptureBinding,
  recoveryKey: Buffer
): void {
  try {
    validateRecoveryPreparedHostBinding(value, recoveryKey);
  } catch {
    fail();
  }
}
function decode(value: string, limit = 8 * 1024 * 1024): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4)
    fail();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit || bytes.toString("base64") !== value) fail();
  return bytes;
}
function journal(value: string): WeeklyJournalRecoverySnapshot {
  return validateWeeklyJournalRecoverySnapshot(
    decode(value, 256 * 1024 * 1024)
  );
}
function journalBytes(value: WeeklyJournalRecoverySnapshot): string {
  const { digest: _digest, ...body } = value;
  return Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  ).toString("base64");
}
function name(value: { area: string; path: string }): string {
  return value.area + "/" + value.path;
}
function sorted<T extends { area: string; path: string }>(values: T[]): T[] {
  return values.sort((a, b) =>
    name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0
  );
}
function inventory(value: Inventory): void {
  if (
    !Array.isArray(value.files) ||
    !Array.isArray(value.directories) ||
    value.files.length > 50000 ||
    value.directories.length > 50000
  )
    fail();
  const seen = new Set<string>();
  let total = 0;
  for (const entry of [...value.files, ...value.directories]) {
    path(entry.path);
    if (
      !["operator", "checkout"].includes(entry.area) ||
      seen.has(name(entry).toLowerCase())
    )
      fail();
    seen.add(name(entry).toLowerCase());
  }
  for (const file of value.files) {
    if (file.bytes === null) {
      if (file.sha256 !== null) fail();
      continue;
    }
    const bytes = decode(file.bytes, 256 * 1024 * 1024);
    total += bytes.length;
    if (sha256(bytes) !== file.sha256 || total > 256 * 1024 * 1024) fail();
  }
  journal(value.journal);
}
function originalDigest(checkpoint: Checkpoint): string {
  return sha256(
    canonicalJson({
      originalOperatorDirectory: checkpoint.originalOperatorDirectory,
      createdAtEpochMs: checkpoint.createdAtEpochMs,
      files: sorted(
        checkpoint.files.map(({ area, path, sha256 }) => ({
          area,
          path,
          sha256,
        }))
      ),
      directories: sorted([...checkpoint.directories]),
      journal: journal(checkpoint.journal).digest,
    })
  );
}
function commits(pairs: readonly RecoveryGmailCaptureCompletedEvidence[]) {
  return pairs.map((pair) => ({
    admissionSha256: sha256(pair.admission),
    resultSha256: sha256(pair.result),
  }));
}
function unfinished(admissions: readonly Buffer[], own: Buffer): void {
  if (!Array.isArray(admissions) || admissions.length > 1) fail();
  for (const bytes of admissions) {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length > maxAdmission ||
      !bytes.equals(own)
    )
      fail();
  }
}
function admissionBody(
  input: RecoveryGmailCaptureAdmissionInput,
  base: Checkpoint
): RecoveryGmailCaptureAdmission {
  binding(input.binding, input.recoveryKey);
  if (
    !integer(input.admittedAtEpochMs) ||
    input.admittedAtEpochMs < input.checkpoint.createdAtEpochMs
  )
    fail();
  const atIntent = { ...base, createdAtEpochMs: input.admittedAtEpochMs };
  const selection = proveRecoveryGmailCaptureSelection({
    checkpoint: atIntent,
    recoveryKey: input.recoveryKey,
    batchId: input.batchId,
    correctionOfByMessageId: input.correctionOfByMessageId,
  });
  const batch = proveRecoveryGmailBatchInventory({
    checkpoint: atIntent,
    recoveryKey: input.recoveryKey,
  }).batches.find((item) => item.batch.batchId === input.batchId)!.batch;
  return {
    kind: "zivv-recovery-gmail-capture-admission",
    version: 1,
    binding: { ...input.binding },
    originalInventorySha256: originalDigest(input.checkpoint),
    batchId: input.batchId,
    batchSha256: selection.batchSha256,
    accountSha256: batch.accountSha256,
    editionId: batch.expectedEditionId,
    firstSavedAtEpochMs: batch.firstSavedAtEpochMs,
    startEpochMs: batch.startEpochMs,
    endEpochMs: batch.endEpochMs,
    admittedAtEpochMs: input.admittedAtEpochMs,
    selectionSha256: selection.selectionSha256,
    orderedRecipeSha256: selection.orderedRecipeSha256,
    correctionOfByMessageId: { ...input.correctionOfByMessageId },
    priorCompleted: {
      count: (input.priorCompleted ?? []).length,
      sha256: sha256(canonicalJson(commits(input.priorCompleted ?? []))),
    },
  };
}
function checkAdmission(
  bytes: Buffer,
  checkpoint: Checkpoint,
  base: Checkpoint,
  recoveryKey: Buffer,
  pairs: readonly RecoveryGmailCaptureCompletedEvidence[]
): RecoveryGmailCaptureAdmission {
  const value = authenticated<RecoveryGmailCaptureAdmission>(
    bytes,
    recoveryKey,
    admissionDomain,
    maxAdmission
  );
  if (pairs.length)
    same(
      value.binding,
      authenticated<RecoveryGmailCaptureAdmission>(
        pairs[pairs.length - 1]!.admission,
        recoveryKey,
        admissionDomain,
        maxAdmission
      ).binding
    );
  same(
    value,
    admissionBody(
      {
        checkpoint,
        recoveryKey,
        binding: value.binding,
        batchId: value.batchId,
        correctionOfByMessageId: value.correctionOfByMessageId,
        admittedAtEpochMs: value.admittedAtEpochMs,
        priorCompleted: pairs,
        unfinishedAdmissions: [],
      },
      base
    )
  );
  return value;
}
function rowKey(row: Evidence): string {
  return row.scope + "/" + row.kind + "/" + row.id;
}
function parseReceipt(row: Evidence): SteveEmailReceipt {
  return object(
    JSON.parse(decode(row.bytes).toString("utf8")) as unknown
  ) as unknown as SteveEmailReceipt;
}
function expectedDelta(
  base: Checkpoint,
  admission: RecoveryGmailCaptureAdmission,
  rows: Evidence[],
  recoveryKey: Buffer
): {
  complete: Checkpoint;
  own: Delta;
  receipts: RecoveryGmailCaptureDeltaProof["receipts"];
  required: string[];
  committedParentFiles: string[];
} {
  const before = journal(base.journal),
    evidence = new Map(before.intakeEvidence.map((row) => [rowKey(row), row]));
  const selection = proveRecoveryGmailCaptureSelection({
    checkpoint: { ...base, createdAtEpochMs: admission.admittedAtEpochMs },
    recoveryKey,
    batchId: admission.batchId,
    correctionOfByMessageId: admission.correctionOfByMessageId,
  });
  const batch = proveRecoveryGmailBatchInventory({
    checkpoint: { ...base, createdAtEpochMs: admission.admittedAtEpochMs },
    recoveryKey,
  }).batches.find((item) => item.batch.batchId === admission.batchId)!.batch;
  const ownRows = new Map<string, Evidence>();
  for (const row of rows) {
    if (
      row.scope !== production ||
      evidence.has(rowKey(row)) ||
      ownRows.has(rowKey(row))
    )
      fail();
    ownRows.set(rowKey(row), row);
    evidence.set(rowKey(row), row);
  }
  const files = new Map(base.files.map((file) => [name(file), file]));
  const directories = new Map(
    base.directories.map((directory) => [name(directory), directory])
  );
  const required = new Set<string>(),
    committedParentFiles = new Set<string>(),
    used = new Set<string>(),
    receipts: RecoveryGmailCaptureDeltaProof["receipts"] = [];
  function add(path: string, bytes: Buffer) {
    const file = {
        area: "operator" as const,
        path,
        sha256: sha256(bytes),
        bytes: bytes.toString("base64"),
      },
      prior = files.get(name(file));
    if (prior) same(prior, file);
    else files.set(name(file), file);
    required.add(name(file));
    for (
      let parent = posix.dirname(path);
      parent !== ".";
      parent = posix.dirname(parent)
    )
      directories.set("operator/" + parent, { area: "operator", path: parent });
  }
  for (let index = 0; index < batch.snapshots.length; index++) {
    const snapshot = batch.snapshots[index]!,
      selected = selection.messages[index]!;
    if (!selected.sourceSha256) continue;
    const receiptId = sha256(
      canonicalJson([
        batch.accountSha256,
        batch.expectedEditionId,
        selected.sourceSha256,
      ])
    );
    const sourceKey = production + "/source/" + receiptId,
      sourceRow = evidence.get(sourceKey);
    if (!sourceRow) continue;
    const receipt = parseReceipt(sourceRow),
      ownSource = ownRows.has(sourceKey);
    if (ownSource && !used.has(sourceKey)) {
      if (
        receipt.messageId !== snapshot.rawMessage.id ||
        receipt.rawSha256 !== selected.rawSha256 ||
        receipt.receivedAtEpochMs !== selected.receivedAtEpochMs ||
        receipt.acquisitionObservedAtEpochMs !== selected.observedAtEpochMs ||
        !integer(receipt.firstObservedAtEpochMs) ||
        receipt.firstObservedAtEpochMs < admission.admittedAtEpochMs
      )
        fail();
      const friday = new Date(batch.expectedEditionId + "T12:00:00Z");
      friday.setUTCDate(friday.getUTCDate() + 3);
      if (
        receipt.firstObservedAtEpochMs >=
        localDateStartEpochMs(friday.toISOString().slice(0, 10))
      )
        fail();
      const siblings = [
        ...before.intakeEvidence,
        ...rows.filter((row) => used.has(rowKey(row))),
      ]
        .filter((row) => row.scope === production && row.kind === "source")
        .map(parseReceipt)
        .filter(
          (row) =>
            row.accountSha256 === batch.accountSha256 &&
            row.editionId === batch.expectedEditionId
        );
      same(receipt.correctionOf, selected.correctionOf);
      same(
        receipt.disposition,
        siblings.length && !selected.correctionOf ? "review-required" : "ready"
      );
      same(
        receipt.partPath,
        selectSteveEmailPlaintext(snapshot.fullMessage.payload).partPath
      );
      used.add(sourceKey);
    }
    if (
      receipt.accountSha256 !== batch.accountSha256 ||
      receipt.editionId !== batch.expectedEditionId ||
      receipt.sourceSha256 !== selected.sourceSha256 ||
      receipt.receiptId !== receiptId
    )
      fail();
    const approvalKey = production + "/correction/" + receiptId,
      approval = evidence.get(approvalKey);
    if (
      selected.prospectiveParentMessageId &&
      (ownSource || ownRows.has(approvalKey))
    ) {
      const bodyPrefix = `operator/email-intake/${batch.accountSha256}/bodies/${selected.correctionOf}/`;
      const messagePrefix = `operator/email-intake/${batch.accountSha256}/messages/${sha256(selected.prospectiveParentMessageId)}/`;
      const parentFiles = [...required].filter(
        (path) => path.startsWith(bodyPrefix) || path.startsWith(messagePrefix)
      );
      if (parentFiles.length < 4) fail();
      for (const path of parentFiles) committedParentFiles.add(path);
    }
    if (ownRows.has(approvalKey)) {
      if (!selected.correctionOf || receipt.disposition !== "review-required")
        fail();
      const value = object(
        JSON.parse(decode(approval!.bytes).toString("utf8")) as unknown
      );
      if (
        value.correctionOf !== selected.correctionOf ||
        typeof value.approvedAtEpochMs !== "number" ||
        value.approvedAtEpochMs < admission.admittedAtEpochMs
      )
        fail();
      used.add(approvalKey);
    }
    if (
      selected.correctionOf &&
      receipt.disposition === "ready" &&
      receipt.correctionOf !== selected.correctionOf
    )
      fail();
    if (
      selected.correctionOf &&
      receipt.disposition === "review-required" &&
      (!approval ||
        object(JSON.parse(decode(approval.bytes).toString("utf8")) as unknown)
          .correctionOf !== selected.correctionOf)
    )
      continue;
    const body = `email-intake/${batch.accountSha256}/bodies/${receiptId}`,
      message = `email-intake/${batch.accountSha256}/messages/${sha256(snapshot.rawMessage.id)}`;
    add(
      body + "/source.txt",
      selectSteveEmailPlaintext(snapshot.fullMessage.payload).source
    );
    add(body + "/receipt.json", decode(sourceRow.bytes));
    if (approval)
      add(body + "/correction-approval.json", decode(approval.bytes));
    add(
      message + "/message.eml",
      Buffer.from(snapshot.rawMessage.raw, "base64url")
    );
    add(
      message + "/capture.json",
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          messageId: snapshot.rawMessage.id,
          accountSha256: batch.accountSha256,
          rawSha256: selected.rawSha256,
          sourceSha256: selected.sourceSha256,
          receiptId,
          receivedAtEpochMs: selected.receivedAtEpochMs,
        }) + "\n"
      )
    );
    receipts.push({
      receiptId,
      sourceSha256: receipt.sourceSha256,
      firstObservedAtEpochMs: receipt.firstObservedAtEpochMs,
      disposition: approval ? "ready" : receipt.disposition,
    });
  }
  if (used.size !== ownRows.size) fail();
  const mergedJournal = {
    ...before,
    intakeEvidence: [...evidence.values()].sort((a, b) =>
      rowKey(a) < rowKey(b) ? -1 : 1
    ),
  };
  const complete: Checkpoint = {
    ...base,
    createdAtEpochMs: Date.now(),
    files: sorted([...files.values()]),
    directories: sorted([...directories.values()]),
    journal: journalBytes(mergedJournal),
  };
  // This is a virtual complete projection, never a relaxation of the ordinary proof.
  proveRecoveryGmailBatchInventory({ checkpoint: complete, recoveryKey });
  const oldFiles = new Set(base.files.map(name)),
    oldDirectories = new Set(base.directories.map(name));
  return {
    complete,
    own: {
      files: complete.files
        .filter((file) => !oldFiles.has(name(file)))
        .map(({ area, path, sha256 }) => ({ area, path, sha256 })),
      directories: complete.directories.filter(
        (directory) => !oldDirectories.has(name(directory))
      ),
      intakeEvidence: [...ownRows.values()].sort((a, b) =>
        rowKey(a) < rowKey(b) ? -1 : 1
      ),
    },
    receipts,
    required: [...required].sort(),
    committedParentFiles: [...committedParentFiles].sort(),
  };
}
function projection(checkpoint: Checkpoint, original: Checkpoint): string {
  const state = journal(checkpoint.journal),
    initial = journal(original.journal).ownership.find(
      (row) => row.scope === production
    )!;
  return sha256(
    canonicalJson({
      files: sorted(
        checkpoint.files.map(({ area, path, sha256 }) => ({
          area,
          path,
          sha256,
        }))
      ),
      directories: sorted([...checkpoint.directories]),
      journal: {
        ...state,
        digest: undefined,
        ownership: state.ownership.map((row) =>
          row.scope === production ? initial : row
        ),
      },
    })
  );
}
function rebuild(
  checkpoint: Checkpoint,
  recoveryKey: Buffer,
  pairs: readonly RecoveryGmailCaptureCompletedEvidence[]
): Checkpoint {
  if (!Array.isArray(pairs) || pairs.length > 1000) fail();
  let total = 0;
  for (const pair of pairs) {
    if (
      !Buffer.isBuffer(pair.admission) ||
      !Buffer.isBuffer(pair.result) ||
      pair.admission.length > maxAdmission ||
      pair.result.length > maxResult
    )
      fail();
    total += pair.admission.length + pair.result.length;
    if (total > 256 * 1024 * 1024) fail();
  }
  inventory(checkpoint);
  const initial = proveRecoveryGmailBatchInventory({ checkpoint, recoveryKey });
  if (pairs.length > initial.batches.length || pairs.length > 1000) fail();
  let base = checkpoint;
  const seen = new Set<string>();
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index]!,
      admission = checkAdmission(
        pair.admission,
        checkpoint,
        base,
        recoveryKey,
        pairs.slice(0, index)
      );
    if (seen.has(admission.batchId)) fail();
    seen.add(admission.batchId);
    const result = authenticated<Result>(
      pair.result,
      recoveryKey,
      resultDomain,
      maxResult
    );
    if (!result.own || !Array.isArray(result.own.intakeEvidence)) fail();
    const derived = expectedDelta(
      base,
      admission,
      result.own.intakeEvidence,
      recoveryKey
    );
    if (
      derived.receipts.length !==
      initial.batches.find((item) => item.batch.batchId === admission.batchId)!
        .batch.snapshots.length
    )
      fail();
    same(result, {
      kind: "zivv-recovery-gmail-capture-result",
      version: 1,
      admissionSha256: sha256(pair.admission),
      projectionSha256: projection(derived.complete, checkpoint),
      own: derived.own,
      productionOwnership: result.productionOwnership,
    });
    const state = journal(derived.complete.journal);
    state.ownership = ownership(state.ownership, result.productionOwnership);
    base = { ...derived.complete, journal: journalBytes(state) };
  }
  return base;
}
function ownership(before: Ownership[], own: Ownership): Ownership[] {
  const previous = before.find((row) => row.scope === production)!;
  same(
    Object.keys(object(own)).sort(),
    ["scope", "owner", "fence", "expiresAtEpochMs"].sort()
  );
  if (
    own.scope !== production ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(own.owner) ||
    !Number.isSafeInteger(own.fence) ||
    own.fence < previous.fence ||
    !Number.isSafeInteger(own.expiresAtEpochMs) ||
    own.expiresAtEpochMs < 0 ||
    (own.fence === previous.fence && own.owner !== previous.owner)
  )
    fail();
  return before.map((row) => (row.scope === production ? { ...own } : row));
}

/** Sign immutable intent only; this performs no IO and grants no capture authority. */
export function createRecoveryGmailCaptureAdmission(
  input: RecoveryGmailCaptureAdmissionInput
): Buffer {
  const pairs = input.priorCompleted ?? [],
    base = rebuild(input.checkpoint, input.recoveryKey, pairs);
  if (pairs.length)
    same(
      input.binding,
      authenticated<RecoveryGmailCaptureAdmission>(
        pairs[pairs.length - 1]!.admission,
        input.recoveryKey,
        admissionDomain,
        maxAdmission
      ).binding
    );
  if (
    pairs.some(
      (pair) =>
        authenticated<RecoveryGmailCaptureAdmission>(
          pair.admission,
          input.recoveryKey,
          admissionDomain,
          maxAdmission
        ).batchId === input.batchId
    )
  )
    fail();
  const bytes = signed(
    admissionBody(input, base),
    input.recoveryKey,
    admissionDomain,
    maxAdmission
  );
  unfinished(input.unfinishedAdmissions, bytes);
  return input.unfinishedAdmissions.length
    ? Buffer.from(input.unfinishedAdmissions[0]!)
    : bytes;
}
/** Authenticate intent against the original and every completed predecessor. */
export function authenticateRecoveryGmailCaptureAdmission(
  input: Omit<
    RecoveryGmailCaptureDeltaInput,
    "current" | "ownProductionOwnership"
  >
): RecoveryGmailCaptureAdmission {
  const pairs = input.priorCompleted ?? [];
  unfinished(input.unfinishedAdmissions, input.admission);
  return checkAdmission(
    input.admission,
    input.checkpoint,
    rebuild(input.checkpoint, input.recoveryKey, pairs),
    input.recoveryKey,
    pairs
  );
}
function prove(input: RecoveryGmailCaptureDeltaInput) {
  unfinished(input.unfinishedAdmissions, input.admission);
  const pairs = input.priorCompleted ?? [],
    base = rebuild(input.checkpoint, input.recoveryKey, pairs),
    admission = checkAdmission(
      input.admission,
      input.checkpoint,
      base,
      input.recoveryKey,
      pairs
    );
  if (
    pairs.some(
      (pair) =>
        authenticated<RecoveryGmailCaptureAdmission>(
          pair.admission,
          input.recoveryKey,
          admissionDomain,
          maxAdmission
        ).batchId === admission.batchId
    )
  )
    fail();
  inventory(input.current);
  const before = journal(base.journal),
    actual = journal(input.current.journal);
  same(actual.runState, before.runState);
  same(actual.stageArtifacts, before.stageArtifacts);
  same(
    actual.ownership,
    input.ownProductionOwnership
      ? ownership(before.ownership, input.ownProductionOwnership)
      : before.ownership
  );
  const oldRows = new Map(
    before.intakeEvidence.map((row) => [rowKey(row), row])
  );
  for (const row of before.intakeEvidence)
    same(
      actual.intakeEvidence.find((item) => rowKey(item) === rowKey(row)),
      row
    );
  const rows = actual.intakeEvidence.filter((row) => !oldRows.has(rowKey(row)));
  const expected = expectedDelta(base, admission, rows, input.recoveryKey);
  const expectedFiles = new Map(
      expected.complete.files.map((file) => [name(file), file])
    ),
    actualFiles = new Map(
      input.current.files.map((file) => [name(file), file])
    );
  for (const file of base.files) same(actualFiles.get(name(file)), file);
  for (const file of input.current.files)
    same(file, expectedFiles.get(name(file)));
  for (const parent of expected.committedParentFiles)
    if (!actualFiles.has(parent)) fail();
  const expectedDirectories = new Set(expected.complete.directories.map(name)),
    actualDirectories = new Set(input.current.directories.map(name));
  for (const directory of base.directories)
    if (!actualDirectories.has(name(directory))) fail();
  for (const directory of input.current.directories)
    if (!expectedDirectories.has(name(directory))) fail();
  // Selected archive trees record their own root, not every shared ancestor
  // (for example dist/lib is retained while dist itself is implicit). Those
  // authenticated original ancestors are physical baseline obligations; they
  // must not be mistaken for missing newly admitted intake directories.
  const originalAncestors = new Set<string>();
  for (const entry of [
    ...input.checkpoint.files,
    ...input.checkpoint.directories,
  ])
    for (
      let parent = posix.dirname(entry.path);
      parent !== ".";
      parent = posix.dirname(parent)
    )
      originalAncestors.add(entry.area + "/" + parent);
  for (const file of input.current.files)
    for (
      let parent = posix.dirname(file.path);
      parent !== ".";
      parent = posix.dirname(parent)
    )
      if (
        !actualDirectories.has(file.area + "/" + parent) &&
        !originalAncestors.has(file.area + "/" + parent)
      )
        fail();
  const selected = proveRecoveryGmailCaptureSelection({
    checkpoint: { ...base, createdAtEpochMs: admission.admittedAtEpochMs },
    recoveryKey: input.recoveryKey,
    batchId: admission.batchId,
    correctionOfByMessageId: admission.correctionOfByMessageId,
  });
  const missingFiles = expected.required.filter(
    (path) => !actualFiles.has(path)
  );
  const complete =
    expected.receipts.length === selected.messages.length &&
    !missingFiles.length;
  if (complete)
    same(sorted([...input.current.directories]), expected.complete.directories);
  const proof: RecoveryGmailCaptureDeltaProof = {
    activationAllowed: false,
    captureAllowed: false,
    physicalValidationRequired: true,
    status: complete
      ? "capture-complete"
      : rows.length || input.current.files.length !== base.files.length
        ? "capture-partial"
        : "capture-pending",
    admissionSha256: sha256(input.admission),
    projectionSha256: projection(
      { ...base, ...input.current },
      input.checkpoint
    ),
    missingFiles,
    receipts: expected.receipts,
  };
  return {
    proof,
    own: expected.own,
    resolutionInventory: {
      files: expected.complete.files,
      directories: expected.complete.directories,
      journal: input.current.journal,
    },
    productionOwnership: actual.ownership.find(
      (row) => row.scope === production
    )!,
  };
}
/** Exact logical evidence validation, including source/approval journal-first restarts.
 * Physical identities and actual MIME/receiver admission remain the executor's job. */
export function proveRecoveryGmailCaptureDelta(
  input: RecoveryGmailCaptureDeltaInput
): RecoveryGmailCaptureDeltaProof {
  return prove(input).proof;
}
/** Detached full-family projection for downstream selected-receipt proofs.
 * The physical enumerator must still prove that this is the complete observed
 * family and recheck runtime, paths and current bytes before any effect.
 * An unfinished journal-first tail remains evidence, never a completed result.
 */
export interface RecoveryGmailCaptureFamilyInput {
  checkpoint: Checkpoint;
  recoveryKey: Buffer;
  completed: readonly RecoveryGmailCaptureCompletedEvidence[];
  unfinishedAdmissions: readonly Buffer[];
  current: Inventory;
  ownProductionOwnership?: Ownership;
}
function projectCaptureFamily(input: RecoveryGmailCaptureFamilyInput): {
  resolutionInventory: Inventory;
  activationAllowed: false;
  captureAllowed: false;
  loadAllowed: false;
  physicalValidationRequired: true;
  familySha256: string;
  completedCount: number;
  unfinished: RecoveryGmailCaptureDeltaProof | null;
  projectedInventory: Inventory;
} {
  const base = rebuild(input.checkpoint, input.recoveryKey, input.completed);
  if (
    !Array.isArray(input.unfinishedAdmissions) ||
    input.unfinishedAdmissions.length > 1
  )
    fail();
  inventory(input.current);
  let tail: RecoveryGmailCaptureDeltaProof | null = null;
  let resolutionInventory: Inventory = base;
  if (input.unfinishedAdmissions.length) {
    const validated = prove({
      checkpoint: input.checkpoint,
      recoveryKey: input.recoveryKey,
      admission: input.unfinishedAdmissions[0]!,
      priorCompleted: input.completed,
      unfinishedAdmissions: input.unfinishedAdmissions,
      current: input.current,
      ...(input.ownProductionOwnership
        ? { ownProductionOwnership: input.ownProductionOwnership }
        : {}),
    });
    tail = validated.proof;
    resolutionInventory = validated.resolutionInventory;
  } else {
    // Without an unfinished owner there is no authority to explain any fresh
    // file, intake, run, artifact or ownership change beyond completed results.
    if (input.ownProductionOwnership !== undefined) fail();
    same(sorted([...input.current.files]), sorted([...base.files]));
    same(sorted([...input.current.directories]), sorted([...base.directories]));
    same(journal(input.current.journal), journal(base.journal));
  }
  return {
    resolutionInventory,
    activationAllowed: false,
    captureAllowed: false,
    loadAllowed: false,
    physicalValidationRequired: true,
    familySha256: sha256(
      canonicalJson({
        domain: "zivv-recovery-gmail-capture-family/v1",
        originalInventorySha256: originalDigest(input.checkpoint),
        completed: commits(input.completed),
        unfinished: input.unfinishedAdmissions.map((bytes) => sha256(bytes)),
        currentProjectionSha256: projection(
          { ...base, ...input.current },
          input.checkpoint
        ),
        currentJournalSha256: journal(input.current.journal).digest,
      })
    ),
    completedCount: input.completed.length,
    unfinished: tail === null ? null : structuredClone(tail),
    projectedInventory: structuredClone({
      files: input.current.files,
      directories: input.current.directories,
      journal: input.current.journal,
    }),
  };
}

/** Full observed-family inputs remain subject to independent physical enumeration. */
export function proveRecoveryGmailCaptureFamily(
  input: RecoveryGmailCaptureFamilyInput
) {
  const { resolutionInventory, ...proof } = projectCaptureFamily(input);
  void resolutionInventory;
  return proof;
}

export interface RecoveryGmailCaptureSnapshotDelta {
  intakeEvidence: Evidence[];
  files: FileCommitment[];
  directories: Checkpoint["directories"];
  productionOwnership: Ownership;
}
/** Compact only the unfinished tail. Completed captures are reconstructed from
 * their original authenticated pairs; original mail/catalog/run artifacts are
 * not duplicated. This is detached evidence, never a physical snapshot permit. */
export function compactRecoveryGmailCaptureInventory(
  input: RecoveryGmailCaptureFamilyInput
) {
  const proof = projectCaptureFamily(input);
  const base = rebuild(input.checkpoint, input.recoveryKey, input.completed);
  const before = journal(base.journal),
    actual = journal(input.current.journal);
  const rows = new Set(before.intakeEvidence.map(rowKey));
  const files = new Set(base.files.map(name)),
    directories = new Set(base.directories.map(name));
  const delta: RecoveryGmailCaptureSnapshotDelta = {
    intakeEvidence: actual.intakeEvidence.filter(
      (row) => !rows.has(rowKey(row))
    ),
    files: input.current.files
      .filter((file) => !files.has(name(file)))
      .map(({ area, path, sha256 }) => ({ area, path, sha256 })),
    directories: input.current.directories.filter(
      (directory) => !directories.has(name(directory))
    ),
    productionOwnership: actual.ownership.find(
      (row) => row.scope === production
    )!,
  };
  return {
    familySha256: proof.familySha256,
    activationAllowed: false as const,
    captureAllowed: false as const,
    loadAllowed: false as const,
    physicalValidationRequired: true as const,
    delta: structuredClone(delta),
  };
}
/** Reconstruct the exact observed membership, not the virtual complete tail.
 * Every reconstructed byte is derived from the original archive, signed capture
 * pairs and validated selected source rows; unlisted canonical files stay absent. */
export function restoreRecoveryGmailCaptureInventory(
  input: Omit<
    RecoveryGmailCaptureFamilyInput,
    "current" | "ownProductionOwnership"
  > & { delta: RecoveryGmailCaptureSnapshotDelta }
) {
  const base = rebuild(input.checkpoint, input.recoveryKey, input.completed);
  if (
    !Array.isArray(input.unfinishedAdmissions) ||
    input.unfinishedAdmissions.length > 1 ||
    !Array.isArray(input.delta.intakeEvidence) ||
    input.delta.intakeEvidence.length > 200 ||
    !Array.isArray(input.delta.files) ||
    input.delta.files.length > 50_000 ||
    !Array.isArray(input.delta.directories) ||
    input.delta.directories.length > 50_000
  )
    fail();
  const state = journal(base.journal);
  const rowIds = new Set(state.intakeEvidence.map(rowKey));
  for (const row of input.delta.intakeEvidence) {
    if (rowIds.has(rowKey(row))) fail();
    rowIds.add(rowKey(row));
  }
  if (input.delta.intakeEvidence.length)
    state.intakeEvidence = [
      ...state.intakeEvidence,
      ...input.delta.intakeEvidence,
    ].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : 1));
  state.ownership = ownership(state.ownership, input.delta.productionOwnership);
  const journalValue = journalBytes(state);
  journal(journalValue);
  let candidates = base;
  if (input.unfinishedAdmissions.length) {
    const selected = input.unfinishedAdmissions[0]!;
    unfinished(input.unfinishedAdmissions, selected);
    const admission = checkAdmission(
      selected,
      input.checkpoint,
      base,
      input.recoveryKey,
      input.completed
    );
    candidates = expectedDelta(
      base,
      admission,
      input.delta.intakeEvidence,
      input.recoveryKey
    ).complete;
  } else if (input.delta.intakeEvidence.length) fail();
  const available = new Map(candidates.files.map((file) => [name(file), file]));
  const fileNames = new Set(base.files.map(name));
  const files = [...base.files];
  for (const file of input.delta.files) {
    same(file, { area: file.area, path: file.path, sha256: file.sha256 });
    const id = name(file),
      derived = available.get(id);
    if (fileNames.has(id) || !derived || derived.sha256 !== file.sha256) fail();
    fileNames.add(id);
    files.push(derived);
  }
  const directoryNames = new Set(base.directories.map(name));
  const directories = [...base.directories];
  for (const directory of input.delta.directories) {
    same(directory, { area: directory.area, path: directory.path });
    if (directoryNames.has(name(directory))) fail();
    directoryNames.add(name(directory));
    directories.push(directory);
  }
  const current = { files, directories, journal: journalValue };
  return proveRecoveryGmailCaptureFamily({
    checkpoint: input.checkpoint,
    recoveryKey: input.recoveryKey,
    completed: input.completed,
    unfinishedAdmissions: input.unfinishedAdmissions,
    current,
    ...(input.unfinishedAdmissions.length
      ? { ownProductionOwnership: input.delta.productionOwnership }
      : {}),
  });
}

export interface RecoveryGmailSelectedReceiptSelector {
  batchId: string;
  messageId: string;
  rawSha256: string;
  receiptId: string;
}

/** Resolve one ready canonical receipt from the authenticated entire capture
 * family. Internal completion of journal-first evidence is only a validation
 * view: selection requires every selected/ancestor canonical file to exist in
 * the actual observed inventory. No source bytes or writer capability escape.
 */
export function proveRecoveryGmailSelectedReceipt(
  input: RecoveryGmailCaptureFamilyInput & {
    selector: RecoveryGmailSelectedReceiptSelector;
  }
) {
  try {
    return selectedReceipt(input);
  } catch {
    throw new Error("INVALID_RECOVERY_GMAIL_SELECTED_RECEIPT_PROOF");
  }
}
function selectedReceipt(
  input: RecoveryGmailCaptureFamilyInput & {
    selector: RecoveryGmailSelectedReceiptSelector;
  }
) {
  const keys = Reflect.ownKeys(input.selector);
  if (keys.length !== 4 || keys.some((key) => typeof key !== "string")) fail();
  const descriptors = Object.getOwnPropertyDescriptors(input.selector);
  same(
    Object.keys(descriptors).sort(),
    ["batchId", "messageId", "rawSha256", "receiptId"].sort()
  );
  for (const descriptor of Object.values(descriptors))
    if (!("value" in descriptor) || typeof descriptor.value !== "string")
      fail();
  const selected = { ...input.selector };
  if (
    !hashPattern.test(selected.batchId) ||
    !hashPattern.test(selected.rawSha256) ||
    !hashPattern.test(selected.receiptId) ||
    !/^[a-f0-9]{1,128}$/.test(selected.messageId)
  )
    fail();
  const family = projectCaptureFamily(input);
  // This is a private validation horizon for authenticated later receipts,
  // not a replacement checkpoint or a new source observation.
  const resolved = proveRecoveryGmailBatchInventory({
    checkpoint: {
      ...input.checkpoint,
      ...family.resolutionInventory,
      createdAtEpochMs: Date.now(),
    },
    recoveryKey: input.recoveryKey,
  });
  const batch = resolved.batches.find(
    (item) => item.batch.batchId === selected.batchId
  );
  const message = batch?.messages.find(
    (item) => item.messageId === selected.messageId
  );
  const snapshot = batch?.batch.snapshots.find(
    (item) => item.rawMessage.id === selected.messageId
  );
  if (
    !batch ||
    !message ||
    message.status !== "captured" ||
    !snapshot ||
    message.receiptId !== selected.receiptId ||
    message.disposition !== "ready" ||
    sha256(Buffer.from(snapshot.rawMessage.raw, "base64url")) !==
      selected.rawSha256
  )
    fail();
  const view = new Map(
    family.resolutionInventory.files.map((file) => [name(file), file])
  );
  const actual = new Map(input.current.files.map((file) => [name(file), file]));
  const receipts = new Map(
    resolved.receipts.map((receipt) => [receipt.receiptId, receipt])
  );
  const presence = new Map<string, boolean>();
  function present(path: string): boolean {
    const cached = presence.get(path);
    if (cached !== undefined) return cached;
    const file = view.get("operator/" + path);
    const matches =
      !!file &&
      !!actual.get("operator/" + path) &&
      canonicalJson(actual.get("operator/" + path)) === canonicalJson(file);
    presence.set(path, matches);
    return matches;
  }
  function canonicalFiles(
    id: string,
    lineage = new Set<string>(),
    requireReady = true
  ): string[] {
    if (lineage.has(id) || lineage.size >= 100) fail();
    lineage.add(id);
    const receipt = receipts.get(id);
    if (!receipt || (requireReady && receipt.disposition !== "ready")) fail();
    const prefix = "email-intake/" + receipt.accountSha256 + "/bodies/" + id;
    const receiptFile = view.get("operator/" + prefix + "/receipt.json");
    if (!receiptFile || !receiptFile.bytes) fail();
    const original = JSON.parse(
      decode(receiptFile.bytes).toString("utf8")
    ) as SteveEmailReceipt;
    const primary =
      "email-intake/" +
      receipt.accountSha256 +
      "/messages/" +
      sha256(original.messageId);
    const paths = [
      prefix + "/source.txt",
      prefix + "/receipt.json",
      primary + "/message.eml",
      primary + "/capture.json",
    ];
    if (view.has("operator/" + prefix + "/correction-approval.json"))
      paths.push(prefix + "/correction-approval.json");
    if (receipt.correctionOf)
      paths.push(...canonicalFiles(receipt.correctionOf, lineage));
    return paths;
  }
  function messagePaths(account: string, id: string): string[] {
    const prefix = "email-intake/" + account + "/messages/" + sha256(id);
    return [prefix + "/message.eml", prefix + "/capture.json"];
  }
  const paths = [
    ...new Set([
      ...canonicalFiles(selected.receiptId),
      ...messagePaths(batch.batch.accountSha256, selected.messageId),
    ]),
  ].sort();
  if (!paths.every(present)) fail();
  const receipt = receipts.get(selected.receiptId)!;
  const source = {
    editionId: receipt.editionId,
    deliveryId: receipt.deliveryId,
    sourceSha256: receipt.sourceSha256,
    importObservedAtEpochMs: receipt.firstObservedAtEpochMs,
  };
  const obligations = resolved.batches.flatMap((item) =>
    item.messages.map((member) => {
      let status: "capture-pending" | "review-required" | "ready" =
        "capture-pending";
      if (
        member.status === "captured" &&
        [
          ...canonicalFiles(member.receiptId, new Set<string>(), false),
          ...messagePaths(item.batch.accountSha256, member.messageId),
        ].every(present)
      )
        status = member.disposition;
      return {
        batchId: item.batch.batchId,
        messageId: member.messageId,
        status,
        receiptId: member.status === "captured" ? member.receiptId : null,
      };
    })
  );
  const canonicalEvidence = paths.map((path) => ({
    path,
    sha256: view.get("operator/" + path)!.sha256,
  }));
  return {
    activationAllowed: false as const,
    captureAllowed: false as const,
    loadAllowed: false as const,
    physicalValidationRequired: true as const,
    familySha256: family.familySha256,
    selector: selected,
    source,
    receipt: structuredClone(receipt),
    canonicalEvidence,
    obligations,
    selectionSha256: sha256(
      canonicalJson({
        domain: "zivv-recovery-gmail-selected-receipt/v1",
        familySha256: family.familySha256,
        selector: selected,
        source,
        receipt,
        canonicalEvidence,
        obligations,
      })
    ),
  };
}

/** A result can be signed only after all selected canonical evidence is complete. */
export function createRecoveryGmailCaptureResult(
  input: RecoveryGmailCaptureDeltaInput
): Buffer {
  const { proof, own, productionOwnership } = prove(input);
  if (proof.status !== "capture-complete") fail();
  return signed(
    {
      kind: "zivv-recovery-gmail-capture-result",
      version: 1,
      admissionSha256: proof.admissionSha256,
      projectionSha256: proof.projectionSha256,
      own,
      productionOwnership,
    } satisfies Result,
    input.recoveryKey,
    resultDomain,
    maxResult
  );
}
