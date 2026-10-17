import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareOperatorRecoveryRuntime,
  verifyPreparedOperatorRuntime,
  type RecoveryRuntimeInput,
} from "../../lib/ingestion/recovery-runtime.js";
import {
  retireAndCaptureOperatorRecovery,
  encryptOperatorRecovery,
  decryptOperatorRecovery,
} from "../../lib/ingestion/operator-recovery.js";
import { createOperatorRetirementReceipt } from "../../lib/ingestion/operator-installation.js";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  canonicalJson,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
describe("prepare an authenticated recovery runtime without activation", () => {
  let base: string;
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "zivv-runtime-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    const rel = relative(resolve(tmpdir()), resolve(base));
    if (!rel.startsWith("zivv-runtime-") || rel.startsWith(".."))
      throw Error("Unsafe cleanup");
    rmSync(base, { recursive: true, force: true });
  });
  async function fixture(
    mode = "success",
    legacy = false
  ): Promise<RecoveryRuntimeInput> {
    const root = join(base, "original checkout"),
      operator = join(base, "original operator"),
      tool = join(base, "original npm"),
      npmCli = join(tool, "bin/npm-cli.js"),
      out = join(base, "final.enc");
    vi.stubEnv("ZIVV_LEDGER_HOME", operator);
    write(
      join(root, "data/ingestion/store.json"),
      canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    for (const name of [
      "package.json",
      "package-lock.json",
      "dist/lib",
      "dist/types",
      "dist/utils",
    ])
      cpSync(resolve(name), join(root, name), { recursive: true });
    cpSync(
      resolve("node_modules/postal-mime"),
      join(tool, "node_modules/postal-mime"),
      { recursive: true }
    );
    write(
      join(tool, "package.json"),
      '{"name":"npm","version":"11.6.0","type":"module"}\n'
    );
    write(
      npmCli,
      `
      import {cpSync,mkdirSync,symlinkSync,writeFileSync} from 'node:fs';
      import {dirname,join,resolve} from 'node:path';
      import {fileURLToPath} from 'node:url';
      const mode=${JSON.stringify(mode)};
      if(process.argv[2]==='--version'){
        if(mode==='noisy') { process.on('SIGTERM',()=>{});console.log('X'.repeat(40_000));setInterval(()=>{},1000); }
        else console.log(mode==='wrong-version'?'0.0.1':'11.6.0');
      }
      else {
        if(mode==='fail') { console.error('PRIVATE_ERROR_DO_NOT_PRINT'); process.exit(1); }
        const root=dirname(process.cwd());
        const modules=join(process.cwd(),'node_modules');mkdirSync(modules);
        if(mode!=='missing-dependency')cpSync(resolve(dirname(fileURLToPath(import.meta.url)),'../node_modules/postal-mime'),join(modules,'postal-mime'),{recursive:true});
        if(mode==='internal-link') {
          mkdirSync(join(modules,'.bin'));
          symlinkSync('../postal-mime/dist/esm/postal-mime.js',join(modules,'.bin/fixture-bin'));
        }
        writeFileSync(join(root,'bootstrap/observed.json'),JSON.stringify({args:process.argv.slice(2),env:process.env}));
        if(mode==='lock-drift')writeFileSync('package-lock.json','changed');
        if(mode==='operator-drift')writeFileSync(join(root,'operator/ledger.sqlite'),'changed');
        if(mode==='extra-file')writeFileSync('surprise.txt','changed');
        if(mode==='worker-drift')writeFileSync('dist/lib/ingestion/weekly-import-runner.js','changed');
      }
    `
    );
    await writeSqliteLedger(
      join(operator, "ledger.sqlite"),
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
      true
    );
    const recoveryKey = loadBackupKey(operator, true);
    if (mode === "cli") {
      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts/operator-recovery.js"),
          "retire",
          "--root",
          root,
          "--out",
          out,
          "--npm-cli",
          npmCli,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 60_000 }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "retire",
        status: "retired",
        activationAllowed: false,
      });
    } else {
      await retireAndCaptureOperatorRecovery({
        root,
        out,
        ...(legacy ? {} : { npmCli }),
      });
    }
    const archive = readFileSync(out),
      retirementReceipt = readFileSync(out + ".retirement.json");
    const movedTool = join(base, "replacement npm; literal path");
    cpSync(tool, movedTool, { recursive: true });
    // A fresh environment cannot silently read any of the original three roots.
    for (const original of [root, operator, tool]) {
      if (
        !relative(base, original) ||
        relative(base, original).startsWith("..")
      )
        throw Error("Unsafe fixture cleanup");
      rmSync(original, { recursive: true });
    }
    return {
      archive,
      retirementReceipt,
      recoveryKey,
      npmCli: join(movedTool, "bin/npm-cli.js"),
      destination: join(base, "replacement"),
    };
  }
  function rebind(
    input: RecoveryRuntimeInput,
    change: (checkpoint: ReturnType<typeof decryptOperatorRecovery>) => void
  ) {
    const checkpoint = decryptOperatorRecovery(
      input.archive,
      input.recoveryKey
    );
    change(checkpoint);
    input.archive = encryptOperatorRecovery(checkpoint, input.recoveryKey);
    input.retirementReceipt = createOperatorRetirementReceipt(
      {
        checkpointSha256: sha256(canonicalJson(checkpoint)),
        archiveSha256: sha256(input.archive),
        ledgerRevision: checkpoint.ledgerRevision,
        originalOperatorDirectory: checkpoint.originalOperatorDirectory,
        installationId: "8dfb65f1-0fa9-4e99-9c49-6a135702dcb1",
        retiredAtEpochMs: 1000,
      },
      input.recoveryKey
    );
  }
  it("installs from a relocated exact tool and probes the actual retained worker after old roots are deleted", async () => {
    const input = await fixture();
    vi.stubEnv("NODE_OPTIONS", "--require=DO_NOT_LOAD");
    vi.stubEnv("NPM_TOKEN", "PRIVATE_TOKEN");
    vi.stubEnv("npm_config_registry", "https://wrong.invalid");
    const result = await prepareOperatorRecoveryRuntime(input);
    expect(result).toMatchObject({
      status: "prepared",
      activationAllowed: false,
      workerProbe: "quarantine-enforced",
    });
    const observed = JSON.parse(
      readFileSync(join(input.destination, "bootstrap/observed.json"), "utf8")
    );
    expect(observed.args).toEqual([
      "ci",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ]);
    expect(observed.env.NODE_OPTIONS).toBeUndefined();
    expect(observed.env.NPM_TOKEN).toBeUndefined();
    expect(observed.env.npm_config_registry).toBe(
      "https://registry.npmjs.org/"
    );
    expect(observed.env.npm_config_userconfig).not.toBe(
      observed.env.npm_config_globalconfig
    );
    expect(existsSync(join(input.destination, "operator/backup-key.bin"))).toBe(
      false
    );
    expect(
      existsSync(join(input.destination, "operator/backup-key.dpapi"))
    ).toBe(false);
    expect(
      JSON.parse(
        readFileSync(join(input.destination, "recovery-state.json"), "utf8")
      )
    ).toMatchObject({ status: "staged", activationAllowed: false });
    const receipt = readFileSync(
      join(input.destination, "prepared-runtime.json")
    );
    expect(verifyPreparedOperatorRuntime(input)).toEqual(result);
    expect(await prepareOperatorRecoveryRuntime(input)).toEqual(result);
    expect(
      readFileSync(join(input.destination, "prepared-runtime.json"))
    ).toEqual(receipt);
    // Installed imports must be self-contained, rather than found in a parent checkout.
    expect(
      existsSync(
        join(
          input.destination,
          "checkout/node_modules/postal-mime/package.json"
        )
      )
    ).toBe(true);
  });
  it("refuses v1 and mismatched physical npm before creating the destination", async () => {
    const legacy = await fixture("success", true);
    await expect(prepareOperatorRecoveryRuntime(legacy)).rejects.toThrow(
      "RECOVERY_BOOTSTRAP_NPM_REQUIRED"
    );
    expect(existsSync(legacy.destination)).toBe(false);
  });
  it("rejects a changed npm package closure before executing it", async () => {
    const input = await fixture();
    write(
      join(dirname(dirname(input.npmCli)), "node_modules/postal-mime/extra.js"),
      "throw Error('must not execute');"
    );
    await expect(prepareOperatorRecoveryRuntime(input)).rejects.toThrow(
      "INVALID_NPM_EXECUTION_TOOL"
    );
    expect(existsSync(input.destination)).toBe(false);
  });
  it("refuses ancestor dependencies before executing their code", async () => {
    const input = await fixture("missing-dependency"),
      sentinel = join(base, "ancestor-was-loaded.txt");
    cpSync(
      resolve("node_modules/postal-mime"),
      join(base, "node_modules/postal-mime"),
      { recursive: true }
    );
    const entry = join(
      base,
      "node_modules/postal-mime/dist/esm/postal-mime.js"
    );
    write(
      entry,
      `
      import { writeFileSync as markAncestor } from 'node:fs';
      markAncestor(${JSON.stringify(sentinel)},'unexpected import');
    ` + readFileSync(entry, "utf8")
    );
    await expect(prepareOperatorRecoveryRuntime(input)).rejects.toThrow(
      "RECOVERY_RUNTIME_CHILD_FAILED"
    );
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(join(input.destination, "prepared-runtime.json"))).toBe(
      false
    );
    // Negative control: ordinary Node would execute this ancestor dependency
    // and reach quarantine, incorrectly making a bare worker probe look valid.
    const control = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      const {runWeeklyImport}=await import('./dist/lib/ingestion/weekly-import-runner.js');
      try {await runWeeklyImport({root:process.cwd(),runId:'probe',stopAfter:'load'});process.exitCode=1;}
      catch(error){if(error?.message!=='RECOVERY_INSTALLATION_NOT_ACTIVATED')process.exitCode=1;}
    `,
      ],
      {
        cwd: join(input.destination, "checkout"),
        env: {
          ...process.env,
          ZIVV_LEDGER_HOME: join(input.destination, "operator"),
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      }
    );
    expect(control.status, control.stderr).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
  });
  it("rejects a different retained runtime before staging or child execution", async () => {
    const input = await fixture();
    rebind(input, (checkpoint) => {
      checkpoint.runtime.node = "v0.0.1";
    });
    await expect(prepareOperatorRecoveryRuntime(input)).rejects.toThrow(
      "RECOVERY_RUNTIME_MISMATCH"
    );
    expect(existsSync(input.destination)).toBe(false);
  });
  it.each([
    "fail",
    "wrong-version",
    "noisy",
    "missing-dependency",
    "lock-drift",
    "worker-drift",
    "operator-drift",
    "extra-file",
  ])(
    "leaves incomplete %s preparation quarantined with no signed success",
    async (mode) => {
      const input = await fixture(mode);
      await expect(prepareOperatorRecoveryRuntime(input)).rejects.toThrow();
      expect(existsSync(join(input.destination, "prepared-runtime.json"))).toBe(
        false
      );
      expect(existsSync(join(input.destination, "recovery-state.json"))).toBe(
        true
      );
      await expect(prepareOperatorRecoveryRuntime(input)).rejects.toThrow();
    }
  );
  it("detects dependency, marker and signature drift, without repairing or reinstalling", async () => {
    const input = await fixture();
    await prepareOperatorRecoveryRuntime(input);
    const dependency = join(
        input.destination,
        "checkout/node_modules/postal-mime/package.json"
      ),
      original = readFileSync(dependency);
    write(dependency, "changed");
    expect(() => verifyPreparedOperatorRuntime(input)).toThrow();
    write(dependency, original);
    const marker = join(input.destination, "recovery-state.json"),
      markerBytes = readFileSync(marker);
    unlinkSync(marker);
    expect(() => verifyPreparedOperatorRuntime(input)).toThrow();
    write(marker, markerBytes);
    const path = join(input.destination, "prepared-runtime.json"),
      receipt = JSON.parse(readFileSync(path, "utf8"));
    receipt.activationAllowed = true;
    write(path, canonicalJson(receipt));
    expect(() => verifyPreparedOperatorRuntime(input)).toThrow();
  });
  it("binds completion to its physical root and refuses hardlinked dependency files", async () => {
    const input = await fixture();
    await prepareOperatorRecoveryRuntime(input);
    const moved = join(base, "moved prepared tree");
    cpSync(input.destination, moved, { recursive: true });
    expect(() =>
      verifyPreparedOperatorRuntime({ ...input, destination: moved })
    ).toThrow();
    const movedTool = join(base, "another tool copy");
    cpSync(dirname(dirname(input.npmCli)), movedTool, { recursive: true });
    expect(() =>
      verifyPreparedOperatorRuntime({
        ...input,
        npmCli: join(movedTool, "bin/npm-cli.js"),
      })
    ).toThrow();
    const module = join(input.destination, "checkout/node_modules/extra.txt"),
      outside = join(base, "outside.txt");
    write(outside, "same bytes");
    linkSync(outside, module);
    expect(() => verifyPreparedOperatorRuntime(input)).toThrow();
  });
  it.skipIf(process.platform === "win32")(
    "accepts recorded internal npm bin links but refuses external links",
    async () => {
      const input = await fixture("internal-link");
      await prepareOperatorRecoveryRuntime(input);
      const modules = join(input.destination, "checkout/node_modules");
      // Demonstrate scanner rejects escaping links even with an otherwise authenticated receipt.
      symlinkSync("../../../operator/ledger.sqlite", join(modules, "outside"));
      expect(() => verifyPreparedOperatorRuntime(input)).toThrow();
    }
  );
  it("exposes preparation and read-only verification via the real CLI with redacted output", async () => {
    const input = await fixture("cli");
    const archive = join(base, "portable.enc"),
      receipt = join(base, "retirement.json"),
      key = join(base, "recovery.key");
    write(archive, input.archive);
    write(receipt, input.retirementReceipt);
    write(key, input.recoveryKey.toString("base64"));
    const args = [
      "--file",
      archive,
      "--receipt",
      receipt,
      "--key",
      key,
      "--destination",
      input.destination,
      "--npm-cli",
      input.npmCli,
    ];
    for (const command of ["prepare-runtime", "verify-prepared-runtime"]) {
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/operator-recovery.js"), command, ...args],
        { encoding: "utf8", timeout: 60_000, windowsHide: true }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command,
        status: "prepared",
        activationAllowed: false,
      });
      expect(result.stdout).not.toContain(base);
      expect(result.stdout).not.toContain(input.recoveryKey.toString("base64"));
    }
    write(receipt, "bad private receipt");
    const bad = spawnSync(
      process.execPath,
      [resolve("scripts/operator-recovery.js"), "prepare-runtime", ...args],
      { encoding: "utf8", timeout: 60_000, windowsHide: true }
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).not.toContain("bad private receipt");
    expect(bad.stderr).not.toContain(base);
  });
});
