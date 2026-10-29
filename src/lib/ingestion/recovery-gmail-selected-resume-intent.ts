import {
  validateResumeSnapshotEvidence,
  type ResumeSnapshotEvidence,
} from "./recovery-gmail-selected-resume-snapshot-evidence.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import type { WeeklyRunLease } from "./weekly-run-journal.js";
export interface SelectedLoadResumeIntent {
  kind: "zivv-selected-load-resume-intent";
  version: 2;
  snapshotEvidence: ResumeSnapshotEvidence | null;
  admissionSha256: string;
  executionBaselineSha256: string;
  journalSha256: string;
  inventorySha256: string;
  ledgerRevision: string;
  generation: number;
  previousOwner: WeeklyRunLease;
  fence: number;
  owner: string;
  startedAtEpochMs: number;
  deadlineEpochMs: number;
}
/** Authentication is detached evidence and grants no execution authority. */
export function verifySelectedLoadResumeIntent(
  bytes: Buffer,
  key: Buffer
): SelectedLoadResumeIntent {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_RESUME_INTENT");
  };
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > 65536 ||
    !Buffer.isBuffer(key) ||
    key.length !== 32
  )
    return fail();
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    return fail();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !bytes.equals(Buffer.from(canonicalJson(value) + "\n"))
  )
    return fail();
  const keys = [
    "kind",
    "version",
    "snapshotEvidence",
    "signature",
    "admissionSha256",
    "executionBaselineSha256",
    "journalSha256",
    "inventorySha256",
    "ledgerRevision",
    "generation",
    "previousOwner",
    "fence",
    "owner",
    "startedAtEpochMs",
    "deadlineEpochMs",
  ];
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort()) ||
    value.kind !== "zivv-selected-load-resume-intent" ||
    value.version !== 2 ||
    value.generation !== 2 ||
    typeof value.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.signature)
  )
    return fail();
  for (const field of [
    "admissionSha256",
    "executionBaselineSha256",
    "journalSha256",
    "inventorySha256",
    "ledgerRevision",
  ])
    if (
      typeof value[field] !== "string" ||
      !/^[a-f0-9]{64}$/.test(value[field] as string)
    )
      return fail();
  if (value.snapshotEvidence !== null)
    validateResumeSnapshotEvidence(value.snapshotEvidence);
  const { signature, ...body } = value,
    expected = createHmac("sha256", key)
      .update("zivv-selected-load-resume-intent/v1\0")
      .update(canonicalJson(body))
      .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature as string, "hex")))
    return fail();
  const previous = value.previousOwner as WeeklyRunLease;
  if (
    !previous ||
    typeof previous !== "object" ||
    Array.isArray(previous) ||
    canonicalJson(Object.keys(previous).sort()) !==
      canonicalJson(["scope", "owner", "fence", "expiresAtEpochMs"].sort()) ||
    previous.scope !== "prodigic/zivv/production" ||
    typeof previous.owner !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(previous.owner) ||
    !Number.isSafeInteger(previous.fence) ||
    previous.fence < 1 ||
    !Number.isSafeInteger(previous.expiresAtEpochMs) ||
    previous.expiresAtEpochMs < 0 ||
    !Number.isSafeInteger(value.fence) ||
    value.fence !== previous.fence + 1 ||
    !Number.isSafeInteger(value.startedAtEpochMs) ||
    Number(value.startedAtEpochMs) < previous.expiresAtEpochMs ||
    !Number.isSafeInteger(value.deadlineEpochMs) ||
    value.deadlineEpochMs !== Number(value.startedAtEpochMs) + 180000
  )
    return fail();
  const hash = sha256("selected-load/" + value.admissionSha256),
    owner = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join("-");
  if (value.owner !== owner || previous.owner !== owner) return fail();
  return structuredClone(body) as unknown as SelectedLoadResumeIntent;
}
