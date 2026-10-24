import {
  assertNoRecoveredGmailCapture,
  assertRecoveredGmailCaptureFile,
  assertRecoveredGmailCaptureKey,
  assertRecoveredGmailCaptureRepair,
  observeRecoveredGmailCaptureFileCheckpoint,
  isRecoveryGmailCaptureTestInterruption,
} from "./recovery-gmail-capture-admission.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  closeSync,
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  readdirSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { IngestionLedger } from "../../types/ingestion.js";
import { validateLedger } from "./ledger.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  withStoreTransaction,
} from "./sqlite-store.js";
import { projectLedgerLocation } from "./store-location.js";

const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const FORMAT = "zivv-ledger-backup";

/** Authenticated encryption of a complete, canonical logical ledger snapshot. */
export function encryptLedgerSnapshot(
  ledger: IngestionLedger,
  key: Buffer
): Buffer {
  validateLedger(ledger);
  if (key.length !== 32)
    throw new Error("Backup key must contain exactly 32 random bytes.");
  const header = {
    format: FORMAT,
    version: 1,
    cipher: "aes-256-gcm",
    compression: "gzip",
    keyId: createHash("sha256").update(key).digest("hex"),
  };
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonicalJson(header)));
  const clear = Buffer.from(
    canonicalJson({ schemaVersion: 1, digest: ledgerDigest(ledger), ledger })
  );
  const compressed = gzipSync(clear);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.from(
    canonicalJson({
      ...header,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }) + "\n"
  );
}

/** Reject the wrong key, modified headers/payloads and invalid ledger snapshots. */
export function decryptLedgerSnapshot(
  bytes: Buffer,
  key: Buffer
): IngestionLedger {
  if (key.length !== 32 || bytes.length > MAX_SNAPSHOT_BYTES)
    throw new Error("Invalid backup key or oversized snapshot.");
  const envelope: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof envelope !== "object" || envelope === null)
    throw new Error("Invalid encrypted snapshot.");
  const value = envelope as Record<string, unknown>;
  const { format, version, cipher, compression, keyId } = value;
  if (
    format !== FORMAT ||
    version !== 1 ||
    cipher !== "aes-256-gcm" ||
    compression !== "gzip" ||
    keyId !== createHash("sha256").update(key).digest("hex")
  )
    throw new Error("Unsupported snapshot format or wrong recovery key.");
  for (const field of ["nonce", "tag", "ciphertext"])
    if (typeof value[field] !== "string")
      throw new Error(`Invalid snapshot ${field}.`);
  const nonce = Buffer.from(value.nonce as string, "base64");
  const tag = Buffer.from(value.tag as string, "base64");
  if (nonce.length !== 12 || tag.length !== 16)
    throw new Error("Invalid snapshot authentication parameters.");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(
    Buffer.from(canonicalJson({ format, version, cipher, compression, keyId }))
  );
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext as string, "base64")),
    decipher.final(),
  ]);
  const clear: unknown = JSON.parse(
    gunzipSync(compressed, { maxOutputLength: MAX_SNAPSHOT_BYTES }).toString(
      "utf8"
    )
  );
  if (
    typeof clear !== "object" ||
    clear === null ||
    !("schemaVersion" in clear) ||
    clear.schemaVersion !== 1 ||
    !("ledger" in clear) ||
    !("digest" in clear)
  )
    throw new Error("Invalid decrypted snapshot schema.");
  validateLedger(clear.ledger);
  if (ledgerDigest(clear.ledger) !== clear.digest)
    throw new Error("Snapshot content checksum mismatch.");
  return clear.ledger;
}

/** Flush a private/operator artifact before an atomic same-directory replacement. */
export function writeDurableFile(path: string, bytes: Buffer): void {
  assertRecoveredGmailCaptureFile(path, bytes);
  assertRecoveredGmailCaptureFile(dirname(path), undefined, "directory");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  assertRecoveredGmailCaptureFile(temporary, bytes);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      assertRecoveredGmailCaptureFile(temporary, bytes);
      writeFileSync(fd, bytes);
      assertRecoveredGmailCaptureFile(temporary, bytes, "install");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    observeRecoveredGmailCaptureFileCheckpoint(path, "flushed");
    assertRecoveredGmailCaptureFile(path, bytes);
    assertRecoveredGmailCaptureFile(temporary, bytes, "install");
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    observeRecoveredGmailCaptureFileCheckpoint(path, "published");
  } catch (error) {
    if (
      existsSync(temporary) &&
      !isRecoveryGmailCaptureTestInterruption(error)
    ) {
      assertRecoveredGmailCaptureFile(temporary, bytes, "unlink");
      unlinkSync(temporary);
    }
    throw error;
  }
}

/** Refresh this checkout's encrypted snapshot from the latest committed shared revision. */
export async function synchronizeEncryptedSnapshot(
  root: string
): Promise<void> {
  assertNoRecoveredGmailCapture();
  const location = projectLedgerLocation(root);
  if (location.backend !== "sqlite") return;
  const key = loadBackupKey(location.directory);
  await withStoreTransaction(location.path, async () => {
    const ledger = readSqliteLedger(location.path);
    validateLedger(ledger);
    const path = join(
      root,
      "data",
      "ingestion",
      "backups",
      "ledger.snapshot.enc"
    );
    if (
      existsSync(path) &&
      ledgerDigest(decryptLedgerSnapshot(readFileSync(path), key)) ===
        ledgerDigest(ledger)
    )
      return;
    const bytes = encryptLedgerSnapshot(ledger, key);
    if (
      ledgerDigest(decryptLedgerSnapshot(bytes, key)) !== ledgerDigest(ledger)
    )
      throw new Error("Encrypted backup validation failed.");
    writeDurableFile(path, bytes);
  });
}

function protectForWindows(bytes: Buffer, unprotect = false): Buffer {
  // Secrets travel through stdin, never through command arguments or logs.
  const operation = unprotect ? "Unprotect" : "Protect";
  const script = `$ErrorActionPreference='Stop'; $null=[Reflection.Assembly]::LoadWithPartialName('System.Security'); $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[System.Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: bytes.toString("base64"), encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0)
    throw new Error(
      "Windows could not protect/unprotect the backup key for this user."
    );
  return Buffer.from(result.stdout.trim(), "base64");
}

/** Authenticate existing DPAPI/plaintext bytes without installing or changing them. */
export function validateRecoveredBackupKeyBytes(
  bytes: Buffer,
  expected: Buffer
): void {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > 16 * 1024 ||
    !Buffer.isBuffer(expected) ||
    expected.length !== 32
  )
    throw Error("RECOVERY_IMPORT_WORKING_KEY_MISMATCH");
  const clear =
    process.platform === "win32" ? protectForWindows(bytes, true) : bytes;
  if (!clear.equals(expected))
    throw Error("RECOVERY_IMPORT_WORKING_KEY_MISMATCH");
}

/** Install a fully flushed key exactly once, even when two operators initialize together. */
function installKeyOnce(
  path: string,
  bytes: Buffer,
  stagingDirectory = dirname(path)
): void {
  const temporary = join(
    stagingDirectory,
    `${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  writeDurableFile(temporary, bytes);
  let interrupted = false;
  try {
    assertRecoveredGmailCaptureFile(path, bytes);
    assertRecoveredGmailCaptureFile(temporary, bytes, "install");
    linkSync(temporary, path);
    flushRecoveryDirectory(dirname(path));
    observeRecoveredGmailCaptureFileCheckpoint(path, "linked");
  } catch (error) {
    interrupted = isRecoveryGmailCaptureTestInterruption(error);
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  } finally {
    if (!interrupted) {
      assertRecoveredGmailCaptureFile(temporary, bytes, "unlink");
      unlinkSync(temporary);
    }
  }
  if (process.platform !== "win32") {
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

export interface RecoveryInstallationFile {
  path: string;
  bytes: Buffer;
  dev: number;
  ino: number;
  nlink: number;
}
export interface RecoveryInstallationObservation {
  target: RecoveryInstallationFile | null;
  candidate: RecoveryInstallationFile | null;
}
function assertRecoveryStagingAncestry(directory: string): void {
  for (let parent = resolve(directory); ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git")))
      throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
    let stat;
    try {
      stat = lstatSync(parent);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
    if (dirname(parent) === parent) break;
  }
}
function flushRecoveryDirectory(directory: string): void {
  if (process.platform === "win32") return;
  assertRecoveredGmailCaptureFile(directory, undefined, "directory");
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Read bounded exact-target installation evidence only. Other target families in
 * a shared staging directory remain untouched; this report grants no authority. */
export function inspectRecoveryInstalledFile(
  path: string,
  stagingDirectory: string,
  limit = 16 * 1024 * 1024
): RecoveryInstallationObservation {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024)
    throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
  const target = resolve(path),
    directory = resolve(stagingDirectory);
  assertRecoveryStagingAncestry(dirname(target));
  assertRecoveryStagingAncestry(directory);
  for (const root of [dirname(target), directory])
    for (let parent = root; ; parent = dirname(parent)) {
      let stat;
      try {
        stat = lstatSync(parent);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
      if (dirname(parent) === parent) break;
    }
  const read = (path: string): RecoveryInstallationFile | null => {
    let before;
    try {
      before = lstatSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink < 1 ||
      before.nlink > 2 ||
      before.size > limit
    )
      throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
    const fd = openSync(path, "r");
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.nlink !== before.nlink
      )
        throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
      const bounded = Buffer.alloc(before.size + 1);
      let length = 0,
        count: number;
      while (
        length < bounded.length &&
        (count = readSync(fd, bounded, length, bounded.length - length, null)) >
          0
      )
        length += count;
      if (length !== before.size)
        throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
      bytes = Buffer.from(bounded.subarray(0, length));
      const after = fstatSync(fd);
      if (after.size !== before.size || after.nlink !== before.nlink)
        throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
    } finally {
      closeSync(fd);
    }
    const after = lstatSync(path);
    if (
      bytes.length !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.isSymbolicLink()
    )
      throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
    return {
      path,
      bytes,
      dev: before.dev,
      ino: before.ino,
      nlink: before.nlink,
    };
  };
  let candidate: RecoveryInstallationFile | null = null;
  if (existsSync(directory)) {
    const names = readdirSync(directory);
    if (names.length > 1000) throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
    for (const name of names) {
      const prefix = basename(target) + ".";
      if (!name.startsWith(prefix)) continue;
      if (
        !/^\d+\.[a-f0-9]{16}\.tmp(?:\.\d+\.[a-f0-9]{16}\.tmp)?$/.test(
          name.slice(prefix.length)
        ) ||
        candidate
      )
        throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
      candidate = read(join(directory, name));
      if (!candidate) throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
    }
  }
  const installed = read(target);
  if (installed && candidate && !installed.bytes.equals(candidate.bytes))
    throw Error("RECOVERY_INSTALLATION_FILE_CONFLICT");
  if (installed?.nlink === 2 || candidate?.nlink === 2) {
    if (
      !installed ||
      !candidate ||
      installed.nlink !== 2 ||
      candidate.nlink !== 2 ||
      installed.dev !== candidate.dev ||
      installed.ino !== candidate.ino
    )
      throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
  }
  return { target: installed, candidate };
}

/** Validate and unlink only this installer's private orphan links after a crash. */
export function readRecoveryInstalledFile(
  path: string,
  stagingDirectory: string,
  validate: (bytes: Buffer) => void
): Buffer {
  const target = resolve(path),
    directory = resolve(stagingDirectory);
  let observed = inspectRecoveryInstalledFile(target, directory);
  const value = observed.target ?? observed.candidate;
  if (!value) throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
  validate(value.bytes);
  if (observed.target) validate(observed.target.bytes);
  if (observed.candidate) validate(observed.candidate.bytes);
  const bytes = Buffer.from(value.bytes);
  if (observed.target && !observed.candidate) return bytes;
  // Authentication precedes ACL changes, writable handles and adoption.
  if (observed.candidate) {
    secureOperatorDirectory(dirname(target));
    secureRecoveryStagingDirectory(directory);
  }
  const flush = (file: RecoveryInstallationFile, stage: boolean) => {
    assertRecoveredGmailCaptureFile(
      file.path,
      bytes,
      stage ? "install" : "write"
    );
    const fd = openSync(file.path, "r+");
    try {
      const stat = fstatSync(fd),
        named = lstatSync(file.path);
      if (
        stat.dev !== file.dev ||
        stat.ino !== file.ino ||
        stat.size !== bytes.length ||
        stat.nlink !== file.nlink ||
        named.dev !== stat.dev ||
        named.ino !== stat.ino ||
        named.isSymbolicLink()
      )
        throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
      const bounded = Buffer.alloc(bytes.length + 1);
      let length = 0,
        count: number;
      while (
        length < bounded.length &&
        (count = readSync(fd, bounded, length, bounded.length - length, null)) >
          0
      )
        length += count;
      if (length !== bytes.length || !bounded.subarray(0, length).equals(bytes))
        throw Error("RECOVERY_INSTALLATION_FILE_CONFLICT");
      assertRecoveredGmailCaptureFile(
        file.path,
        bytes,
        stage ? "install" : "write"
      );
      const before = fstatSync(fd),
        current = lstatSync(file.path);
      if (
        before.dev !== stat.dev ||
        before.ino !== stat.ino ||
        before.size !== bytes.length ||
        before.nlink !== stat.nlink ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.isSymbolicLink()
      )
        throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  if (!observed.target) {
    const stage = observed.candidate!;
    flush(stage, true);
    assertRecoveredGmailCaptureFile(target, bytes);
    assertRecoveredGmailCaptureFile(stage.path, bytes, "install");
    try {
      linkSync(stage.path, target);
      flushRecoveryDirectory(dirname(target));
      observeRecoveredGmailCaptureFileCheckpoint(target, "linked");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    observed = inspectRecoveryInstalledFile(target, directory);
    if (!observed.target || !observed.target.bytes.equals(bytes))
      throw Error("RECOVERY_INSTALLATION_FILE_CONFLICT");
    validate(observed.target.bytes);
  }
  flush(observed.target!, false);
  flushRecoveryDirectory(dirname(target));
  if (observed.candidate) {
    const stage = observed.candidate;
    const current = inspectRecoveryInstalledFile(target, directory);
    if (
      !current.target ||
      !current.target.bytes.equals(bytes) ||
      !current.candidate ||
      current.candidate.dev !== stage.dev ||
      current.candidate.ino !== stage.ino ||
      !current.candidate.bytes.equals(bytes)
    )
      throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
    assertRecoveredGmailCaptureFile(stage.path, bytes, "unlink");
    unlinkSync(stage.path);
    flushRecoveryDirectory(directory);
  }
  const complete = inspectRecoveryInstalledFile(target, directory);
  if (
    !complete.target ||
    complete.candidate ||
    complete.target.nlink !== 1 ||
    !complete.target.bytes.equals(bytes)
  )
    throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
  return bytes;
}

/** Publish only complete flushed intent bytes, without replacing an existing intent. */
export function installRecoveryIntent(
  path: string,
  bytes: Buffer,
  stagingDirectory: string
): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024)
    throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
  const validate = (current: Buffer) => {
    if (!current.equals(bytes))
      throw Error("RECOVERY_INSTALLATION_FILE_CONFLICT");
  };
  const observed = inspectRecoveryInstalledFile(path, stagingDirectory);
  if (observed.target) validate(observed.target.bytes);
  if (observed.candidate) validate(observed.candidate.bytes);
  if (!observed.target && !observed.candidate) {
    secureRecoveryStagingDirectory(stagingDirectory);
    installKeyOnce(path, bytes, stagingDirectory);
  }
  return readRecoveryInstalledFile(path, stagingDirectory, validate);
}

/** Only the closed capture coordinator can request this exact intake repair. */
export function repairRecoveredGmailCaptureFile(
  path: string,
  bytes: Buffer
): void {
  assertRecoveredGmailCaptureRepair(path, bytes);
  const observed = inspectRecoveryInstalledFile(
    path,
    dirname(path),
    8 * 1024 * 1024
  );
  if (
    observed.candidate &&
    !/^\d+\.[a-f0-9]{16}\.tmp$/.test(
      observed.candidate.path.slice(resolve(path).length + 1)
    )
  )
    throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
  if (
    (observed.target && !observed.target.bytes.equals(bytes)) ||
    (observed.candidate && !observed.candidate.bytes.equals(bytes))
  )
    throw Error("RECOVERY_INSTALLATION_FILE_CONFLICT");
  if (observed.candidate)
    readRecoveryInstalledFile(path, dirname(path), (value) => {
      if (!value.equals(bytes))
        throw Error("RECOVERY_INSTALLATION_FILE_CONFLICT");
    });
}

function secureRecoveryStagingDirectory(directory: string): void {
  for (let parent = resolve(directory); ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git")))
      throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
    if (existsSync(parent)) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error("UNSAFE_RECOVERY_INSTALLATION_FILE");
    }
    if (dirname(parent) === parent) break;
  }
  secureOperatorDirectory(directory);
}

/** Restrict the permanent operator directory before putting private artifacts in it. */
export function secureOperatorDirectory(directory: string): void {
  assertRecoveredGmailCaptureFile(directory, undefined, "directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(directory, 0o700);
    return;
  }
  const script =
    "$ErrorActionPreference='Stop'; $path=$env:ZIVV_SECURE_DIRECTORY; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($path,$acl)";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, ZIVV_SECURE_DIRECTORY: directory },
      encoding: "utf8",
      windowsHide: true,
    }
  );
  if (result.status !== 0)
    throw new Error(
      `Could not restrict the operator directory permissions: ${result.error?.message || result.stderr.trim()}`
    );
}

/** Generate once; Windows keeps the working key encrypted under the current user's DPAPI. */
export function loadBackupKey(directory: string, create = false): Buffer {
  assertRecoveredGmailCaptureKey(directory);
  const path = join(
    directory,
    process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
  );
  if (!existsSync(path)) {
    assertNoRecoveredGmailCapture();
    if (!create)
      throw new Error(
        "Backup key missing. Import the separately saved recovery key; never generate a replacement to decrypt an existing snapshot."
      );
    secureOperatorDirectory(directory);
    const key = randomBytes(32);
    installKeyOnce(
      path,
      process.platform === "win32" ? protectForWindows(key) : key
    );
  }
  const bytes = readFileSync(path);
  const key =
    process.platform === "win32" ? protectForWindows(bytes, true) : bytes;
  if (key.length !== 32) throw new Error("Invalid stored backup key.");
  return key;
}

/** Export a portable recovery key to a private path outside all Git checkouts. */
export function exportRecoveryKey(
  directory: string,
  destination: string
): void {
  assertNoRecoveredGmailCapture();
  let ancestor = resolve(dirname(destination));
  while (true) {
    if (existsSync(join(ancestor, ".git")))
      throw new Error(
        "Recovery keys cannot be exported inside a Git checkout."
      );
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (existsSync(destination))
    throw new Error("Recovery key destination already exists.");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  installKeyOnce(
    destination,
    Buffer.from(loadBackupKey(directory).toString("base64") + "\n")
  );
  if (process.platform === "win32") {
    const script =
      "$ErrorActionPreference='Stop'; $acl=New-Object System.Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true,$false); $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow'); $acl.AddAccessRule($rule); [IO.File]::SetAccessControl($env:ZIVV_RECOVERY_FILE,$acl)";
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...process.env, ZIVV_RECOVERY_FILE: destination },
        encoding: "utf8",
        windowsHide: true,
      }
    );
    if (result.status !== 0) {
      unlinkSync(destination);
      throw new Error("Could not protect the exported recovery key.");
    }
  }
}

/** Install a portable key without ever overwriting an existing operator key. */
export function importRecoveryKey(directory: string, source: string): void {
  assertNoRecoveredGmailCapture();
  const destination = join(
    directory,
    process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
  );
  if (existsSync(destination))
    throw new Error(
      "A backup key already exists; preserve it before recovering another installation."
    );
  installRecoveredBackupKey(
    directory,
    Buffer.from(readFileSync(source, "utf8").trim(), "base64")
  );
}

/** Install an authenticated recovery key exclusively, including racing installers. */
export function installRecoveredBackupKey(
  directory: string,
  suppliedKey: Buffer,
  options?: { stagingDirectory: string }
): void {
  assertRecoveredGmailCaptureKey(directory, suppliedKey);
  if (!Buffer.isBuffer(suppliedKey) || suppliedKey.length !== 32)
    throw new Error("Invalid recovery key file.");
  const key = Buffer.from(suppliedKey);
  const destination = join(
    directory,
    process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
  );
  if (existsSync(destination) && !options)
    throw new Error(
      "A backup key already exists; preserve it before recovering another installation."
    );
  if (key.length !== 32) throw new Error("Invalid recovery key file.");
  const stagingDirectory = options?.stagingDirectory ?? directory;
  const observed = inspectRecoveryInstalledFile(
    destination,
    stagingDirectory,
    16 * 1024
  );
  if (observed.target)
    validateRecoveredBackupKeyBytes(observed.target.bytes, key);
  if (observed.candidate)
    validateRecoveredBackupKeyBytes(observed.candidate.bytes, key);
  if (!observed.target && !observed.candidate) {
    secureOperatorDirectory(directory);
    secureRecoveryStagingDirectory(stagingDirectory);
    installKeyOnce(
      destination,
      process.platform === "win32" ? protectForWindows(key) : key,
      stagingDirectory
    );
  }
  readRecoveryInstalledFile(destination, stagingDirectory, (bytes) => {
    const installed =
      process.platform === "win32" ? protectForWindows(bytes, true) : bytes;
    if (!installed.equals(key))
      throw Error("RECOVERY_IMPORT_WORKING_KEY_MISMATCH");
  });
}
