import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { secureOperatorDirectory } from "./encrypted-backup.js";
import { GmailOAuthError } from "./gmail-oauth-refresh.js";
import { resolvePrivateCandidateDirectory } from "./private-artifacts.js";
import { assertNoRecoveredGmailCapture } from "./recovery-gmail-capture-admission.js";
import { assertNoSelectedGmailLoadExecution } from "./recovery-gmail-selected-load-executor.js";
import {
  protectForWindows,
  runWindowsPowerShell,
} from "./windows-current-user-protection.js";

interface Credentials {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

type RefreshCredentials = Credentials & {
  persistRefreshToken: (next: string) => Promise<void>;
};

const filename = "gmail-credentials.sqlite";
const table = `CREATE TABLE gmail_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  protected BLOB NOT NULL
) STRICT`;

function secret(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function validate(value: unknown): Credentials {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("GMAIL_AUTH_CONFIGURATION_REQUIRED");
  const entry = value as Record<string, unknown>;
  if (
    !secret(entry.clientId, 512) ||
    !secret(entry.refreshToken, 8192) ||
    (entry.clientSecret !== undefined && !secret(entry.clientSecret, 4096))
  )
    throw Error("GMAIL_AUTH_CONFIGURATION_REQUIRED");
  return {
    clientId: entry.clientId,
    ...(entry.clientSecret === undefined
      ? {}
      : { clientSecret: entry.clientSecret }),
    refreshToken: entry.refreshToken,
  };
}

function seal(credentials: Credentials): Buffer {
  const bytes = Buffer.from(JSON.stringify(credentials));
  try {
    return protectForWindows(bytes);
  } finally {
    bytes.fill(0);
  }
}

function unseal(bytes: Buffer): Credentials {
  const clear = protectForWindows(bytes, true);
  try {
    return validate(JSON.parse(clear.toString("utf8")) as unknown);
  } finally {
    clear.fill(0);
  }
}

function same(left: Credentials, right: Credentials): boolean {
  return (
    left.clientId === right.clientId &&
    left.clientSecret === right.clientSecret &&
    left.refreshToken === right.refreshToken
  );
}

function verifyPermissions(paths: string[], ownerOnly = false): void {
  const request = Buffer.from(JSON.stringify({ paths, ownerOnly })).toString(
    "base64"
  );
  const script = `
    $ErrorActionPreference = 'Stop'
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
    $request = ConvertFrom-Json -InputObject $json
    $sidType = [System.Security.Principal.SecurityIdentifier]
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($path in $request.paths) {
      $acl = if ([IO.Directory]::Exists($path)) {
        [IO.Directory]::GetAccessControl($path)
      } else {
        [IO.File]::GetAccessControl($path)
      }
      if (!$acl.GetOwner($sidType).Equals($sid)) { throw 'Owner mismatch' }
      if ($request.ownerOnly) { continue }
      $allowed = $false
      foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
        if (!$rule.IdentityReference.Equals($sid)) {
          if ($rule.AccessControlType -eq 'Allow') { throw 'Foreign grant' }
          continue
        }
        if ($rule.AccessControlType -eq 'Deny') { throw 'Owner deny' }
        $required = [System.Security.AccessControl.FileSystemRights]::Modify
        if (($rule.FileSystemRights -band $required) -eq $required) {
          $allowed = $true
        }
      }
      if (!$allowed) { throw 'Owner access missing' }
    }
  `;
  try {
    runWindowsPowerShell(script, request);
  } catch {
    throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
  }
}

function credentialPath(directory: string, create: boolean): string {
  assertNoRecoveredGmailCapture();
  assertNoSelectedGmailLoadExecution();
  const requested = resolve(directory);
  if (
    process.platform !== "win32" ||
    dirname(requested) === requested ||
    resolvePrivateCandidateDirectory(requested) !== requested
  )
    throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
  for (let ancestor = requested; ; ancestor = dirname(ancestor)) {
    if (
      ["operator-retired.json", "recovery-state.json"].some((name) =>
        lstatSync(join(ancestor, name), { throwIfNoEntry: false })
      )
    )
      throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
    if (dirname(ancestor) === ancestor) break;
  }
  const parent = lstatSync(requested, { throwIfNoEntry: false });
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink()))
    throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");

  const path = join(requested, filename);
  const names = parent ? readdirSync(requested) : [];
  for (const name of names) {
    if (name !== filename && name !== `${filename}-journal`)
      throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
    const stat = lstatSync(join(requested, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
  }
  if (!names.includes(filename)) {
    if (names.length) throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
    if (!create) throw Error("GMAIL_CREDENTIAL_NOT_PROVISIONED");
    if (parent) verifyPermissions([requested], true);
    secureOperatorDirectory(requested);
  }
  verifyPermissions([requested, ...names.map((name) => join(requested, name))]);
  return path;
}

function begin(database: DatabaseSync, create = false): void {
  database.exec(
    "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE"
  );
  const mode = database.prepare("PRAGMA journal_mode").get();
  if (mode?.journal_mode !== "delete")
    throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
  const rows = database
    .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name LIMIT 2")
    .all();
  if (create && rows.length === 0) {
    database.exec(table);
    return;
  }
  if (
    rows.length !== 1 ||
    rows[0]?.type !== "table" ||
    rows[0].name !== "gmail_credentials" ||
    rows[0].sql !== table
  )
    throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
}

function readProtected(database: DatabaseSync): Buffer | undefined {
  const row = database
    .prepare(
      "SELECT CASE WHEN length(protected) <= 65536 THEN protected END AS protected FROM gmail_credentials WHERE id = 1"
    )
    .get();
  if (row === undefined) return undefined;
  if (!(row.protected instanceof Uint8Array))
    throw Error("GMAIL_CREDENTIAL_STORAGE_FAILED");
  return Buffer.from(row.protected);
}

function storageFailed(error: unknown): never {
  if (error instanceof GmailOAuthError) throw error;
  if (error instanceof Error && "errcode" in error && error.errcode === 5)
    throw new GmailOAuthError("GMAIL_CREDENTIAL_STORAGE_BUSY");
  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "GMAIL_AUTH_CONFIGURATION_REQUIRED":
    case "GMAIL_CREDENTIAL_STORAGE_UNSAFE":
    case "GMAIL_CREDENTIAL_NOT_PROVISIONED":
    case "GMAIL_CREDENTIAL_ALREADY_PROVISIONED":
      throw new GmailOAuthError(code);
    default:
      throw new GmailOAuthError("GMAIL_CREDENTIAL_STORAGE_FAILED");
  }
}

/** Provision a dedicated, current-user Windows credential store. */
export function provisionWindowsGmailCredentials(
  directory: string,
  input: Credentials
): void {
  try {
    const credentials = validate(input);
    const path = credentialPath(directory, true);
    const database = new DatabaseSync(path);
    try {
      verifyPermissions([path]);
      begin(database, true);
      const stored = readProtected(database);
      if (!stored)
        database
          .prepare("INSERT INTO gmail_credentials VALUES (1, ?)")
          .run(seal(credentials));
      else if (!same(unseal(stored), credentials))
        throw Error("GMAIL_CREDENTIAL_ALREADY_PROVISIONED");
      database.exec("COMMIT");
    } finally {
      database.close();
    }
  } catch (error) {
    storageFailed(error);
  }
}

/** Hold an exclusive writer transaction across the OAuth refresh and rotation. */
export async function withWindowsGmailCredentials<T>(
  directory: string,
  refresh: (credentials: RefreshCredentials) => Promise<T>
): Promise<T> {
  try {
    const path = credentialPath(directory, false);
    const database = new DatabaseSync(path);
    try {
      begin(database);
      const stored = readProtected(database);
      if (!stored) throw Error("GMAIL_CREDENTIAL_NOT_PROVISIONED");
      const credentials = unseal(stored);
      let committed = false;
      const result = await refresh({
        ...credentials,
        async persistRefreshToken(refreshToken) {
          if (committed) throw Error("GMAIL_CREDENTIAL_STORAGE_FAILED");
          const updated = validate({ ...credentials, refreshToken });
          const sealed = seal(updated);
          database
            .prepare("UPDATE gmail_credentials SET protected = ? WHERE id = 1")
            .run(sealed);
          if (!readProtected(database)?.equals(sealed))
            throw Error("GMAIL_CREDENTIAL_STORAGE_FAILED");
          database.exec("COMMIT");
          committed = true;
        },
      });
      if (!committed) database.exec("COMMIT");
      return result;
    } finally {
      database.close();
    }
  } catch (error) {
    return storageFailed(error);
  }
}
