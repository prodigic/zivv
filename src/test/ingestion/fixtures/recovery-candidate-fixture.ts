import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
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
import { createAcknowledgedRecoveryRemoteFixture } from "./recovery-import-remote-fixture.js";
import type { WeeklyRunState } from "../../../lib/ingestion/weekly-run-state.js";

function write(path: string, bytes: Buffer | string): void {
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
  })
    .toString()
    .trim();
}
function removeTemporary(base: string, path: string): void {
  const suffix = relative(resolve(base), resolve(path));
  if (!suffix || suffix.startsWith("..") || resolve(path) === resolve(tmpdir()))
    throw new Error("Unsafe fixture cleanup");
  rmSync(path, { recursive: true, force: true });
}

// An ordinary portable npm package, not a module mock. Its compiler preserves the
// actual frozen worker/ETL bytes and its Vite entrypoint emits a minimal valid app.
const fixtureNpm = String.raw`
import {cpSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const tool = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] === '--version') { console.log('11.6.0'); }
else {
  mkdirSync('node_modules', {recursive:true});
  cpSync(join(tool,'node_modules/postal-mime'), 'node_modules/postal-mime', {recursive:true});
  mkdirSync('node_modules/typescript/bin',{recursive:true});
  writeFileSync('node_modules/typescript/package.json','{"type":"module"}');
  const compiler = "import {cpSync} from 'node:fs'; if(process.argv.includes('--project')) cpSync(" + JSON.stringify(join(tool,'compiled')) + ", 'dist', {recursive:true});\n";
  writeFileSync('node_modules/typescript/bin/tsc',compiler);
  mkdirSync('node_modules/vite/bin',{recursive:true});
  writeFileSync('node_modules/vite/package.json','{"type":"module"}');
  writeFileSync('node_modules/vite/bin/vite.js',
    "import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';" +
    "const output=process.argv[process.argv.indexOf('--outDir')+1];" +
    "mkdirSync(join(output,'assets'),{recursive:true});mkdirSync(join(output,'.vite'),{recursive:true});" +
    "const html='<script src=\"'+process.env.ZIVV_BASE_PATH+'assets/app.js\"></script>\\n';" +
    "writeFileSync(join(output,'index.html'),html);writeFileSync(join(output,'404.html'),html);" +
    "writeFileSync(join(output,'assets/app.js'),'console.log(1);\\n');" +
    "writeFileSync(join(output,'manifest.json'),JSON.stringify({scope:process.env.ZIVV_BASE_PATH,start_url:process.env.ZIVV_BASE_PATH}));" +
    "writeFileSync(join(output,'.vite/manifest.json'),JSON.stringify({'index.html':{file:'assets/app.js',isEntry:true}}));");
}
`;

/** Real validation, retirement, relocation, Git authority and loopback API drill. */
export async function createRecoveryCandidateFixture() {
  const base = mkdtempSync(join(tmpdir(), "zivv-candidate-recovery-"));
  const originalOperator = join(base, "original-operator"),
    originalTool = join(base, "original-tool");
  const previousHome = process.env.ZIVV_LEDGER_HOME;
  process.env.ZIVV_LEDGER_HOME = originalOperator;
  const servers: ReturnType<typeof createServer>[] = [];
  let activeCalls = 0;
  let cleanupRequested = false;
  let cleanup: Promise<void> | undefined;
  function closeWhenIdle(): Promise<void> {
    if (activeCalls > 0) return Promise.resolve();
    cleanup ??= (async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((done, reject) => {
              server.closeAllConnections();
              server.close((error) => (error ? reject(error) : done()));
            })
        )
      );
      const suffix = relative(resolve(tmpdir()), resolve(base));
      if (
        !suffix.startsWith("zivv-candidate-recovery-") ||
        suffix.startsWith("..")
      )
        throw new Error("Unsafe fixture cleanup");
      rmSync(base, { recursive: true, force: true });
    })();
    return cleanup;
  }
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
    const remote = await createAcknowledgedRecoveryRemoteFixture({
      directory: join(base, "original-authority"),
      ledger: baseline,
      recoveryKey,
    });
    const originalCheckout = remote.repositoryRoot;
    git(originalCheckout, [
      "checkout",
      "--quiet",
      "-B",
      "main",
      remote.sourceCommit,
    ]);
    git(originalCheckout, ["config", "user.name", "Recovery fixture"]);
    git(originalCheckout, ["config", "user.email", "fixture@example.test"]);
    git(originalCheckout, ["config", "core.autocrlf", "false"]);
    git(originalCheckout, ["config", "commit.gpgsign", "false"]);
    for (const path of [
      "package.json",
      "package-lock.json",
      "tsconfig.build.json",
      ".github/workflows/publish-candidate.yml",
    ]) {
      write(join(originalCheckout, path), readFileSync(resolve(path)));
    }
    write(
      join(originalCheckout, "src/main.ts"),
      "export const reviewed = true;\n"
    );
    write(
      join(originalCheckout, "index.html"),
      '<script type="module" src="/src/main.ts"></script>\n'
    );
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
      "reviewed fixture application",
    ]);
    const workflowCommit = git(originalCheckout, ["rev-parse", "HEAD"]);
    git(originalCheckout, [
      "push",
      "--quiet",
      remote.bareDirectory,
      "HEAD:refs/heads/main",
    ]);
    git(originalCheckout, [
      "update-ref",
      "refs/remotes/origin/main",
      workflowCommit,
    ]);
    for (const path of ["dist/lib", "dist/types", "dist/utils"]) {
      cpSync(resolve(path), join(originalCheckout, path), { recursive: true });
      cpSync(resolve(path), join(originalTool, "compiled", path.slice(5)), {
        recursive: true,
      });
    }
    cpSync(
      resolve("node_modules/postal-mime"),
      join(originalTool, "node_modules/postal-mime"),
      { recursive: true }
    );
    write(
      join(originalTool, "package.json"),
      '{"name":"npm","version":"11.6.0","type":"module"}\n'
    );
    const npmCli = join(originalTool, "bin/npm-cli.js");
    write(npmCli, fixtureNpm);
    const observed = Date.parse("2026-10-16T20:00:00Z");
    const initial = await runWeeklyImport({
      root: originalCheckout,
      source: {
        editionId: "2026-10-16",
        deliveryId: "actual-candidate-recovery-drill",
        importObservedAtEpochMs: observed,
        raw: Buffer.from(
          "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\noct 23 fri Fixture Band at Test Room, Oakland a/a $20 8pm\nPlease feel free to forward The List on to your friends.\n"
        ),
      },
      stopAfter: "validate",
      freezeCutoffEpochMs: Date.parse("2026-10-16T21:00:00Z"),
      candidateBuild: {
        sourceCommit: workflowCommit,
        purpose: "release",
        basePath: "/zivv/",
        npmCli,
      },
    });
    if (
      initial.stages.find((stage) => stage.stage === "validate")?.status !==
      "succeeded"
    )
      throw new Error("Fixture candidate did not validate");
    const ledgerRevision = ledgerDigest(
      readSqliteLedger(join(originalOperator, "ledger.sqlite"))
    );
    const archivePath = join(base, "final.enc");
    await retireAndCaptureOperatorRecovery({
      root: originalCheckout,
      out: archivePath,
      npmCli,
    });
    const replacementTool = join(base, "replacement-tool");
    cpSync(originalTool, replacementTool, { recursive: true });
    const templateBare = join(base, "replacement-authority.git");
    git(base, [
      "clone",
      "--quiet",
      "--bare",
      remote.bareDirectory,
      templateBare,
    ]);
    const portable = {
      archive: readFileSync(archivePath),
      retirementReceipt: readFileSync(archivePath + ".retirement.json"),
      recoveryKey,
      npmCli: join(replacementTool, "bin/npm-cli.js"),
    };
    const originalPaths = [originalCheckout, originalOperator, originalTool];
    for (const path of originalPaths) removeTemporary(base, path);
    return {
      base,
      initial,
      portable,
      originalPaths,
      workflowCommit,
      ledgerRevision,
      async track<T>(operation: () => Promise<T>): Promise<T> {
        activeCalls++;
        try {
          return await operation();
        } finally {
          activeCalls--;
          if (cleanupRequested) await closeWhenIdle();
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
        const requests: { method: string; url: string }[] = [];
        const dispatches: { ref: string; inputs: Record<string, string> }[] =
          [];
        const server = createServer(async (request, response) => {
          const method = request.method ?? "GET",
            url = request.url ?? "";
          requests.push({ method, url });
          response.setHeader("Content-Type", "application/json");
          if (url.includes("/git/ref/")) {
            response.end(
              JSON.stringify({
                ref: `refs/tags/zivv-workflows/${workflowCommit}`,
                object: { type: "commit", sha: workflowCommit },
              })
            );
            return;
          }
          if (method === "POST" && url.endsWith("/dispatches")) {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString()) as {
              ref: string;
              inputs: Record<string, string>;
            };
            dispatches.push(body);
            response.end(
              JSON.stringify({
                workflow_run_id: 101,
                run_url:
                  "https://api.github.com/repos/prodigic/zivv/actions/runs/101",
                html_url: "https://github.com/prodigic/zivv/actions/runs/101",
              })
            );
            return;
          }
          const dispatch = dispatches.at(-1);
          const run = dispatch
            ? {
                id: 101,
                event: "workflow_dispatch",
                head_sha: workflowCommit,
                head_branch: dispatch.ref,
                display_title: `zivv-pages/${dispatch.inputs.operation_id}/${dispatch.inputs.mode}/${dispatch.inputs.attempt_id}`,
                path: ".github/workflows/publish-candidate.yml",
                run_attempt: 1,
                repository: { full_name: "prodigic/zivv" },
                url: "https://api.github.com/repos/prodigic/zivv/actions/runs/101",
                html_url: "https://github.com/prodigic/zivv/actions/runs/101",
                inputs: dispatch.inputs,
              }
            : null;
          if (!url.includes("/actions/")) {
            response.statusCode = 404;
            response.end("{}");
            return;
          }
          response.end(
            JSON.stringify(
              url.includes("/actions/runs/101")
                ? run
                : { total_count: run ? 1 : 0, workflow_runs: run ? [run] : [] }
            )
          );
        });
        servers.push(server);
        await new Promise<void>((resolveListen, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolveListen);
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing fixture HTTP address");
        const input = {
          ...portable,
          destination,
          repositoryRoot,
          bareDirectory,
          runId: initial.runId,
          workflowCommit,
          githubToken: "ghp_isolated_recovery_fixture",
          pagesApiBaseUrl: `http://127.0.0.1:${address.port}`,
        };
        await prepareOperatorRecoveryRuntime(input);
        return {
          input,
          requests,
          dispatches,
          git: (args: string[]) => git(repositoryRoot, args),
          readState: () => {
            const db = new DatabaseSync(
              join(destination, "operator/weekly-runs.sqlite"),
              { readOnly: true }
            );
            try {
              const row = db
                .prepare("SELECT payload FROM run_state WHERE id=?")
                .get(initial.runId);
              if (!row) throw new Error("Missing recovered run");
              return JSON.parse(String(row.payload)) as WeeklyRunState;
            } finally {
              db.close();
            }
          },
        };
      },
      async close() {
        // A Vitest deadline must not remove a still-running child's runtime or
        // close its loopback API. The last tracked invocation cleans up later.
        cleanupRequested = true;
        await closeWhenIdle();
      },
    };
  } catch (error) {
    for (const server of servers) server.close();
    const suffix = relative(resolve(tmpdir()), resolve(base));
    if (
      suffix.startsWith("zivv-candidate-recovery-") &&
      !suffix.startsWith("..")
    )
      rmSync(base, { recursive: true, force: true });
    throw error;
  } finally {
    if (previousHome === undefined) delete process.env.ZIVV_LEDGER_HOME;
    else process.env.ZIVV_LEDGER_HOME = previousHome;
  }
}
