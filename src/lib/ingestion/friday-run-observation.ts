import { fridayDeliveryTimes } from "./weekly.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";

const production = "prodigic/zivv/production";
const reviewCodes = new Set([
  "PREFLIGHT_REVIEW_REQUIRED",
  "CORE_RECONCILIATION_REQUIRED",
  "PREFLIGHT_CONTEXT_CHANGED",
  "LATE_IMPORT_REQUIRES_REVIEW",
]);
const failureCodes = new Set([
  "STAGE_EXECUTION_FAILED",
  "STAGE_EVIDENCE_FAILED",
  "CANDIDATE_STAGE_FAILED",
]);

interface FridayRunObservationInput {
  journal: Buffer;
  editionId: string;
  runId: string;
  observedAtEpochMs: number;
}

function invalid(): never {
  throw Error("FRIDAY_RUN_OBSERVATION_UNVERIFIED");
}

function digest(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

/**
 * Report a named run from an authoritative private journal observation.
 * A missing local row is distinct from an independently missed start.
 */
export function inspectFridayRunObservation({
  journal,
  editionId,
  runId,
  observedAtEpochMs,
}: FridayRunObservationInput) {
  try {
    if (
      typeof editionId !== "string" ||
      editionId.length !== 10 ||
      digest(runId) === null ||
      !Number.isSafeInteger(observedAtEpochMs) ||
      observedAtEpochMs < 0 ||
      !Number.isFinite(new Date(observedAtEpochMs).getTime())
    )
      return invalid();
    fridayDeliveryTimes(editionId);
    const snapshot = validateWeeklyJournalRecoverySnapshot(journal);
    const expiry = snapshot.ownership.find(
      (row) => row.scope === production
    )?.expiresAtEpochMs;
    if (expiry === undefined) return invalid();
    const leaseStatus =
      expiry === 0
        ? "released"
        : expiry > observedAtEpochMs
          ? "active"
          : "expired";
    const observation = {
      editionId,
      observedAtEpochMs,
      lease: { status: leaseStatus, expiresAtEpochMs: expiry },
    };
    const retained = snapshot.runState.find(
      (entry) => entry.scope === production && entry.id === runId
    );
    if (!retained) return { ...observation, status: "no-run-record" as const };
    const run = parseWeeklyRunState(JSON.parse(retained.payload));
    if (
      run.source.editionId !== editionId ||
      run.source.importObservedAtEpochMs > observedAtEpochMs
    )
      return invalid();
    const stage =
      run.stages.find((entry) => entry.status !== "succeeded") ??
      run.stages.at(-1)!;
    let errorCode: string | null = null;
    if (stage.status === "blocked")
      errorCode =
        stage.errorCode && reviewCodes.has(stage.errorCode)
          ? stage.errorCode
          : "WEEKLY_STAGE_REVIEW_REQUIRED";
    else if (stage.status === "failed")
      errorCode =
        stage.errorCode && failureCodes.has(stage.errorCode)
          ? stage.errorCode
          : "WEEKLY_STAGE_FAILED";
    const exported = run.stages.find(
      (entry) => entry.stage === "export"
    )?.evidence;
    const loaded = run.stages.find((entry) => entry.stage === "load")?.evidence;
    const deployment = run.stages.find((entry) => entry.stage === "deploy")
      ?.evidence?.deploymentId;
    return {
      ...observation,
      status: "recorded" as const,
      runId,
      revision: run.revision,
      stage: stage.stage,
      stageStatus: stage.status,
      errorCode,
      ledgerRevision: digest(
        exported?.ledgerRevision ?? loaded?.ledgerRevision
      ),
      candidateId: digest(exported?.candidateId),
      deploymentId:
        typeof deployment === "string" && /^[1-9][0-9]{0,19}$/.test(deployment)
          ? deployment
          : null,
    };
  } catch {
    return invalid();
  }
}
