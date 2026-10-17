import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installRecoveredBackupKey,
  installRecoveryIntent,
  loadBackupKey,
} from "../../lib/ingestion/encrypted-backup.js";

vi.setConfig({ testTimeout: 30_000 });
describe("atomic recovery installation files", () => {
  let base: string, operator: string, scratch: string;
  const key = randomBytes(32),
    intent = Buffer.from('{"authenticated":"fixture-intent"}\n');
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "zivv-install-files-"));
    operator = join(base, "operator");
    scratch = join(base, "private-staging");
    mkdirSync(operator);
    mkdirSync(scratch);
  });
  afterEach(() => {
    const offset = relative(resolve(tmpdir()), resolve(base));
    if (!offset.startsWith("zivv-install-files-") || offset.startsWith(".."))
      throw Error("Unsafe cleanup");
    rmSync(base, { recursive: true, force: true });
  });
  it.each([
    ["key", "before"],
    ["key", "after"],
    ["intent", "before"],
    ["intent", "after"],
  ] as const)(
    "recovers %s publication interrupted %s the exclusive link",
    (kind, point) => {
      const target = join(
        operator,
        kind === "key"
          ? process.platform === "win32"
            ? "backup-key.dpapi"
            : "backup-key.bin"
          : "recovery-import.json"
      );
      const module = pathToFileURL(
        resolve("dist/lib/ingestion/encrypted-backup.js")
      ).href;
      const script = `
      import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
      const link=fs.linkSync;
      fs.linkSync=(source,target)=>{if(target===${JSON.stringify(target)}){if(${JSON.stringify(point)}==='before')process.exit(77);link(source,target);process.exit(78);}return link(source,target);};
      syncBuiltinESMExports();
      const api=await import(${JSON.stringify(module)});
      ${kind === "key" ? `api.installRecoveredBackupKey(${JSON.stringify(operator)},Buffer.from(${JSON.stringify(key.toString("base64"))},'base64'),{stagingDirectory:${JSON.stringify(scratch)}});` : `api.installRecoveryIntent(${JSON.stringify(target)},Buffer.from(${JSON.stringify(intent.toString("base64"))},'base64'),${JSON.stringify(scratch)});`}
    `;
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { encoding: "utf8", windowsHide: true, timeout: 25_000 }
      );
      expect(child.status, child.stderr).toBe(point === "before" ? 77 : 78);
      expect(existsSync(target)).toBe(point === "after");
      if (point === "after") expect(statSync(target).nlink).toBe(2);
      if (kind === "key") {
        installRecoveredBackupKey(operator, key, { stagingDirectory: scratch });
        expect(loadBackupKey(operator)).toEqual(key);
      } else {
        expect(installRecoveryIntent(target, intent, scratch)).toEqual(intent);
        expect(readFileSync(target)).toEqual(intent);
      }
      expect(statSync(target).nlink).toBe(1);
    }
  );
  it("never removes an arbitrary external hardlink to an installed intent", () => {
    const path = join(operator, "recovery-import.json"),
      external = join(base, "unowned-link");
    installRecoveryIntent(path, intent, scratch);
    linkSync(path, external);
    expect(() => installRecoveryIntent(path, intent, scratch)).toThrow(
      "UNSAFE_RECOVERY_INSTALLATION_FILE"
    );
    expect(existsSync(external)).toBe(true);
    expect(readFileSync(path)).toEqual(intent);
  });
  it("refuses different keys and conflicting intent bytes without replacing the first", () => {
    installRecoveredBackupKey(operator, key, { stagingDirectory: scratch });
    expect(() =>
      installRecoveredBackupKey(operator, randomBytes(32), {
        stagingDirectory: scratch,
      })
    ).toThrow("RECOVERY_IMPORT_WORKING_KEY_MISMATCH");
    expect(loadBackupKey(operator)).toEqual(key);
    const path = join(operator, "recovery-import.json");
    installRecoveryIntent(path, intent, scratch);
    expect(() =>
      installRecoveryIntent(path, Buffer.from("other"), scratch)
    ).toThrow("RECOVERY_INSTALLATION_FILE_CONFLICT");
    expect(readFileSync(path)).toEqual(intent);
  });
});
