import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setImmediate as yieldToReporter } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryCandidateRemoteFixture } from "./fixtures/recovery-candidate-remote-fixture.js";
import { openRecoveryCandidateRemoteForTest } from "../../lib/ingestion/recovery-candidate-remote.js";
import { journalVerifiedWeeklyDelivery } from "../../lib/ingestion/weekly-delivery.js";
import {
  WeeklyRunJournal,
  type WeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  captureOperatorRecoveryCheckpoint,
  type OperatorRecoveryCheckpoint,
} from "../../lib/ingestion/operator-recovery.js";
import {
  canonicalJson,
  ledgerDigest,
} from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  markWeeklyEditionPublished,
  parseWeeklyEditionLedger,
  serializeWeeklyEditionLedger,
} from "../../lib/ingestion/weekly.js";
import {
  applyPromotionTransition,
  candidatePublicReleaseId,
  createCompletionProof,
  parsePromotionControl,
  promotionAttemptId,
  promotionDigest,
  PROMOTION_DESTINATIONS,
  serializePromotionControl,
  type PromotionEvent,
} from "../../lib/ingestion/promotion-control.js";
import {
  PROMOTION_FIXTURE_CHECKS,
  syntheticPromotionRequest,
} from "./fixtures/promotion-control-fixture.js";

describe("verified-before-ack canonical recovery profile", () => {
  let directory: string;
  let f: Awaited<ReturnType<typeof createRecoveryCandidateRemoteFixture>>;
  let checkpoint: OperatorRecoveryCheckpoint;
  let verifiedHead: string, operationId: string, verificationReceiptId: string;
  let before: Buffer, after: Buffer;
  const createdAt = "2026-10-16T22:30:00.123Z";

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "zivv-verified-remote-"));
    f = await createRecoveryCandidateRemoteFixture(directory);
    f.transport.append(f.payloadArtifactRef, f.payloadCommit, null);
    const initial = f.store.read(),
      control = parsePromotionControl(initial.bytes!);
    const claim = f.step({
      type: "claim",
      request: f.claimRequest,
      proof: createCompletionProof(
        control.completionRoot,
        f.state.runId,
        (id, type) => f.store.readCompletionObject(initial.head!, id, type)
      ),
    });
    operationId = claim.state.active!.operationId;
    const attemptId = promotionAttemptId(
        operationId,
        "promote",
        1,
        f.workflowCommit,
        1
      ),
      owner = { operationId, attemptId, mode: "promote" as const },
      admission = {
        workflowCommit: f.workflowCommit,
        runId: "401",
        runAttempt: 1,
      };
    f.step({
      type: "dispatch-intent",
      ...owner,
      attemptNumber: 1,
      workflowCommit: f.workflowCommit,
      expectedRunAttempt: 1,
    });
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
    verificationReceiptId = promotionDigest(body);
    verifiedHead = f.step({
      type: "verified",
      ...owner,
      verification: { ...body, receiptId: verificationReceiptId },
      replayProof: null,
    }).head;
    const journal = new WeeklyRunJournal(f.operator),
      lease = journal.acquire("prodigic/zivv/production");
    try {
      await journalVerifiedWeeklyDelivery({
        state: f.state,
        candidate: f.candidateBytes,
        store: f.store,
        journal,
        lease,
        verifyContext() {},
        async onProgress() {},
      });
    } finally {
      journal.release(lease);
      journal.close();
    }
    before = readFileSync(
      join(f.checkout, "data/ingestion/weekly-editions.json")
    );
    after = Buffer.from(
      serializeWeeklyEditionLedger(
        markWeeklyEditionPublished(
          parseWeeklyEditionLedger(JSON.parse(before.toString("utf8"))),
          f.candidate.editionId
        ).ledger
      )
    );
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
  beforeEach(() => f.setControl(verifiedHead));
  afterAll(() => {
    if (
      directory &&
      !relative(tmpdir(), directory).startsWith("..") &&
      directory.startsWith(join(tmpdir(), "zivv-verified-remote-"))
    )
      rmSync(directory, { recursive: true, force: true });
  });
  const open = (
    capsule = checkpoint,
    profile: "verified" | "pending-dispatch" | "default" = "verified"
  ) =>
    openRecoveryCandidateRemoteForTest({
      repositoryRoot: f.repositoryRoot,
      bareDirectory: f.bareDirectory,
      checkpoint: capsule,
      recoveryKey: f.key,
      runId: f.state.runId,
      workflowCommit: f.workflowCommit,
      profile: profile === "default" ? undefined : profile,
    });
  const intent = (timestamp = createdAt) => ({
    schemaVersion: 1,
    runId: f.state.runId,
    operationId,
    requestId: f.state.runId,
    candidateId: f.candidate.candidateId,
    verificationReceiptId,
    before: before.toString("base64"),
    after: after.toString("base64"),
    createdAt: timestamp,
  });
  const prepare = (event: PromotionEvent, timestamp = createdAt) => {
    const current = f.store.read();
    return f.store.prepareAppend({
      expectedHead: current.head,
      bytes: serializePromotionControl(
        applyPromotionTransition(parsePromotionControl(current.bytes!), event)
      ),
      createdAt: timestamp,
    });
  };
  const bind = (acknowledgementId = sha256(canonicalJson(intent()))) => {
    const append = prepare({
      type: "acknowledgement-intent",
      operationId,
      verificationReceiptId,
      acknowledgementId,
    });
    expect(f.store.compareAndAppend(append).status).toBe("appended");
    return append;
  };
  const completion = () =>
    prepare({
      type: "acknowledged",
      operationId,
      verificationReceiptId,
      acknowledgementId: sha256(canonicalJson(intent())),
      replayProof: null,
    });
  const rewrite = (
    mutate: (journal: WeeklyJournalRecoverySnapshot) => void
  ) => {
    const copy = structuredClone(checkpoint),
      journal = JSON.parse(
        Buffer.from(copy.journal, "base64").toString("utf8")
      ) as WeeklyJournalRecoverySnapshot;
    mutate(journal);
    const { digest: _digest, ...body } = journal;
    copy.journal = Buffer.from(
      canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
    ).toString("base64");
    return copy;
  };

  it("authenticates both original delivery receipts without refs or publication effects", async () => {
    await yieldToReporter();
    const refs = f.refs(),
      remote = open();
    expect(remote.binding).toMatchObject({
      profile: "verified",
      verifiedControlHead: verifiedHead,
      acknowledgedLedgerRevision: ledgerDigest(f.baseline),
    });
    expect(remote.verifiedDelivery).toMatchObject({
      operationId,
      controlHead: verifiedHead,
      verificationReceiptId,
      deploymentId: "601",
    });
    expect(
      remote.validateProgress(remote.binding.initialControlHead)
    ).toMatchObject({ phase: "verified", acknowledgement: "pending" });
    await yieldToReporter();
    remote.verifiedDelivery!.assertWeekly(before);
    expect(() => remote.verifiedDelivery!.assertWeekly(after)).toThrow(
      "WEEKLY_STATE_CHANGED"
    );
    expect(() =>
      remote.verifiedDelivery!.assertWeekly(Buffer.from("changed"))
    ).toThrow("WEEKLY_STATE_CHANGED");
    expect(f.refs()).toBe(refs);
    expect(() => open(f.checkpoint)).toThrow("VERIFIED_RUN_REQUIRED");
    expect(() => open(checkpoint, "default")).toThrow("VALIDATED_RUN_REQUIRED");
    expect(() => open(checkpoint, "pending-dispatch")).toThrow(
      "PENDING_DISPATCH_RUN_REQUIRED"
    );
  }, 90_000);

  it("admits only exact own ACK bytes, bound after-state and stable predecessor baseline through completion", async () => {
    await yieldToReporter();
    const remote = open(),
      binding = remote.binding,
      guard = remote.verifiedDelivery!;
    const bad = prepare({
      type: "acknowledgement-intent",
      operationId,
      verificationReceiptId,
      acknowledgementId: "a".repeat(64),
    });
    expect(() => guard.assertAppend(bad)).toThrow("UNRELATED_ACKNOWLEDGEMENT");
    await yieldToReporter();
    const planned = prepare({
      type: "acknowledgement-intent",
      operationId,
      verificationReceiptId,
      acknowledgementId: sha256(canonicalJson(intent())),
    });
    guard.assertAppend(planned);
    expect(f.store.compareAndAppend(planned).status).toBe("appended");
    guard.assertWeekly(before);
    guard.assertWeekly(after);
    expect(
      remote.validateProgress(binding.initialControlHead).acknowledgement
    ).toBe("intent-bound");
    await yieldToReporter();
    const terminal = completion();
    expect(() =>
      guard.assertAppend({ ...terminal, createdAt: "2026-10-16T22:31:00.000Z" })
    ).toThrow("ACKNOWLEDGEMENT_TIMESTAMP_CHANGED");
    guard.assertAppend(terminal);
    expect(f.store.compareAndAppend(terminal).status).toBe("appended");
    await yieldToReporter();
    expect(remote.validateProgress(binding.initialControlHead)).toMatchObject({
      operationId,
      phase: null,
      acknowledgement: "completed",
    });
    await yieldToReporter();
    const reopened = open();
    expect(reopened.binding).toEqual(binding);
    reopened.verifiedDelivery!.assertWeekly(before);
    reopened.verifiedDelivery!.assertWeekly(after);
    expect(() => reopened.verifiedDelivery!.assertAppend(terminal)).toThrow(
      "ACKNOWLEDGEMENT_ALREADY_COMPLETED"
    );
  }, 180_000);

  it("allows later ownership only after proven own completion and never grants it new append authority", async () => {
    await yieldToReporter();
    const remote = open();
    await yieldToReporter();
    bind();
    const terminal = completion();
    expect(f.store.compareAndAppend(terminal).status).toBe("appended");
    await yieldToReporter();
    const current = f.store.read(),
      control = parsePromotionControl(current.bytes!),
      request = syntheticPromotionRequest(control, "later-owner");
    f.step({
      type: "claim",
      request,
      proof: createCompletionProof(
        control.completionRoot,
        request.requestId,
        (id, type) => f.store.readCompletionObject(current.head!, id, type)
      ),
    });
    await yieldToReporter();
    const reopened = open(),
      refs = f.refs();
    expect(reopened.binding).toEqual(remote.binding);
    expect(
      reopened.validateProgress(reopened.binding.initialControlHead)
    ).toMatchObject({ operationId, phase: null, acknowledgement: "completed" });
    reopened.verifiedDelivery!.assertWeekly(after);
    expect(() => reopened.verifiedDelivery!.assertAppend(terminal)).toThrow(
      "ACKNOWLEDGEMENT_ALREADY_COMPLETED"
    );
    expect(f.refs()).toBe(refs);
  }, 180_000);

  it("rejects canonical intents with wrong digest or a timestamp divorced from their committed identity", async () => {
    await yieldToReporter();
    bind("a".repeat(64));
    expect(() => open()).toThrow("UNRELATED_ACKNOWLEDGEMENT");
    await yieldToReporter();
    f.setControl(verifiedHead);
    const changed = prepare({
      type: "acknowledgement-intent",
      operationId,
      verificationReceiptId,
      acknowledgementId: sha256(
        canonicalJson(intent("2026-10-16T22:31:00.000Z"))
      ),
    });
    expect(f.store.compareAndAppend(changed).status).toBe("appended");
    expect(() => open()).toThrow("UNRELATED_ACKNOWLEDGEMENT");
  }, 120_000);

  it("refuses rehashed missing or changed delivery receipts and running acknowledgement checkpoints", async () => {
    await yieldToReporter();
    const missing = rewrite((journal) => {
      journal.stageArtifacts = journal.stageArtifacts.filter(
        (row) => row.stage !== "verify"
      );
    });
    expect(() => open(missing)).toThrow("INCOMPLETE_OPERATOR_RECOVERY");
    await yieldToReporter();
    const changed = rewrite((journal) => {
      for (const row of journal.stageArtifacts.filter((item) =>
        ["deploy", "verify"].includes(item.stage)
      )) {
        const anchor = JSON.parse(
          Buffer.from(row.bytes, "base64").toString("utf8")
        );
        anchor.controlSha256 = "a".repeat(64);
        const bytes = Buffer.from(canonicalJson(anchor) + "\n");
        row.bytes = bytes.toString("base64");
        row.identity = sha256(bytes);
      }
    });
    expect(() => open(changed)).toThrow("CAPTURED_DELIVERY_ANCHOR_CHANGED");
    await yieldToReporter();
    const running = rewrite((journal) => {
      const row = journal.runState.find((item) => item.id === f.state.runId)!;
      const state = JSON.parse(row.payload);
      state.stages[10].status = "running";
      state.stages[10].attempt = 1;
      state.revision++;
      row.payload = canonicalJson(state);
      row.revision = state.revision;
    });
    expect(() => open(running)).toThrow("VERIFIED_RUN_REQUIRED");
  }, 120_000);
});
