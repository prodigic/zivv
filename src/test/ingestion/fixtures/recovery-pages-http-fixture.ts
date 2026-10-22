import { createServer, type Server } from "node:http";

const repositoryPath = "/repos/prodigic/zivv";
const workflowName = "publish-candidate.yml";
const workflowPath = ".github/workflows/publish-candidate.yml";
const maxDispatchBodyBytes = 64 * 1024;

export interface RecoveryPagesHttpFixtureOptions {
  workflowCommit: string;
  loseFirstAcceptedResponse?: boolean;
}

export interface RecoveryPagesDispatch {
  ref: string;
  inputs: Record<string, string>;
}

export interface RecoveryPagesHttpFixture {
  pagesApiBaseUrl: string;
  requests: { method: string; url: string }[];
  dispatches: RecoveryPagesDispatch[];
  close(): Promise<void>;
}

function json(response: import("node:http").ServerResponse, value: unknown) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

async function dispatchBody(
  request: import("node:http").IncomingMessage
): Promise<RecoveryPagesDispatch | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxDispatchBodyBytes) return undefined;
    chunks.push(bytes);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const body = value as Record<string, unknown>;
  if (
    typeof body.ref !== "string" ||
    body.ref.length === 0 ||
    body.ref.length > 4096 ||
    (body.return_run_details !== undefined &&
      body.return_run_details !== true) ||
    !body.inputs ||
    typeof body.inputs !== "object" ||
    Array.isArray(body.inputs)
  )
    return undefined;
  const inputEntries = Object.entries(body.inputs);
  if (
    inputEntries.length === 0 ||
    inputEntries.length > 32 ||
    inputEntries.some(
      ([name, input]) =>
        !name ||
        name.length > 128 ||
        typeof input !== "string" ||
        input.length > 4096
    )
  )
    return undefined;
  return {
    ref: body.ref,
    inputs: Object.fromEntries(inputEntries) as Record<string, string>,
  };
}

function runFor(
  workflowCommit: string,
  dispatch: RecoveryPagesDispatch | undefined
) {
  if (!dispatch) return null;
  return {
    id: 101,
    event: "workflow_dispatch",
    head_sha: workflowCommit,
    head_branch: dispatch.ref,
    display_title: `zivv-pages/${dispatch.inputs.operation_id}/${dispatch.inputs.mode}/${dispatch.inputs.attempt_id}`,
    path: workflowPath,
    run_attempt: 1,
    repository: { full_name: "prodigic/zivv" },
    url: "https://api.github.com/repos/prodigic/zivv/actions/runs/101",
    html_url: "https://github.com/prodigic/zivv/actions/runs/101",
    inputs: dispatch.inputs,
  };
}

/** A loopback-only Pages API fixture for deterministic accepted/lost-response recovery. */
export async function createRecoveryPagesHttpFixture(
  options: RecoveryPagesHttpFixtureOptions
): Promise<RecoveryPagesHttpFixture> {
  if (!/^[a-f0-9]{40}$/.test(options.workflowCommit))
    throw new Error("Invalid recovery Pages workflow commit");

  const requests: { method: string; url: string }[] = [];
  const dispatches: RecoveryPagesDispatch[] = [];
  let droppedAcceptedResponse = false;
  const server: Server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const requestUrl = request.url ?? "";
    requests.push({ method, url: requestUrl });
    response.setHeader("Content-Type", "application/json");

    let pathname: string;
    try {
      pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
    } catch {
      response.statusCode = 400;
      json(response, {});
      return;
    }

    if (
      method === "GET" &&
      pathname ===
        `${repositoryPath}/git/ref/tags/zivv-workflows/${options.workflowCommit}`
    ) {
      json(response, {
        ref: `refs/tags/zivv-workflows/${options.workflowCommit}`,
        object: { type: "commit", sha: options.workflowCommit },
      });
      return;
    }

    const dispatchPath = `${repositoryPath}/actions/workflows/${workflowName}/dispatches`;
    if (method === "POST" && pathname === dispatchPath) {
      const dispatch = await dispatchBody(request);
      if (!dispatch) {
        response.statusCode = 400;
        json(response, {});
        return;
      }
      dispatches.push(dispatch);
      if (options.loseFirstAcceptedResponse && !droppedAcceptedResponse) {
        droppedAcceptedResponse = true;
        response.destroy();
        return;
      }
      json(response, {
        workflow_run_id: 101,
        run_url: "https://api.github.com/repos/prodigic/zivv/actions/runs/101",
        html_url: "https://github.com/prodigic/zivv/actions/runs/101",
      });
      return;
    }

    const run = runFor(options.workflowCommit, dispatches.at(-1));
    if (
      method === "GET" &&
      pathname === `${repositoryPath}/actions/workflows/${workflowName}/runs`
    ) {
      json(response, {
        total_count: run ? 1 : 0,
        workflow_runs: run ? [run] : [],
      });
      return;
    }
    if (method === "GET" && pathname === `${repositoryPath}/actions/runs/101`) {
      if (!run) {
        response.statusCode = 404;
        json(response, {});
        return;
      }
      json(response, run);
      return;
    }

    response.statusCode = 404;
    json(response, {});
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose())
    );
    throw new Error("Missing recovery Pages fixture HTTP address");
  }

  return {
    pagesApiBaseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    dispatches,
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeAllConnections();
      });
    },
  };
}
