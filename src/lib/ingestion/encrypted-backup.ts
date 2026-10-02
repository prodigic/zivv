import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

/** Refresh this checkout's encrypted snapshot from the latest committed shared revision. */
export async function synchronizeEncryptedSnapshot(
  root: string
): Promise<void> {
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

/** Install a fully flushed key exactly once, even when two operators initialize together. */
function installKeyOnce(path: string, bytes: Buffer): void {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeDurableFile(temporary, bytes);
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  } finally {
    unlinkSync(temporary);
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

/** Restrict the permanent operator directory before putting private artifacts in it. */
export function secureOperatorDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") return;
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
  const path = join(
    directory,
    process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
  );
  if (!existsSync(path)) {
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
  const destination = join(
    directory,
    process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
  );
  if (existsSync(destination))
    throw new Error(
      "A backup key already exists; preserve it before recovering another installation."
    );
  const key = Buffer.from(readFileSync(source, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error("Invalid recovery key file.");
  secureOperatorDirectory(directory);
  writeDurableFile(
    destination,
    process.platform === "win32" ? protectForWindows(key) : key
  );
}
