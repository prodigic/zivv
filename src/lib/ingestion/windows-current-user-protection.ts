import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

/** Run a fixed Windows system script with private input on stdin. */
export function runWindowsPowerShell(script: string, input: string): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot))
    throw new Error("Windows system directory unavailable.");
  const result = spawnSync(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    }
  );
  if (result.status !== 0)
    throw new Error("Windows could not complete the private operation.");
  return result.stdout.trim();
}

/** Protect locally provisioned bytes for the current Windows account. */
export function protectForWindows(bytes: Buffer, unprotect = false): Buffer {
  const operation = unprotect ? "Unprotect" : "Protect";
  const script = `$ErrorActionPreference='Stop'; $null=[Reflection.Assembly]::LoadWithPartialName('System.Security'); $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[System.Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  const encoded = runWindowsPowerShell(script, bytes.toString("base64"));
  if (!encoded.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error("Windows could not protect/unprotect data for this user.");
  return Buffer.from(encoded, "base64");
}
