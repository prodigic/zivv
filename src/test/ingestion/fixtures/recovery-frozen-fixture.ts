import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadBackupKey } from "../../../lib/ingestion/encrypted-backup.js";
import { bootstrapLedger } from "../../../lib/ingestion/ledger.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  writeSqliteLedger,
} from "../../../lib/ingestion/sqlite-store.js";
import { runWeeklyImport } from "../../../lib/ingestion/weekly-import-runner.js";
import { retireAndCaptureOperatorRecovery } from "../../../lib/ingestion/operator-recovery.js";
import { prepareOperatorRecoveryRuntime } from "../../../lib/ingestion/recovery-runtime.js";
import { captureExportConfiguration } from "../../../lib/ingestion/export-configuration.js";
import { createAcknowledgedRecoveryRemoteFixture } from "./recovery-import-remote-fixture.js";
import type {
  WeeklyRunStage,
  WeeklyRunState,
} from "../../../lib/ingestion/weekly-run-state.js";

function write(path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("GIT_")) delete env[name];
  return execFileSync("git", args, {
    cwd,
    env,
    windowsHide: true,
    stdio: "pipe",
    maxBuffer: 8 * 1024 * 1024,
  })
    .toString()
    .trim();
}

interface LockEntry {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}
/** Keep the installed, pinned tool versions and their complete dependency closure. */
export function realToolchainManifest() {
  const original = JSON.parse(
    readFileSync(resolve("package-lock.json"), "utf8")
  ) as { packages: Record<string, LockEntry> };
  const names = ["postal-mime", "typescript", "vite", "@types/node"];
  const selected = new Map<string, LockEntry>();
  function dependencyLocation(owner: string, name: string): string {
    let scope = owner;
    for (;;) {
      const nested = `${scope}/node_modules/${name}`;
      if (original.packages[nested]) return nested;
      const parent = scope.lastIndexOf("/node_modules/");
      if (parent < 0) break;
      scope = scope.slice(0, parent);
    }
    const root = `node_modules/${name}`;
    if (!original.packages[root])
      throw new Error("Missing pinned fixture dependency");
    return root;
  }
  function visit(key: string): void {
    if (selected.has(key)) return;
    const entry = original.packages[key];
    if (!entry) throw new Error("Missing pinned fixture dependency");
    selected.set(key, entry);
    for (const name of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
    })) {
      visit(dependencyLocation(key, name));
    }
  }
  for (const name of names) visit(`node_modules/${name}`);
  const versions = Object.fromEntries(
    names.map((name) => [
      name,
      original.packages[`node_modules/${name}`].version,
    ])
  );
  const manifest = {
    name: "zivv-real-frozen-recovery-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: { "postal-mime": versions["postal-mime"] },
    devDependencies: {
      typescript: versions.typescript,
      vite: versions.vite,
      "@types/node": versions["@types/node"],
    },
  };
  return {
    manifest,
    lock: {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": manifest, ...Object.fromEntries(selected) },
    },
  };
}

const viteConfiguration = `import {defineConfig} from 'vite';
export default defineConfig({base:process.env.ZIVV_BASE_PATH,build:{manifest:true},plugins:[{
  name:'fixture-pages-output',enforce:'post',generateBundle(_options,bundle){
    const entry=Object.values(bundle).find(file=>file.type==='chunk'&&file.isEntry);
    if(!entry) throw Error('Missing actual Vite entry');
    this.emitFile({type:'asset',fileName:'404.html',source:'<script type="module" src="'+process.env.ZIVV_BASE_PATH+entry.fileName+'"></script>\\n'});
    this.emitFile({type:'asset',fileName:'manifest.json',source:JSON.stringify({scope:process.env.ZIVV_BASE_PATH,start_url:process.env.ZIVV_BASE_PATH})});
  }
}]});\n`;

/** Genuine npm/TypeScript/Vite build of a tiny app and the reviewed ETL sources. */
export async function createRecoveryFrozenFixture() {
  const base = mkdtempSync(join(tmpdir(), "zivv-frozen-real-"));
  const originalOperator = join(base, "original-operator"),
    originalTool = join(base, "original-tool");
  const previousHome = process.env.ZIVV_LEDGER_HOME;
  process.env.ZIVV_LEDGER_HOME = originalOperator;
  let activeCalls = 0,
    cleanupRequested = false;
  let preserveEvidence = false;
  const cleanup = () => {
    if (activeCalls || preserveEvidence) return;
    const suffix = relative(resolve(tmpdir()), resolve(base));
    if (!suffix.startsWith("zivv-frozen-real-") || suffix.startsWith(".."))
      throw new Error("Unsafe fixture cleanup");
    rmSync(base, { recursive: true, force: true });
  };
  try {
    const baseline = bootstrapLedger(
      { events: [], artists: [], venues: [] },
      1000
    );
    await writeSqliteLedger(
      join(originalOperator, "ledger.sqlite"),
      baseline,
      true
    );
    const recoveryKey = loadBackupKey(originalOperator, true);
    const authority = await createAcknowledgedRecoveryRemoteFixture({
      directory: join(base, "original-authority"),
      ledger: baseline,
      recoveryKey,
    });
    const originalCheckout = authority.repositoryRoot;
    git(originalCheckout, [
      "checkout",
      "--quiet",
      "-B",
      "main",
      authority.sourceCommit,
    ]);
    for (const [key, value] of [
      ["user.name", "Frozen recovery fixture"],
      ["user.email", "fixture@example.test"],
      ["core.autocrlf", "false"],
      ["commit.gpgsign", "false"],
    ])
      git(originalCheckout, ["config", key, value]);
    const { manifest, lock } = realToolchainManifest();
    write(
      join(originalCheckout, "package.json"),
      canonicalJson(manifest) + "\n"
    );
    write(
      join(originalCheckout, "package-lock.json"),
      canonicalJson(lock) + "\n"
    );
    const config = {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "node",
        outDir: "./dist",
        rootDir: "./src",
        tsBuildInfoFile: "./.cache/fixture.tsbuildinfo",
        strict: true,
        noImplicitAny: false,
        skipLibCheck: true,
        esModuleInterop: true,
        baseUrl: ".",
        paths: { "@/*": ["./src/*"] },
      },
      include: ["src/lib/etl/processor.ts", "src/main.ts"],
    };
    write(
      join(originalCheckout, "tsconfig.json"),
      canonicalJson(config) + "\n"
    );
    write(
      join(originalCheckout, "tsconfig.build.json"),
      canonicalJson(config) + "\n"
    );
    write(join(originalCheckout, "vite.config.mjs"), viteConfiguration);
    write(
      join(originalCheckout, "index.html"),
      '<!doctype html><html><body><main id="app"></main><script type="module" src="/src/main.ts"></script></body></html>\n'
    );
    write(
      join(originalCheckout, "src/main.ts"),
      'document.querySelector("#app")!.textContent = "Frozen recovery fixture";\n'
    );
    for (const path of ["src/lib", "src/types", "src/utils"])
      cpSync(resolve(path), join(originalCheckout, path), { recursive: true });
    write(
      join(originalCheckout, "data/venue-sources.json"),
      '{"sources":[]}\n'
    );
    write(
      join(originalCheckout, "data/ingestion/store.json"),
      canonicalJson({
        schemaVersion: 1,
        backend: "sqlite",
        namespace: "zivv",
      }) + "\n"
    );
    git(originalCheckout, ["add", "."]);
    git(originalCheckout, [
      "commit",
      "--quiet",
      "-m",
      "reviewed real ETL and tiny app",
    ]);
    const sourceCommit = git(originalCheckout, ["rev-parse", "HEAD"]);
    git(originalCheckout, [
      "push",
      "--quiet",
      authority.bareDirectory,
      "HEAD:refs/heads/main",
    ]);
    git(originalCheckout, [
      "update-ref",
      "refs/remotes/origin/main",
      sourceCommit,
    ]);
    // The retained operator worker belongs to the real repository runtime.
    // Its dirty working-copy package files must match that runtime exactly.
    // The explicitly nominated Git commit independently retains the minimal
    // pinned package files used by the genuine reviewed application build.
    for (const path of ["package.json", "package-lock.json"])
      write(join(originalCheckout, path), readFileSync(resolve(path)));
    for (const path of ["dist/lib", "dist/types", "dist/utils"])
      cpSync(resolve(path), join(originalCheckout, path), { recursive: true });
    const candidates = [
      process.env.ZIVV_TEST_REAL_NPM_CLI,
      process.env.npm_execpath,
      resolve(".cache/npm-runtime-11.6.0/package/bin/npm-cli.js"),
      join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
      resolve(
        dirname(process.execPath),
        "../lib/node_modules/npm/bin/npm-cli.js"
      ),
    ];
    const actualCli = candidates.find(
      (path): path is string =>
        typeof path === "string" &&
        path.endsWith("npm-cli.js") &&
        existsSync(path)
    );
    if (!actualCli)
      throw new Error("Real npm CLI is required for this integration drill");
    const realNpm = dirname(dirname(actualCli));
    cpSync(realNpm, originalTool, { recursive: true });
    const npmCli = join(originalTool, "bin/npm-cli.js");
    const initial = await runWeeklyImport({
      root: originalCheckout,
      source: {
        editionId: "2026-10-16",
        deliveryId: "real-frozen-recovery",
        importObservedAtEpochMs: Date.parse("2026-10-16T20:00:00Z"),
        raw: Buffer.from(
          "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\noct 23 fri Fixture Band at Test Room, Oakland a/a $20 8pm\nPlease feel free to forward The List on to your friends.\n"
        ),
      },
      stopAfter: "freeze",
      freezeCutoffEpochMs: Date.parse("2026-10-16T21:00:00Z"),
    });
    if (
      initial.stages
        .slice(0, 5)
        .some((stage) => stage.status !== "succeeded") ||
      initial.stages.slice(5).some((stage) => stage.status !== "pending")
    )
      throw new Error("Fixture did not stop exactly after freeze");
    const ledgerRevision = ledgerDigest(
      readSqliteLedger(join(originalOperator, "ledger.sqlite"))
    );
    const configuration = captureExportConfiguration(originalCheckout);
    const archivePath = join(base, "final.enc");
    await retireAndCaptureOperatorRecovery({
      root: originalCheckout,
      out: archivePath,
      npmCli,
    });
    const replacementTool = join(base, "replacement-tool"),
      templateBare = join(base, "replacement-authority.git");
    cpSync(originalTool, replacementTool, { recursive: true });
    git(base, [
      "clone",
      "--quiet",
      "--bare",
      authority.bareDirectory,
      templateBare,
    ]);
    const portable = {
      archive: readFileSync(archivePath),
      retirementReceipt: readFileSync(archivePath + ".retirement.json"),
      recoveryKey,
      npmCli: join(replacementTool, "bin/npm-cli.js"),
    };
    const originalPaths = [originalCheckout, originalOperator, originalTool];
    for (const path of originalPaths) {
      const suffix = relative(base, path);
      if (!suffix || suffix.startsWith(".."))
        throw new Error("Unsafe fixture cleanup");
      rmSync(path, { recursive: true, force: true });
    }
    return {
      base,
      initial,
      portable,
      originalPaths,
      sourceCommit,
      ledgerRevision,
      configuration,
      preserve() {
        preserveEvidence = true;
      },
      async track<T>(operation: () => Promise<T>): Promise<T> {
        activeCalls++;
        try {
          return await operation();
        } finally {
          activeCalls--;
          if (cleanupRequested) cleanup();
        }
      },
      async prepare(name: string) {
        if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid fixture name");
        const location = join(base, name),
          bareDirectory = join(location, "remote.git"),
          repositoryRoot = join(location, "repository"),
          destination = join(location, "restored");
        mkdirSync(location);
        git(location, [
          "clone",
          "--quiet",
          "--bare",
          templateBare,
          bareDirectory,
        ]);
        git(location, [
          "clone",
          "--quiet",
          "--branch",
          "main",
          bareDirectory,
          repositoryRoot,
        ]);
        git(repositoryRoot, [
          "remote",
          "set-url",
          "origin",
          "https://github.com/prodigic/zivv.git",
        ]);
        const input = {
          ...portable,
          destination,
          repositoryRoot,
          bareDirectory,
          runId: initial.runId,
          sourceCommit,
        };
        await prepareOperatorRecoveryRuntime(input);
        const query = (stage?: WeeklyRunStage) => {
          const db = new DatabaseSync(
            join(destination, "operator/weekly-runs.sqlite"),
            { readOnly: true }
          );
          try {
            if (stage) {
              const row = db
                .prepare(
                  "SELECT bytes FROM stage_artifact WHERE run_id=? AND stage=? ORDER BY attempt DESC LIMIT 1"
                )
                .get(initial.runId, stage);
              if (!row) throw new Error("Missing stage artifact");
              return JSON.parse(
                Buffer.from(row.bytes as Uint8Array).toString()
              ) as unknown;
            }
            const row = db
              .prepare("SELECT payload FROM run_state WHERE id=?")
              .get(initial.runId);
            if (!row) throw new Error("Missing retained run");
            return JSON.parse(String(row.payload)) as WeeklyRunState;
          } finally {
            db.close();
          }
        };
        return {
          input,
          refs: () => git(repositoryRoot, ["ls-remote", bareDirectory]),
          readState: () => query() as WeeklyRunState,
          artifact: (stage: WeeklyRunStage) => query(stage),
          candidateDirectories: () =>
            readdirSync(join(destination, "operator/weekly-candidates"), {
              recursive: true,
            })
              .filter((path) =>
                /(?:^|[\\/])candidate\.json$/.test(String(path))
              )
              .map((path) =>
                dirname(
                  join(destination, "operator/weekly-candidates", String(path))
                )
              ),
        };
      },
      close() {
        cleanupRequested = true;
        cleanup();
      },
    };
  } catch (error) {
    cleanupRequested = true;
    cleanup();
    throw error;
  } finally {
    if (previousHome === undefined) delete process.env.ZIVV_LEDGER_HOME;
    else process.env.ZIVV_LEDGER_HOME = previousHome;
  }
}
