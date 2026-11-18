import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import {
  selectedLoadHistoryLayout,
  selectedLoadHistoryManifestFilename,
} from "./recovery-gmail-selected-load-paths.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import {
  describeResumeSnapshot,
  restoreResumeSnapshot,
  resumeSnapshotChunkSize,
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
  encryptedCatalog:
    selectedLoadHistoryLayout.encryptedCatalog.chunks * resumeSnapshotChunkSize,
  guardedJournal:
    selectedLoadHistoryLayout.guardedJournal.chunks * resumeSnapshotChunkSize,
  inventory:
    selectedLoadHistoryLayout.inventory.chunks * resumeSnapshotChunkSize,
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

export function assertSelectedLoadHistoryIdentity(
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
  assertSelectedLoadHistoryIdentity(identity);
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
  assertSelectedLoadHistoryIdentity(expectedIdentity);
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
    assertSelectedLoadHistoryIdentity(body.identity);
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

function partFilename(part: PartName, index: number) {
  return (
    selectedLoadHistoryLayout[part].prefix +
    String(index).padStart(3, "0") +
    ".bin"
  );
}

/** Produce ordered, immutable files for the existing secure intent installer.
 * The guarded caller must authorize exactly this set and install the result last. */
export function prepareSelectedLoadHistoryFiles(
  identity: SelectedLoadHistoryIdentity,
  parts: HistoryParts<Buffer>,
  key: Buffer
) {
  const manifest = signSelectedLoadHistoryManifest(identity, parts, key);
  const files: { name: string; bytes: Buffer }[] = [];
  for (const part of partNames) {
    const bytes = parts[part];
    for (
      let offset = 0;
      offset < bytes.length;
      offset += resumeSnapshotChunkSize
    ) {
      files.push({
        name: partFilename(part, offset / resumeSnapshotChunkSize),
        bytes: bytes.subarray(offset, offset + resumeSnapshotChunkSize),
      });
    }
  }
  files.push({ name: selectedLoadHistoryManifestFilename, bytes: manifest });
  return { files, manifestSha256: sha256(manifest) };
}

/** Require a settled closed family. The supplied reader must independently bind
 * every file to its observed entry and stable unlinked physical identity. */
export function readSelectedLoadHistoryFiles(input: {
  loadPath: string;
  entries: readonly RecoveryRuntimeEntry[];
  read: (path: string, limit: number) => Buffer;
  identity: SelectedLoadHistoryIdentity;
  key: Buffer;
}) {
  if (!/^recovery-gmail-load\/[a-f0-9]{64}$/.test(input.loadPath))
    return invalid();
  const prefix = input.loadPath + "/";
  if (input.loadPath !== "recovery-gmail-load/" + input.identity.runId)
    return invalid();
  const observed = input.entries.filter((entry) =>
    entry.path.startsWith(prefix + "history-")
  );
  const byPath = new Map(observed.map((entry) => [entry.path, entry]));
  if (byPath.size !== observed.length) return invalid();
  const read = (name: string, limit: number) => {
    const path = prefix + name;
    const file = byPath.get(path);
    if (
      file?.kind !== "file" ||
      file.size > limit ||
      byPath.get(path + "-stage")?.kind !== "directory"
    )
      return invalid();
    const bytes = input.read(path, limit);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== file.size ||
      sha256(bytes) !== file.sha256
    )
      return invalid();
    byPath.delete(path);
    byPath.delete(path + "-stage");
    return bytes;
  };
  const manifest = verifySelectedLoadHistoryManifest(
    read(selectedLoadHistoryManifestFilename, maxManifestBytes),
    input.key,
    input.identity
  );
  const parts = {} as HistoryParts<Buffer>;
  for (const part of partNames) {
    const evidence = manifest.parts[part];
    parts[part] = restoreResumeSnapshot(
      evidence,
      evidence.chunks.map(({ index, size }) =>
        read(partFilename(part, index), size)
      )
    );
  }
  if (byPath.size !== 0) return invalid();
  return {
    manifestSha256: manifest.manifestSha256,
    parts,
    loadAllowed: false as const,
  };
}
