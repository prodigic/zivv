import { createHash } from "node:crypto";
import { bootstrapLedger } from "./ledger.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
} from "./weekly-run-state.js";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function source(deliveryId: string, rawSource: Buffer) {
  return {
    editionId: "2026-10-16",
    deliveryId,
    rawSha256: sha256(rawSource),
    rulesSha256: "b".repeat(64),
    importObservedAtEpochMs: 1_792_000_000_000,
  };
}

/**
 * Return ordinary valid values for positive journal/catalog controls.
 * This factory has no path, callback, permission, database, or capture scope.
 */
export function createRecoveryGmailCaptureProbeControls() {
  const createRawSource = Buffer.from("capture-probe-create-source\n");
  const createState = createWeeklyRunState(
    source("capture-probe-create", createRawSource)
  );

  const seedRawSource = Buffer.from("capture-probe-seed-source\n");
  const initialState = createWeeklyRunState(
    source("capture-probe-seed", seedRawSource)
  );
  const runningState = transitionWeeklyRun(
    initialState,
    initialState.revision,
    "acquire",
    { status: "running" },
    1_792_000_000_001
  );
  const artifactBytes = Buffer.from(seedRawSource);
  const succeededState = transitionWeeklyRun(
    runningState,
    runningState.revision,
    "acquire",
    {
      status: "succeeded",
      evidence: {
        rawSha256: sha256(seedRawSource),
        deliveryId: source("capture-probe-seed", seedRawSource).deliveryId,
      },
    },
    1_792_000_000_002
  );

  return {
    catalogLedger: bootstrapLedger(
      { events: [], artists: [], venues: [] },
      1_792_000_000_000
    ),
    create: {
      state: structuredClone(createState),
      rawSource: Buffer.from(createRawSource),
    },
    seed: {
      initialState: structuredClone(initialState),
      rawSource: Buffer.from(seedRawSource),
      runningState: structuredClone(runningState),
      runningRawArtifact: Buffer.from(artifactBytes),
      succeededState: structuredClone(succeededState),
    },
    artifactBytes: Buffer.from(artifactBytes),
  };
}
