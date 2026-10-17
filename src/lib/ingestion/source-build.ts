import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "./sqlite-store.js";
import { resolvePrivateCandidateDirectory } from "./private-artifacts.js";
import {
  secureOperatorDirectory,
  writeDurableFile,
} from "./encrypted-backup.js";
import { normalizeSiteBase } from "../../utils/site-base.js";

interface SourceFile {
  path: string;
  blob: string;
  mode: "100644" | "100755";
}
export interface ApplicationBuildReceipt {
  schemaVersion: 1;
  purpose: "preview" | "release";
  sourceRepository: "prodigic/zivv";
  sourceCommit: string;
  sourceTree: string;
  sourceInventorySha256: string;
  archiveSha256: string;
  packageLockSha256: string;
  basePath: string;
  nodeVersion: string;
  npmVersion: string;
  buildManifestSha256: string;
  etlInventorySha256: string;
  applicationFiles: { path: string; size: number; sha256: string }[];
}
/** Check a build receipt against the exact captured application bytes and target. */
export function verifyApplicationBuildReceipt(
  bytes: Buffer,
  input: {
    sourceCommit: string;
    basePath: string;
    applicationBuildManifest: Buffer;
    applicationFiles: ReadonlyMap<string, Buffer>;
  }
): ApplicationBuildReceipt {
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Invalid application build receipt");
  const value = parsed as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "purpose",
    "sourceRepository",
    "sourceCommit",
    "sourceTree",
    "sourceInventorySha256",
    "archiveSha256",
    "packageLockSha256",
    "basePath",
    "nodeVersion",
    "npmVersion",
    "buildManifestSha256",
    "applicationFiles",
    "etlInventorySha256",
  ];
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort()) ||
    value.schemaVersion !== 1 ||
    value.sourceRepository !== "prodigic/zivv" ||
    typeof value.purpose !== "string" ||
    !["preview", "release"].includes(value.purpose) ||
    value.sourceCommit !== input.sourceCommit ||
    value.basePath !== normalizeSiteBase(input.basePath)
  )
    throw new Error("Application build provenance mismatch");
  if (
    typeof value.sourceTree !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceTree)
  )
    throw new Error("Invalid captured source tree");
  for (const name of [
    "sourceInventorySha256",
    "archiveSha256",
    "packageLockSha256",
    "buildManifestSha256",
    "etlInventorySha256",
  ])
    if (
      typeof value[name] !== "string" ||
      !/^[a-f0-9]{64}$/.test(value[name] as string)
    )
      throw new Error("Invalid build receipt digest");
  if (
    typeof value.nodeVersion !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(value.nodeVersion) ||
    typeof value.npmVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.npmVersion)
  )
    throw new Error("Invalid build runtime receipt");
  const files = [...input.applicationFiles]
    .map(([path, content]) => ({
      path,
      size: content.length,
      sha256: hash(content),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    value.buildManifestSha256 !== hash(input.applicationBuildManifest) ||
    canonicalJson(value.applicationFiles) !== canonicalJson(files)
  )
    throw new Error("Application bytes differ from captured build receipt");
  return value as unknown as ApplicationBuildReceipt;
}
export interface CapturedSource {
  directory: string;
  sourceRoot: string;
  sourceCommit: string;
  sourceTree: string;
  files: SourceFile[];
  archiveSha256: string;
  purpose: "preview" | "release";
}
function verifyCapturedSource(source: CapturedSource): void {
  const directory = resolvePrivateCandidateDirectory(source.directory);
  if (
    directory !== source.directory ||
    source.sourceRoot !== join(directory, "source") ||
    resolvePrivateCandidateDirectory(source.sourceRoot) !== source.sourceRoot
  )
    throw new Error("Invalid private captured source location");
  const saved: unknown = JSON.parse(
    regular(join(directory, "source-capture.json")).toString("utf8")
  );
  if (
    canonicalJson(saved) !== canonicalJson(source) ||
    hash(regular(join(directory, "source.blobs"))) !== source.archiveSha256
  )
    throw new Error("Captured source receipt changed");
  const expected = new Set(source.files.map((file) => file.path));
  function checkTree(path: string, prefix: string) {
    if (lstatSync(path).isSymbolicLink())
      throw new Error("Linked source directory refused");
    for (const name of readdirSync(path)) {
      if (prefix === "" && ["node_modules", ".cache", "dist"].includes(name)) {
        if (lstatSync(join(path, name)).isSymbolicLink())
          throw new Error("Linked build directory refused");
        continue;
      }
      const child = join(path, name),
        key = prefix + name;
      if (lstatSync(child).isDirectory()) checkTree(child, key + "/");
      else if (!expected.has(key))
        throw new Error("Unexpected file in captured source");
    }
  }
  checkTree(source.sourceRoot, "");
  for (const file of source.files) {
    portablePath(file.path);
    const bytes = regular(join(source.sourceRoot, file.path));
    const blob = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
    if (blob !== file.blob)
      throw new Error("Reviewed source changed during build");
  }
}
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ])
    if (process.env[name]) env[name] = process.env[name];
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "";
  return env;
}
function git(root: string, args: string[]): Buffer {
  return execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnvironment(),
  });
}
function portablePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part === ".git" ||
          part === "node_modules" ||
          /[<>:"|?*]/.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
    throw new Error("Unsupported captured source path");
}
function regular(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error(
      "Captured source/artifact must be an unlinked regular file"
    );
  return readFileSync(path);
}
/** Capture exact Git blobs, independently of dirty workspace files or attributes. */
export function captureReviewedSource(input: {
  repositoryRoot: string;
  privateDirectory: string;
  sourceCommit: string;
  purpose: "preview" | "release";
}): CapturedSource {
  if (
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    !["preview", "release"].includes(input.purpose)
  )
    throw new Error("Invalid source capture identity");
  const root = resolve(input.repositoryRoot);
  const remote = git(root, ["remote", "get-url", "origin"])
    .toString("utf8")
    .trim();
  if (
    ![
      "git@github.com:prodigic/zivv.git",
      "https://github.com/prodigic/zivv.git",
      "https://github.com/prodigic/zivv",
    ].includes(remote)
  )
    throw new Error("Unexpected authoritative source repository");
  const commit = git(root, [
    "rev-parse",
    "--verify",
    input.sourceCommit + "^{commit}",
  ])
    .toString("utf8")
    .trim();
  if (commit !== input.sourceCommit) throw new Error("Source commit changed");
  if (input.purpose === "release")
    git(root, ["merge-base", "--is-ancestor", commit, "origin/main"]);
  const sourceTree = git(root, ["rev-parse", commit + "^{tree}"])
    .toString("utf8")
    .trim();
  const portable = new Set<string>();
  const files: SourceFile[] = git(root, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    commit,
  ])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
      if (!match)
        throw new Error("Linked/submodule source entries are unsupported");
      const [, mode, blob, path] = match;
      portablePath(path);
      if (portable.has(path.toLowerCase()))
        throw new Error("Case-folded captured source collision");
      portable.add(path.toLowerCase());
      return { path, blob, mode: mode as SourceFile["mode"] };
    });
  const parent = resolvePrivateCandidateDirectory(input.privateDirectory);
  secureOperatorDirectory(parent);
  const directory = mkdtempSync(join(parent, "source-build-"));
  secureOperatorDirectory(directory);
  const sourceRoot = join(directory, "source");
  mkdirSync(sourceRoot, { mode: 0o700 });
  const archive = join(directory, "source.blobs");
  const stream = execFileSync(
    "git",
    ["--no-replace-objects", "cat-file", "--batch"],
    {
      cwd: root,
      input: Buffer.from(files.map((file) => file.blob).join("\n") + "\n"),
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: gitEnvironment(),
    }
  );
  let offset = 0;
  for (const file of files) {
    const newline = stream.indexOf(10, offset);
    if (newline < 0) throw new Error("Incomplete Git blob stream");
    const header = /^([a-f0-9]{40}) blob (\d+)$/.exec(
      stream.subarray(offset, newline).toString("ascii")
    );
    if (!header || header[1] !== file.blob)
      throw new Error("Invalid Git blob stream identity");
    const size = Number(header[2]),
      end = newline + 1 + size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end >= stream.length ||
      stream[end] !== 10
    )
      throw new Error("Invalid Git blob stream framing");
    const bytes = stream.subarray(newline + 1, end);
    const blob = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
    if (blob !== file.blob)
      throw new Error(
        `Captured content does not match reviewed Git blob: ${file.path}`
      );
    writeDurableFile(join(sourceRoot, file.path), bytes);
    if (process.platform !== "win32")
      chmodSync(
        join(sourceRoot, file.path),
        file.mode === "100755" ? 0o700 : 0o600
      );
    offset = end + 1;
  }
  if (offset !== stream.length)
    throw new Error("Unexpected trailing Git blob records");
  writeDurableFile(archive, stream);
  const capture = {
    directory,
    sourceRoot,
    sourceCommit: commit,
    sourceTree,
    files,
    archiveSha256: hash(regular(archive)),
    purpose: input.purpose,
  };
  writeDurableFile(
    join(directory, "source-capture.json"),
    Buffer.from(canonicalJson(capture) + "\n")
  );
  return capture;
}
function run(
  node: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onProgress?: (line: string) => void
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(node, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-24000);
        onProgress?.(chunk.toString("utf8"));
      });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolvePromise(output)
        : reject(
            new Error(`Captured build command failed (${code}): ${output}`)
          )
    );
  });
}
function applicationTree(
  root: string,
  omitPublicMetadata = true
): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  function walk(directory: string, prefix: string) {
    if (lstatSync(directory).isSymbolicLink())
      throw new Error("Linked build output refused");
    for (const name of readdirSync(directory)) {
      const path = join(directory, name),
        key = prefix + name;
      if (
        omitPublicMetadata &&
        prefix === "" &&
        ["data", ".vite", "CNAME"].includes(name)
      )
        continue;
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, key + "/");
      else files.set(key, regular(path));
    }
  }
  walk(root, "");
  return files;
}
/** Refuse an ETL executable inventory that differs from the captured build. */
export function verifyCompiledEtl(
  sourceRoot: string,
  expectedDigest: string
): void {
  if (compiledEtlDigest(sourceRoot) !== expectedDigest)
    throw new Error("Compiled ETL differs from reviewed build receipt");
}
function compiledEtlDigest(sourceRoot: string): string {
  const files = applicationTree(join(sourceRoot, "dist"), false);
  return hash(
    canonicalJson(
      [...files]
        .map(([path, bytes]) => ({
          path,
          size: bytes.length,
          sha256: hash(bytes),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    )
  );
}
/** Install the captured lockfile and compile only the private reviewed source. */
export async function buildCapturedApplication(input: {
  source: CapturedSource;
  basePath: string;
  npmCli: string;
  onProgress?: (line: string) => void;
}): Promise<{
  receipt: ApplicationBuildReceipt;
  applicationFiles: Map<string, Buffer>;
  applicationBuildManifest: Buffer;
}> {
  const source = structuredClone(input.source);
  verifyCapturedSource(source);
  const basePath = normalizeSiteBase(input.basePath);
  const npmCli = resolve(input.npmCli);
  regular(npmCli);
  const cache = join(dirname(source.directory), "npm-cache");
  secureOperatorDirectory(cache);
  const userconfig = join(source.directory, "empty.npmrc");
  writeDurableFile(userconfig, Buffer.alloc(0));
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ])
    if (process.env[name]) env[name] = process.env[name];
  env.npm_config_cache = cache;
  env.npm_config_userconfig = userconfig;
  env.npm_config_registry = "https://registry.npmjs.org/";
  env.ZIVV_CANDIDATE_BUILD = "1";
  env.ZIVV_BASE_PATH = basePath;
  const npmVersion = (
    await run(process.execPath, [npmCli, "--version"], source.sourceRoot, env)
  ).trim();
  if (!/^\d+\.\d+\.\d+$/.test(npmVersion))
    throw new Error("Invalid npm runtime version");
  const packageLockSha256 = hash(
    regular(join(source.sourceRoot, "package-lock.json"))
  );
  await run(
    process.execPath,
    [
      npmCli,
      "ci",
      "--ignore-scripts",
      "--include=dev",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
    ],
    source.sourceRoot,
    env,
    input.onProgress
  );
  await run(
    process.execPath,
    [join(source.sourceRoot, "node_modules/typescript/bin/tsc"), "-b"],
    source.sourceRoot,
    env,
    input.onProgress
  );
  await run(
    process.execPath,
    [
      join(source.sourceRoot, "node_modules/typescript/bin/tsc"),
      "--project",
      "tsconfig.build.json",
    ],
    source.sourceRoot,
    env,
    input.onProgress
  );
  const output = join(source.directory, "application");
  await run(
    process.execPath,
    [
      join(source.sourceRoot, "node_modules/vite/bin/vite.js"),
      "build",
      "--outDir",
      output,
      "--emptyOutDir",
    ],
    source.sourceRoot,
    env,
    input.onProgress
  );
  verifyCapturedSource(source);
  const applicationFiles = applicationTree(output);
  const applicationBuildManifest = regular(join(output, ".vite/manifest.json"));
  const etlInventorySha256 = compiledEtlDigest(source.sourceRoot);
  const receipt: ApplicationBuildReceipt = {
    schemaVersion: 1,
    purpose: source.purpose,
    sourceRepository: "prodigic/zivv",
    sourceCommit: source.sourceCommit,
    sourceTree: source.sourceTree,
    sourceInventorySha256: hash(canonicalJson(source.files)),
    archiveSha256: source.archiveSha256,
    packageLockSha256,
    basePath,
    nodeVersion: process.version,
    npmVersion,
    buildManifestSha256: hash(applicationBuildManifest),
    etlInventorySha256,
    applicationFiles: [...applicationFiles]
      .map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: hash(bytes),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  writeDurableFile(
    join(source.directory, "application-build.json"),
    Buffer.from(canonicalJson(receipt) + "\n")
  );
  return { receipt, applicationFiles, applicationBuildManifest };
}
