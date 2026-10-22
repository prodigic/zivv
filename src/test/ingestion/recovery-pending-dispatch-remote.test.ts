import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToReporter } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryCandidateRemoteFixture } from "./fixtures/recovery-candidate-remote-fixture.js";
import { openRecoveryCandidateRemoteForTest } from "../../lib/ingestion/recovery-candidate-remote.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import { transitionWeeklyRun } from "../../lib/ingestion/weekly-run-state.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  captureOperatorRecoveryCheckpoint,
  type OperatorRecoveryCheckpoint,
} from "../../lib/ingestion/operator-recovery.js";
import {
  applyPromotionTransition,
  createCompletionProof,
  parsePromotionControl,
  serializePromotionControl,
  promotionDigest,
  candidatePublicReleaseId,
  PROMOTION_DESTINATIONS,
} from "../../lib/ingestion/promotion-control.js";
import { preparePagesWorkflowDispatch } from "../../lib/ingestion/pages-dispatch.js";
import {
  parseSavedPagesDispatch,
  type SavedPagesDispatch,
} from "../../lib/ingestion/pages-dispatch-runner.js";
import { readPublicationPayloadGit } from "../../lib/ingestion/publication-git.js";
import { verifyPublicationPayload } from "../../lib/ingestion/publication-payload.js";
import { PROMOTION_FIXTURE_CHECKS } from "./fixtures/promotion-control-fixture.js";

describe("pending dispatch canonical recovery profile", () => {
  let directory: string;
  let f: Awaited<ReturnType<typeof createRecoveryCandidateRemoteFixture>>;
  let checkpoint: OperatorRecoveryCheckpoint;
  let claimHead: string,
    initialHead: string,
    intentHead: string,
    verifiedHead: string;
  let saved: SavedPagesDispatch;
  let planPath: string, dispatchPath: string;
  const createdAt = "2026-10-16T22:00:00.000Z";
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "zivv-pending-remote-"));
    f = await createRecoveryCandidateRemoteFixture(directory);
    f.transport.append(f.payloadArtifactRef, f.payloadCommit, null);
    const initial = f.store.read(),
      control = parsePromotionControl(initial.bytes!);
    initialHead = initial.head!;
    const claim = f.step({
      type: "claim",
      request: f.claimRequest,
      proof: createCompletionProof(
        control.completionRoot,
        f.state.runId,
        (id, type) => f.store.readCompletionObject(initial.head!, id, type)
      ),
    });
    claimHead = claim.head;
    const payload = verifyPublicationPayload(
      readPublicationPayloadGit({
        repositoryRoot: f.repositoryRoot,
        payloadCommit: f.payloadCommit,
      }).files,
      {
        expectedCandidateId: f.candidate.candidateId,
        expectedSourceCommit: f.workflowCommit,
        purpose: "release",
        basePath: "/zivv/",
      }
    );
    const plan = {
      schemaVersion: 1,
      runId: f.state.runId,
      candidateId: f.candidate.candidateId,
      workflowCommit: f.workflowCommit,
      payloadCommit: f.payloadCommit,
      payloadReceiptId: payload.receipt.receiptId,
      createdAt,
      claim: {
        expectedHead: initialHead,
        attemptedHead: claimHead,
        bytes: serializePromotionControl(claim.state).toString("base64"),
        createdAt,
      },
    };
    const intent = preparePagesWorkflowDispatch({
      control: claim.state,
      controlHead: claimHead,
      workflowCommit: f.workflowCommit,
      reviewedMainAncestor: true,
      mode: "promote",
      dispatchNonce: "a".repeat(64),
    });
    const pending = f.store.prepareAppend({
      expectedHead: claimHead,
      bytes: serializePromotionControl(
        applyPromotionTransition(claim.state, intent.event)
      ),
      createdAt,
    });
    const accepted = f.store.compareAndAppend(pending);
    expect(accepted.status).toBe("appended");
    intentHead = pending.attemptedHead;
    saved = {
      schemaVersion: 1,
      intent,
      pendingAppend: {
        expectedHead: claimHead,
        attemptedHead: intentHead,
        bytes: pending.bytes.toString("base64"),
        createdAt,
      },
    };
    parseSavedPagesDispatch(Buffer.from(JSON.stringify(saved) + "\n"));
    const folder = join(f.operator, "weekly-publication", f.state.runId);
    mkdirSync(join(folder, "dispatch"), { recursive: true });
    writeFileSync(join(folder, "claim-plan.json"), canonicalJson(plan) + "\n");
    writeFileSync(
      join(folder, "dispatch/pages-dispatch.json"),
      JSON.stringify(saved) + "\n"
    );
    planPath = `weekly-publication/${f.state.runId}/claim-plan.json`;
    dispatchPath = `weekly-publication/${f.state.runId}/dispatch/pages-dispatch.json`;
    const journal = new WeeklyRunJournal(f.operator),
      lease = journal.acquire("prodigic/zivv/production");
    try {
      journal.save(
        transitionWeeklyRun(
          f.state,
          f.state.revision,
          "deploy",
          { status: "running" },
          Date.now()
        ),
        f.state.revision,
        lease
      );
    } finally {
      journal.release(lease);
      journal.close();
    }
    const previous = process.env.ZIVV_LEDGER_HOME;
    process.env.ZIVV_LEDGER_HOME = f.operator;
    try {
      checkpoint = await captureOperatorRecoveryCheckpoint(f.checkout, {
        npmCli: f.npmCli,
      });
    } finally {
      if (previous === undefined) delete process.env.ZIVV_LEDGER_HOME;
      else process.env.ZIVV_LEDGER_HOME = previous;
    }
  }, 180_000);
  afterAll(() => {
    if (directory?.startsWith(join(tmpdir(), "zivv-pending-remote-")))
      rmSync(directory, { recursive: true, force: true });
  });
  const open = (
    capsule = checkpoint,
    profile: "pending-dispatch" | "validated" = "pending-dispatch"
  ) =>
    openRecoveryCandidateRemoteForTest({
      repositoryRoot: f.repositoryRoot,
      bareDirectory: f.bareDirectory,
      checkpoint: capsule,
      recoveryKey: f.key,
      runId: f.state.runId,
      workflowCommit: f.workflowCommit,
      profile: profile === "pending-dispatch" ? profile : undefined,
    });
  const changed = (
    path: string,
    mutate: (value: Record<string, unknown>) => void
  ) => {
    const copy = structuredClone(checkpoint),
      row = copy.files.find(
        (item) => item.area === "operator" && item.path === path
      )!;
    const value = JSON.parse(
      Buffer.from(row.bytes!, "base64").toString("utf8")
    ) as Record<string, unknown>;
    mutate(value);
    const bytes = Buffer.from(
      (path === planPath ? canonicalJson(value) : JSON.stringify(value)) + "\n"
    );
    row.bytes = bytes.toString("base64");
    row.sha256 = sha256(bytes);
    return copy;
  };
  it("authenticates the original accepted bytes and retains GET-only identity through own verified progress", async () => {
    await yieldToReporter();
    const refs = f.refs(),
      context = open(),
      proof = context.pendingDispatch!;
    expect(context.binding.profile).toBe("pending-dispatch");
    expect(proof).toMatchObject({
      operationId: saved.intent.event.operationId,
      attemptId: saved.intent.event.attemptId,
      controlHead: intentHead,
    });
    expect(proof.savedBytes).toEqual(Buffer.from(JSON.stringify(saved) + "\n"));
    expect(context.binding.pendingDispatchSha256).toBe(
      sha256(proof.savedBytes)
    );
    const detached = proof.savedBytes;
    detached.fill(0);
    expect(proof.savedBytes).toEqual(Buffer.from(JSON.stringify(saved) + "\n"));
    expect(() => open(checkpoint, "validated")).toThrow(
      "VALIDATED_RUN_REQUIRED"
    );
    expect(f.refs()).toBe(refs);
    await yieldToReporter();
    const owner = {
      operationId: proof.operationId,
      attemptId: proof.attemptId,
      mode: "promote" as const,
    };
    const admission = {
      workflowCommit: f.workflowCommit,
      runId: "401",
      runAttempt: 1,
    };
    f.step({ type: "admit-run", ...owner, admission });
    const deployment = { admission, artifactId: "501", deploymentId: "601" };
    f.step({ type: "deployed", ...owner, deployment });
    const body = {
      destination: "production" as const,
      liveUrl: PROMOTION_DESTINATIONS.production.liveUrl,
      releaseId: candidatePublicReleaseId("production", f.claimRequest),
      inventorySha256: f.claimRequest.publicInventorySha256,
      deployment,
      verifiedAt: "2026-10-16T22:10:00.000Z",
      checks: PROMOTION_FIXTURE_CHECKS,
    };
    verifiedHead = f.step({
      type: "verified",
      ...owner,
      verification: { ...body, receiptId: promotionDigest(body) },
      replayProof: null,
    }).head;
    await yieldToReporter();
    expect(
      context.validateProgress(context.binding.initialControlHead)
    ).toMatchObject({
      head: verifiedHead,
      phase: "verified",
      operationId: proof.operationId,
    });
    const before = f.refs(),
      reopened = open();
    expect(reopened.binding).toEqual(context.binding);
    expect(reopened.pendingDispatch!.savedBytes).toEqual(proof.savedBytes);
    expect(f.refs()).toBe(before);
  }, 180_000);
  it("rejects rehashed private CAS timestamp, plan ownership and receipt association changes", async () => {
    await yieldToReporter();
    const wrongDate = changed(dispatchPath, (value) => {
      (value.pendingAppend as Record<string, unknown>).createdAt =
        "2026-10-16T22:00:00.001Z";
    });
    expect(() => open(wrongDate)).toThrow("CAPTURED_DISPATCH_CHANGED");
    await yieldToReporter();
    const wrongPlan = changed(planPath, (value) => {
      (value.claim as Record<string, unknown>).attemptedHead = "f".repeat(40);
    });
    expect(() => open(wrongPlan)).toThrow("CAPTURED_CLAIM_CHANGED");
    await yieldToReporter();
    const wrongReceipt = changed(dispatchPath, (value) => {
      value.receipt = {
        intent: saved.intent,
        controlHead: intentHead,
        runId: "999",
        runUrl: "https://api.github.com/repos/prodigic/zivv/actions/runs/999",
        htmlUrl: "https://github.com/prodigic/zivv/actions/runs/999",
      };
    });
    expect(() => open(wrongReceipt)).toThrow(
      "CAPTURED_DISPATCH_ADMISSION_CHANGED"
    );
  }, 180_000);
  it("reconstructs absent private files only from accepted history and rejects an unpublished intent", async () => {
    await yieldToReporter();
    const absent = structuredClone(checkpoint);
    absent.files = absent.files.filter(
      (item) =>
        item.area !== "operator" ||
        ![planPath, dispatchPath].includes(item.path)
    );
    const context = open(absent);
    expect(context.pendingDispatch!.savedBytes).toEqual(
      Buffer.from(JSON.stringify(saved) + "\n")
    );
    expect(context.binding.capturedClaimSha256).toBeNull();
    expect(context.binding.capturedDispatchSha256).toBeNull();
    await yieldToReporter();
    f.setControl(claimHead);
    try {
      const refs = f.refs();
      expect(() => open()).toThrow("PENDING_INTENT_MISSING_OR_AMBIGUOUS");
      expect(f.refs()).toBe(refs);
    } finally {
      f.setControl(verifiedHead);
    }
    await yieldToReporter();
    f.setControl(initialHead);
    try {
      const refs = f.refs();
      expect(() => open()).toThrow("PENDING_CLAIM_REQUIRED");
      expect(f.refs()).toBe(refs);
    } finally {
      f.setControl(verifiedHead);
    }
  }, 180_000);
  it("checks receipt association against a fresh canonical admission", async () => {
    await yieldToReporter();
    const previous = f.store.read().head!;
    f.setControl(intentHead);
    try {
      const context = open();
      const pending = context.pendingDispatch!;
      const receipt = (runId: string) => ({
        intent: saved.intent,
        controlHead: intentHead,
        runId,
        runUrl: `https://api.github.com/repos/prodigic/zivv/actions/runs/${runId}`,
        htmlUrl: `https://github.com/prodigic/zivv/actions/runs/${runId}`,
      });
      // No native admission authenticates this hint. The caller must still obtain
      // a unique GET match before permitting any added receipt or exact selector.
      expect(() => pending.assertReceipt(receipt("999"))).not.toThrow();
      await yieldToReporter();
      f.step({
        type: "admit-run",
        operationId: pending.operationId,
        attemptId: pending.attemptId,
        mode: "promote",
        admission: {
          workflowCommit: f.workflowCommit,
          runId: "401",
          runAttempt: 1,
        },
      });
      const refs = f.refs();
      expect(() => pending.assertReceipt(receipt("999"))).toThrow(
        "CAPTURED_DISPATCH_ADMISSION_CHANGED"
      );
      expect(() => pending.assertReceipt(receipt("401"))).not.toThrow();
      expect(f.refs()).toBe(refs);
    } finally {
      f.setControl(previous);
    }
  }, 120_000);
});
