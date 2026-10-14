import { describe, expect, it } from "vitest";
import {
  createWeeklyRunState,
  parseWeeklyRunState,
  transitionWeeklyRun,
  WEEKLY_RUN_STAGES,
  type StageEvidence,
  type WeeklyRunStage,
  type WeeklyRunState,
} from "../../lib/ingestion/weekly-run-state.js";

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);
const source = {
  editionId: "2026-10-16",
  deliveryId: "fixture-delivery",
  rawSha256: a,
  rulesSha256: b,
  importObservedAtEpochMs: 4000,
};
const evidence: Record<WeeklyRunStage, StageEvidence> = {
  acquire: { rawSha256: a, deliveryId: source.deliveryId },
  prepare: { preparedSha256: c, rulesSha256: b },
  reconcile: { ledgerRevision: a, reportSha256: b, preparedSha256: c },
  load: {
    ledgerRevision: c,
    importRunId: "fixture-import",
    reviewedLedgerRevision: a,
    reportSha256: b,
    preparedSha256: c,
  },
  freeze: {
    editionId: source.editionId,
    cutoffEpochMs: 5000,
    membershipSha256: a,
    preCutoffPendingCount: 0,
  },
  enrich: { configSha256: b },
  export: {
    ledgerRevision: c,
    snapshotRevision: c,
    manifestSha256: a,
    datasetVersion: "fixture-dataset",
    candidateId: "fixture-candidate",
    editionId: source.editionId,
    cutoffEpochMs: 5000,
    membershipSha256: a,
    configSha256: b,
  },
  validate: { candidateId: "fixture-candidate", manifestSha256: a },
  deploy: {
    candidateId: "fixture-candidate",
    manifestSha256: a,
    deploymentId: "fixture-deployment",
    destination: "gitlab-preview",
  },
  verify: {
    candidateId: "fixture-candidate",
    manifestSha256: a,
    deploymentId: "fixture-deployment",
    destination: "gitlab-preview",
  },
  acknowledge: {
    candidateId: "fixture-candidate",
    editionId: source.editionId,
    cutoffEpochMs: 5000,
  },
};
function complete(
  state: WeeklyRunState,
  stage: WeeklyRunStage,
  output = evidence[stage]
) {
  const running = transitionWeeklyRun(
    state,
    state.revision,
    stage,
    { status: "running" },
    6000
  );
  return transitionWeeklyRun(
    running,
    running.revision,
    stage,
    { status: "succeeded", evidence: output },
    6000
  );
}
function before(stage: WeeklyRunStage) {
  let state = createWeeklyRunState(source);
  for (const current of WEEKLY_RUN_STAGES) {
    if (current === stage) break;
    state = complete(state, current);
  }
  return state;
}

describe("weekly run-state foundation", () => {
  it("binds export to the freeze catalog revision while preserving legacy evidence", () => {
    let state = complete(before("freeze"), "freeze", {
      ...evidence.freeze,
      mode: "initial",
      ledgerRevision: b,
    });
    state = complete(state, "enrich");
    expect(() => complete(state, "export")).toThrow();
    state = complete(state, "export", {
      ...evidence.export,
      ledgerRevision: b,
      snapshotRevision: b,
    });
    expect(parseWeeklyRunState(state)).toEqual(state);
    expect(() => complete(before("export"), "export")).not.toThrow();
  });

  it("allows corrections after cutoff without relaxing edition or pending-batch guards", () => {
    const correction = {
      ...evidence.freeze,
      cutoffEpochMs: 3000,
      mode: "correction",
      ledgerRevision: b,
    };
    expect(() =>
      complete(before("freeze"), "freeze", correction)
    ).not.toThrow();
    expect(() =>
      complete(before("freeze"), "freeze", {
        ...correction,
        editionId: "other",
      })
    ).toThrow();
    expect(() =>
      complete(before("freeze"), "freeze", {
        ...correction,
        preCutoffPendingCount: 1,
      })
    ).toThrow();
    expect(() =>
      complete(before("freeze"), "freeze", { ...correction, mode: "initial" })
    ).toThrow();
  });

  it("round-trips all stages and binds publication to the exact verified candidate/window", () => {
    let state = createWeeklyRunState(source);
    for (const stage of WEEKLY_RUN_STAGES) state = complete(state, stage);
    expect(parseWeeklyRunState(JSON.parse(JSON.stringify(state)))).toEqual(
      state
    );
    expect(state.revision).toBe(22);
    expect(state.stages.every((stage) => stage.status === "succeeded")).toBe(
      true
    );
    expect(state.source.importObservedAtEpochMs).toBe(4000);
  });

  it("rejects skipped import/verification and does not mutate the previous checkpoint", () => {
    const state = createWeeklyRunState(source);
    expect(() =>
      transitionWeeklyRun(state, 0, "load", { status: "running" }, 6000)
    ).toThrow("predecessor");
    const deployed = before("verify");
    expect(() =>
      transitionWeeklyRun(
        deployed,
        deployed.revision,
        "acknowledge",
        { status: "running" },
        6000
      )
    ).toThrow("predecessor");
    expect(state.revision).toBe(0);
    expect(state.stages[0].status).toBe("pending");
  });

  it("keeps interrupted running state and requires evidence recovery rather than blind retry", () => {
    const state = createWeeklyRunState(source);
    const running = transitionWeeklyRun(
      state,
      0,
      "acquire",
      { status: "running" },
      6000
    );
    const recovered = parseWeeklyRunState(JSON.parse(JSON.stringify(running)));
    expect(recovered.stages[0].status).toBe("running");
    expect(() =>
      transitionWeeklyRun(recovered, 1, "acquire", { status: "running" }, 6000)
    ).toThrow("blind retry");
    expect(complete(state, "acquire").stages[0].evidence).toEqual(
      evidence.acquire
    );
    expect(
      transitionWeeklyRun(
        recovered,
        1,
        "acquire",
        { status: "succeeded", evidence: evidence.acquire },
        6000
      ).stages[0].attempt
    ).toBe(1);
  });

  it("retries a recorded failure with a higher attempt and rejects stale writes", () => {
    const running = transitionWeeklyRun(
      createWeeklyRunState(source),
      0,
      "acquire",
      { status: "running" },
      6000
    );
    const failed = transitionWeeklyRun(
      running,
      1,
      "acquire",
      { status: "failed", errorCode: "SOURCE_UNAVAILABLE" },
      6000
    );
    expect(() =>
      transitionWeeklyRun(failed, 1, "acquire", { status: "running" }, 6000)
    ).toThrow("Stale");
    const retry = transitionWeeklyRun(
      failed,
      2,
      "acquire",
      { status: "running" },
      6000
    );
    expect(retry.stages[0]).toMatchObject({
      attempt: 2,
      status: "running",
      errorCode: null,
    });
  });

  it.each([
    ["acquire", { ...evidence.acquire, rawSha256: b }],
    ["prepare", { ...evidence.prepare, rulesSha256: a }],
    ["export", { ...evidence.export, snapshotRevision: a }],
    ["reconcile", { ...evidence.reconcile, preparedSha256: a }],
    ["load", { ...evidence.load, reviewedLedgerRevision: b }],
    ["load", { ...evidence.load, reportSha256: a }],
    ["load", { ...evidence.load, preparedSha256: b }],
    ["export", { ...evidence.export, cutoffEpochMs: 5001 }],
    ["export", { ...evidence.export, membershipSha256: b }],
    ["export", { ...evidence.export, configSha256: a }],
    ["export", { ...evidence.export, editionId: "different" }],
    ["validate", { ...evidence.validate, candidateId: "different" }],
    ["deploy", { ...evidence.deploy, manifestSha256: b }],
    ["verify", { ...evidence.verify, deploymentId: "different" }],
    ["verify", { ...evidence.verify, destination: "another-host" }],
    ["acknowledge", { ...evidence.acknowledge, cutoffEpochMs: 5001 }],
  ] satisfies [WeeklyRunStage, StageEvidence][])(
    "rejects mismatched %s receipts",
    (stage: WeeklyRunStage, output: StageEvidence) => {
      expect(() => complete(before(stage), stage, output)).toThrow();
    }
  );

  it("rejects future cutoffs and pending earlier batches", () => {
    const frozen = before("freeze");
    expect(() =>
      complete(frozen, "freeze", { ...evidence.freeze, cutoffEpochMs: 6001 })
    ).toThrow("future cutoff");
    expect(() =>
      complete(frozen, "freeze", {
        ...evidence.freeze,
        preCutoffPendingCount: 1,
      })
    ).toThrow("unresolved earlier");
    expect(() =>
      complete(frozen, "freeze", {
        ...evidence.freeze,
        cutoffEpochMs: source.importObservedAtEpochMs,
      })
    ).toThrow("include the source");
  });

  it("rejects impossible serialized revision/attempt histories", () => {
    const state = before("acknowledge");
    expect(() => parseWeeklyRunState({ ...state, revision: 0 })).toThrow(
      "stage attempts"
    );
    const tampered = structuredClone(state);
    tampered.stages[0].attempt++;
    expect(() => parseWeeklyRunState(tampered)).toThrow("stage attempts");
  });

  it("fails closed for corrupt identities, missing stages, unknown fields and private error text", () => {
    const state = createWeeklyRunState(source);
    expect(() =>
      parseWeeklyRunState({
        ...state,
        source: { ...source, importObservedAtEpochMs: 9000 },
      })
    ).toThrow("identity");
    expect(() => parseWeeklyRunState({ ...state, stages: [] })).toThrow(
      "Incomplete"
    );
    expect(() =>
      parseWeeklyRunState({ ...state, secret: "must-not-be-here" })
    ).toThrow("fields");
    const running = transitionWeeklyRun(
      state,
      0,
      "acquire",
      { status: "running" },
      6000
    );
    expect(() =>
      transitionWeeklyRun(
        running,
        1,
        "acquire",
        { status: "failed", errorCode: "subscriber@example.invalid" },
        6000
      )
    ).toThrow("error code");
  });
});
