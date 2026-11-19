import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WeeklyRunJournal,
  readWeeklyJournalRecoverySnapshotReadOnly,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
} from "../../lib/ingestion/weekly-run-state.js";
import { inspectFridayRunObservation } from "../../lib/ingestion/friday-run-observation.js";
import { planFridayRunAttention } from "../../lib/ingestion/friday-run-attention.js";

const prefix = "zivv-friday-observation-";
const roots: string[] = [];
const source = {
  editionId: "2026-10-16",
  deliveryId: "synthetic-private-delivery",
  rawSha256: "a".repeat(64),
  rulesSha256: "b".repeat(64),
  importObservedAtEpochMs: 1000,
};
function fixture(
  mode:
    | "empty"
    | "active"
    | "released"
    | "failed"
    | "blocked"
    | "running" = "active"
) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const journal = new WeeklyRunJournal(join(root, "operator"), () => 2000);
  const state = createWeeklyRunState(source);
  const lease = journal.acquire("prodigic/zivv/production", 1000);
  if (mode !== "empty") {
    journal.create(state, lease);

    if (mode === "blocked") {
      let run = transitionWeeklyRun(
        state,
        0,
        "acquire",
        { status: "running" },
        2000
      );
      journal.save(run, 0, lease);
      run = transitionWeeklyRun(
        run,
        1,
        "acquire",
        {
          status: "succeeded",
          evidence: {
            deliveryId: source.deliveryId,
            rawSha256: source.rawSha256,
          },
        },
        2000
      );
      journal.save(run, 1, lease);
      run = transitionWeeklyRun(run, 2, "prepare", { status: "running" }, 2000);
      journal.save(run, 2, lease);
      journal.save(
        transitionWeeklyRun(
          run,
          3,
          "prepare",
          {
            status: "blocked",
            errorCode: "PREFLIGHT_REVIEW_REQUIRED",
          },
          2000
        ),
        3,
        lease
      );
    }
    if (mode === "running") {
      journal.save(
        transitionWeeklyRun(state, 0, "acquire", { status: "running" }, 2000),
        0,
        lease
      );
    }
    if (mode === "failed") {
      const running = transitionWeeklyRun(
        state,
        0,
        "acquire",
        { status: "running" },
        2000
      );
      journal.save(running, 0, lease);
      const failed = transitionWeeklyRun(
        running,
        1,
        "acquire",
        { status: "failed", errorCode: "SYNTHETIC_PRIVATE_FAILURE" },
        2000
      );
      journal.save(failed, 1, lease);
    }
  }
  if (mode === "released" || mode === "empty") journal.release(lease);
  const path = journal.path;
  journal.close();
  return { state, bytes: readWeeklyJournalRecoverySnapshotReadOnly(path) };
}
function inspect(
  bytes: Buffer,
  runId: string,
  observedAtEpochMs = 2500,
  editionId = source.editionId
) {
  return inspectFridayRunObservation({
    journal: bytes,
    editionId,
    runId,
    observedAtEpochMs,
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (
      dirname(absolute) !== resolve(tmpdir()) ||
      !basename(absolute).startsWith(prefix)
    )
      throw Error("UNSAFE_TEST_CLEANUP");
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe("Friday run observation", () => {
  it("reports a missing run from an initialized production journal", () => {
    const f = fixture("empty");
    const before = Buffer.from(f.bytes);
    expect(inspect(f.bytes, f.state.runId)).toEqual({
      editionId: source.editionId,
      observedAtEpochMs: 2500,
      lease: { status: "released", expiresAtEpochMs: 0 },
      status: "no-run-record",
    });
    expect(f.bytes).toEqual(before);
  });

  it("reports the first incomplete stage with active and exactly expired lease", () => {
    const f = fixture();
    const before = Buffer.from(f.bytes);
    const active = inspect(f.bytes, f.state.runId, 2999);
    expect(active).toEqual({
      editionId: source.editionId,
      observedAtEpochMs: 2999,
      lease: { status: "active", expiresAtEpochMs: 3000 },
      status: "recorded",
      runId: f.state.runId,
      revision: 0,
      stage: "acquire",
      stageStatus: "pending",
      errorCode: null,
      ledgerRevision: null,
      candidateId: null,
      deploymentId: null,
    });
    expect(inspect(f.bytes, f.state.runId, 3000)).toEqual({
      ...active,
      observedAtEpochMs: 3000,
      lease: { status: "expired", expiresAtEpochMs: 3000 },
    });
    expect(f.bytes).toEqual(before);
  });

  it("reports a released lease and does not confuse a different absent run", () => {
    const f = fixture("released");
    expect(inspect(f.bytes, f.state.runId)).toMatchObject({
      status: "recorded",
      lease: { status: "released", expiresAtEpochMs: 0 },
    });
    expect(inspect(f.bytes, "f".repeat(64))).toMatchObject({
      status: "no-run-record",
      lease: { status: "released", expiresAtEpochMs: 0 },
    });
  });

  it("sanitizes arbitrary stored failure codes and private delivery data", () => {
    const f = fixture("failed");
    const result = inspect(f.bytes, f.state.runId);
    expect(result).toMatchObject({
      status: "recorded",
      revision: 2,
      stage: "acquire",
      stageStatus: "failed",
      errorCode: "WEEKLY_STAGE_FAILED",
    });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_FAILURE");
    expect(JSON.stringify(result)).not.toContain(source.deliveryId);
  });

  it("retains a known review reason for the next blocked stage", () => {
    const f = fixture("blocked");
    expect(inspect(f.bytes, f.state.runId)).toMatchObject({
      status: "recorded",
      revision: 4,
      stage: "prepare",
      stageStatus: "blocked",
      errorCode: "PREFLIGHT_REVIEW_REQUIRED",
    });
  });
  it("rejects wrong edition, corrupt bytes, and invalid observation times safely", () => {
    const f = fixture();
    expect(() => inspect(f.bytes, f.state.runId, 2500, "2026-10-23")).toThrow(
      "FRIDAY_RUN_OBSERVATION_UNVERIFIED"
    );
    expect(() =>
      inspect(Buffer.from("corrupt private bytes"), f.state.runId)
    ).toThrow("FRIDAY_RUN_OBSERVATION_UNVERIFIED");
    for (const time of [-1, NaN, Infinity, 1.5])
      expect(() => inspect(f.bytes, f.state.runId, time)).toThrow(
        "FRIDAY_RUN_OBSERVATION_UNVERIFIED"
      );
    expect(() => inspect(f.bytes, "not-a-run-id")).toThrow(
      "FRIDAY_RUN_OBSERVATION_UNVERIFIED"
    );
  });
});

describe("Friday run attention", () => {
  function plan(
    bytes: Buffer,
    runId: string,
    observedAtEpochMs = 3000,
    nowEpochMs = 3000,
    maxEvidenceAgeMs = 0
  ) {
    return planFridayRunAttention({
      journal: bytes,
      editionId: source.editionId,
      runId,
      observedAtEpochMs,
      nowEpochMs,
      maxEvidenceAgeMs,
    });
  }

  it("plans closed actions for inactive blocked, failed, and interrupted runs without exposing private data", () => {
    for (const [mode, revision, stage, stageStatus, reasonCode, action] of [
      [
        "blocked",
        4,
        "prepare",
        "blocked",
        "PREFLIGHT_REVIEW_REQUIRED",
        "review-stage",
      ],
      [
        "failed",
        2,
        "acquire",
        "failed",
        "WEEKLY_STAGE_FAILED",
        "inspect-failure-and-resume",
      ],
      [
        "running",
        1,
        "acquire",
        "running",
        "WEEKLY_STAGE_LEASE_INACTIVE",
        "reconcile-interrupted-stage",
      ],
    ] as const) {
      const f = fixture(mode);
      const before = Buffer.from(f.bytes);
      const result = plan(f.bytes, f.state.runId);
      expect(result).toEqual({
        schemaVersion: 1,
        key: expect.stringMatching(/^friday\/2026-10-16\/stage\/[a-f0-9]{64}$/),
        kind: "run-attention",
        editionId: source.editionId,
        runId: f.state.runId,
        revision,
        stage,
        stageStatus,
        reasonCode,
        action,
      });
      expect(JSON.stringify(result)).not.toContain(source.deliveryId);
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_FAILURE");
      expect(f.bytes).toEqual(before);
      expect(plan(f.bytes, f.state.runId, 3001, 3002, 1)).toEqual(result);
      expect(plan(f.bytes, f.state.runId, 2999, 2999)).toBeNull();
    }
  });

  it("omits absent and pending runs and enforces the freshness window", () => {
    const pending = fixture("released");
    expect(plan(pending.bytes, pending.state.runId)).toBeNull();
    expect(plan(pending.bytes, "f".repeat(64))).toBeNull();
    const failed = fixture("failed");
    expect(
      plan(failed.bytes, failed.state.runId, 3000, 3010, 10)
    ).not.toBeNull();
    expect(plan(failed.bytes, failed.state.runId, 3000, 3011, 10)).toBeNull();
    for (const [observed, now, age] of [
      [3001, 3000, 10],
      [3000, 3000, -1],
      [3000, NaN, 0],
      [3000, 3000, 0.5],
    ]) {
      expect(() =>
        plan(failed.bytes, failed.state.runId, observed, now, age)
      ).toThrow("INVALID_FRIDAY_RUN_ATTENTION_WINDOW");
    }
  });
});
