import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCapturedApplication,
  captureReviewedSource,
  verifyApplicationBuildReceipt,
  verifyCompiledEtl,
  type ApplicationBuildReceipt,
  type CapturedSource,
} from "../../lib/ingestion/source-build.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";

interface ToolBehavior {
  version?: string;
  ciExit?: number;
  compilerExit?: number;
  viteExit?: number;
  mutate?: "ci" | "compiler" | "vite";
}
interface ToolLog {
  stage: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

// This committed fake installer performs no network access. Its generated tool
// entry points are ordinary Node programs, so these tests exercise real spawn
// arguments, environment isolation, exit handling, and source-integrity checks.
const fakeNpm = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const behavior = JSON.parse(fs.readFileSync("tool-behavior.json", "utf8"));
function log(stage, args) {
  const env = {};
  for (const key of ["npm_config_cache", "npm_config_userconfig", "npm_config_registry", "ZIVV_CANDIDATE_BUILD", "ZIVV_BASE_PATH", "ZIVV_TEST_SECRET", "NODE_OPTIONS", "npm_config_script_shell", "npm_config_ignore_scripts"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  fs.appendFileSync(path.join(process.cwd(), "..", "tool-log.jsonl"), JSON.stringify({ stage, args, cwd: process.cwd(), env }) + "\n");
}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  log("version", args);
  process.stdout.write(behavior.version || "11.6.0");
} else {
  log("ci", args);
  if (behavior.mutate === "ci") fs.writeFileSync("main.ts", "installer mutation");
  if (behavior.ciExit) process.exit(behavior.ciExit);
  const common = 'const fs = require("node:fs"); const path = require("node:path"); const behavior = JSON.parse(fs.readFileSync("tool-behavior.json", "utf8"));\n' + log.toString() + '\n';
  fs.mkdirSync("node_modules/typescript/bin", { recursive: true });
  fs.writeFileSync("node_modules/typescript/bin/tsc", common + 'log("compiler", process.argv.slice(2)); if (behavior.mutate === "compiler") fs.writeFileSync("main.ts", "compiler mutation"); if (behavior.compilerExit) process.exit(behavior.compilerExit); if (process.argv.includes("--project")) { fs.mkdirSync("dist/lib/etl", { recursive: true }); fs.writeFileSync("dist/lib/etl/processor.js", "export class ETLProcessor {}\\n"); }');
  fs.mkdirSync("node_modules/vite/bin", { recursive: true });
  fs.writeFileSync("node_modules/vite/bin/vite.js", common + 'log("vite", process.argv.slice(2)); if (behavior.mutate === "vite") fs.writeFileSync("main.ts", "vite mutation"); if (behavior.viteExit) process.exit(behavior.viteExit); const output = process.argv[process.argv.indexOf("--outDir") + 1]; fs.mkdirSync(path.join(output, "assets"), { recursive: true }); fs.mkdirSync(path.join(output, ".vite"), { recursive: true }); fs.mkdirSync(path.join(output, "data"), { recursive: true }); fs.writeFileSync(path.join(output, "index.html"), "<script src=\\"" + process.env.ZIVV_BASE_PATH + "assets/app.js\\"></script>"); fs.writeFileSync(path.join(output, "assets/app.js"), "console.log(1);\\n"); fs.writeFileSync(path.join(output, ".vite/manifest.json"), JSON.stringify({ "main.ts": { file: "assets/app.js", isEntry: true } })); fs.writeFileSync(path.join(output, "data/private.json"), "excluded data"); fs.writeFileSync(path.join(output, "CNAME"), "excluded host");');
  process.stdout.write("installed fixture toolchain\n");
}
`;

describe("reviewed source capture and isolated application build", () => {
  let directory: string;
  let repositoryRoot: string;
  let privateDirectory: string;
  let sourceCommit: string;
  const npmName = "fake npm;cli.cjs";

  function git(args: string[], input?: string): string {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }
  function write(path: string, content: string): void {
    const target = join(repositoryRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  function commit(): string {
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "fixture source"]);
    return git(["rev-parse", "HEAD"]);
  }
  function capture(purpose: "preview" | "release" = "preview"): CapturedSource {
    return captureReviewedSource({
      repositoryRoot,
      privateDirectory,
      sourceCommit,
      purpose,
    });
  }
  function captureBehavior(behavior: ToolBehavior): CapturedSource {
    write("tool-behavior.json", JSON.stringify(behavior));
    sourceCommit = commit();
    return capture();
  }
  function build(source: CapturedSource, basePath = "/zivv/") {
    return buildCapturedApplication({
      source,
      basePath,
      npmCli: join(source.sourceRoot, npmName),
    });
  }
  function logs(source: CapturedSource): ToolLog[] {
    return readFileSync(join(source.directory, "tool-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ToolLog);
  }
  function hash(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "zivv-source-test-"));
    repositoryRoot = join(directory, "repository");
    privateDirectory = join(directory, "private");
    mkdirSync(repositoryRoot);
    git(["init", "--quiet"]);
    git(["config", "user.name", "Source fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "core.protectNTFS", "false"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["remote", "add", "origin", "https://github.com/prodigic/zivv.git"]);
    write("main.ts", "export const reviewed = true;\n");
    write("package.json", '{"name":"source-fixture","private":true}\n');
    write(
      "package-lock.json",
      '{"name":"source-fixture","lockfileVersion":3}\n'
    );
    write("tool-behavior.json", "{}\n");
    write(npmName, fakeNpm);
    sourceCommit = commit();
    git(["update-ref", "refs/remotes/origin/main", sourceCommit]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("captures exact committed blobs despite modified, deleted and untracked workspace files", () => {
    write("main.ts", "dirty workspace bytes\n");
    rmSync(join(repositoryRoot, "package-lock.json"));
    write("unreviewed.txt", "untracked secret");
    write(".gitattributes", "main.ts export-ignore\n");
    const source = capture("release");
    expect(readFileSync(join(source.sourceRoot, "main.ts"), "utf8")).toBe(
      "export const reviewed = true;\n"
    );
    expect(
      readFileSync(join(source.sourceRoot, "package-lock.json"), "utf8")
    ).toBe('{"name":"source-fixture","lockfileVersion":3}\n');
    expect(existsSync(join(source.sourceRoot, "unreviewed.txt"))).toBe(false);
    expect(existsSync(join(source.sourceRoot, ".gitattributes"))).toBe(false);
    expect(source.sourceCommit).toBe(sourceCommit);
    expect(source.sourceTree).toBe(
      git(["rev-parse", sourceCommit + "^{tree}"])
    );
    expect(source.archiveSha256).toBe(
      hash(readFileSync(join(source.directory, "source.blobs")))
    );
    expect(
      JSON.parse(
        readFileSync(join(source.directory, "source-capture.json"), "utf8")
      )
    ).toEqual(source);
    for (const file of source.files) {
      expect(readFileSync(join(source.sourceRoot, file.path))).toEqual(
        execFileSync("git", ["cat-file", "blob", file.blob], {
          cwd: repositoryRoot,
        })
      );
    }
  });

  it("rejects private output anywhere inside a Git repository", () => {
    privateDirectory = join(repositoryRoot, "nested", "private");
    expect(() => capture()).toThrow("outside Git repositories");
    expect(existsSync(privateDirectory)).toBe(false);
  });

  it("rejects a different origin before producing a capture", () => {
    git(["remote", "set-url", "origin", "https://github.com/example/zivv.git"]);
    expect(() => capture()).toThrow(
      "Unexpected authoritative source repository"
    );
    expect(existsSync(privateDirectory)).toBe(false);
  });

  it("allows a preview stack commit but releases require ancestry in origin/main", () => {
    write("stack.ts", "export const stack = true;\n");
    sourceCommit = commit();
    expect(() => capture("release")).toThrow();
    expect(capture("preview").sourceCommit).toBe(sourceCommit);
    git(["update-ref", "refs/remotes/origin/main", sourceCommit]);
    expect(capture("release").purpose).toBe("release");
  }, 30_000);

  it("ignores Git replacement objects when capturing a nominated reviewed commit", () => {
    const reviewedCommit = sourceCommit;
    const reviewedTree = git(["rev-parse", reviewedCommit + "^{tree}"]);
    write("main.ts", "export const spoofed = true;\n");
    const replacementCommit = commit();
    git(["replace", reviewedCommit, replacementCommit]);
    expect(git(["rev-parse", `refs/replace/${reviewedCommit}`])).toBe(
      replacementCommit
    );
    sourceCommit = reviewedCommit;
    const source = capture();
    expect(source.sourceCommit).toBe(reviewedCommit);
    expect(source.sourceTree).toBe(reviewedTree);
    expect(readFileSync(join(source.sourceRoot, "main.ts"), "utf8")).toBe(
      "export const reviewed = true;\n"
    );
  });

  it("ignores inherited Git repository and config environment when capturing reviewed source", () => {
    const reviewedTree = git(["rev-parse", sourceCommit + "^{tree}"]);
    vi.stubEnv("GIT_DIR", join(directory, "hostile", "git-metadata"));
    vi.stubEnv("GIT_WORK_TREE", join(directory, "hostile", "worktree"));
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "remote.origin.url");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://github.com/example/spoofed.git");
    const source = capture();
    expect(source.sourceCommit).toBe(sourceCommit);
    expect(source.sourceTree).toBe(reviewedTree);
    expect(readFileSync(join(source.sourceRoot, "main.ts"), "utf8")).toBe(
      "export const reviewed = true;\n"
    );
  });

  it.each(["HEAD", "-".repeat(40), "A".repeat(40)])(
    "rejects noncanonical source identity %s",
    (identity: string) => {
      sourceCommit = identity;
      expect(() => capture()).toThrow("Invalid source capture identity");
    }
  );

  it.each(["120000", "160000"])(
    "rejects Git source entries with mode %s",
    (mode: string) => {
      const object =
        mode === "160000"
          ? sourceCommit
          : git(["hash-object", "-w", "--stdin"], "main.ts");
      git([
        "update-index",
        "--add",
        "--cacheinfo",
        `${mode},${object},linked-entry`,
      ]);
      git(["commit", "--quiet", "-m", "unsupported entry"]);
      sourceCommit = git(["rev-parse", "HEAD"]);
      expect(() => capture()).toThrow(
        "Linked/submodule source entries are unsupported"
      );
      expect(existsSync(privateDirectory)).toBe(false);
    }
  );

  it("rejects case-folded collisions without relying on filesystem case sensitivity", () => {
    const blob = git(["rev-parse", sourceCommit + ":main.ts"]);
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},MAIN.ts`]);
    git(["commit", "--quiet", "-m", "case collision"]);
    sourceCommit = git(["rev-parse", "HEAD"]);
    expect(() => capture()).toThrow("Case-folded captured source collision");
  });

  it.each(["node_modules/payload.js", "CON.txt"])(
    "rejects nonportable committed source path %s",
    (path: string) => {
      const blob = git(["rev-parse", sourceCommit + ":main.ts"]);
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
      git(["commit", "--quiet", "-m", "unsupported path"]);
      sourceCommit = git(["rev-parse", "HEAD"]);
      expect(() => capture()).toThrow("Unsupported captured source path");
    }
  );

  it("preserves literal committed content despite export-subst attributes", () => {
    write("main.ts", "$Format:%H$\n");
    write(".gitattributes", "main.ts export-subst\n");
    sourceCommit = commit();
    const source = capture();
    expect(readFileSync(join(source.sourceRoot, "main.ts"), "utf8")).toBe(
      "$Format:%H$\n"
    );
    expect(
      readFileSync(join(source.sourceRoot, ".gitattributes"), "utf8")
    ).toBe("main.ts export-subst\n");
  });

  it("captures committed files even when export-ignore would omit them", () => {
    write(".gitattributes", "main.ts export-ignore\n");
    sourceCommit = commit();
    const source = capture();
    expect(readFileSync(join(source.sourceRoot, "main.ts"), "utf8")).toBe(
      "export const reviewed = true;\n"
    );
    expect(source.files.map(({ path }) => path)).toContain("main.ts");
  });

  it("preserves committed LF bytes under Windows autocrlf and eol attributes", () => {
    const content = '{"id":"reviewed"}\n{"id":"second"}\n';
    write(".gitattributes", "* text eol=crlf\n");
    write(".beads/issues.jsonl", content);
    git(["config", "core.autocrlf", "true"]);
    sourceCommit = commit();
    write(".beads/issues.jsonl", content.replaceAll("\n", "\r\n"));
    const source = capture();
    expect(
      readFileSync(join(source.sourceRoot, ".beads/issues.jsonl"))
    ).toEqual(Buffer.from(content));
    expect(
      readFileSync(join(repositoryRoot, ".beads/issues.jsonl"), "utf8")
    ).toContain("\r\n");
  });

  it("rejects a changed private blob envelope before starting build commands", async () => {
    const source = capture();
    const envelope = join(source.directory, "source.blobs");
    const bytes = readFileSync(envelope);
    bytes[0] ^= 1;
    writeFileSync(envelope, bytes);
    await expect(build(source)).rejects.toThrow(
      "Captured source receipt changed"
    );
    expect(existsSync(join(source.directory, "tool-log.jsonl"))).toBe(false);
  });

  it("builds with literal npm arguments, an isolated environment and a bound receipt", async () => {
    vi.stubEnv("ZIVV_TEST_SECRET", "must not reach build tools");
    vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=384");
    vi.stubEnv("npm_config_script_shell", "untrusted shell");
    vi.stubEnv("npm_config_ignore_scripts", "false");
    const source = capture();
    const progress: string[] = [];
    const result = await buildCapturedApplication({
      source,
      basePath: "/nested/zivv/",
      npmCli: join(source.sourceRoot, npmName),
      onProgress: (line) => progress.push(line),
    });
    const commands = logs(source);
    expect(commands.map(({ stage }) => stage)).toEqual([
      "version",
      "ci",
      "compiler",
      "compiler",
      "vite",
    ]);
    expect(commands[0].args).toEqual(["--version"]);
    expect(commands[1].args).toEqual([
      "ci",
      "--ignore-scripts",
      "--include=dev",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
    ]);
    expect(commands[2].args).toEqual(["-b"]);
    expect(commands[3].args).toEqual(["--project", "tsconfig.build.json"]);
    expect(commands[4].args).toEqual([
      "build",
      "--outDir",
      join(source.directory, "application"),
      "--emptyOutDir",
    ]);
    for (const command of commands) {
      expect(command.cwd).toBe(source.sourceRoot);
      expect(command.env).toEqual({
        npm_config_cache: join(privateDirectory, "npm-cache"),
        npm_config_userconfig: join(source.directory, "empty.npmrc"),
        npm_config_registry: "https://registry.npmjs.org/",
        ZIVV_CANDIDATE_BUILD: "1",
        ZIVV_BASE_PATH: "/nested/zivv/",
      });
    }
    expect(readFileSync(join(source.directory, "empty.npmrc")).length).toBe(0);
    expect(progress.join("")).toContain("installed fixture toolchain");
    expect([...result.applicationFiles.keys()].sort()).toEqual([
      "assets/app.js",
      "index.html",
    ]);
    expect(result.applicationFiles.get("index.html")?.toString()).toContain(
      "/nested/zivv/assets/app.js"
    );
    expect(result.receipt).toEqual({
      schemaVersion: 1,
      purpose: "preview",
      sourceRepository: "prodigic/zivv",
      sourceCommit,
      sourceTree: source.sourceTree,
      sourceInventorySha256: hash(canonicalJson(source.files)),
      archiveSha256: source.archiveSha256,
      packageLockSha256: hash(
        readFileSync(join(source.sourceRoot, "package-lock.json"))
      ),
      basePath: "/nested/zivv/",
      nodeVersion: process.version,
      npmVersion: "11.6.0",
      buildManifestSha256: hash(result.applicationBuildManifest),
      etlInventorySha256: hash(
        canonicalJson([
          {
            path: "lib/etl/processor.js",
            size: Buffer.byteLength("export class ETLProcessor {}\n"),
            sha256: hash("export class ETLProcessor {}\n"),
          },
        ])
      ),
      applicationFiles: [...result.applicationFiles]
        .map(([path, bytes]) => ({
          path,
          size: bytes.length,
          sha256: hash(bytes),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    });
    expect(
      JSON.parse(
        readFileSync(join(source.directory, "application-build.json"), "utf8")
      )
    ).toEqual(result.receipt);
    expect(
      verifyApplicationBuildReceipt(
        readFileSync(join(source.directory, "application-build.json")),
        {
          sourceCommit,
          basePath: "/nested/zivv/",
          applicationBuildManifest: result.applicationBuildManifest,
          applicationFiles: result.applicationFiles,
        }
      )
    ).toEqual(result.receipt);
    expect(readFileSync(join(repositoryRoot, "main.ts"), "utf8")).toBe(
      "export const reviewed = true;\n"
    );
  });

  it.each(["ci", "compiler", "vite"] as const)(
    "rejects reviewed source mutation by %s",
    async (stage: "ci" | "compiler" | "vite") => {
      const source = captureBehavior({ mutate: stage });
      await expect(build(source)).rejects.toThrow(
        "Reviewed source changed during build"
      );
      expect(existsSync(join(source.directory, "application-build.json"))).toBe(
        false
      );
    },
    30_000
  );

  it("snapshots caller-owned source metadata before awaiting build commands", async () => {
    const source = capture();
    const sourceInventorySha256 = hash(canonicalJson(source.files));
    let mutated = false;
    const result = await buildCapturedApplication({
      source,
      basePath: "/zivv/",
      npmCli: join(source.sourceRoot, npmName),
      onProgress: () => {
        mutated = true;
        source.sourceCommit = "e".repeat(40);
        source.purpose = "release";
        source.files[0].blob = "f".repeat(40);
      },
    });
    expect(mutated).toBe(true);
    expect(result.receipt.sourceCommit).toBe(sourceCommit);
    expect(result.receipt.purpose).toBe("preview");
    expect(result.receipt.sourceInventorySha256).toBe(sourceInventorySha256);
  });

  it.each([{ ciExit: 17 }, { compilerExit: 18 }, { viteExit: 19 }])(
    "rejects a nonzero build subprocess exit %j",
    async (behavior: ToolBehavior) => {
      const source = captureBehavior(behavior);
      await expect(build(source)).rejects.toThrow(
        /Captured build command failed \((17|18|19)\)/
      );
      expect(existsSync(join(source.directory, "application-build.json"))).toBe(
        false
      );
    }
  );

  it("rejects an invalid npm version before running an install", async () => {
    const source = captureBehavior({ version: "11.6.0\nextra output" });
    await expect(build(source)).rejects.toThrow("Invalid npm runtime version");
    expect(logs(source).map(({ stage }) => stage)).toEqual(["version"]);
  });

  it("rejects an invalid deployment base before spawning npm", async () => {
    const source = capture();
    await expect(build(source, "/../outside/")).rejects.toThrow("Site base");
    expect(existsSync(join(source.directory, "tool-log.jsonl"))).toBe(false);
  });

  it("rejects a directory used as the npm entry point before spawning", async () => {
    const source = capture();
    await expect(
      buildCapturedApplication({
        source,
        basePath: "/zivv/",
        npmCli: source.sourceRoot,
      })
    ).rejects.toThrow("unlinked regular file");
    expect(existsSync(join(source.directory, "tool-log.jsonl"))).toBe(false);
  });

  it.each(["node_modules", ".cache", "dist"])(
    "rejects a linked ignored build directory %s before spawning npm",
    async (name: string) => {
      const source = capture();
      const target = join(directory, "linked-build-target");
      mkdirSync(target);
      symlinkSync(
        target,
        join(source.sourceRoot, name),
        process.platform === "win32" ? "junction" : "dir"
      );
      await expect(build(source)).rejects.toThrow(
        "Linked build directory refused"
      );
      expect(existsSync(join(source.directory, "tool-log.jsonl"))).toBe(false);
      expect(existsSync(target)).toBe(true);
    }
  );
});

describe("compiled ETL inventory verification", () => {
  let sourceRoot: string;
  let expectedDigest: string;
  const fixtureFiles = new Map([
    ["lib/etl/processor.js", Buffer.from('import "./dependency.js";\n')],
    ["lib/etl/dependency.js", Buffer.from("export const reviewed = true;\n")],
  ]);
  function writeCompiled(path: string, bytes: string | Buffer): void {
    const target = join(sourceRoot, "dist", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }

  beforeEach(() => {
    sourceRoot = mkdtempSync(join(tmpdir(), "zivv-compiled-etl-test-"));
    for (const [path, bytes] of fixtureFiles) writeCompiled(path, bytes);
    expectedDigest = createHash("sha256")
      .update(
        canonicalJson(
          [...fixtureFiles]
            .map(([path, bytes]) => ({
              path,
              size: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        )
      )
      .digest("hex");
  });

  afterEach(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("accepts an exact compiled ETL inventory", () => {
    expect(() => verifyCompiledEtl(sourceRoot, expectedDigest)).not.toThrow();
  });

  it.each(["lib/etl/processor.js", "lib/etl/dependency.js"])(
    "rejects changed compiled executable %s",
    (path: string) => {
      writeCompiled(path, "export const modified = true;\n");
      expect(() => verifyCompiledEtl(sourceRoot, expectedDigest)).toThrow(
        "Compiled ETL differs from reviewed build receipt"
      );
    }
  );

  it.each([
    "new-dependency.js",
    "data/hidden.js",
    "CNAME",
    ".vite/manifest.json",
  ])(
    "rejects added compiled inventory file %s including public metadata paths",
    (path: string) => {
      writeCompiled(path, "unreviewed bytes");
      expect(() => verifyCompiledEtl(sourceRoot, expectedDigest)).toThrow(
        "Compiled ETL differs from reviewed build receipt"
      );
    }
  );

  it.each(["dist", "dist/linked-dependency"])(
    "rejects linked compiled inventory directory %s",
    (path: string) => {
      const target = join(sourceRoot, "linked-target");
      mkdirSync(target);
      if (path === "dist")
        rmSync(join(sourceRoot, "dist"), { recursive: true });
      symlinkSync(
        target,
        join(sourceRoot, path),
        process.platform === "win32" ? "junction" : "dir"
      );
      expect(() => verifyCompiledEtl(sourceRoot, expectedDigest)).toThrow(
        /Linked build output refused|unlinked regular file/
      );
    }
  );
});

describe("application build receipt verification", () => {
  const sourceCommit = "a".repeat(40);
  const applicationBuildManifest = Buffer.from(
    '{"main.ts":{"file":"assets/app.js"}}'
  );
  const applicationFiles = new Map([
    ["assets/app.js", Buffer.from("console.log(1);\n")],
    ["index.html", Buffer.from("<html>reviewed build</html>")],
  ]);
  const hash = (bytes: string | Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  const input = {
    sourceCommit,
    basePath: "/zivv/",
    applicationBuildManifest,
    applicationFiles,
  };
  function receipt(
    purpose: "preview" | "release" = "preview"
  ): ApplicationBuildReceipt {
    return {
      schemaVersion: 1,
      purpose,
      sourceRepository: "prodigic/zivv",
      sourceCommit,
      sourceTree: "b".repeat(40),
      sourceInventorySha256: "c".repeat(64),
      archiveSha256: "d".repeat(64),
      packageLockSha256: "e".repeat(64),
      etlInventorySha256: "f".repeat(64),
      basePath: "/zivv/",
      nodeVersion: process.version,
      npmVersion: "11.6.0",
      buildManifestSha256: hash(applicationBuildManifest),
      applicationFiles: [...applicationFiles].map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: hash(bytes),
      })),
    };
  }
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

  it.each(["preview", "release"] as const)(
    "accepts a valid %s receipt bound to application bytes",
    (purpose: "preview" | "release") => {
      const value = receipt(purpose);
      expect(verifyApplicationBuildReceipt(bytes(value), input)).toEqual(value);
    }
  );

  it("rejects changed or extra receipt fields", () => {
    for (const changes of [
      { schemaVersion: 2 },
      { sourceRepository: "another/zivv" },
      { unexpected: true },
      { etlInventorySha256: "invalid" },
      { sourceTree: "B".repeat(40) },
      { npmVersion: "11.6.0-beta" },
    ]) {
      expect(() =>
        verifyApplicationBuildReceipt(
          bytes({ ...receipt(), ...changes }),
          input
        )
      ).toThrow();
    }
  });

  it("rejects a receipt for a different reviewed commit or deployment base", () => {
    expect(() =>
      verifyApplicationBuildReceipt(bytes(receipt()), {
        ...input,
        sourceCommit: "b".repeat(40),
      })
    ).toThrow("provenance mismatch");
    expect(() =>
      verifyApplicationBuildReceipt(bytes(receipt()), {
        ...input,
        basePath: "/different/",
      })
    ).toThrow("provenance mismatch");
  });

  it("rejects invalid purpose values including an array that coerces to preview", () => {
    for (const purpose of ["publish", "", null, ["preview"]]) {
      expect(() =>
        verifyApplicationBuildReceipt(bytes({ ...receipt(), purpose }), input)
      ).toThrow("provenance mismatch");
    }
  });

  it("rejects changed application, manifest and inventory bytes", () => {
    const changedFiles = new Map(applicationFiles);
    changedFiles.set("assets/app.js", Buffer.from("console.log(2);\n"));
    expect(() =>
      verifyApplicationBuildReceipt(bytes(receipt()), {
        ...input,
        applicationFiles: changedFiles,
      })
    ).toThrow("Application bytes differ");
    expect(() =>
      verifyApplicationBuildReceipt(bytes(receipt()), {
        ...input,
        applicationBuildManifest: Buffer.from("{}"),
      })
    ).toThrow("Application bytes differ");
    const value = receipt();
    value.applicationFiles[0].size += 1;
    expect(() => verifyApplicationBuildReceipt(bytes(value), input)).toThrow(
      "Application bytes differ"
    );
  });
});
