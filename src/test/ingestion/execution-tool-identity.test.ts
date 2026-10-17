import { createHash } from "node:crypto";
import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureNpmExecutionTool,
  validateNpmExecutionToolIdentity,
  verifyNpmExecutionTool,
  type NpmExecutionToolIdentity,
} from "../../lib/ingestion/execution-tool-identity.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";

describe("complete npm execution package identity", () => {
  let directory: string, root: string, cli: string;
  function write(path: string, content: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  function rehash(value: NpmExecutionToolIdentity) {
    const { identitySha256: _old, ...payload } = value;
    return {
      ...payload,
      identitySha256: createHash("sha256")
        .update(canonicalJson(payload))
        .digest("hex"),
    };
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "zivv-npm-identity-"));
    root = join(directory, "npm package; literal arguments");
    cli = join(root, "bin/npm-cli.js");
    write(cli, "require('../lib/cli.js');\n");
    write(join(root, "package.json"), '{"name":"npm","version":"11.6.0"}\n');
    write(join(root, "lib/cli.js"), "module.exports = 1;\n");
    write(
      join(root, "node_modules/dependency/index.js"),
      "module.exports = 2;\n"
    );
  });
  afterEach(() => {
    if (!directory.startsWith(join(tmpdir(), "zivv-npm-identity-")))
      throw new Error("Unsafe test cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  it("captures deterministic immutable metadata for the entire closure without spawning or writing", () => {
    const identity = captureNpmExecutionTool(cli);
    expect(identity).toEqual(captureNpmExecutionTool(cli));
    expect(identity).toMatchObject({
      schemaVersion: 1,
      kind: "npm-package",
      originalCli: cli,
      version: "11.6.0",
      entrypoint: "bin/npm-cli.js",
    });
    expect(identity.files.map((file) => file.path)).toEqual([
      "bin/npm-cli.js",
      "lib/cli.js",
      "node_modules/dependency/index.js",
      "package.json",
    ]);
    for (const file of identity.files) {
      const bytes = readFileSync(join(root, file.path));
      expect(file).toEqual({
        path: file.path,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(Object.isFrozen(file)).toBe(true);
    }
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.files)).toBe(true);
    expect(identity).toEqual(rehash(identity));
    expect(verifyNpmExecutionTool(identity, cli)).toBe(cli);
  });
  it("verifies relocation using only the exact new package while preserving original manifest bytes", () => {
    const identity = captureNpmExecutionTool(cli),
      before = canonicalJson(identity),
      relocated = join(directory, "relocated npm; tools");
    cpSync(root, relocated, { recursive: true });
    rmSync(root, { recursive: true });
    expect(validateNpmExecutionToolIdentity(JSON.parse(before))).toEqual(
      identity
    );
    expect(
      verifyNpmExecutionTool(identity, join(relocated, "bin/npm-cli.js"))
    ).toBe(join(relocated, "bin/npm-cli.js"));
    expect(canonicalJson(identity)).toBe(before);
    expect(
      captureNpmExecutionTool(join(relocated, "bin/npm-cli.js")).identitySha256
    ).not.toBe(identity.identitySha256);
  });
  it("validates Windows and POSIX retained logical paths independently of the current host", () => {
    const captured = captureNpmExecutionTool(cli);
    for (const originalCli of [
      "C:\\retained npm; tools\\bin\\npm-cli.js",
      "/retained npm; tools/bin/npm-cli.js",
    ]) {
      const retained = rehash({ ...captured, originalCli });
      expect(validateNpmExecutionToolIdentity(retained)).toEqual(retained);
      expect(verifyNpmExecutionTool(retained, cli)).toBe(cli);
    }
    for (const originalCli of [
      "\\\\server\\share\\bin\\npm-cli.js",
      "\\\\?\\C:\\npm\\bin\\npm-cli.js",
      "C:\\npm\\bin\\..\\bin\\npm-cli.js",
      "//server/share/bin/npm-cli.js",
    ]) {
      expect(() =>
        validateNpmExecutionToolIdentity(rehash({ ...captured, originalCli }))
      ).toThrow();
    }
  });

  it.each([
    "changed dependency",
    "extra file",
    "missing file",
    "changed version",
  ])("refuses %s after capture", (change) => {
    const identity = captureNpmExecutionTool(cli);
    if (change === "changed dependency")
      write(join(root, "node_modules/dependency/index.js"), "changed");
    if (change === "extra file") write(join(root, "extra.js"), "extra");
    if (change === "missing file") rmSync(join(root, "lib/cli.js"));
    if (change === "changed version")
      write(join(root, "package.json"), '{"name":"npm","version":"11.7.0"}');
    expect(() => verifyNpmExecutionTool(identity, cli)).toThrow();
  });
  it.each([".npmrc", ".git/config", "node_modules/dependency/.NPMRC"])(
    "rejects private or repository configuration %s",
    (path) => {
      write(join(root, path), "private configuration");
      expect(() => captureNpmExecutionTool(cli)).toThrow(
        "INVALID_NPM_EXECUTION_TOOL"
      );
    }
  );
  it("rejects hardlinks and linked package directories", () => {
    linkSync(join(root, "lib/cli.js"), join(root, "linked.js"));
    expect(() => captureNpmExecutionTool(cli)).toThrow();
    rmSync(join(root, "linked.js"));
    symlinkSync(
      root,
      join(directory, "linked-package"),
      process.platform === "win32" ? "junction" : "dir"
    );
    expect(() =>
      captureNpmExecutionTool(join(directory, "linked-package/bin/npm-cli.js"))
    ).toThrow();
  });
  it("rejects links within the dependency closure", () => {
    symlinkSync(
      join(root, "lib"),
      join(root, "node_modules/linked"),
      process.platform === "win32" ? "junction" : "dir"
    );
    expect(() => captureNpmExecutionTool(cli)).toThrow();
  });
  it.each(["01.6.0", "11.06.0", "11.6", "latest", "11.6.0\n"])(
    "rejects noncanonical package version %j",
    (version) => {
      write(
        join(root, "package.json"),
        JSON.stringify({ name: "npm", version })
      );
      expect(() => captureNpmExecutionTool(cli)).toThrow();
    }
  );
  it("requires genuine npm metadata and an absolute exact entrypoint", () => {
    for (const path of [
      "bin/npm-cli.js",
      join(root, "lib/cli.js"),
      join(root, "bin", "..", "npm-cli.js"),
      cli + "/..",
    ])
      expect(() => captureNpmExecutionTool(path)).toThrow();
    write(join(root, "package.json"), '{"name":"other","version":"11.6.0"}');
    expect(() => captureNpmExecutionTool(cli)).toThrow();
  });
  it("rejects oversized package inventory before reading the large file", () => {
    const file = join(root, "large.bin");
    write(file, "");
    truncateSync(file, 64 * 1024 * 1024 + 1);
    expect(() => captureNpmExecutionTool(cli)).toThrow();
  });
  it("strictly validates retained identity shape, digest, portable paths and bounds", () => {
    const identity = captureNpmExecutionTool(cli);
    const cases: unknown[] = [
      null,
      [],
      { ...identity, extra: true },
      {
        ...identity,
        originalCli: resolve(directory, "different/bin/npm-cli.js"),
      },
      { ...identity, identitySha256: "0".repeat(64) },
      rehash({ ...identity, files: [...identity.files].reverse() }),
      rehash({
        ...identity,
        files: [
          { ...identity.files[0], path: "../escape" },
          ...identity.files.slice(1),
        ],
      }),
      rehash({
        ...identity,
        files: [
          { ...identity.files[0], path: "bin\\npm-cli.js" },
          ...identity.files.slice(1),
        ],
      }),
      rehash({
        ...identity,
        files: [{ ...identity.files[0], size: -1 }, ...identity.files.slice(1)],
      }),
      rehash({
        ...identity,
        files: [
          { ...identity.files[0], size: 64 * 1024 * 1024 + 1 },
          ...identity.files.slice(1),
        ],
      }),
      rehash({
        ...identity,
        files: [
          { ...identity.files[0], path: "BIN/NPM-CLI.JS" },
          ...identity.files,
        ],
      }),
      {
        ...identity,
        files: Array.from({ length: 10_001 }, () => identity.files[0]),
      },
    ];
    for (const value of cases) {
      expect(() => validateNpmExecutionToolIdentity(value)).toThrow();
      expect(() =>
        Reflect.apply(verifyNpmExecutionTool, undefined, [value, cli])
      ).toThrow();
    }
  });

  it.each(["LIB/extra.js", "lib"])(
    "rejects rehashed directory-prefix conflicts at %s without filesystem access",
    (path) => {
      const identity = captureNpmExecutionTool(cli),
        files = [...identity.files, { ...identity.files[0], path }].sort(
          (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
        ),
        conflicting = rehash({ ...identity, files });
      rmSync(root, { recursive: true });
      expect(() => validateNpmExecutionToolIdentity(conflicting)).toThrow(
        "INVALID_NPM_EXECUTION_TOOL"
      );
    }
  );
});
