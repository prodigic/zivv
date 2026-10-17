import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";

const markerName = "operator-retired.json";
const kind = "zivv-operator-retirement" as const;
const scopes = new AsyncLocalStorage<{
  directory: string;
  active: boolean;
  permitted?: Buffer;
}>();
const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export interface OperatorRetirementInput {
  readonly checkpointSha256: string;
  readonly archiveSha256: string;
  readonly ledgerRevision: string;
  readonly originalOperatorDirectory: string;
  readonly installationId: string;
  readonly retiredAtEpochMs: number;
}
export interface OperatorRetirementReceipt extends OperatorRetirementInput {
  readonly schemaVersion: 1;
  readonly kind: typeof kind;
  readonly signature: string;
}
function invalid(): never {
  throw new Error("INVALID_OPERATOR_RETIREMENT");
}
function canonicalLogicalDirectory(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > 4096)
    invalid();
  const flavor = /^[A-Za-z]:\\/.test(value) ? win32 : posix;
  if (
    !flavor.isAbsolute(value) ||
    flavor.resolve(value) !== value ||
    value.startsWith("\\\\") ||
    value.startsWith("//")
  )
    invalid();
  return value;
}
function physicalDirectory(value: string, required: boolean): string {
  if (
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.startsWith("\\\\") ||
    value.includes("\0")
  )
    throw new Error("INVALID_OPERATOR_INSTALLATION");
  let existing: string | undefined;
  for (let path = value; ; path = dirname(path)) {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("INVALID_OPERATOR_INSTALLATION");
      existing ??= path;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    if (dirname(path) === path) break;
  }
  if (
    !existing ||
    (required && (existing !== value || dirname(value) === value))
  )
    throw new Error("INVALID_OPERATOR_INSTALLATION");
  return resolve(realpathSync(existing), relative(existing, value));
}
function marker(directory: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(join(directory, markerName));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

/** Refuse every retirement marker, irrespective of its contents or authenticity. */
export function assertOperatorInstallationWritable(directory: string): void {
  const physical = physicalDirectory(directory, false),
    stat = marker(physical);
  if (!stat) return;
  const scope = scopes.getStore();
  if (
    scope?.active &&
    scope.directory === physical &&
    scope.permitted &&
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    stat.size === scope.permitted.length
  ) {
    const path = join(physical, markerName),
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.size !== scope.permitted.length
      )
        throw new Error("OPERATOR_INSTALLATION_RETIRED");
      const bytes = Buffer.alloc(scope.permitted.length + 1);
      let length = 0,
        count: number;
      while (
        length < bytes.length &&
        (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0
      )
        length += count;
      const current = lstatSync(path),
        after = fstatSync(fd);
      if (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.nlink === 1 &&
        current.dev === opened.dev &&
        current.ino === opened.ino &&
        after.size === scope.permitted.length &&
        bytes.subarray(0, length).equals(scope.permitted)
      )
        return;
    } finally {
      closeSync(fd);
    }
  }
  throw new Error("OPERATOR_INSTALLATION_RETIRED");
}

/**
 * Trusted retirement-coordinator cleanup authority, never an activation switch.
 * Async descendants of work inherit it; escaped work loses it when work settles.
 * This cooperative guard cannot fence malicious administrators or old binaries.
 */
export async function withOperatorRetirementScope<T>(
  directory: string,
  work: (permitOwnRetirement: (bytes: Buffer) => void) => Promise<T>
): Promise<T> {
  if (scopes.getStore()?.active) throw new Error("NESTED_OPERATOR_RETIREMENT");
  const physical = physicalDirectory(directory, true);
  for (let path = physical; ; path = dirname(path)) {
    if (existsSync(join(path, ".git")))
      throw new Error("INVALID_OPERATOR_INSTALLATION");
    if (dirname(path) === path) break;
  }
  assertOperatorInstallationWritable(physical);
  const scope: { directory: string; active: boolean; permitted?: Buffer } = {
    directory: physical,
    active: true,
  };
  const permitOwnRetirement = (bytes: Buffer) => {
    if (
      !scope.active ||
      scopes.getStore() !== scope ||
      scope.permitted ||
      marker(physical) ||
      !Buffer.isBuffer(bytes) ||
      bytes.length === 0 ||
      bytes.length > 16 * 1024
    )
      throw new Error("INVALID_OPERATOR_RETIREMENT_PERMISSION");
    scope.permitted = Buffer.from(bytes);
  };
  try {
    return await scopes.run(scope, () => work(permitOwnRetirement));
  } finally {
    scope.active = false;
  }
}

function fields(value: unknown, receipt: boolean): OperatorRetirementInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  const keys = [
    "checkpointSha256",
    "archiveSha256",
    "ledgerRevision",
    "originalOperatorDirectory",
    "installationId",
    "retiredAtEpochMs",
  ];
  if (receipt) keys.push("schemaVersion", "kind", "signature");
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(keys.sort()))
    invalid();
  for (const name of ["checkpointSha256", "archiveSha256", "ledgerRevision"])
    if (typeof raw[name] !== "string" || !hashPattern.test(raw[name] as string))
      invalid();
  if (
    typeof raw.installationId !== "string" ||
    !uuidPattern.test(raw.installationId) ||
    typeof raw.retiredAtEpochMs !== "number" ||
    !Number.isSafeInteger(raw.retiredAtEpochMs) ||
    raw.retiredAtEpochMs < 0
  )
    invalid();
  return {
    checkpointSha256: raw.checkpointSha256 as string,
    archiveSha256: raw.archiveSha256 as string,
    ledgerRevision: raw.ledgerRevision as string,
    originalOperatorDirectory: canonicalLogicalDirectory(
      raw.originalOperatorDirectory
    ),
    installationId: raw.installationId,
    retiredAtEpochMs: raw.retiredAtEpochMs,
  };
}
function signature(input: OperatorRetirementInput, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== 32) invalid();
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        kind,
        1,
        input.checkpointSha256,
        input.archiveSha256,
        input.ledgerRevision,
        input.originalOperatorDirectory,
        input.installationId,
        input.retiredAtEpochMs,
      ])
    )
    .digest("hex");
}
/** Sign final checkpoint/installation binding; this function performs no writes. */
export function createOperatorRetirementReceipt(
  input: OperatorRetirementInput,
  key: Buffer
): Buffer {
  const payload = fields(input, false);
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      kind,
      ...payload,
      signature: signature(payload, key),
    }) + "\n"
  );
}
/** Authenticate strict retirement evidence without requiring the original host. */
export function verifyOperatorRetirementReceipt(
  bytes: Buffer,
  key: Buffer
): OperatorRetirementReceipt {
  if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid();
  }
  const payload = fields(parsed, true),
    raw = parsed as Record<string, unknown>;
  if (
    raw.schemaVersion !== 1 ||
    raw.kind !== kind ||
    typeof raw.signature !== "string" ||
    !hashPattern.test(raw.signature)
  )
    invalid();
  const expected = signature(payload, key);
  if (
    !timingSafeEqual(
      Buffer.from(raw.signature, "hex"),
      Buffer.from(expected, "hex")
    )
  )
    invalid();
  return Object.freeze({
    schemaVersion: 1,
    kind,
    ...payload,
    signature: raw.signature,
  });
}
