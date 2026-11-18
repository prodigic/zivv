import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import {
  describeResumeSnapshot,
  validateResumeSnapshotEvidence,
  type ResumeSnapshotEvidence,
} from "./recovery-gmail-selected-resume-snapshot-evidence.js";

export interface SelectedLoadHistoryIdentity {
  runId: string;
  admissionSha256: string;
  executionBaselineSha256: string;
  priorFamilySha256: string;
  ledgerRevision: string;
  generation: number;
}
const partNames = ["encryptedCatalog", "guardedJournal", "inventory"] as const;
type PartName = (typeof partNames)[number];
type HistoryParts<T> = Record<PartName, T>;
const limits: HistoryParts<number> = {
  encryptedCatalog: 512 * 1024 * 1024,
  guardedJournal: 256 * 1024 * 1024,
  inventory: 32 * 1024 * 1024,
};
const identityKeys = [
  "admissionSha256",
  "executionBaselineSha256",
  "generation",
  "ledgerRevision",
  "priorFamilySha256",
  "runId",
] as const;
const kind = "zivv-selected-load-history";
const domain = kind + "/v1\0";
const maxManifestBytes = 64 * 1024;
const digest = /^[a-f0-9]{64}$/;

function invalid(): never {
  throw Error("INVALID_SELECTED_LOAD_HISTORY_MANIFEST");
}

function object(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some(
      (field) =>
        !("value" in (Object.getOwnPropertyDescriptor(value, field) ?? {}))
    )
  )
    return invalid();
  return value as Record<string, unknown>;
}

function assertIdentity(
  value: unknown
): asserts value is SelectedLoadHistoryIdentity {
  const identity = object(value, identityKeys);
  for (const field of identityKeys) {
    const value = identity[field];
    if (
      field === "generation"
        ? typeof value !== "number" || !Number.isSafeInteger(value) || value < 2
        : typeof value !== "string" || !digest.test(value)
    )
      invalid();
  }
}

function signature(body: unknown, key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return invalid();
  return createHmac("sha256", key)
    .update(domain)
    .update(canonicalJson(body))
    .digest();
}

/** Describe immutable private evidence before the completed result is signed.
 * The final result must bind the manifest digest to close the historical load. */
export function signSelectedLoadHistoryManifest(
  identity: SelectedLoadHistoryIdentity,
  parts: HistoryParts<Buffer>,
  key: Buffer
): Buffer {
  assertIdentity(identity);
  object(parts, partNames);
  const evidence = {} as HistoryParts<ResumeSnapshotEvidence>;
  for (const name of partNames) {
    const bytes = parts[name];
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length === 0 ||
      bytes.length > limits[name]
    )
      invalid();
    evidence[name] = describeResumeSnapshot(bytes);
  }
  const body = { kind, version: 1, identity, parts: evidence };
  const encoded = Buffer.from(
    canonicalJson({
      ...body,
      signature: signature(body, key).toString("hex"),
    }) + "\n"
  );
  if (encoded.length > maxManifestBytes) return invalid();
  return encoded;
}

/** Authenticate the historical manifest and its exact selected-load identity.
 * Callers must verify the result binding, all chunks and semantic deltas. */
export function verifySelectedLoadHistoryManifest(
  bytes: Buffer,
  key: Buffer,
  expectedIdentity: SelectedLoadHistoryIdentity
) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxManifestBytes)
    return invalid();
  assertIdentity(expectedIdentity);
  try {
    const { signature: saved, ...body } = object(
      JSON.parse(bytes.toString("utf8")),
      ["kind", "version", "identity", "parts", "signature"]
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
      return invalid();
    assertIdentity(body.identity);
    if (canonicalJson(body.identity) !== canonicalJson(expectedIdentity))
      return invalid();
    const parts = object(body.parts, partNames);
    const verified = {} as HistoryParts<ResumeSnapshotEvidence>;
    for (const name of partNames) {
      const part = validateResumeSnapshotEvidence(parts[name]);
      if (part.size > limits[name]) return invalid();
      verified[name] = part;
    }
    return {
      manifestSha256: sha256(bytes),
      parts: verified,
      loadAllowed: false as const,
    };
  } catch {
    return invalid();
  }
}
