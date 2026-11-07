import { sha256 } from "./steve-preflight.js";

export const resumeSnapshotChunkSize = 4 * 1024 * 1024;
const maxSize = 512 * 1024 * 1024;
export interface ResumeSnapshotEvidence {
  size: number;
  sha256: string;
  chunks: { index: number; size: number; sha256: string }[];
}
/** Deterministic description of encrypted bytes; installation and signing are
 * separate obligations. No key or decrypted ledger is included. */
export function describeResumeSnapshot(bytes: Buffer): ResumeSnapshotEvidence {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maxSize)
    throw Error("INVALID_RESUME_SNAPSHOT_EVIDENCE");
  const chunks: ResumeSnapshotEvidence["chunks"] = [];
  for (
    let offset = 0;
    offset < bytes.length;
    offset += resumeSnapshotChunkSize
  ) {
    const chunk = bytes.subarray(offset, offset + resumeSnapshotChunkSize);
    chunks.push({
      index: chunks.length,
      size: chunk.length,
      sha256: sha256(chunk),
    });
  }
  return { size: bytes.length, sha256: sha256(bytes), chunks };
}
/** Validate the bounded manifest before using its paths or sizes. */
export function validateResumeSnapshotEvidence(
  value: unknown
): ResumeSnapshotEvidence {
  const fail = (): never => {
    throw Error("INVALID_RESUME_SNAPSHOT_EVIDENCE");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const e = value as ResumeSnapshotEvidence;
  if (
    Object.keys(e).sort().join(",") !== "chunks,sha256,size" ||
    !Number.isSafeInteger(e.size) ||
    e.size <= 0 ||
    e.size > maxSize ||
    typeof e.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(e.sha256) ||
    !Array.isArray(e.chunks) ||
    e.chunks.length !== Math.ceil(e.size / resumeSnapshotChunkSize)
  )
    return fail();
  for (const [index, item] of e.chunks.entries())
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(",") !== "index,sha256,size" ||
      item.index !== index ||
      item.size !==
        Math.min(
          resumeSnapshotChunkSize,
          e.size - index * resumeSnapshotChunkSize
        ) ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      return fail();
  return structuredClone(e);
}
/** Authenticate detached chunks against a separately authenticated manifest. */
export function restoreResumeSnapshot(
  evidence: ResumeSnapshotEvidence,
  chunks: Buffer[]
): Buffer {
  const fail = (): never => {
    throw Error("INVALID_RESUME_SNAPSHOT_EVIDENCE");
  };
  if (
    !evidence ||
    !Number.isSafeInteger(evidence.size) ||
    evidence.size <= 0 ||
    evidence.size > maxSize ||
    !Array.isArray(evidence.chunks) ||
    !Array.isArray(chunks) ||
    chunks.length !== evidence.chunks.length ||
    chunks.length !== Math.ceil(evidence.size / resumeSnapshotChunkSize) ||
    !/^[a-f0-9]{64}$/.test(evidence.sha256)
  )
    return fail();
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index],
      item = evidence.chunks[index];
    const size = Math.min(
      resumeSnapshotChunkSize,
      evidence.size - index * resumeSnapshotChunkSize
    );
    if (
      !Buffer.isBuffer(chunk) ||
      !item ||
      Object.keys(item).sort().join(",") !== "index,sha256,size" ||
      item.index !== index ||
      item.size !== size ||
      chunk.length !== size ||
      item.sha256 !== sha256(chunk)
    )
      return fail();
  }
  const bytes = Buffer.concat(chunks);
  if (
    sha256(bytes) !== evidence.sha256 ||
    Object.keys(evidence).sort().join(",") !== "chunks,sha256,size"
  )
    return fail();
  return bytes;
}
