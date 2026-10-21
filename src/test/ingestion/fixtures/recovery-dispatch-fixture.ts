import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../../lib/ingestion/sqlite-store.js";
import { runWeeklyImport } from "../../../lib/ingestion/weekly-import-runner.js";
import { readVerifiedCandidateBundle } from "../../../lib/ingestion/candidate-bundle.js";
import { createRecoveryFrozenFixture } from "./recovery-frozen-fixture.js";
import type { SavedPagesDispatch } from "../../../lib/ingestion/pages-dispatch-runner.js";
import type { WeeklyRunState } from "../../../lib/ingestion/weekly-run-state.js";
import type { FrozenFixtureRetirementContext } from "./recovery-frozen-fixture.js";

export type RecoveryDispatchAfterAccepted = (
  context: FrozenFixtureRetirementContext,
  state: WeeklyRunState,
  candidateBytes: Buffer,
  workflowCommit: string,
  saved: SavedPagesDispatch
) => Promise<WeeklyRunState>;

/** An original worker really POSTs once; only its accepted response is lost. */
export async function createRecoveryDispatchFixture(
  options: { afterAccepted?: RecoveryDispatchAfterAccepted } = {}
) {
  let saved: SavedPagesDispatch | undefined;
  let workflowCommit = "";
  let originalPhase = true;
  let listedRunIds = [101];
  let apiBaseUrl = "";
  const requests: { method: string; url: string }[] = [];
  const originalPosts: { ref: string; inputs: Record<string, string> }[] = [];
  function run(id: number) {
    if (!saved) throw new Error("Original dispatch intent is not captured");
    return {
      id,
      event: "workflow_dispatch",
      head_sha: workflowCommit,
      head_branch: saved.intent.ref,
      display_title: saved.intent.runName,
      path: ".github/workflows/publish-candidate.yml",
      run_attempt: 1,
      repository: { full_name: "prodigic/zivv" },
      url: `https://api.github.com/repos/prodigic/zivv/actions/runs/${id}`,
      html_url: `https://github.com/prodigic/zivv/actions/runs/${id}`,
      inputs: {
        ...saved.intent.inputs,
        control_head: saved.pendingAppend.attemptedHead,
      },
    };
  }
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
    if (method === "POST") {
      if (!originalPhase) {
        response.statusCode = 409;
        response.end("{}");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      originalPosts.push(
        JSON.parse(Buffer.concat(chunks).toString()) as {
          ref: string;
          inputs: Record<string, string>;
        }
      );
      // The fixture provider accepted the dispatch, but the original worker
      // never receives a usable response or a private receipt.
      request.socket.destroy();
      return;
    }
    if (!saved) {
      response.end('{"total_count":0,"workflow_runs":[]}');
      return;
    }
    const exact = /\/actions\/runs\/(\d+)(?:\?|$)/.exec(url);
    if (exact) response.end(JSON.stringify(run(Number(exact[1]))));
    else
      response.end(
        JSON.stringify({
          total_count: listedRunIds.length,
          workflow_runs: listedRunIds.map(run),
        })
      );
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local dispatch fixture address");
  apiBaseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const core = await createRecoveryFrozenFixture({
      beforeRetirement: async (context) => {
        const workflow = ".github/workflows/publish-candidate.yml";
        mkdirSync(dirname(join(context.root, workflow)), { recursive: true });
        writeFileSync(
          join(context.root, workflow),
          readFileSync(resolve(workflow))
        );
        context.authority.git(["add", workflow]);
        context.authority.git([
          "commit",
          "--quiet",
          "-m",
          "reviewed fixture publication workflow",
        ]);
        workflowCommit = context.authority.git(["rev-parse", "HEAD"]);
        context.authority.git([
          "push",
          "--quiet",
          context.authority.bareDirectory,
          "HEAD:refs/heads/main",
        ]);
        context.authority.git([
          "update-ref",
          "refs/remotes/origin/main",
          workflowCommit,
        ]);
        const validated = await runWeeklyImport({
          root: context.root,
          runId: context.state.runId,
          stopAfter: "validate",
          candidateBuild: {
            sourceCommit: context.sourceCommit,
            purpose: "release",
            basePath: "/zivv/",
            npmCli: context.npmCli,
          },
        });
        const db = new DatabaseSync(
          join(context.operatorDirectory, "weekly-runs.sqlite"),
          { readOnly: true }
        );
        let workDirectory: string;
        try {
          const row = db
            .prepare(
              "SELECT bytes FROM stage_artifact WHERE run_id=? AND stage='export' ORDER BY attempt DESC LIMIT 1"
            )
            .get(validated.runId);
          if (!row) throw new Error("Original worker export intent is missing");
          workDirectory = (
            JSON.parse(Buffer.from(row.bytes as Uint8Array).toString()) as {
              workDirectory: string;
            }
          ).workDirectory;
        } finally {
          db.close();
        }
        const candidates = readdirSync(workDirectory!).filter((name) =>
          name.startsWith("candidate-")
        );
        if (candidates.length !== 1)
          throw new Error("Original worker candidate is not unique");
        const candidateId = String(
          validated.stages.find((stage) => stage.stage === "validate")?.evidence
            ?.candidateId
        );
        const bundle = await readVerifiedCandidateBundle(
          join(workDirectory!, candidates[0]),
          context.recoveryKey,
          candidateId
        );
        const candidateBytes = Buffer.from(
          canonicalJson(bundle.candidate) + "\n"
        );
        const state = await runWeeklyImport({
          root: context.root,
          runId: validated.runId,
          stopAfter: "dispatch",
          controlledPublishing: "enabled",
          manualPublisherJoined: "true",
          publication: {
            store: context.authority.store,
            transport: context.authority.transport,
            candidate: candidateBytes,
            workflowCommit,
            githubToken: "ghp_original_dispatch_fixture",
            testTransport: { kind: "local-test", apiBaseUrl },
          },
        });
        if (
          state.stages
            .slice(0, 8)
            .some((stage) => stage.status !== "succeeded") ||
          state.stages.find((stage) => stage.stage === "deploy")?.status !==
            "running" ||
          originalPosts.length !== 1
        )
          throw new Error(
            "Original worker did not retain an accepted lost-response dispatch"
          );
        saved = JSON.parse(
          readFileSync(
            join(
              context.operatorDirectory,
              "weekly-publication",
              state.runId,
              "dispatch/pages-dispatch.json"
            ),
            "utf8"
          )
        ) as SavedPagesDispatch;
        if (saved.receipt)
          throw new Error("Original accepted response was not actually lost");
        return options.afterAccepted
          ? options.afterAccepted(
              context,
              state,
              candidateBytes,
              workflowCommit,
              saved
            )
          : state;
      },
    });
    originalPhase = false;
    let active = 0,
      closing = false;
    let closePromise: Promise<void> | undefined;
    const closeWhenIdle = () => {
      if (active) return Promise.resolve();
      closePromise ??= new Promise<void>((done, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : done()));
      }).then(() => core.close());
      return closePromise;
    };
    return {
      base: core.base,
      initial: core.initial,
      originalPaths: core.originalPaths,
      configuration: core.configuration,
      ledgerRevision: core.ledgerRevision,
      saved: saved!,
      originalPosts,
      preserve: () => core.preserve(),
      async track<T>(operation: () => Promise<T>): Promise<T> {
        active++;
        try {
          return await core.track(operation);
        } finally {
          active--;
          if (closing) await closeWhenIdle();
        }
      },
      async prepare(name: string, ids = [101]) {
        listedRunIds = ids;
        const f = await core.prepare(name);
        const { sourceCommit: _sourceCommit, ...portableInput } = f.input;
        const start = requests.length;
        const input = {
          ...portableInput,
          workflowCommit,
          githubToken: "ghp_recovery_dispatch_fixture",
          pagesApiBaseUrl: apiBaseUrl,
        };
        const path = join(
          input.destination,
          "operator/weekly-publication",
          input.runId,
          "dispatch/pages-dispatch.json"
        );
        if (!existsSync(path))
          throw new Error(
            "Captured original private dispatch intent is missing"
          );
        const originalProducerDispatchBytes = readFileSync(path);
        return {
          ...f,
          input,
          requests: () => requests.slice(start),
          saved: () =>
            JSON.parse(readFileSync(path, "utf8")) as SavedPagesDispatch,
          injectReceipt999() {
            writeFileSync(
              path,
              JSON.stringify({
                ...saved!,
                receipt: {
                  intent: saved!.intent,
                  controlHead: saved!.pendingAppend.attemptedHead,
                  runId: "999",
                  runUrl:
                    "https://api.github.com/repos/prodigic/zivv/actions/runs/999",
                  htmlUrl: "https://github.com/prodigic/zivv/actions/runs/999",
                },
              }) + "\n"
            );
          },
          restoreOriginalProducerDispatchBytes() {
            writeFileSync(path, originalProducerDispatchBytes);
          },
        };
      },
      async close() {
        closing = true;
        await closeWhenIdle();
      },
    };
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
}
