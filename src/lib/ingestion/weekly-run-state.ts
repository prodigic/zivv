import { createHash } from "node:crypto";

/** Ordered delivery stages. Workers must inspect actual side effects on recovery. */
export const WEEKLY_RUN_STAGES = [
  "acquire",
  "prepare",
  "reconcile",
  "load",
  "freeze",
  "enrich",
  "export",
  "validate",
  "deploy",
  "verify",
  "acknowledge",
] as const;
export type WeeklyRunStage = (typeof WEEKLY_RUN_STAGES)[number];
type Status = "pending" | "running" | "succeeded" | "blocked" | "failed";
export type StageEvidence = Record<string, string | number>;
export interface WeeklyRunSource {
  editionId: string;
  deliveryId: string;
  rawSha256: string;
  rulesSha256: string;
  importObservedAtEpochMs: number;
}
interface StageState {
  stage: WeeklyRunStage;
  status: Status;
  attempt: number;
  evidence: StageEvidence | null;
  errorCode: string | null;
}
export interface WeeklyRunState {
  schemaVersion: 1;
  runId: string;
  revision: number;
  source: WeeklyRunSource;
  stages: StageState[];
}

const fields: Record<WeeklyRunStage, readonly string[]> = {
  acquire: ["rawSha256", "deliveryId"],
  prepare: ["preparedSha256", "rulesSha256"],
  reconcile: ["ledgerRevision", "reportSha256", "preparedSha256"],
  load: [
    "ledgerRevision",
    "importRunId",
    "reviewedLedgerRevision",
    "reportSha256",
    "preparedSha256",
  ],
  freeze: [
    "editionId",
    "cutoffEpochMs",
    "membershipSha256",
    "preCutoffPendingCount",
  ],
  enrich: ["configSha256"],
  export: [
    "ledgerRevision",
    "snapshotRevision",
    "manifestSha256",
    "datasetVersion",
    "candidateId",
    "editionId",
    "cutoffEpochMs",
    "membershipSha256",
    "configSha256",
  ],
  validate: ["candidateId", "manifestSha256"],
  deploy: ["candidateId", "manifestSha256", "deploymentId", "destination"],
  verify: ["candidateId", "manifestSha256", "deploymentId", "destination"],
  acknowledge: ["candidateId", "editionId", "cutoffEpochMs"],
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected run-state object");
  return value as Record<string, unknown>;
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Unexpected or missing run-state fields");
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function sourceIdentity(source: WeeklyRunSource): string {
  return digest(
    JSON.stringify([
      source.editionId,
      source.deliveryId,
      source.rawSha256,
      source.rulesSha256,
      source.importObservedAtEpochMs,
    ])
  );
}
function evidenceFor(
  state: WeeklyRunState,
  stage: WeeklyRunStage
): StageEvidence {
  const evidence = state.stages.find((item) => item.stage === stage)?.evidence;
  if (!evidence) throw new Error(`Missing ${stage} evidence`);
  return evidence;
}
function validateEvidence(
  state: WeeklyRunState,
  stage: WeeklyRunStage,
  evidence: StageEvidence
): void {
  exactKeys(evidence, fields[stage]);
  for (const [key, value] of Object.entries(evidence)) {
    if (key === "cutoffEpochMs" || key === "preCutoffPendingCount") {
      if (!integer(value)) throw new Error(`Invalid ${key}`);
    } else if (typeof value !== "string" || !value.trim() || value.length > 256)
      throw new Error(`Invalid ${key}`);
    if (
      (key.endsWith("Sha256") || key.endsWith("Revision")) &&
      (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    )
      throw new Error(`Invalid digest ${key}`);
  }
  if (
    stage === "acquire" &&
    (evidence.rawSha256 !== state.source.rawSha256 ||
      evidence.deliveryId !== state.source.deliveryId)
  )
    throw new Error("Acquired source identity changed");
  if (stage === "prepare" && evidence.rulesSha256 !== state.source.rulesSha256)
    throw new Error("Preparation rules changed");
  if (
    ["reconcile", "load"].includes(stage) &&
    evidence.preparedSha256 !== evidenceFor(state, "prepare").preparedSha256
  )
    throw new Error("Reviewed/imported prepared source changed");
  if (
    stage === "load" &&
    (evidence.reviewedLedgerRevision !==
      evidenceFor(state, "reconcile").ledgerRevision ||
      evidence.reportSha256 !== evidenceFor(state, "reconcile").reportSha256)
  )
    throw new Error("Load does not match reviewed revision/report");
  if (
    stage === "freeze" &&
    (evidence.editionId !== state.source.editionId ||
      evidence.preCutoffPendingCount !== 0)
  )
    throw new Error("Edition has unresolved earlier batches or wrong identity");
  if (
    stage === "freeze" &&
    typeof evidence.cutoffEpochMs === "number" &&
    evidence.cutoffEpochMs <= state.source.importObservedAtEpochMs
  )
    throw new Error(
      "Initial cutoff must include the source import observation"
    );
  if (stage === "export") {
    if (
      evidence.ledgerRevision !== evidenceFor(state, "load").ledgerRevision ||
      evidence.snapshotRevision !== evidence.ledgerRevision
    )
      throw new Error(
        "Export and recovery revisions must match committed import"
      );
    const frozen = evidenceFor(state, "freeze");
    if (
      evidence.editionId !== frozen.editionId ||
      evidence.cutoffEpochMs !== frozen.cutoffEpochMs ||
      evidence.membershipSha256 !== frozen.membershipSha256 ||
      evidence.configSha256 !== evidenceFor(state, "enrich").configSha256
    )
      throw new Error("Export does not match frozen edition/configuration");
  }
  if (["validate", "deploy", "verify", "acknowledge"].includes(stage)) {
    const candidate = evidenceFor(state, "export");
    if (evidence.candidateId !== candidate.candidateId)
      throw new Error("Candidate identity changed");
    if (
      stage !== "acknowledge" &&
      evidence.manifestSha256 !== candidate.manifestSha256
    )
      throw new Error("Candidate artifact changed");
  }
  if (
    stage === "verify" &&
    (evidence.deploymentId !== evidenceFor(state, "deploy").deploymentId ||
      evidence.destination !== evidenceFor(state, "deploy").destination)
  )
    throw new Error("Verified deployment identity changed");
  if (stage === "acknowledge") {
    const frozen = evidenceFor(state, "freeze");
    if (
      evidence.editionId !== frozen.editionId ||
      evidence.cutoffEpochMs !== frozen.cutoffEpochMs
    )
      throw new Error("Publication window changed");
  }
}

/** Validate untrusted persisted state; running stages remain running on restart. */
export function parseWeeklyRunState(input: unknown): WeeklyRunState {
  const raw = record(input);
  exactKeys(raw, ["schemaVersion", "runId", "revision", "source", "stages"]);
  if (raw.schemaVersion !== 1 || !integer(raw.revision))
    throw new Error("Unsupported run-state schema/revision");
  const source = record(raw.source);
  exactKeys(source, [
    "editionId",
    "deliveryId",
    "rawSha256",
    "rulesSha256",
    "importObservedAtEpochMs",
  ]);
  for (const key of ["editionId", "deliveryId"])
    if (
      typeof source[key] !== "string" ||
      !(source[key] as string).trim() ||
      (source[key] as string).length > 256
    )
      throw new Error(`Invalid source ${key}`);
  for (const key of ["rawSha256", "rulesSha256"])
    if (
      typeof source[key] !== "string" ||
      !/^[a-f0-9]{64}$/.test(source[key] as string)
    )
      throw new Error(`Invalid source ${key}`);
  if (!integer(source.importObservedAtEpochMs))
    throw new Error("Invalid original import observation time");
  if (
    !Array.isArray(raw.stages) ||
    raw.stages.length !== WEEKLY_RUN_STAGES.length
  )
    throw new Error("Incomplete stage state");
  const state = structuredClone(raw) as unknown as WeeklyRunState;
  if (state.runId !== sourceIdentity(state.source))
    throw new Error("Run source identity changed");
  let incomplete = false;
  for (const [index, item] of state.stages.entries()) {
    const value = record(item);
    exactKeys(value, ["stage", "status", "attempt", "evidence", "errorCode"]);
    if (
      item.stage !== WEEKLY_RUN_STAGES[index] ||
      !["pending", "running", "succeeded", "blocked", "failed"].includes(
        item.status
      ) ||
      !integer(item.attempt)
    )
      throw new Error("Invalid stage state/order");
    if (incomplete && item.status !== "pending")
      throw new Error("Stage bypassed unfinished predecessor");
    if ((item.status === "pending") !== (item.attempt === 0))
      throw new Error("Invalid stage attempt count");
    if (item.status === "succeeded") {
      const evidence = record(item.evidence);
      validateEvidence(state, item.stage, evidence as StageEvidence);
    } else {
      if (item.evidence !== null)
        throw new Error("Unfinished stage contains success evidence");
      incomplete = true;
    }
    const errored = item.status === "blocked" || item.status === "failed";
    if (
      errored
        ? typeof item.errorCode !== "string" ||
          !/^[A-Z0-9_]{1,64}$/.test(item.errorCode)
        : item.errorCode !== null
    )
      throw new Error("Invalid stage error code");
  }
  const expectedRevision = state.stages.reduce(
    (sum, item) => sum + item.attempt * 2 - (item.status === "running" ? 1 : 0),
    0
  );
  if (
    !Number.isSafeInteger(expectedRevision) ||
    state.revision !== expectedRevision
  )
    throw new Error("Run revision disagrees with stage attempts");
  return state;
}

export function createWeeklyRunState(source: WeeklyRunSource): WeeklyRunState {
  return parseWeeklyRunState({
    schemaVersion: 1,
    runId: sourceIdentity(source),
    revision: 0,
    source,
    stages: WEEKLY_RUN_STAGES.map((stage) => ({
      stage,
      status: "pending",
      attempt: 0,
      evidence: null,
      errorCode: null,
    })),
  });
}

type Transition =
  | { status: "running" }
  | { status: "succeeded"; evidence: StageEvidence }
  | { status: "blocked" | "failed"; errorCode: string };

/** Pure guarded transition. File/database concurrency and side effects belong to the runner. */
export function transitionWeeklyRun(
  state: WeeklyRunState,
  expectedRevision: number,
  stage: WeeklyRunStage,
  transition: Transition,
  nowEpochMs: number
): WeeklyRunState {
  const next = parseWeeklyRunState(state);
  if (next.revision !== expectedRevision)
    throw new Error("Stale run-state revision");
  if (!integer(nowEpochMs)) throw new Error("Invalid transition time");
  const index = WEEKLY_RUN_STAGES.indexOf(stage);
  if (
    index < 0 ||
    next.stages.slice(0, index).some((item) => item.status !== "succeeded")
  )
    throw new Error("Stage predecessor has not succeeded");
  const item = next.stages[index];
  if (transition.status === "running") {
    if (!["pending", "blocked", "failed"].includes(item.status))
      throw new Error(
        "Running or succeeded stage requires evidence recovery, not blind retry"
      );
    item.attempt++;
    item.errorCode = null;
  } else {
    if (item.status !== "running")
      throw new Error("Stage must be running before completion");
    if (transition.status === "succeeded") {
      validateEvidence(next, stage, transition.evidence);
      if (
        stage === "freeze" &&
        typeof transition.evidence.cutoffEpochMs === "number" &&
        transition.evidence.cutoffEpochMs > nowEpochMs
      )
        throw new Error("Cannot freeze future cutoff");
      item.evidence = structuredClone(transition.evidence);
    } else item.errorCode = transition.errorCode;
  }
  item.status = transition.status;
  next.revision++;
  return parseWeeklyRunState(next);
}
