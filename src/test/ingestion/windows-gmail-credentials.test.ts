import { afterEach, describe, expect, it, vi } from "vitest";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GmailOAuthError } from "../../lib/ingestion/gmail-oauth-refresh.js";
import { runWindowsPowerShell } from "../../lib/ingestion/windows-current-user-protection.js";
import {
  provisionWindowsGmailCredentials,
  withWindowsGmailCredentials,
} from "../../lib/ingestion/windows-gmail-credentials.js";

const prefix = "zivv-gmail-credentials-test-";
const roots: string[] = [];
const credentials = {
  clientId: "synthetic-client-id-742b",
  clientSecret: "synthetic-client-secret-821c",
  refreshToken: "synthetic-refresh-token-931d",
};
const rotated = "synthetic-rotated-token-a42e";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function readCredentials(directory: string) {
  return withWindowsGmailCredentials(
    directory,
    async ({ clientId, clientSecret, refreshToken }) => ({
      clientId,
      clientSecret,
      refreshToken,
    })
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (
      dirname(absolute) !== resolve(tmpdir()) ||
      !basename(absolute).startsWith(prefix)
    )
      throw Error("UNSAFE_TEST_CLEANUP");
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "win32")(
  "Windows Gmail credentials",
  () => {
    it("round trips with current-user DPAPI without storing plaintext", async () => {
      const directory = fixture();
      provisionWindowsGmailCredentials(directory, credentials);
      expect(await readCredentials(directory)).toEqual(credentials);
      const bytes = readFileSync(join(directory, "gmail-credentials.sqlite"));
      for (const value of Object.values(credentials)) {
        expect(bytes.includes(Buffer.from(value, "utf8"))).toBe(false);
        expect(bytes.includes(Buffer.from(value, "utf16le"))).toBe(false);
      }
    });

    it("allows identical provisioning but refuses replacement", async () => {
      const directory = fixture();
      provisionWindowsGmailCredentials(directory, credentials);
      provisionWindowsGmailCredentials(directory, { ...credentials });
      expect(() =>
        provisionWindowsGmailCredentials(directory, {
          ...credentials,
          refreshToken: rotated,
        })
      ).toThrow("GMAIL_CREDENTIAL_ALREADY_PROVISIONED");
      expect(await readCredentials(directory)).toEqual(credentials);
    });

    it("commits the rotation even if the new access token expires afterward", async () => {
      const directory = fixture();
      provisionWindowsGmailCredentials(directory, credentials);
      await expect(
        withWindowsGmailCredentials(
          directory,
          async ({ persistRefreshToken }) => {
            await persistRefreshToken(rotated);
            throw new GmailOAuthError("GMAIL_TOKEN_EXPIRED_DURING_REFRESH");
          }
        )
      ).rejects.toThrow("GMAIL_TOKEN_EXPIRED_DURING_REFRESH");
      expect((await readCredentials(directory)).refreshToken).toBe(rotated);
      const bytes = readFileSync(join(directory, "gmail-credentials.sqlite"));
      expect(bytes.includes(Buffer.from(rotated))).toBe(false);
    });

    it("supports credentials without a client secret", async () => {
      const directory = fixture();
      const input = {
        clientId: credentials.clientId,
        refreshToken: credentials.refreshToken,
      };
      provisionWindowsGmailCredentials(directory, input);
      expect(await readCredentials(directory)).toEqual(input);
    });

    it("refuses a linked database without modifying its target", async () => {
      const directory = fixture();
      const target = join(directory, "target.bin");
      const original = Buffer.from("synthetic unrelated target");
      writeFileSync(target, original);
      linkSync(target, join(directory, "gmail-credentials.sqlite"));
      await expect(readCredentials(directory)).rejects.toThrow(
        "GMAIL_CREDENTIAL_STORAGE_UNSAFE"
      );
      expect(() =>
        provisionWindowsGmailCredentials(directory, credentials)
      ).toThrow("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
      expect(readFileSync(target)).toEqual(original);
    });

    it("refuses a SQLite trigger before delivering credentials to a refresh", async () => {
      const directory = fixture();
      provisionWindowsGmailCredentials(directory, credentials);
      const database = new DatabaseSync(
        join(directory, "gmail-credentials.sqlite")
      );
      try {
        database.exec(`CREATE TRIGGER unexpected
        AFTER UPDATE ON gmail_credentials BEGIN SELECT 1; END`);
      } finally {
        database.close();
      }
      const refresh = vi.fn(async () => undefined);
      await expect(
        withWindowsGmailCredentials(directory, refresh)
      ).rejects.toThrow("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
      expect(refresh).not.toHaveBeenCalled();
    });

    it("refuses an explicit foreign grant on the credential database", async () => {
      const directory = fixture();
      provisionWindowsGmailCredentials(directory, credentials);
      const path = join(directory, "gmail-credentials.sqlite");
      const script = `
      $ErrorActionPreference = 'Stop'
      $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
      $acl = [IO.File]::GetAccessControl($path)
      $sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow')
      $acl.AddAccessRule($rule)
      [IO.File]::SetAccessControl($path, $acl)
    `;
      runWindowsPowerShell(script, Buffer.from(path).toString("base64"));
      await expect(readCredentials(directory)).rejects.toThrow(
        "GMAIL_CREDENTIAL_STORAGE_UNSAFE"
      );
    });

    it("rejects provisioning under retired or quarantined ancestors", () => {
      for (const marker of ["operator-retired.json", "recovery-state.json"]) {
        const directory = fixture();
        writeFileSync(join(directory, marker), "{}");
        expect(() =>
          provisionWindowsGmailCredentials(
            join(directory, "creds"),
            credentials
          )
        ).toThrow("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
      }
    });
  }
);
