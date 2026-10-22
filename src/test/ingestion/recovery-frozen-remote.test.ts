import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setImmediate as yieldToReporter } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryFrozenRemoteFixture } from "./fixtures/recovery-frozen-remote-fixture.js";
import { openRecoveryFrozenRemoteForTest } from "../../lib/ingestion/recovery-frozen-remote.js";
import { proveRecoveryWeeklyLineage } from "../../lib/ingestion/recovery-weekly-lineage.js";
import {
  canonicalJson,
  ledgerDigest,
} from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { transitionWeeklyRun } from "../../lib/ingestion/weekly-run-state.js";
import type { WeeklyJournalRecoverySnapshot } from "../../lib/ingestion/weekly-run-journal.js";
import type { OperatorRecoveryCheckpoint } from "../../lib/ingestion/operator-recovery.js";

describe("frozen recovery canonical baseline", () => {
  let directory: string;
  let fixture: Awaited<ReturnType<typeof createRecoveryFrozenRemoteFixture>>;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "zivv-frozen-remote-"));
    fixture = await createRecoveryFrozenRemoteFixture(directory);
  }, 120_000);
  afterAll(() => {
    if (directory?.startsWith(join(tmpdir(), "zivv-frozen-remote-")))
      rmSync(directory, { recursive: true, force: true });
  });
  const open = (
    checkpoint = fixture.checkpoint,
    sourceCommit = fixture.sourceCommit
  ) =>
    openRecoveryFrozenRemoteForTest({
      repositoryRoot: fixture.repositoryRoot,
      bareDirectory: fixture.bareDirectory,
      checkpoint,
      recoveryKey: fixture.key,
      runId: fixture.state.runId,
      sourceCommit,
    });
  const rewrite = (
    mutate: (journal: WeeklyJournalRecoverySnapshot) => void
  ): OperatorRecoveryCheckpoint => {
    const checkpoint = structuredClone(fixture.checkpoint);
    const journal = JSON.parse(
      Buffer.from(checkpoint.journal, "base64").toString("utf8")
    ) as WeeklyJournalRecoverySnapshot;
    mutate(journal);
    const { digest: _digest, ...body } = journal;
    checkpoint.journal = Buffer.from(
      canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
    ).toString("base64");
    return checkpoint;
  };
  it("proves the real post-load frozen run without enrich context or surviving original paths", () => {
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
    const refs = fixture.refs(),
      head = fixture.git(["symbolic-ref", "HEAD"]);
    const context = open();
    expect(context.binding).toMatchObject({
      mainHead: fixture.sourceCommit,
      sourceCommit: fixture.sourceCommit,
      runId: fixture.state.runId,
      acknowledgedLedgerRevision: ledgerDigest(fixture.baseline),
      ledgerRevision: ledgerDigest(fixture.ledger),
    });
    expect(context.binding.ledgerRevision).not.toBe(
      context.binding.acknowledgedLedgerRevision
    );
    expect(
      fixture.state.stages
        .slice(0, 5)
        .every((item) => item.status === "succeeded")
    ).toBe(true);
    expect(
      fixture.state.stages.slice(5).every((item) => item.status === "pending")
    ).toBe(true);
    expect(() => context.assertCurrent()).not.toThrow();
    expect(fixture.refs()).toBe(refs);
    expect(fixture.git(["symbolic-ref", "HEAD"])).toBe(head);
  }, 60_000);
  it("refuses obsolete main, control ownership and missing acknowledged retention instead of rebinding", async () => {
    await yieldToReporter();
    const context = open();
    fixture.main(fixture.payloadCommit);
    try {
      expect(context.assertCurrent).toThrow("REMOTE_CHANGED");
      expect(() => open()).toThrow("SOURCE_NOT_ON_MAIN");
    } finally {
      fixture.main(fixture.sourceCommit);
    }
    await yieldToReporter();
    fixture.setControl(fixture.claimHead);
    try {
      expect(context.assertCurrent).toThrow("REMOTE_CHANGED");
      expect(() => open()).toThrow("ACTIVE_OWNER");
    } finally {
      fixture.setControl(context.binding.controlHead);
    }
    await yieldToReporter();
    fixture.git([
      "push",
      "--quiet",
      fixture.bareDirectory,
      `:${fixture.artifactRef}`,
    ]);
    try {
      expect(context.assertCurrent).toThrow("REMOTE_CHANGED");
      expect(() => open()).toThrow("ARTIFACT_NOT_RETAINED");
    } finally {
      fixture.transport.append(
        fixture.artifactRef,
        fixture.payloadCommit,
        null
      );
    }
    await yieldToReporter();
    expect(() => open(fixture.checkpoint, "f".repeat(40))).toThrow(
      "SOURCE_NOT_ON_MAIN"
    );
    expect(() => open(fixture.checkpoint, "main")).toThrow("SOURCE_REQUIRED");
  }, 150_000);
  it("requires exactly frozen stage records and refuses even a rehashed pending-stage artifact", () => {
    const started = rewrite((journal) => {
      const run = transitionWeeklyRun(
        fixture.state,
        fixture.state.revision,
        "enrich",
        { status: "running" },
        Date.now()
      );
      journal.runState[0].payload = canonicalJson(run);
      journal.runState[0].revision = run.revision;
    });
    expect(() => open(started)).toThrow("FROZEN_RUN_REQUIRED");
    const unexpected = rewrite((journal) => {
      const bytes = Buffer.from('{"schemaVersion":1}\n');
      journal.stageArtifacts.push({
        runId: fixture.state.runId,
        stage: "enrich",
        attempt: 0,
        identity: sha256(bytes),
        bytes: bytes.toString("base64"),
      });
    });
    expect(() => open(unexpected)).toThrow();
    const missing = rewrite((journal) => {
      journal.stageArtifacts = journal.stageArtifacts.filter(
        (row) => row.stage !== "freeze"
      );
    });
    expect(() => open(missing)).toThrow("INCOMPLETE_OPERATOR_RECOVERY");
    expect(() =>
      proveRecoveryWeeklyLineage({
        checkpoint: fixture.checkpoint,
        runId: fixture.state.runId,
        stage: "validated",
      })
    ).toThrow("VALIDATED_RUN_REQUIRED");
  });
  it("preserves exact load, clock and weekly preimage proofs after extraction", () => {
    const advanced = structuredClone(fixture.checkpoint);
    advanced.ledger.version += ".unproved";
    advanced.ledgerRevision = ledgerDigest(advanced.ledger);
    expect(() => open(advanced)).toThrow("UNPROVEN_LEDGER_ADVANCEMENT");
    const badClock = rewrite((journal) => {
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
    expect(() => open(badClock)).toThrow("INVALID_ENTITY_CLOCK_LINEAGE");
    const changed = structuredClone(fixture.checkpoint);
    const row = changed.files.find(
      (item) =>
        item.area === "checkout" &&
        item.path === "data/ingestion/weekly-editions.json"
    )!;
    const bytes = Buffer.concat([
      Buffer.from(row.bytes!, "base64"),
      Buffer.from("\n"),
    ]);
    row.bytes = bytes.toString("base64");
    row.sha256 = sha256(bytes);
    expect(() => open(changed)).toThrow("WEEKLY_STATE_CHANGED");
  });
});
