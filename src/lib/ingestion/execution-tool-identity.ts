import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  resolve,
  win32,
} from "node:path";
import { canonicalJson } from "./sqlite-store.js";

export interface NpmExecutionToolIdentity {
  readonly schemaVersion: 1;
  readonly kind: "npm-package";
  readonly originalCli: string;
  readonly version: string;
  readonly entrypoint: "bin/npm-cli.js";
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
  readonly identitySha256: string;
}

const maxEntries = 10_000;
const maxBytes = 64 * 1024 * 1024;
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const hashPattern = /^[a-f0-9]{64}$/;
function fail(): never {
  throw new Error("INVALID_NPM_EXECUTION_TOOL");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: string[]): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(names.sort()))
    fail();
}
function cliPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.startsWith("\\\\") ||
    value.includes("\0") ||
    basename(value) !== "npm-cli.js" ||
    basename(dirname(value)) !== "bin"
  )
    fail();
  return value;
}
function originalCliPath(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) fail();
  const flavor = /^[A-Za-z]:\\/.test(value) ? win32 : posix;
  if (
    !flavor.isAbsolute(value) ||
    flavor.resolve(value) !== value ||
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    flavor.basename(value) !== "npm-cli.js" ||
    flavor.basename(flavor.dirname(value)) !== "bin"
  )
    fail();
  return value;
}
function portable(path: string): void {
  if (!path || path.length > 4096 || path.includes("\\")) fail();
  for (const part of path.split("/"))
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[<>:"|?*]/.test(part) ||
      [...part].some((character) => character.charCodeAt(0) < 32) ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
      [".git", ".npmrc"].includes(part.toLowerCase())
    )
      fail();
}
function inventory(cli: string): {
  version: string;
  files: NpmExecutionToolIdentity["files"];
} {
  const root = dirname(dirname(cli));
  for (let path = root; ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    if (dirname(path) === path) break;
  }
  let count = 0,
    bytes = 0;
  const files: { path: string; size: number; sha256: string }[] = [];
  const seen = new Set<string>();
  function walk(directory: string, prefix: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix + name;
      portable(path);
      if (++count > maxEntries || seen.has(path.toLowerCase())) fail();
      seen.add(path.toLowerCase());
      const physical = join(directory, name),
        stat = lstatSync(physical);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) walk(physical, path + "/");
      else {
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (bytes += stat.size) > maxBytes
        )
          fail();
        const content = readFileSync(physical);
        if (content.length !== stat.size) fail();
        files.push({ path, size: content.length, sha256: digest(content) });
      }
    }
  }
  walk(root, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = files.find((file) => file.path === "package.json");
  if (
    !manifest ||
    manifest.size > 1024 * 1024 ||
    !files.some((file) => file.path === "bin/npm-cli.js")
  )
    fail();
  const packageBytes = readFileSync(join(root, "package.json"));
  if (digest(packageBytes) !== manifest.sha256) fail();
  const metadata = record(JSON.parse(packageBytes.toString("utf8")));
  if (
    metadata.name !== "npm" ||
    typeof metadata.version !== "string" ||
    !semver.test(metadata.version)
  )
    fail();
  return { version: metadata.version, files };
}

/** Bind the complete local npm package closure before executing any tool code. */
export function captureNpmExecutionTool(
  npmCli: string
): NpmExecutionToolIdentity {
  const originalCli = cliPath(npmCli),
    first = inventory(originalCli);
  if (canonicalJson(first) !== canonicalJson(inventory(originalCli))) fail();
  const payload = {
    schemaVersion: 1 as const,
    kind: "npm-package" as const,
    originalCli,
    version: first.version,
    entrypoint: "bin/npm-cli.js" as const,
    files: Object.freeze(first.files.map((file) => Object.freeze(file))),
  };
  return Object.freeze({
    ...payload,
    identitySha256: digest(canonicalJson(payload)),
  });
}

/** Validate retained immutable metadata without accessing the original tool path. */
export function validateNpmExecutionToolIdentity(
  identity: unknown
): NpmExecutionToolIdentity {
  const value = record(identity);
  keys(value, [
    "schemaVersion",
    "kind",
    "originalCli",
    "version",
    "entrypoint",
    "files",
    "identitySha256",
  ]);
  const originalCli = originalCliPath(value.originalCli);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "npm-package" ||
    value.entrypoint !== "bin/npm-cli.js" ||
    typeof value.version !== "string" ||
    !semver.test(value.version) ||
    typeof value.identitySha256 !== "string" ||
    !hashPattern.test(value.identitySha256) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > maxEntries
  )
    fail();
  let previous = "",
    total = 0;
  const aliases = new Set<string>();
  const files: { path: string; size: number; sha256: string }[] = [];
  for (const item of value.files) {
    const file = record(item);
    keys(file, ["path", "size", "sha256"]);
    if (typeof file.path !== "string") fail();
    portable(file.path);
    if (
      file.path <= previous ||
      aliases.has(file.path.toLowerCase()) ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      (total += file.size) > maxBytes ||
      typeof file.sha256 !== "string" ||
      !hashPattern.test(file.sha256)
    )
      fail();
    previous = file.path;
    aliases.add(file.path.toLowerCase());
    files.push(
      Object.freeze({ path: file.path, size: file.size, sha256: file.sha256 })
    );
  }
  if (
    !files.some(
      (file) => file.path === "package.json" && file.size <= 1024 * 1024
    ) ||
    !files.some((file) => file.path === "bin/npm-cli.js")
  )
    fail();
  const payload = {
    schemaVersion: 1 as const,
    kind: "npm-package" as const,
    originalCli,
    version: value.version,
    entrypoint: "bin/npm-cli.js" as const,
    files: Object.freeze(files),
  };
  if (digest(canonicalJson(payload)) !== value.identitySha256) fail();
  return Object.freeze({ ...payload, identitySha256: value.identitySha256 });
}

/** Verify retained identity against an exact package copy; this grants no activation. */
export function verifyNpmExecutionTool(
  identity: NpmExecutionToolIdentity,
  candidateCli: string
): string {
  const retained = validateNpmExecutionToolIdentity(identity);
  const cli = cliPath(candidateCli),
    candidate = captureNpmExecutionTool(cli);
  if (
    candidate.version !== retained.version ||
    canonicalJson(candidate.files) !== canonicalJson(retained.files)
  )
    fail();
  return cli;
}
