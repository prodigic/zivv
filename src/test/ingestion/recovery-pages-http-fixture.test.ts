import { afterEach, describe, expect, it } from "vitest";
import {
  ensureReviewedPagesWorkflowTag,
  preparePagesWorkflowDispatch,
  recoverGithubPagesWorkflowDispatch,
  requestGithubPagesWorkflowDispatch,
} from "../../lib/ingestion/pages-dispatch.js";
import { claimPromotion } from "../../lib/ingestion/promotion-control.js";
import { createPromotionControlFixture } from "./fixtures/promotion-control-fixture.js";
import {
  createRecoveryPagesHttpFixture,
  type RecoveryPagesHttpFixture,
} from "./fixtures/recovery-pages-http-fixture.js";

const workflowCommit = "b".repeat(40);
const oldControlHead = "c".repeat(40);
const persistedControlHead = "d".repeat(40);
const githubToken = "safe_fixture_credential";

describe("loopback fixture for the production Pages dispatch transport", () => {
  let fixture: RecoveryPagesHttpFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("serves the exact tag, dispatch, list, and detail routes including lost-response recovery", async () => {
    fixture = await createRecoveryPagesHttpFixture({
      workflowCommit,
      loseFirstAcceptedResponse: true,
    });
    const control = createPromotionControlFixture();
    const state = claimPromotion(control.state, control.request);
    const intent = preparePagesWorkflowDispatch({
      control: state,
      controlHead: oldControlHead,
      workflowCommit,
      reviewedMainAncestor: true,
      mode: "promote",
    });
    const transport = {
      githubToken,
      testTransport: {
        kind: "local-test" as const,
        apiBaseUrl: fixture.pagesApiBaseUrl,
      },
    };

    const tag = await ensureReviewedPagesWorkflowTag({
      ...transport,
      workflowCommit,
      reviewedMainAncestor: true,
    });
    expect(fixture.requests).toEqual([
      {
        method: "GET",
        url: `/repos/prodigic/zivv/git/ref/tags/zivv-workflows/${workflowCommit}`,
      },
    ]);
    expect(tag).toEqual({
      status: "verified",
      ref: `refs/tags/zivv-workflows/${workflowCommit}`,
    });

    const dispatched = await requestGithubPagesWorkflowDispatch({
      ...transport,
      intent,
      onIntent: async () => ({ controlHead: persistedControlHead }),
      onDispatched: async () => undefined,
    });
    expect(dispatched).toMatchObject({
      status: "uncertain",
      reason: "transport",
      controlHead: persistedControlHead,
    });
    expect(fixture.dispatches).toHaveLength(1);
    expect(fixture.dispatches[0]).toMatchObject({
      ref: intent.ref,
      inputs: { ...intent.inputs, control_head: persistedControlHead },
    });

    const listed = await recoverGithubPagesWorkflowDispatch({
      ...transport,
      intent,
      controlHead: persistedControlHead,
    });
    expect(listed).toMatchObject({
      status: "matched",
      receipt: { runId: "101" },
    });
    const detailed = await recoverGithubPagesWorkflowDispatch({
      ...transport,
      intent,
      controlHead: persistedControlHead,
      runId: "101",
    });
    expect(detailed).toMatchObject({
      status: "matched",
      receipt: { runId: "101", intent, controlHead: persistedControlHead },
    });

    expect(fixture.requests).toEqual([
      {
        method: "GET",
        url: `/repos/prodigic/zivv/git/ref/tags/zivv-workflows/${workflowCommit}`,
      },
      {
        method: "POST",
        url: "/repos/prodigic/zivv/actions/workflows/publish-candidate.yml/dispatches",
      },
      {
        method: "GET",
        url: `/repos/prodigic/zivv/actions/workflows/publish-candidate.yml/runs?event=workflow_dispatch&head_sha=${workflowCommit}&per_page=100`,
      },
      { method: "GET", url: "/repos/prodigic/zivv/actions/runs/101" },
    ]);
  });
});
