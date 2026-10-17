import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBareTestPromotionControlTransport,
  createRemotePromotionControlStore,
  type PromotionControlStoreOptions,
} from "../../lib/ingestion/promotion-control-git.js";
import {
  applyPromotionTransition,
  candidatePublicReleaseId,
  claimPromotion,
  createCompletionProof,
  parsePromotionControl,
  promotionDigest,
  PROMOTION_DESTINATIONS,
  serializePromotionControl,
  validatePromotionAppend,
  type PromotionEvent,
} from "../../lib/ingestion/promotion-control.js";
import {
  runPagesCandidateDispatch,
  type PagesDispatchRunnerOptions,
} from "../../lib/ingestion/pages-dispatch-runner.js";
import {
  preparePagesWorkflowDispatch,
  type PagesWorkflowDispatchIntent,
} from "../../lib/ingestion/pages-dispatch.js";
import {
  createPromotionControlFixture,
  PROMOTION_FIXTURE_CHECKS,
  syntheticPromotionRequest,
} from "./fixtures/promotion-control-fixture.js";

const workflowCommit = "b".repeat(40);
const directories: string[] = [];
const accepted = {
  workflow_run_id: 101,
  run_url: "https://api.github.com/repos/prodigic/zivv/actions/runs/101",
  html_url: "https://github.com/prodigic/zivv/actions/runs/101",
};
interface SavedDispatch {
  schemaVersion: 1;
  intent: PagesWorkflowDispatchIntent;
  pendingAppend: {
    expectedHead: string;
    attemptedHead: string;
    bytes: string;
    createdAt: string;
  };
  receipt?: unknown;
}
const readSaved = (path: string): SavedDispatch =>
  JSON.parse(readFileSync(path, "utf8"));
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), "zivv-canonical-dispatch-")))
      throw new Error("Unsafe fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "zivv-canonical-dispatch-"));
  directories.push(directory);
  function git(args: string[], cwd: string, input?: string) {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    return execFileSync("git", args, {
      cwd,
      env,
      input,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  function initialize(name: string) {
    const path = join(directory, name);
    mkdirSync(path);
    git(["init", "--quiet", "--object-format=sha1"], path);
    return path;
  }
  const root = initialize("writer");
  const bare = join(directory, "remote.git");
  git(["init", "--quiet", "--bare", "--object-format=sha1", bare], directory);
  function options(repositoryRoot: string): PromotionControlStoreOptions {
    return {
      repositoryRoot,
      destination: "production",
      validateState(bytes, destination) {
        const state = parsePromotionControl(bytes);
        if (state.destination !== destination)
          throw new Error("Destination mismatch");
        return state.completionRoot;
      },
      validateTransition: validatePromotionAppend,
    };
  }
  const transport = createBareTestPromotionControlTransport(root, bare);
  const append = vi.fn(transport.append);
  const store = createRemotePromotionControlStore({
    ...options(root),
    transport: { ...transport, append },
  });
  const base = createPromotionControlFixture();
  let current = base.state;
  let head: string | null = null;
  function persist() {
    const result = store.compareAndAppend({
      expectedHead: head,
      bytes: serializePromotionControl(current),
      createdAt: "2026-10-16T12:00:00.123Z",
    });
    expect(result.status).toBe("appended");
    head = result.attemptedHead;
  }
  persist();
  current = claimPromotion(current, base.request);
  persist();
  function step(event: PromotionEvent) {
    const read = store.read();
    head = read.head;
    current = applyPromotionTransition(
      parsePromotionControl(read.bytes!),
      event
    );
    persist();
  }
  const intentDirectory = join(directory, "private-intent");
  mkdirSync(intentDirectory);
  const path = join(intentDirectory, "pages-dispatch.json");
  const requests: { url: string; method: string }[] = [];
  let original: SavedDispatch | undefined;
  let loseResponse = false;
  const fetcher: typeof fetch = async (url, init) => {
    const address = String(url),
      method = init?.method ?? "GET";
    requests.push({ url: address, method });
    if (address.includes("/git/ref/"))
      return response({
        ref: `refs/tags/zivv-workflows/${workflowCommit}`,
        object: { type: "commit", sha: workflowCommit },
      });
    if (method === "POST") {
      original = readSaved(path);
      expect(transport.readHead(store.ref)).toBe(
        original.pendingAppend.attemptedHead
      );
      if (loseResponse)
        throw new Error("Simulated lost accepted HTTP response");
      return response(accepted);
    }
    if (!original) throw new Error("No accepted workflow dispatch exists");
    const reconstructed = readSaved(path);
    expect(reconstructed.intent).toEqual(original.intent);
    expect(reconstructed.pendingAppend).toEqual(original.pendingAppend);
    const run = {
      id: 101,
      event: "workflow_dispatch",
      head_sha: workflowCommit,
      head_branch: original.intent.ref,
      display_title: original.intent.runName,
      path: ".github/workflows/publish-candidate.yml",
      run_attempt: 1,
      repository: { full_name: "prodigic/zivv" },
      url: accepted.run_url,
      html_url: accepted.html_url,
      inputs: {
        ...original.intent.inputs,
        control_head: original.pendingAppend.attemptedHead,
      },
    };
    return response(
      address.endsWith("/actions/runs/101")
        ? run
        : { total_count: 1, workflow_runs: [run] }
    );
  };
  const runner: PagesDispatchRunnerOptions = {
    command: "dispatch",
    repositoryRoot: root,
    workflowCommit,
    mode: "promote",
    intentDirectory,
    githubToken: "ghp_synthetic_fixture",
    store,
    controlledPublishing: "enabled",
    manualPublisherJoined: "true",
    testTransport: {
      kind: "local-test",
      apiBaseUrl: "http://127.0.0.1:4567",
      fetch: fetcher,
    },
  };
  function freshReader() {
    const readerRoot = initialize(`reader-${requests.length}`);
    const readerTransport = createBareTestPromotionControlTransport(
      readerRoot,
      bare
    );
    return createRemotePromotionControlStore({
      ...options(readerRoot),
      transport: { ...readerTransport, append },
    });
  }
  return {
    runner,
    store,
    append,
    path,
    requests,
    step,
    original: () => {
      if (!original) throw new Error("No original dispatch");
      return original;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    freshReader,
    refs: () => git(["show-ref"], bare),
  };
}

describe("native canonical dispatch recovery after private metadata loss", () => {
  it("recovers the accepted original dispatch with GET only after its response and local metadata are lost", async () => {
    const f = fixture();
    f.loseResponse();
    expect(await runPagesCandidateDispatch(f.runner)).toMatchObject({
      status: "uncertain",
      reason: "transport",
    });
    const original = f.original();
    expect(original.intent.event.dispatchNonce).toMatch(/^[a-f0-9]{64}$/);
    unlinkSync(f.path);
    const effects = f.append.mock.calls.length,
      refs = f.refs(),
      requestCount = f.requests.length;
    const options: PagesDispatchRunnerOptions = {
      ...f.runner,
      store: f.freshReader(),
      command: "recover",
      recovery: {
        operationId: original.intent.event.operationId,
        attemptId: original.intent.event.attemptId,
      },
    };
    expect(await runPagesCandidateDispatch(options)).toMatchObject({
      status: "matched",
      receipt: {
        runId: "101",
        controlHead: original.pendingAppend.attemptedHead,
      },
    });
    const restored = readSaved(f.path);
    expect(restored.intent).toEqual(original.intent);
    expect(restored.pendingAppend).toEqual(original.pendingAppend);
    // A second machine can retain the reconstructed private file while having
    // none of its immutable control objects yet. Acceptance still comes from
    // the fresh canonical read, and the saved receipt selects the exact run.
    expect(
      await runPagesCandidateDispatch({
        ...f.runner,
        command: "recover",
        store: f.freshReader(),
      })
    ).toMatchObject({ status: "matched" });
    expect(f.requests.at(-1)?.url).toContain("/actions/runs/101");
    expect(
      f.requests
        .slice(requestCount)
        .every((request) => request.method === "GET")
    ).toBe(true);
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    expect(f.append).toHaveBeenCalledTimes(effects);
    expect(f.refs()).toEqual(refs);
  }, 45_000);

  it("uses the historically admitted run ID after real completion and a later native owner", async () => {
    const f = fixture();
    expect(await runPagesCandidateDispatch(f.runner)).toMatchObject({
      status: "dispatched",
    });
    const original = f.original();
    const owner = {
      operationId: original.intent.event.operationId,
      mode: "promote" as const,
      attemptId: original.intent.event.attemptId,
    };
    const admission = { workflowCommit, runId: "101", runAttempt: 1 };
    f.step({ type: "admit-run", ...owner, admission });
    const deployment = { admission, artifactId: "201", deploymentId: "301" };
    f.step({ type: "deployed", ...owner, deployment });
    const active = parsePromotionControl(f.store.read().bytes!).active!;
    const body = {
      destination: "production" as const,
      liveUrl: PROMOTION_DESTINATIONS.production.liveUrl,
      releaseId: candidatePublicReleaseId("production", active.request),
      inventorySha256: active.request.publicInventorySha256,
      deployment,
      verifiedAt: "2026-10-16T12:30:00.456Z",
      checks: PROMOTION_FIXTURE_CHECKS,
    };
    const verification = { ...body, receiptId: promotionDigest(body) };
    f.step({ type: "verified", ...owner, verification, replayProof: null });
    f.step({
      type: "acknowledged",
      operationId: owner.operationId,
      verificationReceiptId: verification.receiptId,
      acknowledgementId: "8".repeat(64),
      replayProof: null,
    });
    const completed = f.store.read(),
      state = parsePromotionControl(completed.bytes!);
    expect(state.active).toBeNull();
    const nextRequest = syntheticPromotionRequest(state, "next-edition");
    const proof = createCompletionProof(
      state.completionRoot,
      nextRequest.requestId,
      (sha, type) => f.store.readCompletionObject(completed.head!, sha, type)
    );
    f.step({ type: "claim", request: nextRequest, proof });
    expect(
      parsePromotionControl(f.store.read().bytes!).active!.operationId
    ).not.toBe(owner.operationId);
    unlinkSync(f.path);
    const effects = f.append.mock.calls.length,
      refs = f.refs(),
      requestCount = f.requests.length;
    expect(
      await runPagesCandidateDispatch({
        ...f.runner,
        store: f.freshReader(),
        command: "recover",
        recovery: {
          operationId: owner.operationId,
          attemptId: owner.attemptId,
        },
      })
    ).toMatchObject({
      status: "matched",
      receipt: {
        runId: "101",
        controlHead: original.pendingAppend.attemptedHead,
      },
    });
    expect(f.requests.slice(requestCount)).toHaveLength(1);
    expect(f.requests.at(-1)).toEqual({
      url: "http://127.0.0.1:4567/repos/prodigic/zivv/actions/runs/101",
      method: "GET",
    });
    expect(f.append).toHaveBeenCalledTimes(effects);
    expect(f.refs()).toEqual(refs);
    expect(readSaved(f.path).pendingAppend).toEqual(original.pendingAppend);
  }, 90_000);

  it("refuses a legal unpublished prepared dispatch fork even when its exact metadata existed locally", async () => {
    const f = fixture();
    const before = f.store.read();
    const intent = preparePagesWorkflowDispatch({
      control: parsePromotionControl(before.bytes!),
      controlHead: before.head!,
      workflowCommit,
      mode: "promote",
      reviewedMainAncestor: true,
      dispatchNonce: "7".repeat(64),
    });
    const pending = f.store.prepareAppend({
      expectedHead: before.head,
      bytes: serializePromotionControl(
        applyPromotionTransition(
          parsePromotionControl(before.bytes!),
          intent.event
        )
      ),
      createdAt: "2026-10-16T12:01:00.987Z",
    });
    writeFileSync(
      f.path,
      JSON.stringify({
        schemaVersion: 1,
        intent,
        pendingAppend: { ...pending, bytes: pending.bytes.toString("base64") },
      })
    );
    unlinkSync(f.path);
    const effects = f.append.mock.calls.length,
      refs = f.refs();
    await expect(
      runPagesCandidateDispatch({
        ...f.runner,
        command: "recover",
        recovery: {
          operationId: intent.event.operationId,
          attemptId: intent.event.attemptId,
        },
      })
    ).rejects.toThrow("missing or ambiguous");
    expect(f.requests).toEqual([]);
    expect(f.append).toHaveBeenCalledTimes(effects);
    expect(f.refs()).toEqual(refs);
    expect(existsSync(f.path)).toBe(false);
  }, 30_000);
});
