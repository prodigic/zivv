import { inspectFridayRunObservation } from "./friday-run-observation.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

type RunObservationInput = Parameters<typeof inspectFridayRunObservation>[0];
type RunAttentionInput = RunObservationInput & {
  nowEpochMs: number;
  maxEvidenceAgeMs: number;
};

const stageAttention = {
  blocked: {
    action: "review-stage",
    reason: "WEEKLY_STAGE_REVIEW_REQUIRED",
  },
  failed: {
    action: "inspect-failure-and-resume",
    reason: "WEEKLY_STAGE_FAILED",
  },
  running: {
    action: "reconcile-interrupted-stage",
    reason: "WEEKLY_STAGE_LEASE_INACTIVE",
  },
} as const;

function validTime(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    Number.isFinite(new Date(value).getTime())
  );
}

/**
 * Plan attention for a fresh, named run snapshot after its production lease
 * stopped being active. A separate observer is needed for missed starts.
 */
export function planFridayRunAttention({
  nowEpochMs,
  maxEvidenceAgeMs,
  ...input
}: RunAttentionInput) {
  if (
    !validTime(nowEpochMs) ||
    !validTime(input.observedAtEpochMs) ||
    input.observedAtEpochMs > nowEpochMs ||
    !Number.isSafeInteger(maxEvidenceAgeMs) ||
    maxEvidenceAgeMs < 0
  )
    throw Error("INVALID_FRIDAY_RUN_ATTENTION_WINDOW");

  if (nowEpochMs - input.observedAtEpochMs > maxEvidenceAgeMs) return null;
  const observation = inspectFridayRunObservation(input);
  if (
    observation.status !== "recorded" ||
    observation.lease.status === "active" ||
    observation.stageStatus === "pending" ||
    observation.stageStatus === "succeeded"
  )
    return null;

  const { editionId, runId, revision, stage, stageStatus } = observation;
  const attention = stageAttention[stageStatus];
  const identity = { editionId, runId, revision, stage, stageStatus };
  return {
    schemaVersion: 1 as const,
    key: `friday/${editionId}/stage/${sha256(canonicalJson(identity))}`,
    kind: "run-attention" as const,
    ...identity,
    reasonCode: observation.errorCode ?? attention.reason,
    action: attention.action,
  };
}
