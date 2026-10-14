import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readPublicationPayloadGit,
  writePublicationPayloadGit,
} from "../../lib/ingestion/publication-git.js";

describe("immutable raw publication Git objects", () => {
  let directory: string;
  let repositoryRoot: string;
  const createdAt = "2026-10-14T12:34:56.789Z";

  function git(args: string[], input?: Buffer | string): Buffer {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith("GIT_")) delete env[name];
    }
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      input,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  function gitText(args: string[], input?: Buffer | string): string {
    return git(args, input).toString("utf8").trim();
  }
  function write(files: ReadonlyMap<string, Buffer>) {
    return writePublicationPayloadGit({ repositoryRoot, createdAt, files });
  }
  function read(payloadCommit: string) {
    return readPublicationPayloadGit({
      repositoryRoot,
      payloadCommit,
      createdAt,
    });
  }
  function commitWithTree(tree: string): string {
    const valid = write(new Map([["file.txt", Buffer.from("original")]]));
    const commit = git(["cat-file", "commit", valid.payloadCommit])
      .toString("utf8")
      .replace(/^tree [a-f0-9]{40}/, `tree ${tree}`);
    return gitText(["hash-object", "-w", "--stdin", "-t", "commit"], commit);
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "zivv-publication-git-"));
    repositoryRoot = join(directory, "repository");
    mkdirSync(repositoryRoot);
    git(["init", "--quiet", "--object-format=sha1"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["remote", "add", "origin", "https://github.com/prodigic/zivv.git"]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Only remove the exact temporary fixture directory allocated in beforeEach.
    if (!directory.startsWith(join(tmpdir(), "zivv-publication-git-"))) {
      throw new Error(
        "Temporary fixture path is outside its intended directory"
      );
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("preserves raw binary and CRLF bytes without touching attributes, dirty index, refs or working files", () => {
    git(["config", "core.autocrlf", "true"]);
    writeFileSync(
      join(repositoryRoot, ".gitattributes"),
      "*.txt text eol=lf\n*.bin filter=fail\n"
    );
    git(["config", "filter.fail.clean", "command-that-must-not-run"]);
    git(["config", "filter.fail.required", "true"]);
    writeFileSync(join(repositoryRoot, "tracked.txt"), "initial\r\n");
    git(["add", ".gitattributes", "tracked.txt"]);
    git(["commit", "--quiet", "-m", "fixture"]);
    writeFileSync(join(repositoryRoot, "tracked.txt"), "staged edit\r\n");
    git(["add", "tracked.txt"]);
    writeFileSync(join(repositoryRoot, "tracked.txt"), "unstaged edit\r\n");
    const beforeIndex = readFileSync(join(repositoryRoot, ".git", "index"));
    const beforeStatus = git(["status", "--porcelain=v1", "-z"]);
    const beforeRefs = git(["show-ref"]);
    const files = new Map([
      ["public/data/data.txt", Buffer.from("exact\r\nbytes\r\n")],
      ["assets/image.bin", Buffer.from([0, 255, 128, 13, 10, 0, 1])],
      ["a.b", Buffer.from("sort before tree")],
      ["a/file.txt", Buffer.alloc(0)],
    ]);
    const result = write(files);
    const loaded = read(result.payloadCommit);
    expect(loaded.tree).toBe(result.tree);
    expect(loaded.createdAt).toBe(createdAt);
    expect(loaded.files).toEqual(files);
    expect(
      git(["cat-file", "commit", result.payloadCommit]).toString()
    ).not.toContain("\nparent ");
    expect(git(["ls-tree", "-r", result.tree]).toString()).not.toContain(
      "100755"
    );
    expect(readFileSync(join(repositoryRoot, ".git", "index"))).toEqual(
      beforeIndex
    );
    expect(git(["status", "--porcelain=v1", "-z"])).toEqual(beforeStatus);
    expect(git(["show-ref"])).toEqual(beforeRefs);
    expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe(
      "unstaged edit\r\n"
    );
    expect(existsSync(join(repositoryRoot, "public"))).toBe(false);
  });

  it("has deterministic identities for timestamp and bytes regardless of map order", () => {
    const files = new Map([
      ["nested/b", Buffer.from("second")],
      ["a", Buffer.from("first")],
    ]);
    const first = write(files);
    expect(write(new Map([...files].reverse()))).toEqual(first);
    const changed = writePublicationPayloadGit({
      repositoryRoot,
      files,
      createdAt: "2026-10-14T12:34:56.790Z",
    });
    expect(changed.tree).toBe(first.tree);
    expect(changed.payloadCommit).not.toBe(first.payloadCommit);
    const other = write(new Map([["a", Buffer.from("changed")]]));
    expect(other.tree).not.toBe(first.tree);
  }, 30_000);

  it("strips injected Git environment, global filters, alternates, hooks, author and replace settings", () => {
    const files = new Map([["raw.txt", Buffer.from("exact\r\n")]]);
    const expected = write(files);
    const otherRoot = join(directory, "other");
    mkdirSync(otherRoot);
    execFileSync("git", ["init", "--quiet", otherRoot]);
    const config = join(directory, "hostile.config");
    writeFileSync(
      config,
      "[core]\n repositoryformatversion = 1\n hooksPath = /invalid\n[extensions]\n objectFormat = sha256\n"
    );
    vi.stubEnv("GIT_DIR", join(otherRoot, ".git"));
    vi.stubEnv("GIT_WORK_TREE", otherRoot);
    vi.stubEnv("GIT_INDEX_FILE", join(directory, "injected-index"));
    vi.stubEnv("GIT_OBJECT_DIRECTORY", join(otherRoot, ".git", "objects"));
    vi.stubEnv("GIT_ALTERNATE_OBJECT_DIRECTORIES", "/invalid");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_CONFIG_SYSTEM", config);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "extensions.objectFormat");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "sha256");
    vi.stubEnv("GIT_AUTHOR_NAME", "Hostile author");
    vi.stubEnv("GIT_AUTHOR_DATE", "now");
    vi.stubEnv("GIT_REPLACE_REF_BASE", "refs/hostile/");
    expect(write(files)).toEqual(expected);
    expect(read(expected.payloadCommit).files).toEqual(files);
    expect(existsSync(join(directory, "injected-index"))).toBe(false);
  });

  it("ignores actual replace refs when reading the trusted exact commit", () => {
    const first = write(new Map([["raw.txt", Buffer.from("reviewed")]]));
    const second = write(new Map([["raw.txt", Buffer.from("replacement")]]));
    git(["replace", first.payloadCommit, second.payloadCommit]);
    expect(git(["cat-file", "commit", first.payloadCommit])).toEqual(
      git(["cat-file", "commit", second.payloadCommit])
    );
    expect(read(first.payloadCommit).files.get("raw.txt")).toEqual(
      Buffer.from("reviewed")
    );
  });

  it.each([
    "",
    "/absolute",
    "../escape",
    "path/../escape",
    "path//empty",
    "./file",
    "path\\file",
    "bad\0name",
    "bad\nname",
    "c:drive",
    "bad?name",
    "folder/.git/config",
    "git~1/config",
    "NUL.txt",
    "aux",
    "com1.json",
    "lpt9",
    "CONIN$",
    "trailing.",
    "space ",
    "unicode-é",
  ])("rejects unsafe portable path %j", (path) => {
    expect(() => write(new Map([[path, Buffer.from("bad")]]))).toThrow(
      "Unsafe publication Git path"
    );
  });

  it.each([
    ["a/file", "A/other"],
    ["a", "A"],
    ["a", "a/file"],
    ["a/file", "a"],
  ])("rejects case or file/directory collision %j", (first, second) => {
    const paths = [first, second];
    expect(() =>
      write(new Map(paths.map((path) => [path, Buffer.from("bad")])))
    ).toThrow(/collid|conflict/);
  });

  it("rejects corruption of existing objects on read and retry write", () => {
    const files = new Map([["file", Buffer.from("reviewed")]]);
    const payload = write(files);
    const blob = gitText(["hash-object", "--stdin"], "reviewed");
    const objectPath = join(
      repositoryRoot,
      ".git",
      "objects",
      blob.slice(0, 2),
      blob.slice(2)
    );
    rmSync(objectPath);
    writeFileSync(objectPath, deflateSync(Buffer.from("blob 7\0altered")));
    expect(() => read(payload.payloadCommit)).toThrow("object hash mismatch");
    expect(() => write(files)).toThrow("object hash mismatch");
  });

  it("requires canonical specified timestamps and the authoritative origin before writes", () => {
    const files = new Map([["file", Buffer.from("raw")]]);
    for (const timestamp of [
      "now",
      "2026-02-30T00:00:00.000Z",
      "2026-10-14T12:34:56Z",
    ]) {
      expect(() =>
        writePublicationPayloadGit({
          repositoryRoot,
          files,
          createdAt: timestamp,
        })
      ).toThrow("canonical ISO");
    }
    git([
      "remote",
      "set-url",
      "origin",
      "https://github.com/prodigic/zivv-test.git",
    ]);
    expect(() => write(files)).toThrow("authoritative Zivv origin");
  });

  it("refuses SHA-256 repositories for writing and reading", () => {
    const sha256Root = join(directory, "sha256");
    execFileSync("git", [
      "init",
      "--quiet",
      "--object-format=sha256",
      sha256Root,
    ]);
    expect(() =>
      writePublicationPayloadGit({
        repositoryRoot: sha256Root,
        createdAt,
        files: new Map(),
      })
    ).toThrow("SHA-1");
    expect(() =>
      readPublicationPayloadGit({
        repositoryRoot: sha256Root,
        payloadCommit: "a".repeat(40),
      })
    ).toThrow("SHA-1");
  });

  it.each(["HEAD", "a".repeat(39), "a".repeat(41), "A".repeat(40), "--help"])(
    "rejects non-exact object identity %j",
    (payloadCommit) => {
      expect(() => read(payloadCommit)).toThrow("full lowercase SHA-1");
    }
  );

  it("rejects missing objects, wrong object types, mismatched dates and modified metadata/parents", () => {
    const payload = write(new Map([["file", Buffer.from("raw")]]));
    expect(() => read("a".repeat(40))).toThrow();
    expect(() => read(payload.tree)).toThrow("not a commit");
    expect(() =>
      readPublicationPayloadGit({
        repositoryRoot,
        payloadCommit: payload.payloadCommit,
        createdAt: "2026-10-15T12:34:56.789Z",
      })
    ).toThrow("createdAt");
    const bytes = git(["cat-file", "commit", payload.payloadCommit]).toString(
      "utf8"
    );
    for (const malformed of [
      bytes.replace("Codex", "Other"),
      bytes.replace("\nauthor", `\nparent ${payload.payloadCommit}\nauthor`),
      bytes.replace(" +0000", " +0100"),
      bytes + "extra\n",
    ]) {
      const hash = gitText(
        ["hash-object", "-w", "--stdin", "-t", "commit"],
        malformed
      );
      expect(() => read(hash)).toThrow("metadata");
    }
  });

  it.each(["100755", "120000", "160000"])(
    "rejects unexpected executable, symlink or gitlink mode %s",
    (mode) => {
      const payload = write(new Map([["file", Buffer.from("target")]]));
      const blob = gitText(["hash-object", "-w", "--stdin"], "target");
      const type = mode === "160000" ? "commit" : "blob";
      const object = type === "commit" ? payload.payloadCommit : blob;
      const tree = gitText(["mktree"], `${mode} ${type} ${object}\tfile\n`);
      expect(() => read(commitWithTree(tree))).toThrow(
        "Unsupported publication Git mode"
      );
    }
  );

  it("rejects unsafe tree paths, case collisions and empty directories introduced through Git objects", () => {
    git(["config", "core.protectNTFS", "false"]);
    const blob = gitText(["hash-object", "-w", "--stdin"], "raw");
    const emptyTree = gitText(["mktree"], "");
    for (const input of [
      `100644 blob ${blob}\tNUL.txt\n`,
      `100644 blob ${blob}\tFile\n100644 blob ${blob}\tfile\n`,
      `040000 tree ${emptyTree}\tempty\n`,
    ]) {
      const tree = gitText(["mktree"], input);
      expect(() => read(commitWithTree(tree))).toThrow(
        /Unsafe|collide|inventory/
      );
    }
  }, 30_000);
});
