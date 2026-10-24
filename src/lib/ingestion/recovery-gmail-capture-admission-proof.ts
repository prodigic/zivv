import { createHmac, timingSafeEqual } from "node:crypto";
import { posix, win32 } from "node:path";
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
export interface RecoveryGmailCaptureBinding {
  capsuleSha256: string;
  retirementSha256: string;
  checkpointSha256: string;
  preparedReceiptSha256: string;
  preparedTreeSha256: string;
  preparedImmutableTreeSha256: string;
  physicalRoot: string;
  physicalOperatorDirectory: string;
  physicalNpmPath: string;
  keyId: string;
}
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
    canonicalJson(value) + "\n" !== text ||
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
  const record = object(value);
  same(
    Object.keys(record).sort(),
    [
      "capsuleSha256",
      "retirementSha256",
      "checkpointSha256",
      "preparedReceiptSha256",
      "preparedTreeSha256",
      "preparedImmutableTreeSha256",
      "physicalRoot",
      "physicalOperatorDirectory",
      "physicalNpmPath",
      "keyId",
    ].sort()
  );
  for (const name of [
    "capsuleSha256",
    "retirementSha256",
    "checkpointSha256",
    "preparedReceiptSha256",
    "preparedTreeSha256",
    "preparedImmutableTreeSha256",
    "keyId",
  ] as const)
    if (!hashPattern.test(value[name])) fail();
  if (value.keyId !== sha256(recoveryKey)) fail();
  for (const name of [
    "physicalRoot",
    "physicalOperatorDirectory",
    "physicalNpmPath",
  ] as const) {
    const text = value[name],
      flavor = /^[A-Za-z]:\\/.test(text) ? win32 : posix;
    if (
      typeof text !== "string" ||
      text.length > 4096 ||
      [...text].some((character) => character.charCodeAt(0) < 32) ||
      text.startsWith("\\\\") ||
      text.startsWith("//") ||
      !flavor.isAbsolute(text) ||
      flavor.resolve(text) !== text
    )
      fail();
  }
  const flavor = /^[A-Za-z]:\\/.test(value.physicalRoot) ? win32 : posix;
  if (
    value.physicalOperatorDirectory !==
    flavor.join(value.physicalRoot, "operator")
  )
    fail();
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
