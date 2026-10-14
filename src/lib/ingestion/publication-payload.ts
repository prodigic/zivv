import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readPublishableCandidate } from "./reviewed-candidate.js";
import {
  parseReleaseCandidate,
  type CandidateFile,
  type ReleaseCandidate,
} from "./release-candidate.js";
import { verifyApplicationBuildReceipt } from "./source-build.js";
import { canonicalJson } from "./sqlite-store.js";
import { normalizeSiteBase } from "../../utils/site-base.js";

export interface PublicationExpectation {
  expectedCandidateId: string;
  expectedSourceCommit: string;
  basePath: string;
  purpose: "preview" | "release";
}

/** Public metadata only; encoded build JSON preserves the original hashed bytes. */
export interface PublicationReceipt {
  schemaVersion: 1;
  receiptId: string;
  candidate: ReleaseCandidate;
  purpose: "preview" | "release";
  applicationBuildManifest: string;
  applicationBuildReceipt: string;
  /** Every payload file except this self-identifying receipt. */
  files: CandidateFile[];
}

export interface PublicationPayload {
  receipt: PublicationReceipt;
  files: Map<string, Buffer>;
  publicFiles: Map<string, Buffer>;
  snapshot: Buffer;
}

const RECEIPT = "receipt.json";
const SNAPSHOT = "recovery/ledger.snapshot.enc";
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function portablePath(path: string): void {
  if (
    !path ||
    path.includes("\\") ||
    path.split("/").some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[<>:"|?*]/.test(part) ||
        [...part].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }) ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  )
    throw new Error("Unsupported publication payload path");
}

function inventory(files: ReadonlyMap<string, Buffer>): CandidateFile[] {
  return [...files]
    .filter(([path]) => path !== RECEIPT)
    .map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) }))
    .sort((a, b) => compare(a.path, b.path));
}

function copyFiles(files: ReadonlyMap<string, Buffer>): Map<string, Buffer> {
  const copied = new Map<string, Buffer>();
  const seen = new Set<string>();
  for (const [path, bytes] of files) {
    portablePath(path);
    if (seen.has(path.toLowerCase()))
      throw new Error("Case-folded publication payload collision");
    seen.add(path.toLowerCase());
    if (!Buffer.isBuffer(bytes))
      throw new Error("Publication payload must contain byte buffers");
    copied.set(path, Buffer.from(bytes));
  }
  return copied;
}

function decode(value: unknown): Buffer {
  if (typeof value !== "string")
    throw new Error("Invalid encoded build metadata");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value)
    throw new Error("Noncanonical encoded build metadata");
  return bytes;
}

/** Recheck remote/raw-Git buffers without private ledger inputs or a recovery key. */
export function verifyPublicationPayload(
  suppliedFiles: ReadonlyMap<string, Buffer>,
  expected: PublicationExpectation
): PublicationPayload {
  const files = copyFiles(suppliedFiles);
  const receiptBytes = files.get(RECEIPT);
  if (!receiptBytes) throw new Error("Missing publication receipt");
  const parsed: unknown = JSON.parse(receiptBytes.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Invalid publication receipt");
  const value = parsed as Record<string, unknown>;
  if (
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(
        [
          "schemaVersion",
          "receiptId",
          "candidate",
          "purpose",
          "applicationBuildManifest",
          "applicationBuildReceipt",
          "files",
        ].sort()
      ) ||
    value.schemaVersion !== 1 ||
    typeof value.receiptId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.receiptId) ||
    !["preview", "release"].includes(String(value.purpose)) ||
    typeof value.purpose !== "string"
  )
    throw new Error("Invalid publication receipt schema");
  const { receiptId, ...identity } = value;
  if (
    receiptId !== hash(canonicalJson(identity)) ||
    !receiptBytes.equals(Buffer.from(canonicalJson(value) + "\n"))
  )
    throw new Error("Publication receipt canonical identity mismatch");
  // Candidate identity must be recomputed by the shared candidate parser.
  const candidate = parseReleaseCandidate(
    Buffer.from(canonicalJson(value.candidate))
  );
  if (
    !/^[a-f0-9]{64}$/.test(expected.expectedCandidateId) ||
    !/^[a-f0-9]{40}$/.test(expected.expectedSourceCommit) ||
    candidate.candidateId !== expected.expectedCandidateId ||
    candidate.sourceCommit !== expected.expectedSourceCommit ||
    candidate.basePath !== normalizeSiteBase(expected.basePath) ||
    value.purpose !== expected.purpose
  )
    throw new Error("Publication payload does not match trusted identity");

  const snapshot = files.get(SNAPSHOT);
  if (!snapshot || hash(snapshot) !== candidate.snapshotSha256)
    throw new Error("Publication recovery snapshot mismatch");
  const exactInventory = [
    ...candidate.files.map((file) => ({ ...file, path: "site/" + file.path })),
    { path: SNAPSHOT, size: snapshot.length, sha256: candidate.snapshotSha256 },
  ].sort((a, b) => compare(a.path, b.path));
  if (
    canonicalJson(value.files) !== canonicalJson(exactInventory) ||
    canonicalJson(inventory(files)) !== canonicalJson(exactInventory)
  )
    throw new Error("Publication payload inventory mismatch");
  const publicFiles = new Map(
    candidate.files.map(({ path }) => [
      path,
      Buffer.from(files.get("site/" + path)!),
    ])
  );
  const applicationBuildManifest = decode(value.applicationBuildManifest);
  const applicationBuildReceipt = decode(value.applicationBuildReceipt);
  if (
    hash(applicationBuildManifest) !== candidate.applicationBuildSha256 ||
    hash(applicationBuildReceipt) !== candidate.applicationProvenanceSha256
  )
    throw new Error("Publication build metadata mismatch");
  const build = verifyApplicationBuildReceipt(applicationBuildReceipt, {
    sourceCommit: candidate.sourceCommit,
    basePath: candidate.basePath,
    applicationBuildManifest,
    applicationFiles: new Map(
      [...publicFiles].filter(([path]) => !path.startsWith("data/"))
    ),
  });
  if (build.purpose !== value.purpose)
    throw new Error("Build purpose does not authorize this publication");
  return {
    receipt: value as unknown as PublicationReceipt,
    files,
    publicFiles,
    snapshot: Buffer.from(snapshot),
  };
}

/** Authenticate the private pair once, then create an exact public-safe payload. */
export async function createPublicationPayload(
  input: PublicationExpectation & { directory: string; recoveryKey: Buffer }
): Promise<PublicationPayload> {
  const captured = { ...input, recoveryKey: Buffer.from(input.recoveryKey) };
  const verified = await readPublishableCandidate(captured);
  const files = new Map(
    [...verified.publicFiles].map(([path, bytes]) => [
      "site/" + path,
      Buffer.from(bytes),
    ])
  );
  files.set(SNAPSHOT, Buffer.from(verified.snapshot));
  const identity = {
    schemaVersion: 1 as const,
    candidate: verified.candidate,
    purpose: captured.purpose,
    applicationBuildManifest:
      verified.applicationBuildManifest.toString("base64"),
    applicationBuildReceipt:
      verified.applicationBuildReceipt!.toString("base64"),
    files: inventory(files),
  };
  const receipt = { ...identity, receiptId: hash(canonicalJson(identity)) };
  files.set(RECEIPT, Buffer.from(canonicalJson(receipt) + "\n"));
  return verifyPublicationPayload(files, captured);
}

function unlinkedParents(path: string): void {
  for (let parent = path; ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Linked publication payload directory refused");
    if (dirname(parent) === parent) break;
  }
}

function regularFile(path: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error("Publication payload must contain unlinked regular files");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev
    )
      throw new Error("Publication payload changed while reading");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Strict checkout reader: rejects extra directories, links, files and byte changes. */
export function readPublicationPayload(
  directory: string,
  expected: PublicationExpectation
): PublicationPayload {
  const root = resolve(directory);
  unlinkedParents(root);
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();
  function walk(path: string, prefix: string): void {
    unlinkedParents(path);
    for (const name of readdirSync(path)) {
      const key = prefix + name;
      portablePath(key);
      const child = join(path, name);
      const stat = lstatSync(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        directories.add(key);
        walk(child, key + "/");
      } else files.set(key, regularFile(child));
    }
  }
  walk(root, "");
  const result = verifyPublicationPayload(files, expected);
  const allowedDirectories = new Set<string>();
  for (const path of result.files.keys()) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++)
      allowedDirectories.add(parts.slice(0, count).join("/"));
  }
  if (
    canonicalJson([...directories].sort()) !==
    canonicalJson([...allowedDirectories].sort())
  )
    throw new Error("Unexpected publication payload directory");
  return result;
}
