import { describe, expect, it, vi } from "vitest";
import {
  ensureReviewedPagesWorkflowTag,
  preparePagesWorkflowDispatch,
  recoverGithubPagesWorkflowDispatch,
  requestGithubPagesWorkflowDispatch,
  type PagesWorkflowDispatchIntent,
  type PagesWorkflowDispatchReceipt,
} from "../../lib/ingestion/pages-dispatch.js";
import {
  applyPromotionTransition,
  claimPromotion,
} from "../../lib/ingestion/promotion-control.js";
import { createPromotionControlFixture } from "./fixtures/promotion-control-fixture.js";

const workflowCommit = "b".repeat(40);
const oldHead = "c".repeat(40);
const controlHead = "d".repeat(40);
const githubToken = "ghp_fixture_secret";
const apiRoot = "https://api.github.com/repos/prodigic/zivv";
const dispatchRoute =
  "/repos/prodigic/zivv/actions/workflows/publish-candidate.yml/dispatches";
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const accepted = {
  workflow_run_id: 101,
  run_url: `${apiRoot}/actions/runs/101`,
  html_url: "https://github.com/prodigic/zivv/actions/runs/101",
};
function fixture() {
  const value = createPromotionControlFixture();
  let state = claimPromotion(value.state, value.request);
  const intent = preparePagesWorkflowDispatch({
    control: state,
    controlHead: oldHead,
    workflowCommit,
    mode: "promote",
    reviewedMainAncestor: true,
  });
  const events: string[] = [];
  const requests: { url: string; options?: RequestInit }[] = [];
  let respond = async () => response(accepted);
  const fetcher: typeof fetch = async (url, options) => {
    events.push(options?.method ?? "GET");
    requests.push({ url: String(url), options });
    return respond();
  };
  const transport = {
    githubToken,
    testTransport: {
      kind: "local-test" as const,
      apiBaseUrl: "http://127.0.0.1:4567",
      fetch: fetcher,
    },
  };
  const onIntent = async (value: PagesWorkflowDispatchIntent) => {
    events.push("intent");
    expect(value.expectedControlHead).toBe(oldHead);
    const next = applyPromotionTransition(state, value.event);
    if (next.stateId === state.stateId)
      throw new Error("CAS replay cannot dispatch");
    state = next;
    return { controlHead };
  };
  const receipts: PagesWorkflowDispatchReceipt[] = [];
  const onDispatched = async (receipt: PagesWorkflowDispatchReceipt) => {
    events.push("receipt");
    receipts.push(receipt);
  };
  return {
    intent,
    events,
    requests,
    receipts,
    transport,
    onIntent,
    onDispatched,
    input: { intent, ...transport, onIntent, onDispatched },
    state: () => state,
    respond: (fn: typeof respond) => {
      respond = fn;
    },
  };
}
function run(
  intent: PagesWorkflowDispatchIntent,
  changes: Record<string, unknown> = {}
) {
  return {
    id: 101,
    display_title: intent.runName,
    event: "workflow_dispatch",
    head_sha: workflowCommit,
    head_branch: intent.ref,
    path: ".github/workflows/publish-candidate.yml",
    run_attempt: 1,
    repository: { full_name: "prodigic/zivv" },
    url: accepted.run_url,
    html_url: accepted.html_url,
    ...changes,
  };
}

describe("reviewed immutable Pages workflow dispatch", () => {
  it("derives a legacy rollback solely from the prior verified public snapshot", async () => {
    const f = fixture();
    await f.onIntent(f.intent);
    let state = applyPromotionTransition(f.state(), {
      type: "admit-run",
      operationId: f.intent.event.operationId,
      mode: "promote",
      attemptId: f.intent.event.attemptId,
      admission: { workflowCommit, runId: "101", runAttempt: 1 },
    });
    state = applyPromotionTransition(state, {
      type: "failed",
      operationId: f.intent.event.operationId,
      mode: "promote",
      attemptId: f.intent.event.attemptId,
      failureReceiptId: "e".repeat(64),
    });
    const intent = preparePagesWorkflowDispatch({
      control: state,
      controlHead,
      workflowCommit,
      reviewedMainAncestor: true,
      mode: "rollback",
    });
    expect(intent.inputs).toMatchObject({
      mode: "rollback",
      candidate_id: "legacy",
      source_commit: "a".repeat(40),
      payload_commit: "a".repeat(40),
      request_id: f.intent.inputs.request_id,
    });
    expect(intent.event.attemptId).not.toBe(f.intent.event.attemptId);
    expect(intent.runName).toContain(`/rollback/${intent.event.attemptId}`);
    const result = await requestGithubPagesWorkflowDispatch({
      ...f.input,
      intent,
      onIntent: async (value) => {
        state = applyPromotionTransition(state, value.event);
        return { controlHead: "e".repeat(40) };
      },
    });
    expect(result.status).toBe("dispatched");
    expect(state.active?.phase).toBe("rollback-planned");
  });
  it("requires independently reviewed ancestry and a closed production destination", () => {
    const fixture = createPromotionControlFixture("preview");
    const state = claimPromotion(fixture.state, fixture.request);
    expect(() =>
      preparePagesWorkflowDispatch({
        control: state,
        controlHead,
        workflowCommit,
        mode: "promote",
        reviewedMainAncestor: true,
      })
    ).toThrow("production");
    expect(() =>
      preparePagesWorkflowDispatch({
        control: state,
        controlHead,
        workflowCommit,
        mode: "promote",
        reviewedMainAncestor: false as true,
      })
    ).toThrow("ancestry");
  });
  it("persists a fresh native intent before one exact nine-input POST and persists safe run details", async () => {
    const f = fixture();
    const result = await requestGithubPagesWorkflowDispatch(f.input);
    expect(result.status).toBe("dispatched");
    expect(f.events).toEqual(["intent", "POST", "receipt"]);
    expect(f.state().active?.promotionAttempt?.attemptId).toBe(
      f.intent.event.attemptId
    );
    expect(f.requests[0].url).toBe(`http://127.0.0.1:4567${dispatchRoute}`);
    expect(f.requests[0].options?.redirect).toBe("error");
    expect(f.requests[0].options?.headers).toMatchObject({
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${githubToken}`,
    });
    const payload = JSON.parse(String(f.requests[0].options?.body)) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      ref: `zivv-workflows/${workflowCommit}`,
      inputs: { ...f.intent.inputs, control_head: controlHead },
      return_run_details: true,
    });
    expect(Object.keys(payload.inputs as object)).toHaveLength(9);
    expect(JSON.stringify(f.receipts)).not.toContain(githubToken);
    expect(f.receipts[0]).toMatchObject({
      controlHead,
      runId: "101",
      runUrl: accepted.run_url,
      htmlUrl: accepted.html_url,
    });
  });
  it("starts the HTTP deadline after the durable controller callback", async () => {
    const f = fixture();
    const persist = f.input.onIntent;
    const result = await requestGithubPagesWorkflowDispatch({
      ...f.input,
      timeoutMs: 50,
      onIntent: async (value) => {
        await new Promise((done) => setTimeout(done, 100));
        return persist(value);
      },
    });
    expect(result.status).toBe("dispatched");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].options?.signal?.aborted).toBe(false);
  });
  it("refuses CAS replay and never posts the same planned attempt again", async () => {
    const f = fixture();
    await requestGithubPagesWorkflowDispatch(f.input);
    await expect(requestGithubPagesWorkflowDispatch(f.input)).rejects.toThrow(
      "newly persisted"
    );
    expect(f.requests).toHaveLength(1);
    expect(() =>
      preparePagesWorkflowDispatch({
        control: f.state(),
        controlHead,
        workflowCommit,
        reviewedMainAncestor: true,
        mode: "promote",
      })
    ).toThrow();
  });
  it("does not POST when persistence fails or returns the old head", async () => {
    for (const onIntent of [
      async () => {
        throw new Error(githubToken);
      },
      async () => ({ controlHead: oldHead }),
    ]) {
      const f = fixture();
      await expect(
        requestGithubPagesWorkflowDispatch({ ...f.input, onIntent })
      ).rejects.toThrow("newly persisted");
      expect(f.requests).toHaveLength(0);
    }
  });
  it("retains uncertain ownership after lost response and redacts all transport error details", async () => {
    const f = fixture();
    f.respond(async () => {
      throw new Error(githubToken);
    });
    const result = await requestGithubPagesWorkflowDispatch(f.input);
    expect(result).toMatchObject({
      status: "uncertain",
      reason: "transport",
      controlHead,
    });
    expect(f.requests).toHaveLength(1);
    expect(f.receipts).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(githubToken);
    expect(f.state().active?.phase).toBe("dispatch-planned");
    await expect(requestGithubPagesWorkflowDispatch(f.input)).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });
  it.each([204, 302, 403, 408, 422, 429, 500])(
    "retains uncertain intent on HTTP %s without a blind retry",
    async (status) => {
      const f = fixture();
      f.respond(async () =>
        status === 204
          ? new Response(null, { status })
          : response({ message: githubToken }, status)
      );
      const result = await requestGithubPagesWorkflowDispatch(f.input);
      expect(result).toMatchObject({
        status: "uncertain",
        reason: "api",
        httpStatus: status,
      });
      expect(f.requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(githubToken);
    }
  );
  it.each([
    { ...accepted, workflow_run_id: Number.MAX_SAFE_INTEGER + 1 },
    { ...accepted, run_url: "https://other.example/run/101" },
    { ...accepted, html_url: `${accepted.html_url}?token=${githubToken}` },
    { id: 101, url: accepted.run_url, html_url: accepted.html_url },
  ])("rejects malformed or unrelated run-details receipt", async (value) => {
    const f = fixture();
    f.respond(async () => response(value));
    const result = await requestGithubPagesWorkflowDispatch(f.input);
    expect(result).toMatchObject({ status: "uncertain", reason: "response" });
    expect(f.receipts).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(githubToken);
  });
  it("returns the exact safe receipt if its durable callback fails", async () => {
    const f = fixture();
    const result = await requestGithubPagesWorkflowDispatch({
      ...f.input,
      onDispatched: async () => {
        throw new Error(githubToken);
      },
    });
    expect(result).toMatchObject({
      status: "uncertain",
      reason: "receipt-persistence",
      receipt: { runId: "101", controlHead },
    });
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(githubToken);
  });
  it("blocks redirected fixture credentials, mutable refs, wrong repository and preview before intent", async () => {
    const f = fixture();
    for (const intent of [
      { ...f.intent, ref: "main" },
      { ...f.intent, repository: "prodigic/zivv-test" as "prodigic/zivv" },
      {
        ...f.intent,
        inputs: { ...f.intent.inputs, destination: "preview" as "production" },
      },
    ])
      await expect(
        requestGithubPagesWorkflowDispatch({ ...f.input, intent })
      ).rejects.toThrow();
    await expect(
      requestGithubPagesWorkflowDispatch({
        ...f.input,
        testTransport: {
          kind: "local-test",
          apiBaseUrl: "https://attacker.example",
          fetch: vi.fn(),
        },
      })
    ).rejects.toThrow("loopback");
    expect(f.events).toEqual([]);
  });
  it("does not dispatch after cancellation while persisting the durable intent", async () => {
    const f = fixture();
    const abort = new AbortController();
    const result = await requestGithubPagesWorkflowDispatch({
      ...f.input,
      signal: abort.signal,
      onIntent: async (value) => {
        const saved = await f.onIntent(value);
        abort.abort();
        return saved;
      },
    });
    expect(result).toMatchObject({ status: "uncertain", reason: "transport" });
    expect(f.requests).toHaveLength(0);
  });
});

describe("exact attempt workflow recovery", () => {
  it("recovers only the uniquely bound run and validates exposed inputs", async () => {
    const f = fixture();
    f.respond(async () =>
      response({
        total_count: 2,
        workflow_runs: [
          run(f.intent, { id: 99, display_title: "unrelated" }),
          run(f.intent, {
            inputs: { ...f.intent.inputs, control_head: controlHead },
          }),
        ],
      })
    );
    const result = await recoverGithubPagesWorkflowDispatch({
      ...f.transport,
      intent: f.intent,
      controlHead,
    });
    expect(result).toMatchObject({
      status: "matched",
      receipt: { runId: "101" },
    });
    expect(f.events).toEqual(["GET"]);
    expect(f.requests[0].url).toContain(`head_sha=${workflowCommit}`);
    expect(f.requests[0].options?.redirect).toBe("error");
  });
  it.each([
    { display_title: "unrelated-attempt" },
    { head_sha: "a".repeat(40) },
    { event: "push" },
    { path: ".github/workflows/deploy.yml" },
    { head_branch: "main" },
    { ref: "refs/heads/main" },
    { run_attempt: 2 },
    { repository: { full_name: "prodigic/zivv-test" } },
    { inputs: { request_id: "unrelated" } },
  ])("never adopts a run with mismatched identity %j", async (changes) => {
    const f = fixture();
    f.respond(async () =>
      response({ total_count: 1, workflow_runs: [run(f.intent, changes)] })
    );
    expect(
      await recoverGithubPagesWorkflowDispatch({
        ...f.transport,
        intent: f.intent,
        controlHead,
      })
    ).toEqual({ status: "uncertain", reason: "no-match" });
    expect(f.requests).toHaveLength(1);
  });
  it.each([
    { total_count: 0, count: 0, reason: "no-match" },
    { total_count: 2, count: 2, reason: "ambiguous" },
    { total_count: 101, count: 1, reason: "incomplete-list" },
  ])(
    "keeps missing, ambiguous and incomplete listings uncertain",
    async ({ total_count, count, reason }) => {
      const f = fixture();
      f.respond(async () =>
        response({
          total_count,
          workflow_runs: Array.from({ length: count }, () => run(f.intent)),
        })
      );
      expect(
        await recoverGithubPagesWorkflowDispatch({
          ...f.transport,
          intent: f.intent,
          controlHead,
        })
      ).toEqual({ status: "uncertain", reason });
      expect(f.events).toEqual(["GET"]);
    }
  );
  it("validates exact saved run ID through read-only lookup", async () => {
    const f = fixture();
    f.respond(async () => response(run(f.intent)));
    expect(
      await recoverGithubPagesWorkflowDispatch({
        ...f.transport,
        intent: f.intent,
        controlHead,
        runId: "101",
      })
    ).toMatchObject({ status: "matched" });
    expect(f.requests[0].url).toBe(
      "http://127.0.0.1:4567/repos/prodigic/zivv/actions/runs/101"
    );
    f.respond(async () => response(run(f.intent, { id: 102 })));
    expect(
      await recoverGithubPagesWorkflowDispatch({
        ...f.transport,
        intent: f.intent,
        controlHead,
        runId: "101",
      })
    ).toEqual({ status: "uncertain", reason: "response" });
  });
});

describe("create-once reviewed workflow tag", () => {
  it("verifies a raced exact tag after create conflict without moving it", async () => {
    const f = fixture();
    const ref = `refs/tags/${f.intent.ref}`;
    let call = 0;
    f.respond(async () => {
      call++;
      return call === 1
        ? response({}, 404)
        : call === 2
          ? response({}, 422)
          : response({ ref, object: { type: "commit", sha: workflowCommit } });
    });
    expect(
      await ensureReviewedPagesWorkflowTag({
        ...f.transport,
        workflowCommit,
        reviewedMainAncestor: true,
      })
    ).toEqual({ status: "verified", ref });
    expect(f.events).toEqual(["GET", "POST", "GET"]);
  });
  it("does not repeat tag creation after losing its HTTP response", async () => {
    const f = fixture();
    let call = 0;
    f.respond(async () => {
      if (++call === 1) return response({}, 404);
      throw new Error(githubToken);
    });
    const result = await ensureReviewedPagesWorkflowTag({
      ...f.transport,
      workflowCommit,
      reviewedMainAncestor: true,
    });
    expect(result.status).toBe("uncertain");
    expect(JSON.stringify(result)).not.toContain(githubToken);
    expect(f.events).toEqual(["GET", "POST"]);
  });
  it("creates only a missing lightweight ref and re-verifies its exact target", async () => {
    const f = fixture();
    const ref = `refs/tags/${f.intent.ref}`;
    let call = 0;
    f.respond(async () => {
      call++;
      return call === 1
        ? response({}, 404)
        : call === 2
          ? response({}, 201)
          : response({ ref, object: { type: "commit", sha: workflowCommit } });
    });
    expect(
      await ensureReviewedPagesWorkflowTag({
        ...f.transport,
        workflowCommit,
        reviewedMainAncestor: true,
      })
    ).toEqual({ status: "verified", ref });
    expect(f.events).toEqual(["GET", "POST", "GET"]);
    expect(JSON.parse(String(f.requests[1].options?.body))).toEqual({
      ref,
      sha: workflowCommit,
    });
  });
  it("never moves an existing conflicting or annotated tag", async () => {
    const f = fixture();
    for (const target of [
      { type: "commit", sha: "e".repeat(40) },
      { type: "tag", sha: workflowCommit },
    ]) {
      f.respond(async () =>
        response({ ref: `refs/tags/${f.intent.ref}`, object: target })
      );
      expect(
        await ensureReviewedPagesWorkflowTag({
          ...f.transport,
          workflowCommit,
          reviewedMainAncestor: true,
        })
      ).toMatchObject({ status: "conflict" });
    }
    expect(f.events).toEqual(["GET", "GET"]);
  });
});
