import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runPagesCandidateDispatch,
  verifyReviewedPagesWorkflowCommit,
} from "../../lib/ingestion/pages-dispatch-runner.js";
import {
  applyPromotionTransition,
  claimPromotion,
  parsePromotionControl,
  promotionDigest,
  serializePromotionControl,
  validatePromotionAppend,
} from "../../lib/ingestion/promotion-control.js";
import type { PromotionControlStore } from "../../lib/ingestion/promotion-control-git.js";
import { createPromotionControlFixture } from "./fixtures/promotion-control-fixture.js";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "zivv-dispatch-fixture-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const workflowCommit = "b".repeat(40);
const githubToken = "ghp_fixture_secret";
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const accepted = {
  workflow_run_id: 101,
  run_url: "https://api.github.com/repos/prodigic/zivv/actions/runs/101",
  html_url: "https://github.com/prodigic/zivv/actions/runs/101",
};
function fixture() {
  const base = createPromotionControlFixture();
  let state = claimPromotion(base.state, base.request);
  let head = "c".repeat(40);
  let failAfterCas = false;
  const events: string[] = [];
  const appends = new Map<string, Buffer>();
  const initialHead = head;
  const store: PromotionControlStore = {
    ref: "refs/heads/zivv-promotion-control/production",
    read: () => ({ head, bytes: serializePromotionControl(state) }),
    readAt: () => {
      throw new Error("Unused native history fixture");
    },
    readCompletionObject: () => {
      throw new Error("Unused completion fixture");
    },
    prepareAppend: (input) => {
      const attemptedHead = promotionDigest({
        expectedHead: input.expectedHead,
        createdAt: input.createdAt,
        bytes: input.bytes.toString("base64"),
      }).slice(0, 40);
      appends.set(attemptedHead, input.bytes);
      return { ...input, attemptedHead };
    },
    compareAndAppend: (input) => {
      const attemptedHead = store.prepareAppend(input).attemptedHead;
      events.push("CAS");
      if (head !== input.expectedHead)
        return { status: "conflict", attemptedHead, observedHead: head };
      validatePromotionAppend(serializePromotionControl(state), input.bytes);
      state = parsePromotionControl(input.bytes);
      head = attemptedHead;
      return {
        status: failAfterCas ? "uncertain" : "appended",
        attemptedHead,
        observedHead: head,
      };
    },
    readback: (input) => {
      if (!appends.get(input.attemptedHead)?.equals(input.bytes))
        throw new Error("Fixture prepared append changed");
      return {
        status:
          head === input.attemptedHead
            ? "appended"
            : head === input.expectedHead
              ? "uncertain"
              : "conflict",
        attemptedHead: input.attemptedHead,
        observedHead: head,
      };
    },
  };
  const requests: { url: string; method: string; body?: unknown }[] = [];
  let loseDispatchResponse = false;
  let provideRun = true;
  const intentDirectory = directory();
  const fetcher: typeof fetch = async (url, options) => {
    const method = options?.method ?? "GET";
    const body: unknown = options?.body
      ? JSON.parse(String(options.body))
      : undefined;
    requests.push({ url: String(url), method, body });
    events.push(method);
    if (String(url).includes("/git/ref/"))
      return response({
        ref: `refs/tags/zivv-workflows/${workflowCommit}`,
        object: { type: "commit", sha: workflowCommit },
      });
    if (method === "POST") {
      expect(existsSync(join(intentDirectory, "pages-dispatch.json"))).toBe(
        true
      );
      if (loseDispatchResponse) throw new Error(githubToken);
      return response(accepted);
    }
    const saved = JSON.parse(
      readFileSync(join(intentDirectory, "pages-dispatch.json"), "utf8")
    );
    const run = {
      id: 101,
      event: "workflow_dispatch",
      head_sha: workflowCommit,
      head_branch: saved.intent.ref,
      display_title: saved.intent.runName,
      path: ".github/workflows/publish-candidate.yml",
      run_attempt: 1,
      repository: { full_name: "prodigic/zivv" },
      url: accepted.run_url,
      html_url: accepted.html_url,
      inputs: {
        ...saved.intent.inputs,
        control_head: saved.pendingAppend.attemptedHead,
      },
    };
    return String(url).includes("/actions/runs/101")
      ? response(run)
      : response({
          total_count: provideRun ? 1 : 0,
          workflow_runs: provideRun ? [run] : [],
        });
  };
  const options = {
    command: "dispatch" as const,
    repositoryRoot: process.cwd(),
    workflowCommit,
    mode: "promote" as const,
    intentDirectory,
    githubToken,
    store,
    controlledPublishing: "enabled",
    manualPublisherJoined: "true",
    testTransport: {
      kind: "local-test" as const,
      apiBaseUrl: "http://127.0.0.1:4567",
      fetch: fetcher,
    },
  };
  return {
    options,
    requests,
    events,
    store,
    head: () => head,
    state: () => state,
    initialHead,
    loseResponse: () => {
      loseDispatchResponse = true;
    },
    loseCas: () => {
      failAfterCas = true;
    },
    noRun: () => {
      provideRun = false;
    },
  };
}

describe("private native controller dispatch checkpoint", () => {
  it("persists exact prepared append before POST and sends its won control head", async () => {
    const f = fixture();
    const result = await runPagesCandidateDispatch(f.options);
    expect(result.status).toBe("dispatched");
    expect(f.events).toEqual(["GET", "CAS", "POST"]);
    const journal = JSON.parse(
      readFileSync(
        join(f.options.intentDirectory, "pages-dispatch.json"),
        "utf8"
      )
    );
    expect(journal.pendingAppend.expectedHead).toBe(f.initialHead);
    expect(journal.pendingAppend.attemptedHead).toBe(f.head());
    expect(Buffer.from(journal.pendingAppend.bytes, "base64")).toEqual(
      serializePromotionControl(f.state())
    );
    expect(journal.intent.event.dispatchNonce).toMatch(/^[a-f0-9]{64}$/);
    expect(f.state().active?.promotionAttempt?.dispatchNonce).toBe(
      journal.intent.event.dispatchNonce
    );
    expect(f.requests[1].body).toMatchObject({
      inputs: { control_head: f.head() },
      return_run_details: true,
    });
    expect(journal.receipt.runId).toBe("101");
    expect(JSON.stringify(journal)).not.toContain(githubToken);
  });
  it("treats repeat dispatch command with saved intent as GET-only recovery", async () => {
    const f = fixture();
    await runPagesCandidateDispatch(f.options);
    expect(await runPagesCandidateDispatch(f.options)).toMatchObject({
      status: "matched",
      receipt: { runId: "101" },
    });
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    expect(f.events).toEqual(["GET", "CAS", "POST", "GET"]);
  });
  it("rejects context loss during workflow-tag lookup before saving an intent, winning CAS or sending POST", async () => {
    const f = fixture();
    const fetcher = f.options.testTransport.fetch;
    let current = true;
    await expect(
      runPagesCandidateDispatch({
        ...f.options,
        checkContext: () => {
          if (!current) throw new Error("Expired publication context");
        },
        testTransport: {
          ...f.options.testTransport,
          fetch: async (url, options) => {
            const response = await fetcher(url, options);
            if (String(url).includes("/git/ref/")) current = false;
            return response;
          },
        },
      })
    ).rejects.toThrow("Expired publication context");
    expect(f.events).toEqual(["GET"]);
    expect(f.head()).toBe(f.initialHead);
    expect(f.state().active!.phase).toBe("claimed");
    expect(
      existsSync(join(f.options.intentDirectory, "pages-dispatch.json"))
    ).toBe(false);
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(0);
  });
  it("recovers accepted dispatch after response loss without another POST", async () => {
    const f = fixture();
    f.loseResponse();
    expect(await runPagesCandidateDispatch(f.options)).toMatchObject({
      status: "uncertain",
      reason: "transport",
    });
    expect(
      await runPagesCandidateDispatch({ ...f.options, command: "recover" })
    ).toMatchObject({ status: "matched" });
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
  });
  it("retains planned ownership when context expires after CAS and does not send POST on recovery", async () => {
    const f = fixture();
    await expect(
      runPagesCandidateDispatch({
        ...f.options,
        checkContext: () => {
          if (f.events.includes("CAS"))
            throw new Error("Expired after native claim");
        },
      })
    ).rejects.toThrow("newly persisted control intent");
    expect(f.events).toEqual(["GET", "CAS"]);
    expect(f.state().active!.phase).toBe("dispatch-planned");
    expect(
      existsSync(join(f.options.intentDirectory, "pages-dispatch.json"))
    ).toBe(true);
    f.noRun();
    expect(
      await runPagesCandidateDispatch({ ...f.options, command: "recover" })
    ).toEqual({ status: "uncertain", reason: "no-match" });
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    expect(f.state().active!.phase).toBe("dispatch-planned");
  });
  it("recovers a saved exact run after its native admission advances the control head", async () => {
    const f = fixture();
    await runPagesCandidateDispatch(f.options);
    const active = f.state().active!;
    const attempt = active.promotionAttempt!;
    const next = applyPromotionTransition(f.state(), {
      type: "admit-run",
      operationId: active.operationId,
      mode: "promote",
      attemptId: attempt.attemptId,
      admission: { workflowCommit, runId: "101", runAttempt: 1 },
    });
    const append = f.store.prepareAppend({
      expectedHead: f.head(),
      bytes: serializePromotionControl(next),
      createdAt: new Date().toISOString(),
    });
    expect(f.store.compareAndAppend(append).status).toBe("appended");
    expect(
      await runPagesCandidateDispatch({ ...f.options, command: "recover" })
    ).toMatchObject({ status: "matched", receipt: { runId: "101" } });
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
  });
  it("does not POST after uncertain CAS even if exact append committed remotely", async () => {
    const f = fixture();
    f.loseCas();
    f.noRun();
    await expect(runPagesCandidateDispatch(f.options)).rejects.toThrow(
      "newly persisted"
    );
    expect(
      await runPagesCandidateDispatch({ ...f.options, command: "recover" })
    ).toEqual({ status: "uncertain", reason: "no-match" });
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    expect(f.state().active?.phase).toBe("dispatch-planned");
  });
  it("only one competing nonce can win the native CAS and POST", async () => {
    const f = fixture();
    const otherDirectory = directory();
    const results = await Promise.allSettled([
      runPagesCandidateDispatch(f.options),
      runPagesCandidateDispatch({
        ...f.options,
        intentDirectory: otherDirectory,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    const losingDirectory =
      JSON.parse(
        readFileSync(
          join(f.options.intentDirectory, "pages-dispatch.json"),
          "utf8"
        )
      ).pendingAppend.attemptedHead === f.head()
        ? otherDirectory
        : f.options.intentDirectory;
    expect(
      await runPagesCandidateDispatch({
        ...f.options,
        command: "recover",
        intentDirectory: losingDirectory,
      })
    ).toEqual({ status: "uncertain", reason: "control-readback" });
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
  });
  it("refuses a new directory when native state already contains a planned attempt", async () => {
    const f = fixture();
    await runPagesCandidateDispatch(f.options);
    await expect(
      runPagesCandidateDispatch({ ...f.options, intentDirectory: directory() })
    ).rejects.toThrow();
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
  });
  it("rejects changed journal ownership and a mismatched workflow before HTTP", async () => {
    const f = fixture();
    await runPagesCandidateDispatch(f.options);
    const count = f.requests.length;
    await expect(
      runPagesCandidateDispatch({
        ...f.options,
        workflowCommit: "a".repeat(40),
      })
    ).rejects.toThrow("match");
    const path = join(f.options.intentDirectory, "pages-dispatch.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.pendingAppend.expectedHead = "e".repeat(40);
    writeFileSync(path, JSON.stringify(saved));
    await expect(runPagesCandidateDispatch(f.options)).rejects.toThrow(
      "append"
    );
    expect(f.requests).toHaveLength(count);
  });
  it("blocks missing intent, disabled activation, missing credentials and Git storage before HTTP", async () => {
    const f = fixture();
    await expect(
      runPagesCandidateDispatch({ ...f.options, command: "recover" })
    ).rejects.toThrow("No saved");
    await expect(
      runPagesCandidateDispatch({
        ...f.options,
        controlledPublishing: "disabled",
      })
    ).rejects.toThrow("activation");
    await expect(
      runPagesCandidateDispatch({ ...f.options, githubToken: "" })
    ).rejects.toThrow("GITHUB_TOKEN");
    await expect(
      runPagesCandidateDispatch({
        ...f.options,
        intentDirectory: process.cwd(),
      })
    ).rejects.toThrow("outside Git");
    expect(f.requests).toEqual([]);
  });
});

describe("actual local reviewed Git ancestry", () => {
  it("accepts an authoritative main ancestor and rejects an unmerged workflow commit", () => {
    const root = directory();
    const git = (args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
      )
        .toString()
        .trim();
    git(["init", "-b", "main"]);
    git(["remote", "add", "origin", "https://github.com/prodigic/zivv.git"]);
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    const path = join(root, ".github", "workflows", "publish-candidate.yml");
    writeFileSync(path, "name: Reviewed fixture\n");
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    const reviewed = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", reviewed]);
    expect(() =>
      verifyReviewedPagesWorkflowCommit(root, reviewed)
    ).not.toThrow();
    writeFileSync(path, "name: Unmerged fixture\n");
    git(["add", "."]);
    git(["commit", "-m", "unmerged"]);
    const unmerged = git(["rev-parse", "HEAD"]);
    expect(() => verifyReviewedPagesWorkflowCommit(root, unmerged)).toThrow(
      "origin/main"
    );
    git(["remote", "set-url", "origin", "https://example.invalid/other.git"]);
    expect(() => verifyReviewedPagesWorkflowCommit(root, reviewed)).toThrow(
      "origin/main"
    );
  });
});
