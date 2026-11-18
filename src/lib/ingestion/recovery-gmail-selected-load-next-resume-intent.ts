import { join, relative, resolve, sep } from "node:path";
import { inspectRecoveryInstalledFile } from "./encrypted-backup.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import type { WeeklyRunLease } from "./weekly-run-journal.js";

const kind = "zivv-selected-next-load-resume-intent";
const domain = kind + "/v1\0";
const digest = /^[a-f0-9]{64}$/;
export const nextSelectedLoadResumeIntentFilename = "resume-intent.json";

export interface NextSelectedLoadResumeGap {
  runId: string;
  admissionSha256: string;
  executionBaselineSha256: string;
  priorLoadFamilySha256: string;
  journalSha256: string;
  inventorySha256: string;
  ledgerRevision: string;
  generation: 2 | 3;
  previousOwner: WeeklyRunLease;
  backupSha256: string;
  backupSize: number;
  reportPresent: boolean;
}

export interface NextSelectedLoadResumeIntent extends NextSelectedLoadResumeGap {
  owner: string;
  fence: number;
  startedAtEpochMs: number;
  deadlineEpochMs: number;
}

const fields = [
  "admissionSha256",
  "backupSha256",
  "backupSize",
  "deadlineEpochMs",
  "executionBaselineSha256",
  "fence",
  "generation",
  "inventorySha256",
  "journalSha256",
  "ledgerRevision",
  "owner",
  "previousOwner",
  "priorLoadFamilySha256",
  "reportPresent",
  "runId",
  "startedAtEpochMs",
].sort();

function fail(): never {
  throw Error("INVALID_NEXT_SELECTED_LOAD_RESUME_INTENT");
}

function object(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  )
    return fail();
  return value as Record<string, unknown>;
}

function signature(payload: unknown, key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return fail();
  return createHmac("sha256", key)
    .update(domain)
    .update(canonicalJson(payload))
    .digest();
}

function validate(
  value: unknown
): asserts value is NextSelectedLoadResumeIntent {
  const fieldsValue = object(value, fields);
  for (const name of [
    "runId",
    "admissionSha256",
    "executionBaselineSha256",
    "priorLoadFamilySha256",
    "journalSha256",
    "inventorySha256",
    "ledgerRevision",
    "backupSha256",
  ]) {
    const field = fieldsValue[name];
    if (typeof field !== "string" || !digest.test(field)) return fail();
  }
  const intent = fieldsValue as unknown as NextSelectedLoadResumeIntent;
  const previous = object(intent.previousOwner, [
    "scope",
    "owner",
    "fence",
    "expiresAtEpochMs",
  ]);
  const hash = sha256("selected-load/" + intent.admissionSha256);
  const owner = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
  if (
    ![2, 3].includes(intent.generation) ||
    typeof intent.reportPresent !== "boolean" ||
    (intent.generation === 3 && !intent.reportPresent) ||
    !Number.isSafeInteger(intent.backupSize) ||
    intent.backupSize < 1 ||
    intent.backupSize > 512 * 1024 * 1024 ||
    previous.scope !== "prodigic/zivv/production" ||
    previous.owner !== owner ||
    intent.owner !== owner ||
    !Number.isSafeInteger(previous.fence) ||
    intent.previousOwner.fence < 1 ||
    !Number.isSafeInteger(intent.fence) ||
    intent.fence !== intent.previousOwner.fence + 1 ||
    !Number.isSafeInteger(previous.expiresAtEpochMs) ||
    intent.previousOwner.expiresAtEpochMs <= 0 ||
    !Number.isSafeInteger(intent.startedAtEpochMs) ||
    intent.startedAtEpochMs <= intent.previousOwner.expiresAtEpochMs ||
    !Number.isSafeInteger(intent.deadlineEpochMs) ||
    intent.deadlineEpochMs !== intent.startedAtEpochMs + 180000
  )
    return fail();
}

export function signNextSelectedLoadResumeIntent(
  fields: NextSelectedLoadResumeGap,
  startedAtEpochMs: number,
  key: Buffer
) {
  const intent = {
    ...fields,
    owner: fields.previousOwner.owner,
    fence: fields.previousOwner.fence + 1,
    startedAtEpochMs,
    deadlineEpochMs: startedAtEpochMs + 180000,
  };
  validate(intent);
  const body = { kind, version: 1, intent };
  return Buffer.from(
    canonicalJson({
      ...body,
      signature: signature(body, key).toString("hex"),
    }) + "\n"
  );
}

/** Authenticate the immutable retry plan. It supplies no writer authority. */
export function verifyNextSelectedLoadResumeIntent(bytes: Buffer, key: Buffer) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > 8192) return fail();
    const { signature: saved, ...body } = object(
      JSON.parse(bytes.toString("utf8")),
      ["kind", "version", "intent", "signature"]
    );
    if (
      body.kind !== kind ||
      body.version !== 1 ||
      typeof saved !== "string" ||
      !digest.test(saved) ||
      !bytes.equals(
        Buffer.from(canonicalJson({ ...body, signature: saved }) + "\n")
      ) ||
      !timingSafeEqual(Buffer.from(saved, "hex"), signature(body, key))
    )
      return fail();
    validate(body.intent);
    return structuredClone(body.intent);
  } catch {
    return fail();
  }
}

/** Read only the canonical intent and its empty fixed stage. A candidate
 * needs its own settlement proof before it can grant retry eligibility. */
export function readInstalledNextSelectedLoadResumeIntent(
  loadPath: string,
  entries: RecoveryRuntimeEntry[],
  read: (path: string, limit: number) => Buffer,
  key: Buffer
) {
  const path = loadPath + "/" + nextSelectedLoadResumeIntentFilename;
  const stage = path + "-stage";
  const related = entries.filter((entry) => entry.path.startsWith(path));
  if (!related.length) return undefined;
  if (
    related.length !== 2 ||
    !related.some((entry) => entry.path === path && entry.kind === "file") ||
    !related.some((entry) => entry.path === stage && entry.kind === "directory")
  )
    return fail();
  const bytes = read(path, 8192);
  return {
    path,
    stage,
    bytes,
    intent: verifyNextSelectedLoadResumeIntent(bytes, key),
  };
}

export function nextSelectedLoadResumeGap(
  intent: NextSelectedLoadResumeIntent
): NextSelectedLoadResumeGap {
  const {
    owner: _owner,
    fence: _fence,
    startedAtEpochMs: _started,
    deadlineEpochMs: _deadline,
    ...gap
  } = intent;
  return gap;
}

/** Authenticate the exact installed intent or its one owned stage. */
export function observeNextSelectedLoadResumeIntent(
  destination: string,
  loadPath: string,
  entries: RecoveryRuntimeEntry[],
  key: Buffer
) {
  const path = loadPath + "/" + nextSelectedLoadResumeIntentFilename;
  const stage = path + "-stage";
  const related = entries.filter((entry) => entry.path.startsWith(path));
  if (!related.length) return undefined;
  const directory = resolve(destination);
  const observed = inspectRecoveryInstalledFile(
    join(directory, path),
    join(directory, stage),
    8192
  );
  const { target, candidate } = observed;
  const source = target ?? candidate;
  if (
    !source ||
    (target && candidate && (target.nlink !== 2 || candidate.nlink !== 2))
  )
    return fail();
  const paths = new Map<string, RecoveryRuntimeEntry>();
  paths.set(stage, { path: stage, kind: "directory" });
  for (const file of [target, candidate]) {
    if (!file) continue;
    const physical = relative(directory, file.path).split(sep).join("/");
    paths.set(physical, {
      path: physical,
      kind: "file",
      size: file.bytes.length,
      sha256: sha256(file.bytes),
    });
  }
  if (
    related.length !== paths.size ||
    related.some(
      (entry) => canonicalJson(entry) !== canonicalJson(paths.get(entry.path))
    )
  )
    return fail();
  return {
    path,
    stage,
    bytes: source.bytes,
    intent: verifyNextSelectedLoadResumeIntent(source.bytes, key),
    paths: new Set(paths.keys()),
    observed,
  };
}
