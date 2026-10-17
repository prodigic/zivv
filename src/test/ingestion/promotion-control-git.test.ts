import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthoritativePromotionControlTransport,
  createBareTestPromotionControlTransport,
  createLocalPromotionControlStore,
  createRemotePromotionControlStore,
  type PromotionControlStoreOptions,
  type PromotionControlTransport,
} from "../../lib/ingestion/promotion-control-git.js";

const execute = promisify(execFile);
const createdAt = "2026-10-14T12:34:56.789Z";
const ref = "refs/heads/zivv-promotion-control/production";

interface FixtureState {
  destination: "production" | "preview";
  revision: number;
  operation: string;
}

function parse(bytes: Buffer): FixtureState {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("destination" in value) ||
    !("revision" in value) ||
    !("operation" in value) ||
    Object.keys(value).length !== 3 ||
    (value.destination !== "production" && value.destination !== "preview") ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== "number" ||
    value.revision < 0 ||
    typeof value.operation !== "string"
  )
    throw new Error("Malformed or private state");
  return {
    destination: value.destination,
    revision: value.revision,
    operation: value.operation,
  };
}

function state(
  revision: number,
  operation = "request-a",
  destination = "production"
): Buffer {
  return Buffer.from(
    JSON.stringify({ destination, revision, operation }) + "\r\n"
  );
}

describe("durable promotion Git compare-and-append", () => {
  let directory: string;
  let root: string;
  let bare: string;

  function git(args: string[], cwd = root, input?: Buffer | string): Buffer {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    return execFileSync("git", args, {
      cwd,
      input,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  function initialize(name: string): string {
    const path = join(directory, name);
    mkdirSync(path);
    git(["init", "--quiet", "--object-format=sha1"], path);
    git(["config", "user.name", "Fixture"], path);
    git(["config", "user.email", "fixture@example.invalid"], path);
    git(["config", "commit.gpgsign", "false"], path);
    git(
      ["remote", "add", "origin", "https://github.com/prodigic/zivv.git"],
      path
    );
    return path;
  }
  function options(repositoryRoot = root): PromotionControlStoreOptions {
    return {
      repositoryRoot,
      destination: "production",
      validateState(bytes, destination) {
        if (parse(bytes).destination !== destination)
          throw new Error("Destination mismatch");
      },
      validateTransition(previous, next) {
        const old = previous === null ? null : parse(previous);
        const value = parse(next);
        if (value.revision !== (old === null ? 0 : old.revision + 1))
          throw new Error("Illegal revision");
      },
    };
  }
  function remote(
    transport?: PromotionControlTransport,
    repositoryRoot = root
  ) {
    return createRemotePromotionControlStore({
      ...options(repositoryRoot),
      transport:
        transport ??
        createBareTestPromotionControlTransport(repositoryRoot, bare),
    });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "zivv-promotion-control-git-"));
    root = initialize("repository");
    bare = join(directory, "remote.git");
    git(["init", "--bare", "--quiet", "--object-format=sha1", bare]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (!directory.startsWith(join(tmpdir(), "zivv-promotion-control-git-"))) {
      throw new Error(
        "Fixture deletion escaped the allocated temporary directory"
      );
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("refuses retired installation writes through already-constructed native stores and transports", () => {
    const operator = join(directory, "private-operator");
    mkdirSync(operator);
    mkdirSync(join(root, "data/ingestion"), { recursive: true });
    writeFileSync(
      join(root, "data/ingestion/store.json"),
      JSON.stringify({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    vi.stubEnv("ZIVV_LEDGER_HOME", operator);
    const transport = createBareTestPromotionControlTransport(root, bare),
      local = createLocalPromotionControlStore(options()),
      remoteStore = remote(transport),
      prepared = local.prepareAppend({
        expectedHead: null,
        bytes: state(0),
        createdAt,
      });
    writeFileSync(join(operator, "operator-retired.json"), "retired");
    expect(() => local.compareAndAppend(prepared)).toThrow(
      "OPERATOR_INSTALLATION_RETIRED"
    );
    expect(() => remoteStore.compareAndAppend(prepared)).toThrow(
      "OPERATOR_INSTALLATION_RETIRED"
    );
    expect(() => transport.append(ref, prepared.attemptedHead, null)).toThrow(
      "OPERATOR_INSTALLATION_RETIRED"
    );
    expect(local.read().head).toBeNull();
    expect(transport.readHead(ref)).toBeNull();
  }, 30_000);

  it("rechecks caller context after native preparation and keeps callbacks out of prepared evidence", () => {
    let prepared = false;
    const normal = options();
    const store = createLocalPromotionControlStore({
      ...normal,
      validateTransition(previous, next) {
        normal.validateTransition(previous, next);
        prepared = true;
      },
    });
    const checkContext = vi.fn(() => {
      if (prepared) throw new Error("context changed after preparation");
    });
    const saved = store.prepareAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
      checkContext,
    });
    expect(Object.keys(saved).sort()).toEqual([
      "attemptedHead",
      "bytes",
      "createdAt",
      "expectedHead",
    ]);
    expect(checkContext).not.toHaveBeenCalled();
    prepared = false;
    expect(() =>
      store.compareAndAppend({
        expectedHead: null,
        bytes: state(0),
        createdAt,
        checkContext,
      })
    ).toThrow("context changed after preparation");
    expect(checkContext).toHaveBeenCalledTimes(2);
    expect(store.read().head).toBeNull();
  }, 30_000);

  it("runs a captured caller guard after remote reads and again at the native push boundary", () => {
    const transport = createBareTestPromotionControlTransport(root, bare),
      append = vi.fn(transport.append);
    let current = true;
    const store = remote({
      ...transport,
      append,
      readHead(target) {
        const result = transport.readHead(target);
        current = false;
        return result;
      },
    });
    expect(() =>
      store.compareAndAppend({
        expectedHead: null,
        bytes: state(0),
        createdAt,
        checkContext: () => {
          if (!current) throw new Error("context changed during read");
        },
      })
    ).toThrow("context changed during read");
    expect(append).not.toHaveBeenCalled();
    const prepared = createLocalPromotionControlStore(options()).prepareAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    });
    expect(() =>
      transport.append(ref, prepared.attemptedHead, null, () => {
        throw new Error("context changed before push");
      })
    ).toThrow("context changed before push");
    expect(transport.readHead(ref)).toBeNull();
  }, 30_000);

  it("refuses retirement appearing during local validation before updating its canonical ref", () => {
    const operator = join(root, "data/ingestion");
    mkdirSync(operator, { recursive: true });
    const normal = options(),
      store = createLocalPromotionControlStore({
        ...normal,
        validateState(bytes, destination) {
          normal.validateState(bytes, destination);
          writeFileSync(
            join(operator, "operator-retired.json"),
            "retired during validation"
          );
        },
      });
    expect(() =>
      store.compareAndAppend({ expectedHead: null, bytes: state(0), createdAt })
    ).toThrow("OPERATOR_INSTALLATION_RETIRED");
    expect(store.read().head).toBeNull();
  }, 30_000);

  it("refuses retirement appearing during a remote head read before invoking append", () => {
    const operator = join(root, "data/ingestion");
    mkdirSync(operator, { recursive: true });
    const transport = createBareTestPromotionControlTransport(root, bare),
      append = vi.fn(transport.append),
      store = remote({
        ...transport,
        append,
        readHead(target) {
          const result = transport.readHead(target);
          writeFileSync(
            join(operator, "operator-retired.json"),
            "retired during remote read"
          );
          return result;
        },
      });
    expect(() =>
      store.compareAndAppend({ expectedHead: null, bytes: state(0), createdAt })
    ).toThrow("OPERATOR_INSTALLATION_RETIRED");
    expect(append).not.toHaveBeenCalled();
    expect(transport.readHead(ref)).toBeNull();
  }, 30_000);

  it("stores raw bytes with deterministic metadata and only the exact expected parent", () => {
    const store = createLocalPromotionControlStore(options());
    expect(store.read()).toEqual({ head: null, bytes: null });
    const firstBytes = state(0);
    const first = store.compareAndAppend({
      expectedHead: null,
      bytes: firstBytes,
      createdAt,
    });
    expect(first.status).toBe("appended");
    const firstHead = first.attemptedHead!;
    expect(store.read()).toEqual({ head: firstHead, bytes: firstBytes });
    const commit = git(["cat-file", "commit", firstHead]).toString();
    expect(commit).not.toContain("\nparent ");
    expect(commit).toContain("Codex <codex@openai.com>");
    expect(commit).toContain(`Created-at: ${createdAt}\n`);
    expect(git(["ls-tree", "--name-only", firstHead]).toString()).toBe(
      "control.json\n"
    );
    const second = store.compareAndAppend({
      expectedHead: firstHead,
      bytes: state(1),
      createdAt,
    });
    expect(second.status).toBe("appended");
    expect(
      git(["rev-list", "--parents", "-n", "1", second.attemptedHead!])
        .toString()
        .trim()
    ).toBe(`${second.attemptedHead} ${firstHead}`);
    const alternateRoot = initialize("repeat");
    const repeated = createLocalPromotionControlStore(
      options(alternateRoot)
    ).compareAndAppend({
      expectedHead: null,
      bytes: firstBytes,
      createdAt,
    });
    expect(repeated.attemptedHead).toBe(firstHead);
  }, 30_000);

  it("preserves ordinary HEAD, dirty index, working files, FETCH_HEAD and unrelated refs", () => {
    git(["config", "core.autocrlf", "true"]);
    writeFileSync(join(root, ".gitattributes"), "*.json filter=fail\n");
    git(["config", "filter.fail.clean", "this-command-must-not-run"]);
    git(["config", "filter.fail.required", "true"]);
    writeFileSync(join(root, "tracked.txt"), "initial\n");
    git(["add", "tracked.txt", ".gitattributes"]);
    git(["commit", "--quiet", "-m", "fixture"]);
    writeFileSync(join(root, "tracked.txt"), "staged\n");
    git(["add", "tracked.txt"]);
    writeFileSync(join(root, "tracked.txt"), "unstaged\n");
    writeFileSync(join(root, ".git", "FETCH_HEAD"), "preserved fetch state\n");
    const beforeIndex = readFileSync(join(root, ".git", "index"));
    const beforeHead = git(["rev-parse", "HEAD"]);
    const beforeStatus = git(["status", "--porcelain=v1", "-z"]);
    const store = remote();
    const appended = store.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    });
    expect(appended.status).toBe("appended");
    expect(store.readAt(appended.attemptedHead!)).toEqual({
      head: appended.attemptedHead,
      bytes: state(0),
    });
    expect(readFileSync(join(root, ".git", "index"))).toEqual(beforeIndex);
    expect(git(["rev-parse", "HEAD"])).toEqual(beforeHead);
    expect(git(["status", "--porcelain=v1", "-z"])).toEqual(beforeStatus);
    expect(readFileSync(join(root, ".git", "FETCH_HEAD"), "utf8")).toBe(
      "preserved fetch state\n"
    );
    expect(git(["show-ref"]).toString().trim().split("\n")).toHaveLength(1);
    expect(git(["show-ref"], bare).toString().trim()).toBe(
      `${appended.attemptedHead} ${ref}`
    );
  }, 30_000);

  it("reads only canonical current and historical native heads without changing refs or HEAD", () => {
    const store = createLocalPromotionControlStore(options());
    const first = store.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    }).attemptedHead!;
    const second = store.compareAndAppend({
      expectedHead: first,
      bytes: state(1),
      createdAt,
    }).attemptedHead!;
    const refs = git(["show-ref"]),
      ordinaryHead = git(["symbolic-ref", "HEAD"]);
    expect(store.readAt(second)).toEqual({ head: second, bytes: state(1) });
    expect(store.readAt(first)).toEqual({ head: first, bytes: state(0) });
    const child = store.prepareAppend({
      expectedHead: second,
      bytes: state(2),
      createdAt,
    });
    const fork = store.prepareAppend({
      expectedHead: first,
      bytes: state(1, "unpublished-fork"),
      createdAt,
    });
    const orphan = store.prepareAppend({
      expectedHead: null,
      bytes: state(0, "unpublished-root"),
      createdAt,
    });
    for (const unpublished of [child, fork, orphan])
      expect(() => store.readAt(unpublished.attemptedHead)).toThrow(
        "canonical ancestor"
      );
    expect(git(["show-ref"])).toEqual(refs);
    expect(git(["symbolic-ref", "HEAD"])).toEqual(ordinaryHead);
    expect(store.read()).toEqual({ head: second, bytes: state(1) });
  }, 30_000);

  it("rejects malformed, missing and absent-canonical historical reads", () => {
    const store = createLocalPromotionControlStore(options());
    expect(() => store.readAt("a".repeat(40))).toThrow("Missing canonical");
    const first = store.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    }).attemptedHead!;
    const refs = git(["show-ref"]);
    for (const invalid of [
      "HEAD",
      "--all",
      first.toUpperCase(),
      "0".repeat(40),
      "a".repeat(39),
    ])
      expect(() => store.readAt(invalid)).toThrow(
        "full lowercase commit SHA-1"
      );
    expect(() => store.readAt("9".repeat(40))).toThrow("canonical ancestor");
    expect(git(["show-ref"])).toEqual(refs);
  }, 30_000);

  it("fetches validated canonical remote history for an exact prior-head read", () => {
    const writer = remote();
    const first = writer.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    }).attemptedHead!;
    const second = writer.compareAndAppend({
      expectedHead: first,
      bytes: state(1),
      createdAt,
    }).attemptedHead!;
    const readerRoot = initialize("history-reader");
    const reader = remote(undefined, readerRoot);
    const ordinaryHead = git(["symbolic-ref", "HEAD"], readerRoot);
    expect(reader.readAt(first)).toEqual({ head: first, bytes: state(0) });
    expect(reader.readAt(second)).toEqual({ head: second, bytes: state(1) });
    const unpublished = reader.prepareAppend({
      expectedHead: second,
      bytes: state(2),
      createdAt,
    });
    expect(() => reader.readAt(unpublished.attemptedHead)).toThrow(
      "canonical ancestor"
    );
    expect(git(["symbolic-ref", "HEAD"], readerRoot)).toEqual(ordinaryHead);
    expect(git(["for-each-ref"], readerRoot)).toEqual(Buffer.alloc(0));
    expect(git(["show-ref"], bare).toString().trim()).toBe(`${second} ${ref}`);
  }, 30_000);

  it("rejects stale local owners and validator failures before creating new objects", () => {
    const store = createLocalPromotionControlStore(options());
    const first = store.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    });
    const old = first.attemptedHead!;
    const next = store.compareAndAppend({
      expectedHead: old,
      bytes: state(1),
      createdAt,
    });
    const before = git(["count-objects", "-v"]);
    expect(
      store.compareAndAppend({
        expectedHead: old,
        bytes: state(1, "stale-owner"),
        createdAt,
      })
    ).toEqual({
      status: "conflict",
      attemptedHead: null,
      observedHead: next.attemptedHead,
    });
    for (const bytes of [
      state(3),
      state(2, "other", "preview"),
      Buffer.from('{"privateKey":"secret"}'),
    ]) {
      expect(() =>
        store.compareAndAppend({
          expectedHead: next.attemptedHead,
          bytes,
          createdAt,
        })
      ).toThrow();
    }
    expect(git(["count-objects", "-v"])).toEqual(before);
    expect(store.read().head).toBe(next.attemptedHead);
  }, 30_000);

  it("binds and retains a bounded native completion trie with the same control CAS commit", () => {
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const objectHash = (type: "tree" | "blob", bytes: Buffer) =>
      createHash("sha1")
        .update(`${type} ${bytes.length}\0`, "ascii")
        .update(bytes)
        .digest("hex");
    const record = Buffer.from(
      '{"requestId":"completed-request","status":"complete"}\r\n'
    );
    const leaf = objectHash("blob", record);
    const objects = new Map<string, { type: "tree" | "blob"; bytes: Buffer }>([
      [leaf, { type: "blob", bytes: record }],
    ]);
    let completionTree = leaf;
    for (let depth = 63; depth >= 0; depth--) {
      const bytes = Buffer.concat([
        Buffer.from(`${depth === 63 ? "100644" : "40000"} a\0`, "ascii"),
        Buffer.from(completionTree, "hex"),
      ]);
      completionTree = objectHash("tree", bytes);
      objects.set(completionTree, { type: "tree", bytes });
    }
    const parseIndexed = (bytes: Buffer) => {
      const value: unknown = JSON.parse(bytes.toString());
      if (
        typeof value !== "object" ||
        value === null ||
        !("revision" in value) ||
        !("completionRoot" in value) ||
        typeof value.revision !== "number" ||
        typeof value.completionRoot !== "string"
      )
        throw Error("Invalid indexed fixture");
      return { revision: value.revision, completionRoot: value.completionRoot };
    };
    const indexed = (revision: number) =>
      Buffer.from(
        JSON.stringify({
          revision,
          completionRoot: revision === 0 ? emptyTree : completionTree,
        })
      );
    const transport = createBareTestPromotionControlTransport(root, bare);
    const validateIndexedTransition = (
      previous: Buffer | null,
      next: Buffer
    ) => {
      const nextState = parseIndexed(next);
      if (
        nextState.revision !==
        (previous === null ? 0 : parseIndexed(previous).revision + 1)
      )
        throw Error("Revision mismatch");
      return {
        completionTree: nextState.completionRoot,
        objects: nextState.revision === 1 ? objects : new Map(),
      };
    };
    const store = createRemotePromotionControlStore({
      repositoryRoot: root,
      destination: "production",
      transport,
      validateState: (bytes) => parseIndexed(bytes).completionRoot,
      validateTransition: validateIndexedTransition,
    });
    const boot = store.compareAndAppend({
      expectedHead: null,
      bytes: indexed(0),
      createdAt,
    });
    expect(boot.status).toBe("appended");
    const completed = store.compareAndAppend({
      expectedHead: boot.attemptedHead,
      bytes: indexed(1),
      createdAt,
    });
    expect(completed.status).toBe("appended");
    expect(
      git(["ls-tree", completed.attemptedHead!], bare).toString()
    ).toContain(`040000 tree ${completionTree}\tcompletions\n`);
    const next = store.compareAndAppend({
      expectedHead: completed.attemptedHead,
      bytes: indexed(2),
      createdAt,
    });
    expect(next.status).toBe("appended");
    git(["gc", "--prune=now"], bare);
    const fresh = createRemotePromotionControlStore({
      repositoryRoot: initialize("fresh-index-reader"),
      destination: "production",
      transport: createBareTestPromotionControlTransport(
        join(directory, "fresh-index-reader"),
        bare
      ),
      validateState: (bytes) => parseIndexed(bytes).completionRoot,
      validateTransition: validateIndexedTransition,
    });
    expect(
      fresh.readCompletionObject(next.attemptedHead!, leaf, "blob")
    ).toEqual(record);
    expect(
      fresh.readCompletionObject(next.attemptedHead!, completionTree, "tree")
    ).toEqual(objects.get(completionTree)!.bytes);
    expect(() =>
      fresh.readCompletionObject(next.attemptedHead!, leaf, "tree")
    ).toThrow("not a tree");
    // A standalone valid state blob cannot omit or substitute its native root.
    const plain = createLocalPromotionControlStore({
      ...options(initialize("unbound-index")),
      validateState: () => {},
    });
    const plainHead = plain.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    }).attemptedHead!;
    const mismatched = createLocalPromotionControlStore({
      ...options(join(directory, "unbound-index")),
      validateState: () => completionTree,
    });
    expect(() => mismatched.read()).toThrow("does not match its Git tree");
    expect(plain.read().head).toBe(plainHead);
  }, 60_000);

  it("resolves a lost success response only through exact readback", () => {
    const transport = createBareTestPromotionControlTransport(root, bare);
    const append = vi.fn(
      (target: string, commit: string, expected: string | null) => {
        transport.append(target, commit, expected);
        throw new Error(
          "lost network response with secret token that must not escape"
        );
      }
    );
    const store = remote({ ...transport, append });
    const result = store.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    });
    expect(result.status).toBe("appended");
    expect(append).toHaveBeenCalledTimes(1);
    expect(
      store.readback({
        attemptedHead: result.attemptedHead!,
        expectedHead: null,
        bytes: state(0),
      })
    ).toEqual(result);
    expect(() =>
      store.readback({
        attemptedHead: result.attemptedHead!,
        expectedHead: null,
        bytes: state(0, "mismatch"),
      })
    ).toThrow("does not match");
    expect(() =>
      store.readback({
        attemptedHead: result.attemptedHead!,
        expectedHead: "a".repeat(40),
        bytes: state(0),
      })
    ).toThrow("does not match");
  }, 30_000);

  it("retains an uncertain exact attempt without retry when transport did not confirm it", () => {
    const transport = createBareTestPromotionControlTransport(root, bare);
    const append = vi.fn(() => {
      throw new Error("offline");
    });
    const store = remote({ ...transport, append });
    const result = store.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    });
    expect(result.status).toBe("uncertain");
    expect(result.attemptedHead).toMatch(/^[a-f0-9]{40}$/);
    expect(result.observedHead).toBeNull();
    expect(append).toHaveBeenCalledTimes(1);
    // Recover by externally observing that exact intent; no automatic retry.
    transport.append(ref, result.attemptedHead!, null);
    expect(
      store.readback({
        attemptedHead: result.attemptedHead!,
        expectedHead: null,
        bytes: state(0),
      }).status
    ).toBe("appended");
    expect(append).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("prepares an exact local intent before any remote write and recovers a crash after push", () => {
    const transport = createBareTestPromotionControlTransport(root, bare);
    const append = vi.fn(transport.append);
    const store = remote({ ...transport, append });
    const intent = { expectedHead: null, bytes: state(0), createdAt };
    const prepared = store.prepareAppend(intent);
    expect(append).not.toHaveBeenCalled();
    expect(transport.readHead(ref)).toBeNull();
    expect(
      git(["cat-file", "blob", `${prepared.attemptedHead}:control.json`])
    ).toEqual(intent.bytes);
    // The caller checkpoints this intent before pushing; model a crash before receipt.
    transport.append(ref, prepared.attemptedHead, prepared.expectedHead);
    const restarted = remote();
    expect(restarted.readback(prepared)).toEqual({
      status: "appended",
      attemptedHead: prepared.attemptedHead,
      observedHead: prepared.attemptedHead,
    });
    expect(restarted.prepareAppend(intent).attemptedHead).toBe(
      prepared.attemptedHead
    );
    // Preparation from the captured old SHA does not adopt the moving branch tip.
    const next = {
      expectedHead: prepared.attemptedHead,
      bytes: state(1),
      createdAt,
    };
    const planned = restarted.prepareAppend(next);
    const committed = restarted.compareAndAppend(next);
    expect(committed.attemptedHead).toBe(planned.attemptedHead);
    expect(restarted.prepareAppend(next).attemptedHead).toBe(
      planned.attemptedHead
    );
  }, 30_000);

  it("captures caller fields and buffers before a validator can mutate them", () => {
    const intent: {
      expectedHead: string | null;
      bytes: Buffer;
      createdAt: string;
    } = {
      expectedHead: null,
      bytes: state(0),
      createdAt,
    };
    const original = Buffer.from(intent.bytes);
    const normal = options();
    const store = createLocalPromotionControlStore({
      ...normal,
      validateState(bytes, destination) {
        normal.validateState(bytes, destination);
        intent.expectedHead = "a".repeat(40);
        intent.createdAt = "2026-10-15T00:00:00.000Z";
        intent.bytes.fill(0);
      },
    });
    const prepared = store.prepareAppend(intent);
    expect(prepared.expectedHead).toBeNull();
    expect(prepared.createdAt).toBe(createdAt);
    expect(prepared.bytes).toEqual(original);
    const pristine = createLocalPromotionControlStore(
      options(initialize("pristine"))
    ).prepareAppend({
      expectedHead: null,
      bytes: original,
      createdAt,
    });
    expect(prepared.attemptedHead).toBe(pristine.attemptedHead);
  }, 30_000);

  it("reports conflict when the head advances after an uncertain append", () => {
    const transport = createBareTestPromotionControlTransport(root, bare);
    let advanced: string | null = null;
    const append = vi.fn(
      (target: string, commit: string, expected: string | null) => {
        transport.append(target, commit, expected);
        advanced = remote(transport).compareAndAppend({
          expectedHead: commit,
          bytes: state(1, "new-owner"),
          createdAt,
        }).attemptedHead;
        throw new Error("response lost after another writer advanced");
      }
    );
    const result = remote({ ...transport, append }).compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    });
    expect(result).toEqual({
      status: "conflict",
      attemptedHead: expect.any(String),
      observedHead: advanced,
    });
    expect(append).toHaveBeenCalledTimes(1);
    expect(remote().read().bytes).toEqual(state(1, "new-owner"));
  }, 30_000);

  it.each([false, true])(
    "races two actual Git remote writers (bootstrap %s): exactly one append wins",
    async (bootstrap) => {
      const initial = bootstrap
        ? null
        : remote().compareAndAppend({
            expectedHead: null,
            bytes: state(0),
            createdAt,
          }).attemptedHead!;
      const roots = [initialize("writer-a"), initialize("writer-b")];
      const source = pathToFileURL(
        resolve("dist/lib/ingestion/promotion-control-git.js")
      ).href;
      const run = async (repositoryRoot: string, index: number) => {
        const code = `
        import { createRemotePromotionControlStore, createBareTestPromotionControlTransport } from ${JSON.stringify(source)};
        import { existsSync, writeFileSync } from 'node:fs';
        const transport = createBareTestPromotionControlTransport(${JSON.stringify(repositoryRoot)}, ${JSON.stringify(bare)});
        const marker = ${JSON.stringify(join(directory, "writer-"))};
        const store = createRemotePromotionControlStore({
          repositoryRoot: ${JSON.stringify(repositoryRoot)}, destination: 'production',
          validateState(bytes, destination) { if (JSON.parse(bytes).destination !== destination) throw Error('destination'); },
          validateTransition(old, next) { if (JSON.parse(next).revision !== (old === null ? 0 : JSON.parse(old).revision + 1)) throw Error('revision'); },
          transport: { ...transport, append(ref, commit, old) {
            writeFileSync(marker + ${index}, 'ready');
            const deadline = Date.now() + 10000;
            while (!(existsSync(marker + '0') && existsSync(marker + '1'))) {
              if (Date.now() > deadline) throw Error('barrier timeout');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
            transport.append(ref, commit, old);
          } }
        });
        console.log(JSON.stringify(store.compareAndAppend({ expectedHead: ${JSON.stringify(initial)}, bytes: Buffer.from(${JSON.stringify(state(bootstrap ? 0 : 1, `writer-${index}`).toString())}), createdAt: ${JSON.stringify(createdAt)} })));
      `;
        const result = await execute(
          process.execPath,
          ["--input-type=module", "--eval", code],
          { windowsHide: true }
        );
        return JSON.parse(result.stdout.trim()) as {
          status: string;
          attemptedHead: string;
          observedHead: string;
        };
      };
      const results = await Promise.all(roots.map(run));
      expect(results.map((result) => result.status).sort()).toEqual([
        "appended",
        "conflict",
      ]);
      expect(new Set(results.map((result) => result.attemptedHead)).size).toBe(
        2
      );
      const winner = results.find((result) => result.status === "appended")!;
      expect(remote().read().head).toBe(winner.attemptedHead);
      expect(
        git(["rev-list", "--parents", "-n", "1", winner.attemptedHead], bare)
          .toString()
          .trim()
      ).toBe(`${winner.attemptedHead}${initial === null ? "" : ` ${initial}`}`);
      expect(
        results.every((result) => result.observedHead === winner.attemptedHead)
      ).toBe(true);
    },
    45_000
  );

  it("rejects unsafe SHAs, destinations, refs, timestamps and artifact mismatches", () => {
    const store = createLocalPromotionControlStore(options());
    for (const expectedHead of [
      "HEAD",
      "--help",
      "A".repeat(40),
      "a".repeat(39),
      "0".repeat(40),
    ]) {
      expect(() =>
        store.compareAndAppend({ expectedHead, bytes: state(0), createdAt })
      ).toThrow("SHA-1");
    }
    for (const date of [
      "now",
      "2026-02-30T00:00:00.000Z",
      "2026-10-14T00:00:00Z",
    ]) {
      expect(() =>
        store.compareAndAppend({
          expectedHead: null,
          bytes: state(0),
          createdAt: date,
        })
      ).toThrow("canonical ISO");
    }
    const transport = createBareTestPromotionControlTransport(root, bare);
    for (const unsafe of [
      "refs/heads/main",
      "refs/heads/gh-pages",
      "refs/heads/zivv-promotion-control/production/extra",
      "--all",
    ]) {
      expect(() => transport.readHead(unsafe)).toThrow("dedicated");
      expect(() => transport.append(unsafe, "a".repeat(40), null)).toThrow(
        "dedicated"
      );
    }
    const own = store.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    }).attemptedHead!;
    expect(() =>
      transport.append(
        `refs/heads/zivv-candidate-artifacts/${"a".repeat(40)}`,
        own,
        null
      )
    ).toThrow("matching root");
    expect(() => transport.append(ref, own, "a".repeat(40))).toThrow(
      "exact expected sole parent"
    );
  }, 30_000);

  it("fresh readers replay exact parent transitions and reject forged projections", () => {
    const permissive = createLocalPromotionControlStore({
      ...options(),
      validateTransition: () => {},
    });
    const bootstrap = permissive.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    }).attemptedHead!;
    const forged = permissive.compareAndAppend({
      expectedHead: bootstrap,
      bytes: state(7),
      createdAt,
    }).attemptedHead!;
    expect(permissive.read().head).toBe(forged);
    const strict = createLocalPromotionControlStore(options());
    const before = git(["count-objects", "-v"]);
    expect(() => strict.read()).toThrow("Illegal revision");
    // A legal nominated ancestor cannot bypass an invalid canonical tip.
    expect(() => strict.readAt(bootstrap)).toThrow("Illegal revision");
    expect(git(["count-objects", "-v"])).toEqual(before);
    // Even a latest valid one-step projection cannot hide an invalid bootstrap.
    const other = initialize("forged-bootstrap");
    const writer = createLocalPromotionControlStore({
      ...options(other),
      validateTransition: () => {},
    });
    const invalidInitial = writer.compareAndAppend({
      expectedHead: null,
      bytes: state(9),
      createdAt,
    }).attemptedHead!;
    writer.compareAndAppend({
      expectedHead: invalidInitial,
      bytes: state(10),
      createdAt,
    });
    expect(() =>
      createLocalPromotionControlStore(options(other)).read()
    ).toThrow("Illegal revision");
  }, 30_000);

  it("rejects symbolic control refs and HEAD checkout aliases before any object or ref write", () => {
    const store = createLocalPromotionControlStore(options());
    const first = store.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    }).attemptedHead!;
    const intent = { expectedHead: first, bytes: state(1), createdAt };
    const beforeObjects = git(["count-objects", "-v"]);
    git(["symbolic-ref", "HEAD", ref]);
    expect(() => store.prepareAppend(intent)).toThrow(
      "checked out through HEAD"
    );
    expect(() => store.compareAndAppend(intent)).toThrow(
      "checked out through HEAD"
    );
    git(["symbolic-ref", "refs/heads/alias", ref]);
    git(["symbolic-ref", "HEAD", "refs/heads/alias"]);
    expect(() => store.compareAndAppend(intent)).toThrow(
      "checked out through HEAD"
    );
    git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(["update-ref", "refs/heads/real-control", first]);
    git(["symbolic-ref", ref, "refs/heads/real-control"]);
    expect(() => store.compareAndAppend(intent)).toThrow(
      "must not be symbolic"
    );
    expect(() => store.prepareAppend(intent)).toThrow("must not be symbolic");
    expect(git(["count-objects", "-v"])).toEqual(beforeObjects);
    expect(
      git(["rev-parse", "refs/heads/real-control"]).toString().trim()
    ).toBe(first);
  }, 30_000);

  it("rejects malformed control trees and metadata plus replacement object substitutions", () => {
    const store = createLocalPromotionControlStore(options());
    const first = store.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    }).attemptedHead!;
    const second = store.compareAndAppend({
      expectedHead: first,
      bytes: state(1),
      createdAt,
    }).attemptedHead!;
    git(["replace", first, second]);
    expect(
      store.readback({
        attemptedHead: first,
        expectedHead: null,
        bytes: state(0),
      }).status
    ).toBe("conflict");
    const raw = git([
      "--no-replace-objects",
      "cat-file",
      "commit",
      first,
    ]).toString();
    for (const malformed of [
      raw.replace("Codex", "Other"),
      raw.replace("\nauthor", `\nparent ${first}\nparent ${second}\nauthor`),
    ]) {
      const sha = git(
        ["hash-object", "-w", "--stdin", "-t", "commit"],
        root,
        malformed
      )
        .toString()
        .trim();
      git(["update-ref", ref, sha]);
      expect(() => store.read()).toThrow("metadata");
    }
    const blob = git(["hash-object", "-w", "--stdin"], root, state(0))
      .toString()
      .trim();
    const tree = git(
      ["mktree"],
      root,
      `100644 blob ${blob}\tcontrol.json\n100644 blob ${blob}\tprivate.json\n`
    )
      .toString()
      .trim();
    const commit = git(
      ["hash-object", "-w", "--stdin", "-t", "commit"],
      root,
      raw.replace(/^tree [a-f0-9]{40}/, `tree ${tree}`)
    )
      .toString()
      .trim();
    git(["update-ref", ref, commit]);
    expect(() => store.read()).toThrow("only control.json");
  }, 30_000);

  it("excludes injected Git environment and rejects unsafe remote policy before network operations", () => {
    const store = createLocalPromotionControlStore(options());
    const expected = store.compareAndAppend({
      expectedHead: null,
      bytes: state(0),
      createdAt,
    }).attemptedHead!;
    vi.stubEnv("GIT_DIR", join(directory, "nonexistent"));
    vi.stubEnv("GIT_INDEX_FILE", join(directory, "injected-index"));
    vi.stubEnv("GIT_OBJECT_DIRECTORY", join(directory, "injected-objects"));
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "extensions.objectFormat");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "sha256");
    expect(store.read().head).toBe(expected);
    expect(() => createBareTestPromotionControlTransport(root, ".")).toThrow(
      "absolute"
    );
    expect(() => createBareTestPromotionControlTransport(root, root)).toThrow(
      "bare repository"
    );
    const production = createAuthoritativePromotionControlTransport(root);
    git([
      "config",
      "url.https://example.invalid/.insteadOf",
      "https://github.com/",
    ]);
    expect(() => production.readHead(ref)).toThrow("rewriting");
    git([
      "remote",
      "set-url",
      "origin",
      "https://github.com/prodigic/zivv-test.git",
    ]);
    expect(() => createAuthoritativePromotionControlTransport(root)).toThrow(
      "authoritative"
    );
  }, 30_000);
});
