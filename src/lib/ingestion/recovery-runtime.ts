import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  stageOperatorRecovery,
  verifyOperatorRetirementEvidence,
  type OperatorRecoveryCheckpoint,
} from "./operator-recovery.js";
import { inspectOperatorRecoveryLocations } from "./operator-recovery-location.js";
import { verifyNpmExecutionTool } from "./execution-tool-identity.js";
import { resolvePrivateCandidateDirectory } from "./private-artifacts.js";
import { canonicalJson } from "./sqlite-store.js";
import { compiledEtlDigest } from "./source-build.js";
import { sha256 } from "./steve-preflight.js";

const receiptName = "prepared-runtime.json";
const kind = "zivv-prepared-recovery-runtime";
const maxBytes = 512 * 1024 * 1024;
export type RecoveryRuntimeEntry =
  | { path: string; kind: "directory" }
  | { path: string; kind: "file"; size: number; sha256: string }
  | { path: string; kind: "symlink"; target: string };
export interface RecoveryRuntimeInput {
  archive: Buffer;
  retirementReceipt: Buffer;
  recoveryKey: Buffer;
  destination: string;
  npmCli: string;
}
export interface PreparedRecoveryRuntimeReport {
  status: "prepared";
  activationAllowed: false;
  checkpointSha256: string;
  ledgerRevision: string;
  treeSha256: string;
  entryCount: number;
  workerProbe: "quarantine-enforced";
}
function fail(code = "INVALID_PREPARED_RECOVERY_RUNTIME"): never {
  throw new Error(code);
}
function same(a: unknown, b: unknown): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail();
}
function noLinks(path: string): void {
  for (let item = path; ; item = dirname(item)) {
    const stat = lstatSync(item);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    if (dirname(item) === item) break;
  }
}
function regular(path: string, limit = maxBytes): Buffer {
  noLinks(dirname(path));
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit
  )
    fail();
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) fail();
  return bytes;
}
function portable(path: string): void {
  if (path.length > 4096 || path.includes("\\")) fail();
  for (const part of path.split("/"))
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[<>:"|?*]/.test(part) ||
      [...part].some((character) => character.charCodeAt(0) < 32) ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
      part.toLowerCase() === ".git"
    )
      fail();
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix !== ".." &&
    !suffix.startsWith("../") &&
    !suffix.startsWith("..\\") &&
    !isAbsolute(suffix)
  );
}
/** Include dependencies and private bootstrap files; never follow package links. */
function inventory(
  root: string,
  omit?: (entry: RecoveryRuntimeEntry) => boolean
): RecoveryRuntimeEntry[] {
  noLinks(root);
  const entries: RecoveryRuntimeEntry[] = [],
    aliases = new Set<string>(),
    modules = join(root, "checkout/node_modules");
  let total = 0,
    visited = 0;
  function walk(directory: string, prefix: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix + name,
        physical = join(directory, name);
      if (path === receiptName) continue;
      portable(path);
      if (++visited > 50_000 || aliases.has(path.toLowerCase())) fail();
      aliases.add(path.toLowerCase());
      const stat = lstatSync(physical);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(physical);
        if (
          !path.startsWith("checkout/node_modules/") ||
          isAbsolute(target) ||
          target.includes("\0") ||
          !inside(modules, resolve(dirname(physical), target)) ||
          !inside(modules, realpathSync(physical))
        )
          fail();
        const entry = { path, kind: "symlink" as const, target };
        if (!omit?.(entry)) entries.push(entry);
      } else if (stat.isDirectory()) {
        const entry = { path, kind: "directory" as const };
        if (!omit?.(entry)) entries.push(entry);
        walk(physical, path + "/");
      } else {
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (total += stat.size) > maxBytes
        )
          fail();
        if (omit?.({ path, kind: "file", size: stat.size, sha256: "" }))
          continue;
        const bytes = readFileSync(physical);
        if (bytes.length !== stat.size) fail();
        entries.push({
          path,
          kind: "file",
          size: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
  }
  walk(root, "");
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
}
function runtime(checkpoint: OperatorRecoveryCheckpoint): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  if (
    process.version !== checkpoint.runtime.node ||
    (process.versions.icu ?? "") !== checkpoint.runtime.icu ||
    sha256(regular(process.execPath)) !== checkpoint.runtime.executableSha256 ||
    compiledEtlDigest(root, "worker") !== checkpoint.runtime.workerSha256 ||
    sha256(regular(join(root, "package-lock.json"))) !==
      checkpoint.runtime.lockfileSha256 ||
    sha256(regular(join(root, "package.json"))) !==
      checkpoint.files.find(
        (file) => file.area === "checkout" && file.path === "package.json"
      )?.sha256
  )
    fail("RECOVERY_RUNTIME_MISMATCH");
}
function authenticate(input: RecoveryRuntimeInput) {
  const { checkpoint } = verifyOperatorRetirementEvidence(input);
  if (checkpoint.version !== 2 || !checkpoint.runtime.bootstrapNpm)
    fail("RECOVERY_BOOTSTRAP_NPM_REQUIRED");
  runtime(checkpoint);
  const npmCli = verifyNpmExecutionTool(
    checkpoint.runtime.bootstrapNpm,
    resolve(input.npmCli)
  );
  const root = resolve(input.destination);
  if (resolvePrivateCandidateDirectory(root) !== root) fail();
  return { checkpoint, npmCli, root };
}
function signature(payload: unknown, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
}
function report(
  checkpoint: OperatorRecoveryCheckpoint,
  entries: RecoveryRuntimeEntry[]
): PreparedRecoveryRuntimeReport {
  return {
    status: "prepared",
    activationAllowed: false,
    checkpointSha256: sha256(canonicalJson(checkpoint)),
    ledgerRevision: checkpoint.ledgerRevision,
    treeSha256: sha256(canonicalJson(entries)),
    entryCount: entries.length,
    workerProbe: "quarantine-enforced",
  };
}
function payload(
  input: RecoveryRuntimeInput,
  checkpoint: OperatorRecoveryCheckpoint,
  root: string,
  entries: RecoveryRuntimeEntry[]
) {
  return {
    kind,
    version: 1,
    archiveSha256: sha256(input.archive),
    retirementSha256: sha256(input.retirementReceipt),
    physicalRoot: root,
    physicalNpmCli: resolve(input.npmCli),
    npmIdentitySha256: checkpoint.runtime.bootstrapNpm!.identitySha256,
    ...report(checkpoint, entries),
  };
}
/** Verify a completed preparation without executing npm, a worker, or SQL. */
export function verifyPreparedOperatorRuntime(
  input: RecoveryRuntimeInput
): PreparedRecoveryRuntimeReport {
  const opened = openPreparedRuntimeForAdmission(input),
    entries = opened.inventory();
  same(sha256(canonicalJson(entries)), opened.report.treeSha256);
  same(entries.length, opened.report.entryCount);
  same(entries, opened.inventory());
  opened.assertRuntime();
  return opened.report;
}

/**
 * Authenticate preparation provenance independently of its now potentially
 * mutable tree. Only an admission coordinator may decide which changes are legal.
 * This interface grants no execution or writer authority.
 */
export function openPreparedRuntimeForAdmission(input: RecoveryRuntimeInput) {
  const { checkpoint, root } = authenticate(input);
  const bytes = regular(join(root, receiptName), 16 * 1024),
    value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const { signature: savedSignature, ...savedPayload } = value as Record<
    string,
    unknown
  >;
  if (
    typeof savedSignature !== "string" ||
    !/^[a-f0-9]{64}$/.test(savedSignature)
  )
    fail();
  const expectedSignature = signature(savedPayload, input.recoveryKey);
  if (
    !timingSafeEqual(
      Buffer.from(savedSignature, "hex"),
      Buffer.from(expectedSignature, "hex")
    )
  )
    fail();
  if (
    typeof savedPayload.treeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(savedPayload.treeSha256) ||
    typeof savedPayload.entryCount !== "number" ||
    !Number.isSafeInteger(savedPayload.entryCount) ||
    savedPayload.entryCount < 0 ||
    savedPayload.entryCount > 50_000
  )
    fail();
  same(savedPayload, {
    ...payload(input, checkpoint, root, []),
    treeSha256: savedPayload.treeSha256,
    entryCount: savedPayload.entryCount,
  });
  const preparedReport: PreparedRecoveryRuntimeReport = {
    ...report(checkpoint, []),
    treeSha256: savedPayload.treeSha256,
    entryCount: savedPayload.entryCount,
  };
  const assertReceipt = () =>
    same(
      bytes.toString("base64"),
      regular(join(root, receiptName), 16 * 1024).toString("base64")
    );
  assertReceipt();
  return {
    checkpoint: structuredClone(checkpoint),
    receiptSha256: sha256(bytes),
    report: preparedReport,
    inventory: () => {
      assertReceipt();
      return inventory(root);
    },
    /** Active SQLite bytes are governed by transactions, never read as flat files. */
    inventoryImmutable: (omit: (entry: RecoveryRuntimeEntry) => boolean) => {
      assertReceipt();
      return inventory(root, omit);
    },
    assertRuntime: () => {
      authenticate(input);
      assertReceipt();
    },
  };
}
function environment(root: string): NodeJS.ProcessEnv {
  const bootstrap = join(root, "bootstrap"),
    env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC"])
    if (process.env[name]) env[name] = process.env[name];
  return {
    ...env,
    PATH: dirname(process.execPath),
    HOME: join(bootstrap, "home"),
    USERPROFILE: join(bootstrap, "home"),
    TMP: join(bootstrap, "tmp"),
    TEMP: join(bootstrap, "tmp"),
    TMPDIR: join(bootstrap, "tmp"),
    npm_config_userconfig: join(bootstrap, "user.npmrc"),
    npm_config_globalconfig: join(bootstrap, "global.npmrc"),
    npm_config_cache: join(bootstrap, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_ignore_scripts: "true",
    ZIVV_LEDGER_HOME: join(root, "operator"),
  };
}
async function child(args: string[], root: string): Promise<string> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(root, "bootstrap/module-boundary.mjs")).href,
        ...args,
      ],
      {
        cwd: join(root, "checkout"),
        env: environment(root),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
      }
    );
    let output = "",
      bytes = 0,
      stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      // Never await 'close' for a deadline: descendants may retain the pipes.
      // POSIX children own a process group; Windows forcibly stops the root.
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(new Error("RECOVERY_RUNTIME_CHILD_FAILED"));
    };
    const timer = setTimeout(stop, 10 * 60 * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 24 * 1024) stop();
      else output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 24 * 1024) stop();
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("RECOVERY_RUNTIME_CHILD_FAILED"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || stopped)
        reject(new Error("RECOVERY_RUNTIME_CHILD_FAILED"));
      else resolveChild(output);
    });
  });
}

/** Install and probe retained runtime in a new private quarantine. No admission. */
export async function prepareOperatorRecoveryRuntime(
  input: RecoveryRuntimeInput
): Promise<PreparedRecoveryRuntimeReport> {
  // Copy caller buffers before awaiting any external work.
  input = {
    ...input,
    archive: Buffer.from(input.archive),
    retirementReceipt: Buffer.from(input.retirementReceipt),
    recoveryKey: Buffer.from(input.recoveryKey),
  };
  const { checkpoint, npmCli, root } = authenticate(input);
  if (existsSync(root)) return verifyPreparedOperatorRuntime(input);
  await stageOperatorRecovery(checkpoint, root, input.recoveryKey);
  const inspected = inspectOperatorRecoveryLocations({
    archive: input.archive,
    recoveryKey: input.recoveryKey,
    stagingRoot: root,
  }).report;
  for (const [name, matches] of Object.entries(inspected.runtime))
    if (name !== "npmIdentity" && matches !== true)
      fail("RECOVERY_RUNTIME_MISMATCH");
  let baseline = inventory(root);
  const unchanged = () => {
    runtime(checkpoint);
    verifyNpmExecutionTool(checkpoint.runtime.bootstrapNpm!, npmCli);
    const current = inventory(root),
      originalPaths = new Set(baseline.map((entry) => entry.path));
    same(
      current.filter((entry) => originalPaths.has(entry.path)),
      baseline
    );
    for (const entry of current)
      if (
        !originalPaths.has(entry.path) &&
        entry.path !== "bootstrap" &&
        !entry.path.startsWith("bootstrap/") &&
        entry.path !== "checkout/node_modules" &&
        !entry.path.startsWith("checkout/node_modules/")
      )
        fail();
    return current;
  };
  for (const path of ["bootstrap/home", "bootstrap/tmp", "bootstrap/npm-cache"])
    mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  for (const path of ["bootstrap/user.npmrc", "bootstrap/global.npmrc"])
    writeFileSync(join(root, path), "", { flag: "wx", mode: 0o600 });
  // A successful import must not borrow code from an ancestor installation.
  // Synchronous hooks cover both ESM imports and CommonJS require resolution.
  writeFileSync(
    join(root, "bootstrap/module-boundary.mjs"),
    `
    import { registerHooks } from 'node:module';
    import { realpathSync } from 'node:fs';
    import { isAbsolute, relative } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const roots = ${JSON.stringify([join(root, "checkout"), dirname(dirname(npmCli))])};
    registerHooks({resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if(result.url.startsWith('node:')) return result;
      if(!result.url.startsWith('file:')) throw Error('RECOVERY_MODULE_OUTSIDE_RUNTIME');
      const path = realpathSync(fileURLToPath(result.url));
      if(!roots.some(root => {
        const suffix = relative(root,path);
        return suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\\\') && !isAbsolute(suffix);
      })) throw Error('RECOVERY_MODULE_OUTSIDE_RUNTIME');
      return result;
    }});
  `,
    { flag: "wx", mode: 0o600 }
  );
  unchanged();
  // Bind the controlled loader and empty configurations before the first child.
  baseline = inventory(root);
  const version = await child([npmCli, "--version"], root);
  unchanged();
  if (version.trim() !== checkpoint.runtime.bootstrapNpm!.version)
    fail("RECOVERY_NPM_VERSION_MISMATCH");
  await child(
    [npmCli, "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
    root
  );
  unchanged();
  const worker = pathToFileURL(
    join(root, "checkout/dist/lib/ingestion/weekly-import-runner.js")
  ).href;
  const probe = await child(
    [
      "--input-type=module",
      "--eval",
      `
    const { runWeeklyImport } = await import(${JSON.stringify(worker)});
    try {
      await runWeeklyImport({root:process.cwd(),runId:"recovery-probe",stopAfter:"load"});
      process.exitCode = 1;
    } catch (error) {
      if (error?.message !== "RECOVERY_INSTALLATION_NOT_ACTIVATED") process.exitCode = 1;
      else console.log("quarantine-enforced");
    }
  `,
    ],
    root
  );
  if (probe.trim() !== "quarantine-enforced")
    fail("RECOVERY_RUNTIME_PROBE_FAILED");
  const entries = unchanged(),
    savedPayload = payload(input, checkpoint, root, entries),
    bytes = Buffer.from(
      canonicalJson({
        ...savedPayload,
        signature: signature(savedPayload, input.recoveryKey),
      }) + "\n"
    );
  const fd = openSync(join(root, receiptName), "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return verifyPreparedOperatorRuntime(input);
}
