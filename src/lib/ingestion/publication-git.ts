import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export interface PublicationGitIdentity {
  payloadCommit: string;
  tree: string;
}

export interface PublicationGitPayload extends PublicationGitIdentity {
  createdAt: string;
  files: ReadonlyMap<string, Buffer>;
}

const objectIdPattern = /^[a-f0-9]{40}$/;
const identity = "Codex <codex@openai.com>";
const maximumObjectBytes = 256 * 1024 * 1024;

/** Keep inherited Git configuration, alternate stores and lazy fetch out. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_ALLOW_PROTOCOL = "";
  return env;
}

function git(root: string, args: string[], input?: Buffer): Buffer {
  return execFileSync(
    "git",
    [
      "--no-replace-objects",
      "-c",
      "core.hooksPath=",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd: root,
      input,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: maximumObjectBytes,
      windowsHide: true,
    }
  );
}

function requireSha1Repository(repositoryRoot: string): string {
  const root = resolve(repositoryRoot);
  if (
    git(root, ["rev-parse", "--show-object-format"])
      .toString("ascii")
      .trim() !== "sha1"
  ) {
    throw new Error("Publication payload requires a SHA-1 Git repository");
  }
  return root;
}

function objectHash(type: "blob" | "tree" | "commit", bytes: Buffer): string {
  return createHash("sha1")
    .update(`${type} ${bytes.length}\0`, "ascii")
    .update(bytes)
    .digest("hex");
}

function validateObjectId(value: string): void {
  if (!objectIdPattern.test(value)) {
    throw new Error("Publication Git object ID must be a full lowercase SHA-1");
  }
}

function canonicalCreatedAt(createdAt: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)) {
    throw new Error("Publication createdAt must be a canonical ISO timestamp");
  }
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== createdAt) {
    throw new Error("Publication createdAt must be a canonical ISO timestamp");
  }
  return createdAt;
}

/** Restrict object paths to portable files without filesystem aliases. */
function validatePaths(paths: Iterable<string>): void {
  const seen = new Map<string, string>();
  const files = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    if (
      !path ||
      !/^[\x20-\x7e]+$/.test(path) ||
      path.includes("\\") ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /^(?:\.git|git~[1-9])$/i.test(part) ||
          /[<>:"|?*]/.test(part) ||
          /[ .]$/.test(part) ||
          /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(
            part
          )
      )
    ) {
      throw new Error(`Unsafe publication Git path: ${JSON.stringify(path)}`);
    }
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      const folded = prefix.toLowerCase();
      const prior = seen.get(folded);
      if (prior !== undefined && prior !== prefix) {
        throw new Error(`Publication Git paths collide: ${prior}, ${prefix}`);
      }
      seen.set(folded, prefix);
      if (index < parts.length && files.has(folded)) {
        throw new Error(`Publication Git file/directory conflict: ${prefix}`);
      }
    }
    const folded = path.toLowerCase();
    if (files.has(folded))
      throw new Error(`Duplicate publication path: ${path}`);
    files.add(folded);
  }
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      if (files.has(prefix)) {
        throw new Error(`Publication Git file/directory conflict: ${prefix}`);
      }
    }
  }
}

interface TreeNode {
  directories: Map<string, TreeNode>;
  blobs: Map<string, string>;
}

function treeObjects(blobs: ReadonlyMap<string, string>): {
  tree: string;
  objects: Map<string, Buffer>;
} {
  const root: TreeNode = { directories: new Map(), blobs: new Map() };
  for (const [path, hash] of blobs) {
    const parts = path.split("/");
    const name = parts.pop()!;
    let node = root;
    for (const part of parts) {
      let child = node.directories.get(part);
      if (!child) {
        child = { directories: new Map(), blobs: new Map() };
        node.directories.set(part, child);
      }
      node = child;
    }
    node.blobs.set(name, hash);
  }
  const objects = new Map<string, Buffer>();
  function visit(node: TreeNode): string {
    const entries: {
      name: string;
      mode: string;
      hash: string;
      sort: string;
    }[] = [];
    for (const [name, child] of node.directories) {
      entries.push({
        name,
        mode: "40000",
        hash: visit(child),
        sort: name + "/",
      });
    }
    for (const [name, hash] of node.blobs) {
      entries.push({ name, mode: "100644", hash, sort: name });
    }
    entries.sort((a, b) =>
      Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort))
    );
    const bytes = Buffer.concat(
      entries.map(({ name, mode, hash }) =>
        Buffer.concat([
          Buffer.from(`${mode} ${name}\0`, "ascii"),
          Buffer.from(hash, "hex"),
        ])
      )
    );
    const hash = objectHash("tree", bytes);
    objects.set(hash, bytes);
    return hash;
  }
  return { tree: visit(root), objects };
}

function commitBytes(tree: string, createdAt: string): Buffer {
  const timestamp = Math.floor(new Date(createdAt).getTime() / 1000);
  return Buffer.from(
    `tree ${tree}\nauthor ${identity} ${timestamp} +0000\ncommitter ${identity} ${timestamp} +0000\n\nZivv verified publication payload\n\nCreated-at: ${createdAt}\n`,
    "ascii"
  );
}

function writeObject(
  root: string,
  type: "blob" | "tree" | "commit",
  bytes: Buffer
): string {
  const expected = objectHash(type, bytes);
  const actual = git(
    root,
    ["hash-object", "-w", "--stdin", "--no-filters", "-t", type],
    bytes
  )
    .toString("ascii")
    .trim();
  if (actual !== expected)
    throw new Error("Git wrote an unexpected object hash");
  if (!readObject(root, type, actual).equals(bytes)) {
    throw new Error("Git persisted unexpected object bytes");
  }
  return actual;
}

function readObject(
  root: string,
  type: "blob" | "tree" | "commit",
  hash: string
): Buffer {
  validateObjectId(hash);
  if (git(root, ["cat-file", "-t", hash]).toString("ascii").trim() !== type) {
    throw new Error(`Publication object is not a ${type}: ${hash}`);
  }
  const bytes = git(root, ["cat-file", type, hash]);
  if (objectHash(type, bytes) !== hash) {
    throw new Error(`Publication Git object hash mismatch: ${hash}`);
  }
  return bytes;
}

/**
 * Persist a semantically verified publication map as standalone raw Git objects.
 * The caller must verify the receipt and complete inventory before calling this.
 * Does not write refs, an index, checkout files, or invoke checkout filters.
 */
export function writePublicationPayloadGit(options: {
  repositoryRoot: string;
  files: ReadonlyMap<string, Buffer>;
  createdAt: string;
}): PublicationGitIdentity {
  const createdAt = canonicalCreatedAt(options.createdAt);
  validatePaths(options.files.keys());
  // Snapshot caller buffers before any Git operation, to bind a single byte map.
  const files = new Map<string, Buffer>();
  for (const [path, bytes] of options.files) {
    if (!Buffer.isBuffer(bytes))
      throw new Error(`Publication bytes required: ${path}`);
    files.set(path, Buffer.from(bytes));
  }
  const root = requireSha1Repository(options.repositoryRoot);
  const origin = git(root, ["remote", "get-url", "origin"])
    .toString("utf8")
    .trim();
  if (
    ![
      "git@github.com:prodigic/zivv.git",
      "https://github.com/prodigic/zivv.git",
      "https://github.com/prodigic/zivv",
    ].includes(origin)
  ) {
    throw new Error(
      "Publication payload requires the authoritative Zivv origin"
    );
  }
  const blobs = new Map<string, string>();
  for (const [path, bytes] of files)
    blobs.set(path, writeObject(root, "blob", bytes));
  const { tree, objects } = treeObjects(blobs);
  for (const bytes of objects.values()) writeObject(root, "tree", bytes);
  const payloadCommit = writeObject(
    root,
    "commit",
    commitBytes(tree, createdAt)
  );
  return { payloadCommit, tree };
}

/** Read an exact immutable commit, checking bytes and the complete raw inventory. */
export function readPublicationPayloadGit(options: {
  repositoryRoot: string;
  payloadCommit: string;
  createdAt?: string;
}): PublicationGitPayload {
  validateObjectId(options.payloadCommit);
  const root = requireSha1Repository(options.repositoryRoot);
  const commit = readObject(root, "commit", options.payloadCommit);
  const match =
    /^tree ([a-f0-9]{40})\n[\s\S]*\nCreated-at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\n$/.exec(
      commit.toString("ascii")
    );
  if (!match) throw new Error("Invalid publication payload commit metadata");
  const [, tree, date] = match;
  const createdAt = canonicalCreatedAt(date);
  if (!commit.equals(commitBytes(tree, createdAt))) {
    throw new Error("Invalid publication payload commit metadata or parents");
  }
  if (options.createdAt !== undefined && options.createdAt !== createdAt) {
    throw new Error("Publication payload createdAt does not match expectation");
  }
  readObject(root, "tree", tree);
  const inventory = git(root, [
    "ls-tree",
    "-r",
    "-t",
    "-z",
    "--full-tree",
    tree,
  ]);
  const records = inventory.toString("latin1").split("\0");
  if (records.pop() !== "")
    throw new Error("Invalid publication Git inventory");
  const files = new Map<string, Buffer>();
  const blobs = new Map<string, string>();
  const trees = new Set<string>([tree]);
  const paths: string[] = [];
  for (const record of records) {
    const entry = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(
      record
    );
    if (!entry) throw new Error("Invalid publication Git inventory entry");
    const [, mode, type, hash, path] = entry;
    if (mode === "040000" && type === "tree") {
      trees.add(hash);
    } else if (mode === "100644" && type === "blob") {
      if (files.has(path))
        throw new Error(`Duplicate publication path: ${path}`);
      paths.push(path);
      blobs.set(path, hash);
      files.set(path, readObject(root, "blob", hash));
    } else {
      throw new Error(
        `Unsupported publication Git mode or type: ${mode} ${type}`
      );
    }
    // Validate directory spelling too, including otherwise invisible empty trees.
    validatePaths([path]);
  }
  validatePaths(paths);
  const expected = treeObjects(blobs);
  if (expected.tree !== tree || expected.objects.size !== trees.size) {
    throw new Error("Publication Git tree inventory is not canonical");
  }
  for (const [hash, bytes] of expected.objects) {
    if (!trees.has(hash) || !readObject(root, "tree", hash).equals(bytes)) {
      throw new Error("Publication Git tree bytes do not match inventory");
    }
  }
  return { payloadCommit: options.payloadCommit, tree, createdAt, files };
}
