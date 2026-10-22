import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBareTestPromotionControlTransport,
  createLocalPromotionControlStore,
  createRemotePromotionControlStore,
  type PromotionControlStore,
  type PromotionControlStoreOptions,
  type PromotionControlTransport,
} from "../../lib/ingestion/promotion-control-git.js";

const ref = "refs/heads/zivv-promotion-control/production";
const dates = [
  "2026-10-14T12:34:56.123Z",
  "2026-10-14T12:34:56.789Z",
  "2026-10-14T12:34:57.001Z",
];
const state = (revision: number, operation = "fixture") =>
  Buffer.from(
    JSON.stringify({ destination: "production", revision, operation }) + "\r\n"
  );

function parse(bytes: Buffer): number {
  const value: unknown = JSON.parse(bytes.toString());
  if (
    typeof value !== "object" ||
    value === null ||
    !("destination" in value) ||
    value.destination !== "production" ||
    !("revision" in value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !("operation" in value) ||
    typeof value.operation !== "string" ||
    Object.keys(value).length !== 3
  )
    throw new Error("Malformed state");
  return value.revision;
}

describe("bounded canonical promotion control history", () => {
  let directory: string;
  let root: string;
  let bare: string;
  function git(args: string[], cwd = root, input?: Buffer | string) {
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
  function initialize(name: string) {
    const path = join(directory, name);
    mkdirSync(path);
    git(["init", "--quiet", "--object-format=sha1"], path);
    git(["config", "user.name", "Fixture"], path);
    git(["config", "user.email", "fixture@example.invalid"], path);
    git(["config", "commit.gpgsign", "false"], path);
    return path;
  }
  function options(repositoryRoot = root): PromotionControlStoreOptions {
    return {
      repositoryRoot,
      destination: "production",
      validateState(bytes) {
        parse(bytes);
      },
      validateTransition(previous, next) {
        if (parse(next) !== (previous === null ? 0 : parse(previous) + 1))
          throw new Error("Illegal revision");
      },
    };
  }
  function append(
    store: PromotionControlStore,
    revision: number,
    parent: string | null,
    operation?: string
  ) {
    const result = store.compareAndAppend({
      expectedHead: parent,
      bytes: state(revision, operation),
      createdAt: dates[revision] ?? dates[0],
    });
    expect(result.status).toBe("appended");
    return result.attemptedHead!;
  }
  function history(store: PromotionControlStore) {
    expect(typeof store.readCanonicalHistory).toBe("function");
    return store.readCanonicalHistory!();
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "zivv-control-history-"));
    root = initialize("local");
    bare = join(directory, "remote.git");
    git(["init", "--quiet", "--bare", "--object-format=sha1", bare]);
  });
  afterEach(() => {
    if (!directory.startsWith(join(tmpdir(), "zivv-control-history-")))
      throw new Error("Unsafe fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns an empty complete snapshot only for an absent canonical head", () => {
    expect(history(createLocalPromotionControlStore(options()))).toEqual({
      head: null,
      complete: true,
      commits: [],
    });
  });

  it("returns exact newest-first sole-parent states and original millisecond timestamps through bootstrap", () => {
    const store = createLocalPromotionControlStore(options());
    const first = append(store, 0, null);
    const second = append(store, 1, first);
    const third = append(store, 2, second);
    expect(history(store)).toEqual({
      head: third,
      complete: true,
      commits: [
        {
          head: third,
          parentHead: second,
          bytes: state(2),
          parentBytes: state(1),
          createdAt: dates[2],
        },
        {
          head: second,
          parentHead: first,
          bytes: state(1),
          parentBytes: state(0),
          createdAt: dates[1],
        },
        {
          head: first,
          parentHead: null,
          bytes: state(0),
          parentBytes: null,
          createdAt: dates[0],
        },
      ],
    });
  }, 30_000);
  it("truncates at whole commit entries, counting both byte buffers, and never invents completeness", () => {
    const store = createLocalPromotionControlStore(options());
    const first = append(store, 0, null);
    const second = append(store, 1, first);
    const read = store.readCanonicalHistory!;
    const entryBytes = state(1).length + state(0).length;
    expect(read({ maxCommits: 1 })).toEqual({
      head: second,
      complete: false,
      commits: [
        {
          head: second,
          parentHead: first,
          bytes: state(1),
          parentBytes: state(0),
          createdAt: dates[1],
        },
      ],
    });
    expect(read({ maxBytes: entryBytes - 1 })).toEqual({
      head: second,
      complete: false,
      commits: [],
    });
    expect(read({ maxBytes: entryBytes }).complete).toBe(false);
    expect(
      read({ maxBytes: entryBytes + state(0).length - 1 }).commits
    ).toHaveLength(1);
    expect(read({ maxBytes: entryBytes + state(0).length })).toEqual(
      history(store)
    );
    expect(read({ maxCommits: 2 }).complete).toBe(true);
  }, 30_000);

  it("returns buffers detached from adjacent entries and future calls", () => {
    const store = createLocalPromotionControlStore(options());
    const first = append(store, 0, null);
    append(store, 1, first);
    const before = history(store);
    before.commits[0].parentBytes!.fill(0);
    expect(before.commits[1].bytes).toEqual(state(0));
    before.commits[0].bytes.fill(0);
    before.commits[1].bytes.fill(0);
    const after = history(store);
    expect(after.commits.map((entry) => entry.bytes)).toEqual([
      state(1),
      state(0),
    ]);
    expect(after.commits[0].parentBytes).toEqual(state(0));
  }, 30_000);

  it("ignores unpublished prepared children, forks and orphan roots", () => {
    const store = createLocalPromotionControlStore(options());
    const first = append(store, 0, null);
    const second = append(store, 1, first);
    const expected = history(store);
    const unpublished = [
      { expectedHead: second, bytes: state(2) },
      { expectedHead: first, bytes: state(1, "fork") },
      { expectedHead: null, bytes: state(0, "orphan") },
    ].map(
      (input) =>
        store.prepareAppend({ ...input, createdAt: dates[2] }).attemptedHead
    );
    const objects = git(["count-objects", "-v"]);
    expect(history(store)).toEqual(expected);
    expect(
      history(store).commits.some((entry) => unpublished.includes(entry.head))
    ).toBe(false);
    expect(git(["count-objects", "-v"])).toEqual(objects);
  }, 30_000);

  it("validates the entire canonical chain before applying output limits", () => {
    const permissive = createLocalPromotionControlStore({
      ...options(),
      validateTransition() {},
    });
    const bad = append(permissive, 7, null);
    append(permissive, 8, bad);
    const strict = createLocalPromotionControlStore(options());
    expect(() =>
      strict.readCanonicalHistory!({ maxCommits: 1, maxBytes: 1 })
    ).toThrow("Illegal revision");
  }, 30_000);

  it("rejects merged metadata, invalid timestamps and missing canonical ancestors", () => {
    const store = createLocalPromotionControlStore(options());
    const first = append(store, 0, null);
    const second = append(store, 1, first);
    const raw = git(["cat-file", "commit", second]).toString();
    const invalid = [
      raw.replace(`parent ${first}\n`, `parent ${first}\nparent ${first}\n`),
      raw.replace(dates[1], "2026-02-30T00:00:00.000Z"),
      raw.replace(`parent ${first}\n`, `parent ${"9".repeat(40)}\n`),
    ];
    for (const bytes of invalid) {
      const forged = git(
        ["hash-object", "-w", "--stdin", "-t", "commit"],
        root,
        bytes
      )
        .toString()
        .trim();
      git(["update-ref", ref, forged]);
      const before = git(["count-objects", "-v"]);
      expect(() =>
        createLocalPromotionControlStore(options()).readCanonicalHistory!({
          maxCommits: 1,
        })
      ).toThrow();
      expect(git(["count-objects", "-v"])).toEqual(before);
    }
  }, 30_000);

  it("rejects invalid limits before consulting the authoritative transport", () => {
    const readHead = vi.fn(() => null);
    const transport: PromotionControlTransport = {
      repository: "prodigic/zivv",
      readHead,
      fetchCommit: vi.fn(),
      append: vi.fn(),
    };
    const store = createRemotePromotionControlStore({
      ...options(),
      transport,
    });
    for (const invalid of [
      null,
      [],
      { extra: 1 },
      { maxCommits: 0 },
      { maxCommits: -1 },
      { maxCommits: 1.5 },
      { maxCommits: 10_001 },
      { maxCommits: NaN },
      { maxCommits: null },
      { maxCommits: "1" },
      { maxBytes: 0 },
      { maxBytes: 64 * 1024 * 1024 + 1 },
      { maxBytes: Infinity },
      { maxBytes: 1.5 },
      { maxBytes: null },
    ])
      expect(() =>
        Reflect.apply(store.readCanonicalHistory!, store, [invalid])
      ).toThrow("history limits");
    expect(readHead).not.toHaveBeenCalled();
    expect(
      store.readCanonicalHistory!({
        maxCommits: 10_000,
        maxBytes: 64 * 1024 * 1024,
      })
    ).toEqual({ head: null, complete: true, commits: [] });
  });

  it("fetches remote history without changing refs, HEAD, dirty index, worktree or FETCH_HEAD", () => {
    const writer = createRemotePromotionControlStore({
      ...options(),
      transport: createBareTestPromotionControlTransport(root, bare),
    });
    const first = append(writer, 0, null);
    const second = append(writer, 1, first);
    const readerRoot = initialize("reader");
    writeFileSync(join(readerRoot, "tracked.txt"), "initial\n");
    git(["add", "tracked.txt"], readerRoot);
    git(["commit", "--quiet", "-m", "ordinary"], readerRoot);
    writeFileSync(join(readerRoot, "tracked.txt"), "staged\n");
    git(["add", "tracked.txt"], readerRoot);
    writeFileSync(join(readerRoot, "tracked.txt"), "dirty\n");
    writeFileSync(join(readerRoot, ".git", "FETCH_HEAD"), "preserved\n");
    const snapshot = () => ({
      refs: git(["show-ref"], readerRoot),
      head: git(["rev-parse", "HEAD"], readerRoot),
      index: readFileSync(join(readerRoot, ".git", "index")),
      status: git(["status", "--porcelain=v1", "-z"], readerRoot),
      fetch: readFileSync(join(readerRoot, ".git", "FETCH_HEAD")),
      file: readFileSync(join(readerRoot, "tracked.txt")),
      remoteRefs: git(["show-ref"], bare),
    });
    const before = snapshot();
    const reader = createRemotePromotionControlStore({
      ...options(readerRoot),
      transport: createBareTestPromotionControlTransport(readerRoot, bare),
    });
    expect(history(reader)).toEqual(history(writer));
    expect(history(reader).head).toBe(second);
    expect(snapshot()).toEqual(before);
  }, 30_000);

  it("keeps one authoritative head snapshot when remote advances during immutable fetch", () => {
    const writer = createRemotePromotionControlStore({
      ...options(),
      transport: createBareTestPromotionControlTransport(root, bare),
    });
    const first = append(writer, 0, null);
    const second = append(writer, 1, first);
    const readerRoot = initialize("moving-reader");
    const transport = createBareTestPromotionControlTransport(readerRoot, bare);
    let next: string | null = null;
    const readHead = vi.fn(transport.readHead);
    const reader = createRemotePromotionControlStore({
      ...options(readerRoot),
      transport: {
        ...transport,
        readHead,
        fetchCommit(commit) {
          if (next === null) next = append(writer, 2, second);
          transport.fetchCommit(commit);
        },
      },
    });
    const observed = history(reader);
    expect(observed.head).toBe(second);
    expect(observed.complete).toBe(true);
    expect(observed.commits.map((entry) => entry.head)).toEqual([
      second,
      first,
    ]);
    expect(readHead).toHaveBeenCalledTimes(1);
    expect(history(reader).head).toBe(next);
  }, 30_000);
});
