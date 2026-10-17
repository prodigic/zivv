import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  cancelGithubPagesDeployment,
  getGithubPagesDeployment,
  normalizePagesDeploymentId,
  parsePagesDeploymentReceipt,
  requestGithubPagesDeployment,
  type PagesDeploymentIntent,
  type PagesDeploymentReceipt,
} from "../../lib/ingestion/pages-deployment.js";

const workflowCommit = "b".repeat(40);
const githubToken = "ghp_test_secret_credentials";
const authority: PagesDeploymentIntent = {
  repository: "prodigic/zivv",
  artifactId: "201",
  workflowCommit,
  owner: {
    operationId: "a".repeat(64),
    requestId: "c".repeat(64),
    attemptId: "d".repeat(64),
    runId: "101",
    runAttempt: 2,
  },
};
function oidc(changed: Record<string, unknown> = {}) {
  return (
    [
      { alg: "RS256" },
      {
        iss: "https://token.actions.githubusercontent.com",
        repository: authority.repository,
        sha: workflowCommit,
        ref: `refs/tags/zivv-workflows/${workflowCommit}`,
        environment: "github-pages",
        run_id: "101",
        run_attempt: "2",
        exp: Math.floor(Date.now() / 1000) + 300,
        ...changed,
      },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".") + ".testSignature"
  );
}
const apiRoute = "/repos/prodigic/zivv/pages/deployments";
const created = {
  id: "301",
  status_url: `https://api.github.com${apiRoute}/301/status`,
  page_url: "http://www.prodigic.com/zivv/",
};
const durableReceipt: PagesDeploymentReceipt = {
  ...authority,
  deploymentId: "301",
  pageUrl: "https://www.prodigic.com/zivv/",
};

describe("durable exact GitHub Pages REST effects", () => {
  let server: ReturnType<typeof createServer>;
  let apiBaseUrl: string;
  let events: string[];
  let requests: {
    method: string;
    url: string;
    headers: IncomingMessage["headers"];
    body: string;
  }[];
  let respond: (request: IncomingMessage, response: ServerResponse) => void;
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  beforeEach(async () => {
    events = [];
    requests = [];
    respond = (_request, response) => json(response, 200, created);
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        events.push(request.method ?? "");
        respond(request, response);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const options = () => ({
    githubToken,
    timeoutMs: 1_000,
    testTransport: { kind: "local-test" as const, apiBaseUrl },
  });
  const createInput = () => ({
    ...authority,
    ...options(),
    oidcToken: oidc(),
    onIntent: async (value: PagesDeploymentIntent) => {
      events.push("intent");
      expect(Object.keys(value).sort()).toEqual([
        "artifactId",
        "owner",
        "repository",
        "workflowCommit",
      ]);
      expect(value).toEqual(authority);
    },
    onCreated: async (value: PagesDeploymentReceipt) => {
      events.push("receipt");
      expect(value).toEqual(durableReceipt);
    },
  });
  it("persists safe intent, creates once, persists exact ID, then polls that ID", async () => {
    const input = createInput();
    const result = await requestGithubPagesDeployment(input);
    expect(result).toEqual({ status: "created", receipt: durableReceipt });
    expect(events).toEqual(["intent", "POST", "receipt"]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: apiRoute,
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    expect(JSON.parse(requests[0].body)).toEqual({
      artifact_id: 201,
      pages_build_version: workflowCommit,
      oidc_token: input.oidcToken,
      environment: "github-pages",
    });
    respond = (_request, response) =>
      json(response, 200, { status: "succeed" });
    const status = await getGithubPagesDeployment({
      ...options(),
      receipt: durableReceipt,
    });
    expect(status).toMatchObject({
      classification: "succeeded",
      apiStatus: "succeed",
      receipt: durableReceipt,
    });
    expect(requests[1]).toMatchObject({
      method: "GET",
      url: `${apiRoute}/301`,
      body: "",
    });
    expect(events).toEqual(["intent", "POST", "receipt", "GET"]);
    expect(JSON.stringify(result)).not.toContain(input.oidcToken);
    expect(JSON.stringify(result)).not.toContain(githubToken);
  });
  it("does not POST when durable intent persistence fails", async () => {
    const input = createInput();
    input.onIntent = async () => {
      throw new Error(input.oidcToken + githubToken);
    };
    await expect(requestGithubPagesDeployment(input)).rejects.toThrow(
      "intent could not be persisted"
    );
    expect(requests).toHaveLength(0);
  });
  it("starts the network deadline after durable intent persistence", async () => {
    const input = createInput();
    input.timeoutMs = 100;
    const persist = input.onIntent;
    input.onIntent = async (value) => {
      await new Promise((done) => setTimeout(done, 160));
      await persist(value);
    };
    expect((await requestGithubPagesDeployment(input)).status).toBe("created");
    expect(events).toEqual(["intent", "POST", "receipt"]);
  });
  it("preserves readable edition request IDs from durable promotion control", async () => {
    const input = createInput();
    input.owner = { ...authority.owner, requestId: "edition-2026-10-16" };
    input.onIntent = async (value) => {
      expect(value.owner.requestId).toBe("edition-2026-10-16");
    };
    input.onCreated = async (value) => {
      expect(value.owner.requestId).toBe("edition-2026-10-16");
    };
    expect((await requestGithubPagesDeployment(input)).status).toBe("created");
    expect(requests).toHaveLength(1);
  });
  it("retains known ownership and ID when returned receipt cannot be persisted", async () => {
    const input = createInput();
    input.onCreated = async () => {
      throw new Error(input.oidcToken);
    };
    const result = await requestGithubPagesDeployment(input);
    expect(result).toEqual({
      status: "uncertain",
      intent: authority,
      receipt: durableReceipt,
      reason: "receipt-persistence",
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(input.oidcToken);
  });
  it("captures validated credentials before a durable callback can mutate input", async () => {
    const input = createInput();
    const expectedToken = input.oidcToken;
    input.onIntent = async () => {
      input.oidcToken = oidc({ run_id: "999" });
      input.githubToken = "different";
    };
    expect((await requestGithubPagesDeployment(input)).status).toBe("created");
    expect(JSON.parse(requests[0].body).oidc_token).toBe(expectedToken);
    expect(requests[0].headers.authorization).toBe(`Bearer ${githubToken}`);
  });
  it("redacts credentials encoded with JSON unicode escapes", async () => {
    const input = createInput();
    respond = (_request, response) => {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          message: githubToken + " " + input.oidcToken,
        }).replace(/g/g, "\\u0067")
      );
    };
    const result = await requestGithubPagesDeployment(input);
    expect(result.status).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain(githubToken);
    expect(JSON.stringify(result)).not.toContain(input.oidcToken);
  });
  it("keeps a lost POST response uncertain and never retries or guesses a deployment", async () => {
    respond = (request) => request.socket.destroy();
    const result = await requestGithubPagesDeployment(createInput());
    expect(result).toEqual({
      status: "uncertain",
      intent: authority,
      reason: "transport",
    });
    expect(requests).toHaveLength(1);
    expect(events).toEqual(["intent", "POST"]);
  });
  it.each([400, 401, 403, 404, 422, 429, 408, 500, 502])(
    "retains safe API diagnostics without automatically repeating a %s response",
    async (httpStatus) => {
      const input = createInput();
      respond = (_request, response) =>
        json(response, httpStatus, {
          message: input.oidcToken + " " + githubToken,
        });
      const result = await requestGithubPagesDeployment(input);
      expect(result.status).toBe(
        httpStatus < 500 && httpStatus !== 408 ? "rejected" : "uncertain"
      );
      expect(result).toMatchObject({
        intent: authority,
        diagnostic: { httpStatus },
      });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(input.oidcToken);
      expect(JSON.stringify(result)).not.toContain(githubToken);
      expect(events).toEqual(["intent", "POST"]);
    }
  );
  it.each([
    { page_url: "https://evil.example/zivv/" },
    { page_url: "https://www.prodigic.com/zivv/?token=secret" },
    { page_url: "https://www.prodigic.com:4430/zivv/" },
    { status_url: `https://api.github.com${apiRoute}/999` },
    { status_url: `https://evil.example${apiRoute}/301` },
    { id: "../../../other-repo" },
    { id: 9007199254740992 },
  ])(
    "keeps unexpected create identity or destination uncertain: %j",
    async (changed) => {
      respond = (_request, response) =>
        json(response, 200, { ...created, ...changed });
      expect(await requestGithubPagesDeployment(createInput())).toMatchObject({
        status: "uncertain",
        reason: "response",
        intent: authority,
      });
      expect(events).toEqual(["intent", "POST"]);
    }
  );
  it("does not follow API redirects with credentials", async () => {
    respond = (_request, response) => {
      response.writeHead(302, { location: apiBaseUrl + "/different" });
      response.end();
    };
    expect(await requestGithubPagesDeployment(createInput())).toMatchObject({
      status: "uncertain",
    });
    expect(requests).toHaveLength(1);
  });
  it.each([
    { repository: "other/zivv" },
    { run_id: "999" },
    { run_attempt: "1" },
    { sha: "e".repeat(40) },
    { ref: "refs/heads/main" },
    { environment: "other" },
    { exp: 1 },
  ])(
    "rejects OIDC claims for a different authority before durable intent: %j",
    async (changed) => {
      await expect(
        requestGithubPagesDeployment({
          ...createInput(),
          oidcToken: oidc(changed),
        })
      ).rejects.toThrow("OIDC claims");
      expect(events).toEqual([]);
      expect(requests).toHaveLength(0);
    }
  );
  it("rejects a different repository, invalid artifact or run authority before requests", async () => {
    for (const changed of [
      { repository: "prodigic/zivv-test" as "prodigic/zivv" },
      { artifactId: "01" },
      { artifactId: "9007199254740992" },
      { owner: { ...authority.owner, attemptId: "bad" } },
      { owner: { ...authority.owner, runAttempt: 0 } },
    ])
      await expect(
        requestGithubPagesDeployment({ ...createInput(), ...changed })
      ).rejects.toThrow("authority");
    expect(requests).toHaveLength(0);
  });
  it("limits test API overrides to explicit loopback origins", async () => {
    for (const apiBaseUrl of [
      "http://evil.example",
      "https://api.github.com",
      "http://127.0.0.1/path",
      "http://user:pass@127.0.0.1",
      "http://127.0.0.1/?secret=token",
    ]) {
      await expect(
        requestGithubPagesDeployment({
          ...createInput(),
          testTransport: { kind: "local-test", apiBaseUrl },
        })
      ).rejects.toThrow("loopback");
    }
    expect(requests).toHaveLength(0);
  });
  it("bounds a stalled create response and retains uncertainty after submission", async () => {
    respond = () => {};
    const started = Date.now();
    expect(
      await requestGithubPagesDeployment({ ...createInput(), timeoutMs: 50 })
    ).toMatchObject({ status: "uncertain", reason: "transport" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(requests).toHaveLength(1);
  });
  it("honors an already aborted request before intent or POST", async () => {
    await expect(
      requestGithubPagesDeployment({
        ...createInput(),
        signal: AbortSignal.abort(),
      })
    ).rejects.toThrow("aborted before creation");
    expect(events).toEqual([]);
  });
  it("bounds API response bodies without publishing a receipt", async () => {
    respond = (_request, response) =>
      json(response, 200, { message: "x".repeat(70_000) });
    expect(await requestGithubPagesDeployment(createInput())).toMatchObject({
      status: "uncertain",
      reason: "transport",
    });
    expect(events).toEqual(["intent", "POST"]);
  });
  it.each([
    ["succeed", "succeeded"],
    ["deployment_failed", "failed"],
    ["deployment_perms_error", "failed"],
    ["deployment_content_failed", "failed"],
    ["deployment_cancelled", "failed"],
    ["deployment_in_progress", "in-progress"],
    ["unknown_status", "in-progress"],
    ["not_found", "in-progress"],
    ["deployment_attempt_error", "in-progress"],
    ["deployment_lost", "uncertain"],
    ["new-undocumented-status", "uncertain"],
  ])(
    "classifies exact deployment status %s as %s",
    async (status, classification) => {
      respond = (_request, response) => json(response, 200, { status });
      expect(
        await getGithubPagesDeployment({
          ...options(),
          receipt: durableReceipt,
        })
      ).toMatchObject({
        classification,
        apiStatus: status,
        receipt: durableReceipt,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(`${apiRoute}/301`);
    }
  );
  it("preserves exact identity and sanitized diagnostics when status response names a different ID", async () => {
    respond = (_request, response) =>
      json(response, 200, { id: "999", status: "succeed", error: githubToken });
    const result = await getGithubPagesDeployment({
      ...options(),
      receipt: durableReceipt,
    });
    expect(result).toMatchObject({
      classification: "uncertain",
      receipt: durableReceipt,
      diagnostic: { httpStatus: 200 },
    });
    expect(JSON.stringify(result)).not.toContain(githubToken);
  });
  it("keeps an unavailable status lookup uncertain without a create", async () => {
    respond = (_request, response) =>
      json(response, 404, { message: "not found" });
    expect(
      await getGithubPagesDeployment({ ...options(), receipt: durableReceipt })
    ).toMatchObject({
      classification: "uncertain",
      apiStatus: null,
      diagnostic: { httpStatus: 404 },
    });
    expect(requests[0].method).toBe("GET");
  });
  it("cancels the known exact deployment once and awaits independent terminal status", async () => {
    respond = (_request, response) => {
      response.writeHead(204);
      response.end();
    };
    expect(
      await cancelGithubPagesDeployment({
        ...options(),
        receipt: durableReceipt,
      })
    ).toMatchObject({ status: "accepted", receipt: durableReceipt });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: `${apiRoute}/301/cancel`,
      body: "",
    });
  });
  it.each(["301", 301, "a".repeat(40), "11111111-2222-3333-4444-555555555555"])(
    "normalizes documented and deployed safe IDs verbatim: %s",
    (id) => {
      expect(normalizePagesDeploymentId(id)).toBe(String(id));
    }
  );
  it("canonicalizes only the fixed public-safe receipt fields", () => {
    expect(
      parsePagesDeploymentReceipt({
        ...durableReceipt,
        pageUrl: "http://www.prodigic.com/zivv/",
      })
    ).toEqual(durableReceipt);
    expect(Object.isFrozen(parsePagesDeploymentReceipt(durableReceipt))).toBe(
      true
    );
  });
  it.each([
    { ...durableReceipt, githubToken },
    {
      ...durableReceipt,
      owner: { ...authority.owner, privatePath: "operator-only" },
    },
    { ...durableReceipt, pageUrl: "https://example.com/" },
    { ...durableReceipt, artifactId: 201 },
    { ...durableReceipt, owner: { ...authority.owner, runAttempt: "2" } },
  ])(
    "rejects noncanonical durable receipt metadata before it can be logged",
    (value) => {
      expect(() => parsePagesDeploymentReceipt(value)).toThrow();
      expect(requests).toHaveLength(0);
    }
  );
});
