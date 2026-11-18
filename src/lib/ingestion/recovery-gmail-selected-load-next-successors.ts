import { createHmac, timingSafeEqual } from "node:crypto";
import { reconstructSelectedLoadAcquiredIntentJournal } from "./recovery-gmail-selected-acquired-intent-journal.js";
import type { NextSelectedLoadResumeIntent } from "./recovery-gmail-selected-load-next-resume-intent.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import type { WeeklyRunLease } from "./weekly-run-journal.js";

const kind = "zivv-selected-next-load-resume-successor";
const prefix = "/resume-successor-";
const digest = /^[a-f0-9]{64}$/;
const limit = 999;

export interface NextSelectedLoadResumeSuccessor {
  sequence: number;
  initialSha256: string;
  parentSha256: string;
  journalSha256: string;
  previousOwner: WeeklyRunLease;
  owner: string;
  fence: number;
  startedAtEpochMs: number;
  deadlineEpochMs: number;
}

interface RetryRecord {
  bytes: Buffer;
  intent: NextSelectedLoadResumeIntent | NextSelectedLoadResumeSuccessor;
}

function fail(): never {
  throw Error("INVALID_NEXT_SELECTED_LOAD_RESUME_SUCCESSOR");
}

function filename(sequence: number) {
  return prefix.slice(1) + String(sequence).padStart(5, "0") + ".json";
}

function bodyFor(
  initial: RetryRecord,
  parent: RetryRecord,
  sequence: number,
  journalSha256: string,
  previousOwner: WeeklyRunLease,
  startedAtEpochMs: number
) {
  const prior = parent.intent;
  const { scope, owner, fence, expiresAtEpochMs } = previousOwner;
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > limit ||
    typeof journalSha256 !== "string" ||
    !digest.test(journalSha256) ||
    scope !== "prodigic/zivv/production" ||
    owner !== prior.owner ||
    fence !== prior.fence ||
    !Number.isSafeInteger(fence + 1) ||
    !Number.isSafeInteger(expiresAtEpochMs) ||
    (expiresAtEpochMs !== 0 &&
      (expiresAtEpochMs < prior.startedAtEpochMs ||
        expiresAtEpochMs > prior.deadlineEpochMs)) ||
    !Number.isSafeInteger(startedAtEpochMs + 180000) ||
    startedAtEpochMs <= expiresAtEpochMs ||
    startedAtEpochMs < prior.deadlineEpochMs
  )
    return fail();
  const intent: NextSelectedLoadResumeSuccessor = {
    sequence,
    initialSha256: sha256(initial.bytes),
    parentSha256: sha256(parent.bytes),
    journalSha256,
    previousOwner: { scope, owner, fence, expiresAtEpochMs },
    owner,
    fence: fence + 1,
    startedAtEpochMs,
    deadlineEpochMs: startedAtEpochMs + 180000,
  };
  return { kind, version: 1, intent };
}

function signature(body: ReturnType<typeof bodyFor>, key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return fail();
  return createHmac("sha256", key)
    .update(kind + "/v1\0")
    .update(canonicalJson(body))
    .digest();
}

function encode(body: ReturnType<typeof bodyFor>, signed: string) {
  return Buffer.from(canonicalJson({ ...body, signature: signed }) + "\n");
}

export function prepareNextSelectedLoadResumeSuccessor(input: {
  initial: RetryRecord;
  parent: RetryRecord;
  sequence: number;
  journal: Buffer;
  previousOwner: WeeklyRunLease;
  startedAtEpochMs: number;
  key: Buffer;
}) {
  const body = bodyFor(
    input.initial,
    input.parent,
    input.sequence,
    sha256(input.journal),
    input.previousOwner,
    input.startedAtEpochMs
  );
  return {
    filename: filename(input.sequence),
    bytes: encode(body, signature(body, input.key).toString("hex")),
    intent: body.intent,
  };
}

/** Authenticate only an ordered chain of settled records in the exact B family. */
export function readNextSelectedLoadResumeSuccessors(input: {
  loadPath: string;
  entries: RecoveryRuntimeEntry[];
  read: (path: string, limit: number) => Buffer;
  initial?: RetryRecord;
  key: Buffer;
}) {
  const related = input.entries.filter((entry) =>
    entry.path.startsWith(input.loadPath + prefix)
  );
  const byPath = new Map(related.map((entry) => [entry.path, entry]));
  const records: Array<{
    path: string;
    stage: string;
    bytes: Buffer;
    intent: NextSelectedLoadResumeSuccessor;
  }> = [];
  if (!related.length) return records;
  const count = related.length / 2;
  if (
    !input.initial ||
    byPath.size !== related.length ||
    !Number.isInteger(count) ||
    count > limit
  )
    return fail();
  let parent = input.initial;
  for (let sequence = 1; sequence <= count; sequence++) {
    const path = input.loadPath + "/" + filename(sequence);
    const stage = path + "-stage";
    if (
      byPath.get(path)?.kind !== "file" ||
      byPath.get(stage)?.kind !== "directory"
    )
      return fail();
    const bytes = input.read(path, 8192);
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      signature?: unknown;
      intent?: NextSelectedLoadResumeSuccessor;
    };
    if (
      typeof parsed?.signature !== "string" ||
      !digest.test(parsed.signature) ||
      !parsed.intent
    )
      return fail();
    const body = bodyFor(
      input.initial,
      parent,
      sequence,
      parsed.intent.journalSha256,
      parsed.intent.previousOwner,
      parsed.intent.startedAtEpochMs
    );
    if (
      !bytes.equals(encode(body, parsed.signature)) ||
      !timingSafeEqual(
        Buffer.from(parsed.signature, "hex"),
        signature(body, input.key)
      )
    )
      return fail();
    const record = { path, stage, bytes, intent: body.intent };
    records.push(record);
    parent = record;
  }
  return records;
}

/** Each acquired fence must rewind to its parent's exact signed journal. */
export function rewindNextSelectedLoadAcquiredRetries(
  journal: Buffer,
  records: readonly RetryRecord[]
) {
  let previousJournal = journal;
  for (const { intent } of [...records].reverse()) {
    previousJournal = reconstructSelectedLoadAcquiredIntentJournal({
      observedJournal: previousJournal,
      intent,
    }).previousJournal;
  }
  return previousJournal;
}
