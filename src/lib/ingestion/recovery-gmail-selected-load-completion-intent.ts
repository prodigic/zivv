import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import {
  validateWeeklyJournalRecoverySnapshot,
  type WeeklyRunLease,
} from "./weekly-run-journal.js";
import {
  assertSelectedLoadHistoryIdentity,
  type SelectedLoadHistoryIdentity,
} from "./recovery-gmail-selected-load-history.js";

export interface SelectedLoadCompletionIntent {
  identity: SelectedLoadHistoryIdentity;
  owner: WeeklyRunLease;
  guardedJournalSha256: string;
  releasedJournalSha256: string;
  historyManifestSha256: string;
  resultSha256: string;
}

const kind = "zivv-selected-load-completion-intent";
const domain = kind + "/v1\0";
const digest = /^[a-f0-9]{64}$/;
const fields = [
  "identity",
  "owner",
  "guardedJournalSha256",
  "releasedJournalSha256",
  "historyManifestSha256",
  "resultSha256",
] as const;

function invalid(): never {
  throw Error("INVALID_SELECTED_LOAD_COMPLETION_INTENT");
}

function exactObject(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some(
      (key) => !("value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}))
    )
  )
    return invalid();
  return value as Record<string, unknown>;
}

function requireDigest(value: unknown) {
  if (typeof value !== "string" || !digest.test(value)) invalid();
}

function validate(
  value: unknown
): asserts value is SelectedLoadCompletionIntent {
  const intent = exactObject(value, fields);
  assertSelectedLoadHistoryIdentity(intent.identity);
  for (const field of fields.slice(2)) requireDigest(intent[field]);
  const owner = exactObject(intent.owner, [
    "scope",
    "owner",
    "fence",
    "expiresAtEpochMs",
  ]);
  if (
    owner.scope !== "prodigic/zivv/production" ||
    typeof owner.owner !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner.owner) ||
    typeof owner.fence !== "number" ||
    !Number.isSafeInteger(owner.fence) ||
    owner.fence < 1 ||
    typeof owner.expiresAtEpochMs !== "number" ||
    !Number.isSafeInteger(owner.expiresAtEpochMs) ||
    owner.expiresAtEpochMs <= 0 ||
    intent.guardedJournalSha256 === intent.releasedJournalSha256
  )
    invalid();
}

function sign(body: unknown, key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return invalid();
  return createHmac("sha256", key)
    .update(domain)
    .update(canonicalJson(body))
    .digest();
}

/** Pin the original guarded state before any history files are installed.
 * The caller retains responsibility for the actual writer guards. */
export function signSelectedLoadCompletionIntent(
  fields: SelectedLoadCompletionIntent,
  key: Buffer
): Buffer {
  validate(fields);
  const body = { kind, version: 1, fields };
  return Buffer.from(
    canonicalJson({ ...body, signature: sign(body, key).toString("hex") }) +
      "\n"
  );
}

/** Authenticate one completion proposal. No file mutation or replay is authorized. */
export function verifySelectedLoadCompletionIntent(
  bytes: Buffer,
  key: Buffer,
  expectedIdentity: SelectedLoadHistoryIdentity
) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4096) return invalid();
  assertSelectedLoadHistoryIdentity(expectedIdentity);
  try {
    const { signature, ...body } = exactObject(
      JSON.parse(bytes.toString("utf8")),
      ["kind", "version", "fields", "signature"]
    );
    if (
      body.kind !== kind ||
      body.version !== 1 ||
      typeof signature !== "string" ||
      !digest.test(signature) ||
      !bytes.equals(
        Buffer.from(canonicalJson({ ...body, signature }) + "\n")
      ) ||
      !timingSafeEqual(Buffer.from(signature, "hex"), sign(body, key))
    )
      return invalid();
    validate(body.fields);
    if (canonicalJson(body.fields.identity) !== canonicalJson(expectedIdentity))
      return invalid();
    return {
      fields: body.fields,
      intentSha256: sha256(bytes),
      loadAllowed: false as const,
    };
  } catch {
    return invalid();
  }
}

/** Rebuild both exact snapshots without changing ownership. The caller must
 * authenticate the intent and separately rule out any active or successor owner. */
export function reconstructSelectedLoadCompletionJournals(
  observedJournal: Buffer,
  fields: SelectedLoadCompletionIntent
) {
  validate(fields);
  const observedSha = sha256(observedJournal);
  if (
    observedSha !== fields.guardedJournalSha256 &&
    observedSha !== fields.releasedJournalSha256
  )
    return invalid();
  const { digest: _digest, ...body } =
    validateWeeklyJournalRecoverySnapshot(observedJournal);
  const owner = body.ownership.find((row) => row.scope === fields.owner.scope);
  if (
    !owner ||
    owner.owner !== fields.owner.owner ||
    owner.fence !== fields.owner.fence ||
    owner.expiresAtEpochMs !==
      (observedSha === fields.guardedJournalSha256
        ? fields.owner.expiresAtEpochMs
        : 0)
  )
    return invalid();
  const withExpiry = (expiresAtEpochMs: number) => {
    const projected = {
      ...body,
      ownership: body.ownership.map((row) =>
        row.scope === owner.scope ? { ...row, expiresAtEpochMs } : row
      ),
    };
    return Buffer.from(
      canonicalJson({
        ...projected,
        digest: sha256(canonicalJson(projected)),
      }) + "\n"
    );
  };
  const guardedJournal = withExpiry(fields.owner.expiresAtEpochMs);
  const releasedJournal = withExpiry(0);
  if (
    sha256(guardedJournal) !== fields.guardedJournalSha256 ||
    sha256(releasedJournal) !== fields.releasedJournalSha256
  )
    return invalid();
  return { guardedJournal, releasedJournal, loadAllowed: false as const };
}

/** Derive the exact release equivalent without changing the stored lease. */
export function projectSelectedLoadReleasedJournal(guardedJournal: Buffer) {
  const released = validateWeeklyJournalRecoverySnapshot(guardedJournal);
  const owner = released.ownership.find(
    (row) => row.scope === "prodigic/zivv/production"
  );
  if (!owner || owner.expiresAtEpochMs <= 0) return invalid();
  const guardedOwner = { ...owner };
  owner.expiresAtEpochMs = 0;
  const { digest: _digest, ...body } = released;
  return {
    owner: guardedOwner,
    releasedJournal: Buffer.from(
      canonicalJson({
        ...body,
        digest: sha256(canonicalJson(body)),
      }) + "\n"
    ),
  };
}
