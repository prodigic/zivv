import { fridayDeliveryTimes } from "./weekly.js";

export type FridayMonitorEvidence =
  | {
      kind: "mailbox-scan";
      status: "absent" | "ready" | "unknown";
      scannedThroughEpochMs: number;
    }
  | {
      kind: "independent-watchdog";
      status: "not-started" | "started" | "unknown";
      expectedStartEpochMs: number;
      observedAtEpochMs: number;
    };

export interface FridayMonitorEvaluation {
  editionId: string;
  nowEpochMs: number;
  maxEvidenceAgeMs: number;
  evidence: FridayMonitorEvidence;
}

export interface FridayMonitorNotice {
  schemaVersion: 1;
  key: string;
  editionId: string;
  kind: "missing-source" | "missed-start";
  dueAtEpochMs: number;
}

function invalid(): never {
  throw new Error("INVALID_FRIDAY_MONITOR_EVIDENCE");
}

function assertFields(value: unknown, fields: readonly string[]): void {
  if (!value || typeof value !== "object") invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== fields.length ||
    fields.some((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
    })
  )
    invalid();
}

function assertEpoch(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    !Number.isFinite(new Date(value).getTime())
  )
    invalid();
}

function missingSourceDeadline(editionId: string): number {
  try {
    return fridayDeliveryTimes(editionId).missingSourceAlertAtEpochMs;
  } catch {
    return invalid();
  }
}

/**
 * Plan one notice from a fresh mailbox scan or independent watchdog observation.
 * Callers must obtain the observation from the relevant authority before calling.
 * The result is an intent for durable deduplication and carries no delivery claim.
 */
export function planFridayMonitorNotice(
  input: FridayMonitorEvaluation
): FridayMonitorNotice | null {
  assertFields(input, [
    "editionId",
    "nowEpochMs",
    "maxEvidenceAgeMs",
    "evidence",
  ]);
  const { editionId, nowEpochMs, maxEvidenceAgeMs, evidence } = input;
  assertEpoch(nowEpochMs);
  if (!Number.isSafeInteger(maxEvidenceAgeMs) || maxEvidenceAgeMs < 0)
    invalid();
  if (typeof editionId !== "string" || editionId.length !== 10) invalid();
  const alertAt = missingSourceDeadline(editionId);

  if (!evidence || typeof evidence !== "object") invalid();
  const observedKind: unknown = Object.getOwnPropertyDescriptor(
    evidence,
    "kind"
  )?.value;
  if (
    observedKind !== "mailbox-scan" &&
    observedKind !== "independent-watchdog"
  )
    invalid();

  let kind: FridayMonitorNotice["kind"];
  let observedAt: number;
  let dueAtEpochMs: number;
  let alert: boolean;
  if (evidence.kind === "mailbox-scan") {
    assertFields(evidence, ["kind", "status", "scannedThroughEpochMs"]);
    if (!["absent", "ready", "unknown"].includes(evidence.status)) invalid();
    kind = "missing-source";
    dueAtEpochMs = alertAt;
    observedAt = evidence.scannedThroughEpochMs;
    alert = evidence.status === "absent";
  } else {
    assertFields(evidence, [
      "kind",
      "status",
      "expectedStartEpochMs",
      "observedAtEpochMs",
    ]);
    if (!["not-started", "started", "unknown"].includes(evidence.status))
      invalid();
    kind = "missed-start";
    dueAtEpochMs = evidence.expectedStartEpochMs;
    assertEpoch(dueAtEpochMs);
    observedAt = evidence.observedAtEpochMs;
    alert = evidence.status === "not-started";
  }

  assertEpoch(observedAt);
  if (observedAt > nowEpochMs) invalid();
  if (
    !alert ||
    observedAt < dueAtEpochMs ||
    nowEpochMs - observedAt > maxEvidenceAgeMs
  )
    return null;

  return {
    schemaVersion: 1,
    key: `friday/${editionId}/${kind}/${dueAtEpochMs}`,
    editionId,
    kind,
    dueAtEpochMs,
  };
}
