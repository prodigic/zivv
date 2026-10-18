import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setImmediate as yieldToReporter } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryCandidateRemoteFixture } from "./fixtures/recovery-candidate-remote-fixture.js";
import {
  openRecoveryCandidateRemoteForTest,
  type RecoveryCandidateRemote,
} from "../../lib/ingestion/recovery-candidate-remote.js";
import {
  canonicalJson,
  ledgerDigest,
} from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  createCompletionProof,
  promotionAttemptId,
  candidatePublicReleaseId,
  promotionDigest,
  parsePromotionControl,
  PROMOTION_DESTINATIONS,
} from "../../lib/ingestion/promotion-control.js";
import {
  PROMOTION_FIXTURE_CHECKS,
  syntheticPromotionRequest,
} from "./fixtures/promotion-control-fixture.js";
import type { WeeklyJournalRecoverySnapshot } from "../../lib/ingestion/weekly-run-journal.js";
import type { OperatorRecoveryCheckpoint } from "../../lib/ingestion/operator-recovery.js";

describe("canonical authority for a retained validated candidate", () => {
  let directory: string,
    fixture: Awaited<ReturnType<typeof createRecoveryCandidateRemoteFixture>>,
    context: RecoveryCandidateRemote,
    verifiedHead: string,
    claimHead: string,
    deployedHead: string;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "zivv-candidate-remote-"));
    fixture = await createRecoveryCandidateRemoteFixture(directory);
  }, 120_000);
  afterAll(() => {
    if (
      directory &&
      directory.startsWith(join(tmpdir(), "zivv-candidate-remote-"))
    )
      rmSync(directory, { recursive: true, force: true });
  });
  const open = (
    checkpoint = fixture.checkpoint,
    workflowCommit = fixture.workflowCommit
  ) =>
    openRecoveryCandidateRemoteForTest({
      repositoryRoot: fixture.repositoryRoot,
      bareDirectory: fixture.bareDirectory,
      checkpoint,
      recoveryKey: fixture.key,
      runId: fixture.state.runId,
      workflowCommit,
    });
  it("proves post-load lineage after old paths disappear and follows only original promote progress through remote verification", async () => {
    await yieldToReporter();
    for (const path of [
      fixture.checkout,
      fixture.operator,
      join(directory, "original-tool"),
    ]) {
      const offset = relative(directory, path);
      if (!offset || offset.startsWith(".."))
        throw Error("Unsafe fixture cleanup");
      rmSync(path, { recursive: true });
    }
    const originalRefs = fixture.refs(),
      originalHead = fixture.git(["symbolic-ref", "HEAD"]);
    context = open();
    expect(context.binding).toMatchObject({
      mainHead: fixture.workflowCommit,
      acknowledgedLedgerRevision: ledgerDigest(fixture.baseline),
      ledgerRevision: ledgerDigest(fixture.ledger),
      candidateId: fixture.candidate.candidateId,
      workflowCommit: fixture.workflowCommit,
      runId: fixture.state.runId,
    });
    expect(context.binding.acknowledgedLedgerRevision).not.toBe(
      context.binding.ledgerRevision
    );
    expect(
      context.validateProgress(context.binding.initialControlHead)
    ).toMatchObject({ operationId: null, phase: null });
    expect(fixture.refs()).toBe(originalRefs);
    expect(fixture.git(["symbolic-ref", "HEAD"])).toBe(originalHead);
    await yieldToReporter();
    const detached = context.candidateBytes;
    detached.fill(0);
    context.candidate.files.length = 0;
    expect(context.candidateBytes).toEqual(fixture.candidateBytes);
    expect(context.candidate.files).toHaveLength(
      fixture.candidate.files.length
    );
    fixture.transport.append(
      fixture.payloadArtifactRef,
      fixture.payloadCommit,
      null
    );
    const initial = fixture.store.read(),
      control = parsePromotionControl(initial.bytes!);
    const proof = createCompletionProof(
      control.completionRoot,
      fixture.state.runId,
      (id, type) => fixture.store.readCompletionObject(initial.head!, id, type)
    );
    const claim = fixture.step({
      type: "claim",
      request: fixture.claimRequest,
      proof,
    });
    claimHead = claim.head;
    await yieldToReporter();
    const operationId = claim.state.active!.operationId,
      attemptId = promotionAttemptId(
        operationId,
        "promote",
        1,
        fixture.workflowCommit,
        1
      ),
      owner = { operationId, mode: "promote" as const, attemptId };
    fixture.step({
      type: "dispatch-intent",
      ...owner,
      attemptNumber: 1,
      workflowCommit: fixture.workflowCommit,
      expectedRunAttempt: 1,
    });
    const admission = {
      workflowCommit: fixture.workflowCommit,
      runId: "401",
      runAttempt: 1,
    };
    fixture.step({ type: "admit-run", ...owner, admission });
    const deployment = { admission, artifactId: "501", deploymentId: "601" };
    deployedHead = fixture.step({
      type: "deployed",
      ...owner,
      deployment,
    }).head;
    await yieldToReporter();
    const body = {
      destination: "production" as const,
      liveUrl: PROMOTION_DESTINATIONS.production.liveUrl,
      releaseId: candidatePublicReleaseId("production", fixture.claimRequest),
      inventorySha256: fixture.claimRequest.publicInventorySha256,
      deployment,
      verifiedAt: "2026-10-16T22:10:00.000Z",
      checks: PROMOTION_FIXTURE_CHECKS,
    };
    verifiedHead = fixture.step({
      type: "verified",
      ...owner,
      verification: { ...body, receiptId: promotionDigest(body) },
      replayProof: null,
    }).head;
    const refs = fixture.refs();
    expect(
      context.validateProgress(context.binding.initialControlHead)
    ).toEqual({ head: verifiedHead, operationId, phase: "verified" });
    await yieldToReporter();
    const reopened = open();
    expect(reopened.binding).toEqual(context.binding);
    expect(
      reopened.validateProgress(context.binding.initialControlHead).phase
    ).toBe("verified");
    expect(fixture.refs()).toBe(refs);
    expect(() => context.validateProgress("f".repeat(40))).toThrow(
      "INITIAL_CONTROL_CHANGED"
    );
  }, 150_000);
  it("rejects failure, another owner and a changed workflow instead of rebinding the original authority", async () => {
    await yieldToReporter();
    fixture.setControl(deployedHead);
    try {
      const current = parsePromotionControl(fixture.store.read().bytes!),
        operation = current.active!;
      fixture.step({
        type: "failed",
        operationId: operation.operationId,
        mode: "promote",
        attemptId: operation.promotionAttempt!.attemptId,
        failureReceiptId: "9".repeat(64),
      });
      expect(() => open()).toThrow("UNRELATED_PROGRESS");
    } finally {
      fixture.setControl(verifiedHead);
    }
    await yieldToReporter();
    fixture.setControl(claimHead);
    try {
      const operation = parsePromotionControl(
          fixture.store.read().bytes!
        ).active!,
        workflowCommit = fixture.sourceCommit;
      fixture.step({
        type: "dispatch-intent",
        operationId: operation.operationId,
        mode: "promote",
        attemptId: promotionAttemptId(
          operation.operationId,
          "promote",
          1,
          workflowCommit,
          1
        ),
        attemptNumber: 1,
        workflowCommit,
        expectedRunAttempt: 1,
      });
      expect(() => open()).toThrow("WORKFLOW_CHANGED");
    } finally {
      fixture.setControl(verifiedHead);
    }
    await yieldToReporter();
    fixture.setControl(context.binding.initialControlHead);
    try {
      const before = fixture.store.read(),
        control = parsePromotionControl(before.bytes!),
        request = syntheticPromotionRequest(control, "another-private-run");
      fixture.step({
        type: "claim",
        request,
        proof: createCompletionProof(
          control.completionRoot,
          request.requestId,
          (id, type) =>
            fixture.store.readCompletionObject(before.head!, id, type)
        ),
      });
      expect(() => open()).toThrow("ACTIVE_OWNER");
    } finally {
      fixture.setControl(verifiedHead);
    }
  }, 120_000);
  it("refuses missing retained artifacts, fresh main changes and a workflow without the required blob", () => {
    fixture.git([
      "push",
      "--quiet",
      fixture.bareDirectory,
      `:${fixture.payloadArtifactRef}`,
    ]);
    try {
      expect(context.assertCurrent).toThrow("ARTIFACT_NOT_RETAINED");
      expect(() => open()).toThrow("ARTIFACT_NOT_RETAINED");
    } finally {
      fixture.transport.append(
        fixture.payloadArtifactRef,
        fixture.payloadCommit,
        null
      );
    }
    fixture.main(fixture.sourceCommit);
    try {
      expect(context.assertCurrent).toThrow("REMOTE_CHANGED");
      expect(() => open()).toThrow("SOURCE_OR_WORKFLOW_NOT_ON_MAIN");
    } finally {
      fixture.main(fixture.workflowCommit);
    }
    expect(() => open(fixture.checkpoint, fixture.sourceCommit)).toThrow(
      "SOURCE_OR_WORKFLOW_NOT_ON_MAIN"
    );
  }, 45_000);
  it("rejects unproved ledger advancement, missing successful evidence and a not-yet-validated captured run before native effects", () => {
    const advanced = structuredClone(fixture.checkpoint);
    advanced.ledger.version += ".unproved";
    advanced.ledgerRevision = ledgerDigest(advanced.ledger);
    expect(() => open(advanced)).toThrow("UNPROVEN_LEDGER_ADVANCEMENT");
    const rewrite = (
      mutate: (journal: WeeklyJournalRecoverySnapshot) => void
    ): OperatorRecoveryCheckpoint => {
      const checkpoint = structuredClone(fixture.checkpoint),
        journal = JSON.parse(
          Buffer.from(checkpoint.journal, "base64").toString("utf8")
        ) as WeeklyJournalRecoverySnapshot;
      mutate(journal);
      const { digest: _digest, ...body } = journal;
      checkpoint.journal = Buffer.from(
        canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
      ).toString("base64");
      return checkpoint;
    };
    const missing = rewrite((journal) => {
      journal.stageArtifacts = journal.stageArtifacts.filter(
        (row) => row.stage !== "prepare"
      );
    });
    expect(() => open(missing)).toThrow();
    const pending = rewrite((journal) => {
      journal.runState[0].payload = canonicalJson(
        fixture.validationPendingState
      );
      journal.runState[0].revision = fixture.validationPendingState.revision;
    });
    expect(() => open(pending)).toThrow("VALIDATED_RUN_REQUIRED");
    const invalidValidation = rewrite((journal) => {
      const row = journal.stageArtifacts.find(
        (item) => item.stage === "validate"
      )!;
      const value = JSON.parse(
        Buffer.from(row.bytes, "base64").toString("utf8")
      );
      value.schemaVersion = 99;
      const bytes = Buffer.from(canonicalJson(value) + "\n");
      row.bytes = bytes.toString("base64");
      row.identity = sha256(bytes);
    });
    expect(() => open(invalidValidation)).toThrow(
      "VALIDATION_ARTIFACT_MISMATCH"
    );
    const invalidClock = rewrite((journal) => {
      const row = journal.stageArtifacts.find((item) => item.stage === "load")!;
      const value = JSON.parse(
        Buffer.from(row.bytes, "base64").toString("utf8")
      );
      value.ledger.artists[0].createdAtEpochMs =
        fixture.state.source.importObservedAtEpochMs - 1;
      const bytes = Buffer.from(canonicalJson(value) + "\n");
      row.bytes = bytes.toString("base64");
      row.identity = sha256(bytes);
    });
    expect(() => open(invalidClock)).toThrow("INVALID_ENTITY_CLOCK_LINEAGE");
  });
});
