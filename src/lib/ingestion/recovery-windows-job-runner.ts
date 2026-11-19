import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { secureOperatorDirectory } from "./encrypted-backup.js";
import { resolvePrivateCandidateDirectory } from "./private-artifacts.js";

const runnerSourceSha256 =
  "9436f7523a6d4e9f033654aa40142c902554b2c1de78ffa13b3692792252b344";
const prefix = "zivv-recovery-windows-job-";
const unavailable = "RECOVERY_WINDOWS_JOB_RUNNER_UNAVAILABLE";

/** Build the reviewed host helper in fresh private storage, outside the retained tree. */
export async function withRecoveryWindowsJobRunner<T>(
  run: (executable: string) => Promise<T>
): Promise<T> {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== "win32" || !systemRoot || !isAbsolute(systemRoot))
    throw Error(unavailable);

  let directory: string | undefined;
  const root = resolvePrivateCandidateDirectory(tmpdir());
  try {
    const source = fileURLToPath(
      new URL("../../../scripts/windows-job-runner.cs", import.meta.url)
    );
    const stat = lstatSync(source);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 32768
    )
      throw Error(unavailable);
    const bytes = Buffer.from(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(readFileSync(source))
        .replace(/\r\n/g, "\n")
    );
    if (createHash("sha256").update(bytes).digest("hex") !== runnerSourceSha256)
      throw Error(unavailable);

    directory = mkdtempSync(join(root, prefix));
    secureOperatorDirectory(directory);
    const input = join(directory, "WindowsJobRunner.cs");
    const executable = join(directory, "WindowsJobRunner.exe");
    writeFileSync(input, bytes, { flag: "wx" });

    const compiler = join(
      systemRoot,
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe"
    );
    const result = spawnSync(
      compiler,
      [
        "/nologo",
        "/noconfig",
        "/reference:" + join(dirname(compiler), "System.dll"),
        "/target:exe",
        "/optimize+",
        "/warnaserror+",
        "/out:" + executable,
        input,
      ],
      {
        cwd: directory,
        env: { SystemRoot: systemRoot, TEMP: directory, TMP: directory },
        shell: false,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 128 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    if (result.status !== 0) throw Error(unavailable);
    const binary = lstatSync(executable);
    if (!binary.isFile() || binary.isSymbolicLink() || binary.nlink !== 1)
      throw Error(unavailable);

    return await run(executable);
  } catch (error) {
    if (error instanceof Error && /^[A-Z][A-Z_]{2,95}$/.test(error.message))
      throw error;
    throw Error(unavailable);
  } finally {
    if (directory) {
      const owned = resolve(directory);
      if (dirname(owned) === root && basename(owned).startsWith(prefix)) {
        try {
          rmSync(owned, { recursive: true, force: true });
        } catch {
          // A terminated runner can retain a transient compiler/file handle.
          // The directory has reviewed source and a binary, with no private frame.
        }
      }
    }
  }
}
