import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type PromotionGitDestination = "production" | "preview";

export interface PromotionControlRead {
  head: string | null;
  bytes: Buffer | null;
}

export interface PromotionControlAppend {
  expectedHead: string | null;
  bytes: Buffer;
  createdAt: string;
}

export interface PromotionControlAppendResult {
  status: "appended" | "conflict" | "uncertain";
  attemptedHead: string | null;
  observedHead: string | null;
}

export interface PreparedPromotionControlAppend extends PromotionControlAppend {
  attemptedHead: string;
}

export interface PromotionCompletionObjects {
  completionTree: string;
  objects: ReadonlyMap<string, { type: "tree" | "blob"; bytes: Buffer }>;
}

/** A transport must fetch immutable objects without changing local refs. */
export interface PromotionControlTransport {
  readonly repository: "prodigic/zivv";
  readHead(ref: string): string | null;
  fetchCommit(commit: string): void;
  append(ref: string, commit: string, expectedHead: string | null): void;
}

export interface PromotionControlStore {
  readonly ref: string;
  read(): PromotionControlRead;
  /** Persist local objects only; checkpoint this identity before remote writes. */
  prepareAppend(input: PromotionControlAppend): PreparedPromotionControlAppend;
  /** The completion proof helper verifies the root-to-key chain of these bytes. */
  readCompletionObject(
    head: string,
    objectId: string,
    type: "tree" | "blob"
  ): Buffer;
  compareAndAppend(input: PromotionControlAppend): PromotionControlAppendResult;
  readback(input: {
    attemptedHead: string;
    expectedHead: string | null;
    bytes: Buffer;
  }): PromotionControlAppendResult;
}

export interface PromotionControlStoreOptions {
  repositoryRoot: string;
  destination: PromotionGitDestination;
  /** Reject malformed/private state and require the selected destination. */
  validateState(
    bytes: Buffer,
    destination: PromotionGitDestination
  ): string | void;
  /** Require bootstrap or one legal revision from the exact previous bytes. */
  validateTransition(
    previous: Buffer | null,
    next: Buffer
  ): PromotionCompletionObjects | void;
}

const shaPattern = /^[a-f0-9]{40}$/;
const emptySha = "0".repeat(40);
const authoritativeUrl = "https://github.com/prodigic/zivv.git";
const allowedOrigins = new Set([
  authoritativeUrl,
  "https://github.com/prodigic/zivv",
  "git@github.com:prodigic/zivv.git",
]);
const identity = "Codex <codex@openai.com>";
const maximumBytes = 1024 * 1024;
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function validateSha(value: string): void {
  if (!shaPattern.test(value) || value === emptySha) {
    throw new Error("Promotion control requires a full lowercase commit SHA-1");
  }
}

function validateHead(value: string | null): void {
  if (value !== null) validateSha(value);
}

function controlRef(destination: PromotionGitDestination): string {
  if (destination !== "production" && destination !== "preview") {
    throw new Error("Unknown promotion control destination");
  }
  return `refs/heads/zivv-promotion-control/${destination}`;
}

function validateRef(ref: string): void {
  if (
    ref !== controlRef("production") &&
    ref !== controlRef("preview") &&
    !/^refs\/heads\/zivv-candidate-artifacts\/[a-f0-9]{40}$/.test(ref)
  ) {
    throw new Error(
      "Promotion transport requires a dedicated control or immutable artifact ref"
    );
  }
}

/** Exclude inherited object/index overrides, filters and lazy object fetching. */
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
    // Credential helpers may use the operator's profile. Global Git config is
    // excluded; provision credentials in this repository or its helper store.
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function git(
  root: string,
  args: string[],
  input?: Buffer,
  protocol: "" | "https" | "file" = "",
  token?: string
): Buffer {
  const env = gitEnvironment();
  env.GIT_ALLOW_PROTOCOL = protocol;
  if (token !== undefined) {
    // Only the closed HTTPS transport receives this transient credential.
    // Clear repository headers/helpers; never put the token in argv or config.
    env.GIT_CONFIG_COUNT = "6";
    env.GIT_CONFIG_KEY_0 = `http.${authoritativeUrl}.extraheader`;
    env.GIT_CONFIG_VALUE_0 = "";
    env.GIT_CONFIG_KEY_1 = `http.${authoritativeUrl}.extraheader`;
    env.GIT_CONFIG_VALUE_1 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    env.GIT_CONFIG_KEY_2 = "credential.helper";
    env.GIT_CONFIG_VALUE_2 = "";
    env.GIT_CONFIG_KEY_3 = `http.${authoritativeUrl}.followRedirects`;
    env.GIT_CONFIG_VALUE_3 = "false";
    env.GIT_CONFIG_KEY_4 = `http.${authoritativeUrl}.sslVerify`;
    env.GIT_CONFIG_VALUE_4 = "true";
    env.GIT_CONFIG_KEY_5 = `credential.${authoritativeUrl}.helper`;
    env.GIT_CONFIG_VALUE_5 = "";
  }
  return execFileSync(
    "git",
    [
      "--no-replace-objects",
      "-c",
      "core.hooksPath=",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "fetch.writeCommitGraph=false",
      ...args,
    ],
    {
      cwd: root,
      input,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: maximumBytes,
      windowsHide: true,
      timeout: 30_000,
    }
  );
}

function commandStatus(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  )
    return error.status;
  return null;
}

function repository(root: string): string {
  const resolved = resolve(root);
  if (
    git(resolved, ["rev-parse", "--show-object-format"]).toString().trim() !==
    "sha1"
  ) {
    throw new Error("Promotion control requires a SHA-1 Git repository");
  }
  return resolved;
}

function hash(type: "blob" | "tree" | "commit", bytes: Buffer): string {
  return createHash("sha1")
    .update(`${type} ${bytes.length}\0`, "ascii")
    .update(bytes)
    .digest("hex");
}

function readObject(
  root: string,
  type: "blob" | "tree" | "commit",
  sha: string
): Buffer {
  validateSha(sha);
  if (git(root, ["cat-file", "-t", sha]).toString().trim() !== type) {
    throw new Error(`Promotion control object is not a ${type}`);
  }
  const bytes = git(root, ["cat-file", type, sha]);
  if (hash(type, bytes) !== sha)
    throw new Error("Promotion control object hash mismatch");
  return bytes;
}

function writeObject(
  root: string,
  type: "blob" | "tree" | "commit",
  bytes: Buffer
): string {
  const expected = hash(type, bytes);
  const actual = git(
    root,
    ["hash-object", "-w", "--stdin", "--no-filters", "-t", type],
    bytes
  )
    .toString()
    .trim();
  if (actual !== expected || !readObject(root, type, actual).equals(bytes)) {
    throw new Error("Promotion control object persistence mismatch");
  }
  return actual;
}

function timestamp(createdAt: string): number {
  const date = new Date(createdAt);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== createdAt
  ) {
    throw new Error(
      "Promotion control createdAt must be a canonical ISO timestamp"
    );
  }
  return Math.floor(date.getTime() / 1000);
}

function treeBytes(blob: string, completionTree?: string): Buffer {
  return Buffer.concat([
    ...(completionTree === undefined
      ? []
      : [
          Buffer.from("40000 completions\0", "ascii"),
          Buffer.from(completionTree, "hex"),
        ]),
    Buffer.from("100644 control.json\0", "ascii"),
    Buffer.from(blob, "hex"),
  ]);
}

function commitBytes(
  tree: string,
  parent: string | null,
  createdAt: string
): Buffer {
  const time = timestamp(createdAt);
  return Buffer.from(
    `tree ${tree}\n${parent === null ? "" : `parent ${parent}\n`}author ${identity} ${time} +0000\ncommitter ${identity} ${time} +0000\n\nZivv durable promotion control\n\nCreated-at: ${createdAt}\n`,
    "ascii"
  );
}

function readCommit(
  root: string,
  head: string
): { bytes: Buffer; parent: string | null; completionTree?: string } {
  const commit = readObject(root, "commit", head);
  const match =
    /^tree ([a-f0-9]{40})\n(?:parent ([a-f0-9]{40})\n)?[\s\S]*\nCreated-at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\n$/.exec(
      commit.toString("ascii")
    );
  if (!match) throw new Error("Invalid promotion control commit metadata");
  const [, tree, parent, createdAt] = match;
  if (!commit.equals(commitBytes(tree, parent ?? null, createdAt))) {
    throw new Error("Invalid promotion control commit metadata or parents");
  }
  const rawTree = readObject(root, "tree", tree);
  const completionPrefix = Buffer.from("40000 completions\0", "ascii");
  const completionTree = rawTree
    .subarray(0, completionPrefix.length)
    .equals(completionPrefix)
    ? rawTree
        .subarray(completionPrefix.length, completionPrefix.length + 20)
        .toString("hex")
    : undefined;
  const controlTree =
    completionTree === undefined
      ? rawTree
      : rawTree.subarray(completionPrefix.length + 20);
  const prefix = Buffer.from("100644 control.json\0", "ascii");
  if (
    controlTree.length !== prefix.length + 20 ||
    !controlTree.subarray(0, prefix.length).equals(prefix)
  ) {
    throw new Error("Promotion control tree must contain only control.json");
  }
  const blob = controlTree.subarray(prefix.length).toString("hex");
  if (!rawTree.equals(treeBytes(blob, completionTree)))
    throw new Error("Invalid promotion control tree");
  if (completionTree !== undefined) readObject(root, "tree", completionTree);
  return {
    bytes: readObject(root, "blob", blob),
    parent: parent ?? null,
    completionTree,
  };
}

function writeCommit(
  root: string,
  bytes: Buffer,
  parent: string | null,
  createdAt: string,
  completionTree?: string
): string {
  const blob = writeObject(root, "blob", bytes);
  const tree = writeObject(root, "tree", treeBytes(blob, completionTree));
  return writeObject(root, "commit", commitBytes(tree, parent, createdAt));
}

function writeCompletionObjects(
  root: string,
  generated: PromotionCompletionObjects,
  persist = true
): void {
  validateSha(generated.completionTree);
  if (generated.objects.size > 65)
    throw new Error("Completion append exceeds its bounded object budget");
  const captured = new Map<string, { type: "tree" | "blob"; bytes: Buffer }>();
  let total = 0;
  for (const [sha, object] of generated.objects) {
    validateSha(sha);
    if (
      (object.type !== "tree" && object.type !== "blob") ||
      !Buffer.isBuffer(object.bytes)
    ) {
      throw new Error("Completion append contains an unsupported object");
    }
    const bytes = Buffer.from(object.bytes);
    total += bytes.length;
    if (total > maximumBytes || hash(object.type, bytes) !== sha) {
      throw new Error("Completion append object hash or size mismatch");
    }
    captured.set(sha, { type: object.type, bytes });
  }
  // Persist raw objects; verification below uses one binary-safe batch reader.
  for (const [sha, object] of persist ? captured : []) {
    const actual = git(
      root,
      ["hash-object", "-w", "--stdin", "--no-filters", "-t", object.type],
      object.bytes
    )
      .toString()
      .trim();
    if (actual !== sha)
      throw new Error("Completion object persistence hash mismatch");
  }
  if (captured.size) {
    const batch = git(
      root,
      ["cat-file", "--batch"],
      Buffer.from(
        [...captured.keys()].map((sha) => `${sha}\n`).join(""),
        "ascii"
      )
    );
    let offset = 0;
    for (const [sha, object] of captured) {
      const end = batch.indexOf(10, offset);
      const expectedHeader = `${sha} ${object.type} ${object.bytes.length}`;
      if (
        end < 0 ||
        batch.subarray(offset, end).toString("ascii") !== expectedHeader
      ) {
        throw new Error("Completion object readback metadata mismatch");
      }
      offset = end + 1;
      const bytes = batch.subarray(offset, offset + object.bytes.length);
      offset += object.bytes.length;
      if (
        !bytes.equals(object.bytes) ||
        batch[offset++] !== 10 ||
        hash(object.type, bytes) !== sha
      ) {
        throw new Error("Completion object readback byte mismatch");
      }
    }
    if (offset !== batch.length)
      throw new Error("Completion object readback inventory mismatch");
  }
  if (persist && generated.completionTree === emptyTree)
    writeObject(root, "tree", Buffer.alloc(0));
  readObject(root, "tree", generated.completionTree);
}

function localHead(root: string, ref: string): string | null {
  try {
    const head = git(root, ["rev-parse", "--verify", "--quiet", ref])
      .toString()
      .trim();
    validateSha(head);
    return head;
  } catch (error) {
    if (commandStatus(error) === 1) return null;
    throw new Error("Unable to read local promotion control ref");
  }
}

function requireIsolatedLocalRef(root: string, ref: string): void {
  const symbolic = (name: string, recurse = true): string | null => {
    try {
      return git(root, [
        "symbolic-ref",
        "--quiet",
        ...(recurse ? [] : ["--no-recurse"]),
        name,
      ])
        .toString()
        .trim();
    } catch (error) {
      if (commandStatus(error) === 1) return null;
      throw new Error("Unable to verify isolated local promotion ref");
    }
  };
  if (symbolic(ref, false) !== null) {
    throw new Error("Local promotion control ref must not be symbolic");
  }
  if (symbolic("HEAD") === ref) {
    throw new Error(
      "Local promotion control ref must not be checked out through HEAD"
    );
  }
}

function createStore(
  options: PromotionControlStoreOptions,
  transport?: PromotionControlTransport
): PromotionControlStore {
  const destination = options.destination;
  const validateState = options.validateState;
  const validateTransition = options.validateTransition;
  const ref = controlRef(destination);
  if (
    typeof validateState !== "function" ||
    typeof validateTransition !== "function"
  ) {
    throw new Error(
      "Promotion control requires semantic state and transition validators"
    );
  }
  const root = repository(options.repositoryRoot);
  if (transport && transport.repository !== "prodigic/zivv") {
    throw new Error(
      "Promotion control transport requires the authoritative repository"
    );
  }
  const head = (): string | null => {
    const result = transport ? transport.readHead(ref) : localHead(root, ref);
    validateHead(result);
    return result;
  };
  const validatedHeads = new Set<string>();
  const validateRecord = (record: ReturnType<typeof readCommit>): void => {
    const completionTree = validateState(
      Buffer.from(record.bytes),
      destination
    );
    if (completionTree !== undefined) validateSha(completionTree);
    if (completionTree !== record.completionTree) {
      throw new Error(
        "Promotion state completion root does not match its Git tree"
      );
    }
  };
  const verifyTransition = (
    previous: Buffer | null,
    next: ReturnType<typeof readCommit>
  ): void => {
    const generated = validateTransition(
      previous === null ? null : Buffer.from(previous),
      Buffer.from(next.bytes)
    );
    if (next.completionTree !== undefined) {
      if (!generated || generated.completionTree !== next.completionTree) {
        throw new Error(
          "Persisted promotion transition does not match its completion root"
        );
      }
      writeCompletionObjects(root, generated, false);
    } else if (generated !== undefined) {
      throw new Error(
        "Persisted completion objects require a state-bound root"
      );
    }
  };
  const load = (sha: string): ReturnType<typeof readCommit> => {
    if (transport) transport.fetchCommit(sha);
    const record = readCommit(root, sha);
    validateRecord(record);
    if (!validatedHeads.has(sha)) {
      // A fresh reader verifies the one-parent chain to bootstrap. Later reads
      // stop at an already verified immutable ancestor; no history is trusted
      // merely because a syntactically valid projection is at the branch tip.
      const pending: Array<{
        sha: string;
        record: ReturnType<typeof readCommit>;
      }> = [];
      let cursor: {
        sha: string;
        record: ReturnType<typeof readCommit>;
      } | null = { sha, record };
      let previous: Buffer | null = null;
      while (cursor && !validatedHeads.has(cursor.sha)) {
        pending.push(cursor);
        const parent: string | null = cursor.record.parent;
        if (parent === null) {
          cursor = null;
          break;
        }
        const parentRecord = readCommit(root, parent);
        validateRecord(parentRecord);
        cursor = { sha: parent, record: parentRecord };
      }
      if (cursor) previous = cursor.record.bytes;
      for (const item of pending.reverse()) {
        verifyTransition(previous, item.record);
        validatedHeads.add(item.sha);
        previous = item.record.bytes;
      }
    }
    return record;
  };
  const read = (): PromotionControlRead => {
    const current = head();
    return {
      head: current,
      bytes: current === null ? null : load(current).bytes,
    };
  };
  const capture = (input: PromotionControlAppend): PromotionControlAppend => {
    // Capture every field before calling foreign validators or transports.
    const expectedHead = input.expectedHead;
    const createdAt = input.createdAt;
    const supplied = input.bytes;
    validateHead(expectedHead);
    timestamp(createdAt);
    if (!Buffer.isBuffer(supplied) || supplied.length > maximumBytes) {
      throw new Error("Promotion control requires bounded exact bytes");
    }
    return { expectedHead, createdAt, bytes: Buffer.from(supplied) };
  };
  const prepare = (
    input: PromotionControlAppend,
    previous: Buffer | null,
    completionTree: string | void
  ): PreparedPromotionControlAppend => {
    if (!transport) requireIsolatedLocalRef(root, ref);
    const generated = validateTransition(
      previous === null ? null : Buffer.from(previous),
      Buffer.from(input.bytes)
    );
    if (!transport) requireIsolatedLocalRef(root, ref);
    if (completionTree !== undefined) {
      validateSha(completionTree);
      if (!generated || generated.completionTree !== completionTree) {
        throw new Error("Validated append does not match the completion root");
      }
      writeCompletionObjects(root, generated);
    } else if (generated !== undefined) {
      throw new Error("Completion objects require a state-bound root");
    }
    return {
      ...input,
      bytes: Buffer.from(input.bytes),
      attemptedHead: writeCommit(
        root,
        input.bytes,
        input.expectedHead,
        input.createdAt,
        completionTree ?? undefined
      ),
    };
  };
  const readback: PromotionControlStore["readback"] = (input) => {
    const attemptedHead = input.attemptedHead;
    const expectedHead = input.expectedHead;
    const supplied = input.bytes;
    validateSha(attemptedHead);
    validateHead(expectedHead);
    if (!Buffer.isBuffer(supplied))
      throw new Error("Promotion control requires exact bytes");
    const bytes = Buffer.from(supplied);
    const completionTree = validateState(Buffer.from(bytes), destination);
    const attempted = readCommit(root, attemptedHead);
    validateRecord(attempted);
    if (
      attempted.parent !== expectedHead ||
      !attempted.bytes.equals(bytes) ||
      attempted.completionTree !== completionTree
    ) {
      throw new Error(
        "Promotion control readback does not match the attempted append"
      );
    }
    let current: PromotionControlRead;
    try {
      current = read();
    } catch {
      return {
        status: "uncertain",
        attemptedHead,
        observedHead: null,
      };
    }
    const status =
      current.head === attemptedHead && current.bytes?.equals(bytes)
        ? "appended"
        : current.head === expectedHead
          ? "uncertain"
          : "conflict";
    return {
      status,
      attemptedHead,
      observedHead: current.head,
    };
  };
  return {
    ref,
    read,
    readback,
    readCompletionObject(controlHead, objectId, type) {
      validateSha(controlHead);
      validateSha(objectId);
      if (type !== "tree" && type !== "blob")
        throw new Error("Unsupported completion object type");
      if (!validatedHeads.has(controlHead)) load(controlHead);
      return readObject(root, type, objectId);
    },
    prepareAppend(input) {
      const captured = capture(input);
      const completionTree = validateState(
        Buffer.from(captured.bytes),
        destination
      );
      const previous =
        captured.expectedHead === null
          ? null
          : load(captured.expectedHead).bytes;
      return prepare(captured, previous, completionTree);
    },
    compareAndAppend(input) {
      const captured = capture(input);
      const { bytes, expectedHead } = captured;
      const completionTree = validateState(Buffer.from(bytes), destination);
      const current = read();
      if (current.head !== expectedHead) {
        return {
          status: "conflict",
          attemptedHead: null,
          observedHead: current.head,
        };
      }
      const { attemptedHead } = prepare(
        captured,
        current.bytes,
        completionTree
      );
      try {
        if (transport) transport.append(ref, attemptedHead, expectedHead);
        else
          git(root, [
            "update-ref",
            "--no-deref",
            ref,
            attemptedHead,
            expectedHead ?? emptySha,
          ]);
      } catch {
        // A failed push can have persisted remotely. Never reparent or retry it.
        return readback({
          attemptedHead,
          expectedHead,
          bytes,
        });
      }
      return readback({
        attemptedHead,
        expectedHead,
        bytes,
      });
    },
  };
}

/** Atomic local update-ref CAS; neither ordinary HEAD nor index is changed. */
export function createLocalPromotionControlStore(
  options: PromotionControlStoreOptions
): PromotionControlStore {
  return createStore(options);
}

/** Remote writes require explicit transport selection; construction does no IO. */
export function createRemotePromotionControlStore(
  options: PromotionControlStoreOptions & {
    transport: PromotionControlTransport;
  }
): PromotionControlStore {
  if (
    !options.transport ||
    typeof options.transport.readHead !== "function" ||
    typeof options.transport.fetchCommit !== "function" ||
    typeof options.transport.append !== "function"
  ) {
    throw new Error("Remote promotion control requires an explicit transport");
  }
  return createStore(options, options.transport);
}

function remoteTransport(
  root: string,
  remote: string,
  protocol: "https" | "file",
  token?: string
): PromotionControlTransport {
  // Local credential helpers remain available. Reject URL rewrites so the
  // authoritative HTTPS endpoint cannot be redirected by repository config.
  const checkEndpoint = (): void => {
    const effective = git(
      root,
      ["ls-remote", "--get-url", remote],
      undefined,
      protocol
    )
      .toString()
      .trim();
    if (effective !== remote)
      throw new Error("Promotion transport URL rewriting is forbidden");
    try {
      git(root, [
        "config",
        "--get-regexp",
        "^url\\..*\\.(insteadOf|pushInsteadOf)$",
      ]);
    } catch (error) {
      if (commandStatus(error) === 1) return;
      throw new Error("Unable to verify promotion transport URL policy");
    }
    throw new Error("Promotion transport URL rewriting is forbidden");
  };
  const run = (args: string[]): Buffer => {
    checkEndpoint();
    try {
      return git(root, args, undefined, protocol, token);
    } catch {
      // Do not expose stderr: helper failures and URLs can contain credentials.
      throw new Error(
        "Promotion Git transport failed; verify runtime connectivity and repository credentials"
      );
    }
  };
  return {
    repository: "prodigic/zivv",
    readHead(ref) {
      validateRef(ref);
      const text = run(["ls-remote", "--refs", "--", remote, ref]).toString(
        "ascii"
      );
      if (!text) return null;
      const match = /^([a-f0-9]{40})\t([^\n\r]+)\n$/.exec(text);
      if (!match || match[2] !== ref)
        throw new Error("Unexpected remote promotion control inventory");
      validateSha(match[1]);
      return match[1];
    },
    fetchCommit(commit) {
      validateSha(commit);
      run([
        "fetch",
        "--no-tags",
        "--no-prune",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--",
        remote,
        commit,
      ]);
      readObject(root, "commit", commit);
    },
    append(ref, commit, expectedHead) {
      validateRef(ref);
      validateSha(commit);
      validateHead(expectedHead);
      if (ref.startsWith("refs/heads/zivv-candidate-artifacts/")) {
        const bytes = readObject(root, "commit", commit);
        const headers = bytes.toString("ascii").split("\n\n", 1)[0];
        if (
          ref !== `refs/heads/zivv-candidate-artifacts/${commit}` ||
          expectedHead !== null ||
          /^parent /m.test(headers)
        ) {
          throw new Error(
            "Immutable artifact transport requires a matching root commit and absent branch"
          );
        }
      } else if (readCommit(root, commit).parent !== expectedHead) {
        throw new Error(
          "Remote promotion append must have the exact expected sole parent"
        );
      }
      // Restricted append-only controller writers and non-force fast-forward
      // updates make competing sole-parent appends conflict. No ref refresh or
      // reparent occurs here, and no configured push refspec is used.
      run([
        "push",
        "--porcelain",
        "--no-follow-tags",
        "--recurse-submodules=no",
        "--",
        remote,
        `${commit}:${ref}`,
      ]);
    },
  };
}

/**
 * Authoritative non-served control branches, never zivv-test or a served branch.
 * Repository credential helpers must be provisioned before activation. Global
 * and inherited Git config is excluded. Construction never contacts GitHub.
 */
export function createAuthoritativePromotionControlTransport(
  repositoryRoot: string,
  credentials?: { token: string }
): PromotionControlTransport {
  if (credentials && !/^[\x21-\x7e]{1,4096}$/.test(credentials.token)) {
    throw new Error(
      "Promotion transport requires a nonempty printable credential"
    );
  }
  const root = repository(repositoryRoot);
  const origin = git(root, ["remote", "get-url", "origin"]).toString().trim();
  if (!allowedOrigins.has(origin)) {
    throw new Error(
      "Promotion transport requires the authoritative Zivv origin"
    );
  }
  return remoteTransport(root, authoritativeUrl, "https", credentials?.token);
}

/** Explicit offline fixture adapter: only a real bare repository under OS tmp. */
export function createBareTestPromotionControlTransport(
  repositoryRoot: string,
  bareDirectory: string
): PromotionControlTransport {
  if (!isAbsolute(bareDirectory))
    throw new Error("Bare test transport requires an absolute temporary path");
  const root = repository(repositoryRoot);
  const bare = realpathSync(bareDirectory);
  const offset = relative(realpathSync(tmpdir()), bare);
  if (
    !offset ||
    offset === ".." ||
    offset.startsWith(`..${sep}`) ||
    isAbsolute(offset)
  ) {
    throw new Error(
      "Bare test transport requires a repository under OS temporary storage"
    );
  }
  if (
    git(bare, ["rev-parse", "--is-bare-repository"]).toString().trim() !==
    "true"
  ) {
    throw new Error("Bare test transport requires a bare repository");
  }
  repository(bare);
  return remoteTransport(root, bare, "file");
}
