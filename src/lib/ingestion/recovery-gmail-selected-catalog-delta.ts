import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import type { IngestionLedger } from "../../types/ingestion.js";
import { verifySelectedLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import {
  proveRecoveryGmailSelectedLoadBaseline,
  type RecoveryGmailSelectedLoadBaselineInput,
} from "./recovery-gmail-selected-load-proof.js";
import {
  createSelectedGmailLoadEffectPlan,
  assertSelectedGmailLoadCatalog,
} from "./recovery-gmail-selected-load-effects.js";

/** Detached logical evidence only. The caller must independently authenticate the
 * installed admission, original archive, exact physical inventory and live SQL
 * identity/normalized rows before using this result. It grants no authority. */
export function proveSelectedLoadCatalogDelta(input: {
  baseline: RecoveryGmailSelectedLoadBaselineInput;
  executionBaseline: Buffer;
  admissionSha256: string;
  evidenceSha256: string;
  physicalSnapshotSha256: string;
  raw: Buffer;
  observedGeneration: number;
  observedLedger: IngestionLedger;
}) {
  const execution = verifySelectedLoadExecutionBaseline(
    input.executionBaseline,
    input.baseline.recoveryKey
  );
  if (
    execution.admissionSha256 !== input.admissionSha256 ||
    execution.evidenceSha256 !== input.evidenceSha256 ||
    execution.physicalSnapshotSha256 !== input.physicalSnapshotSha256 ||
    execution.startedAtEpochMs > Date.now()
  )
    throw Error("INVALID_SELECTED_LOAD_CATALOG_DELTA");
  const proof = proveRecoveryGmailSelectedLoadBaseline(input.baseline);
  const plan = createSelectedGmailLoadEffectPlan(
    input.baseline.checkpoint,
    proof,
    input.raw
  );
  const original = input.baseline.checkpoint.ledger;
  if (
    input.observedGeneration === execution.generation &&
    canonicalJson(input.observedLedger) === canonicalJson(original)
  )
    return {
      disposition: "unchanged" as const,
      generation: execution.generation,
      ledgerRevision: ledgerDigest(original),
      loadAllowed: false as const,
    };
  if (
    input.observedGeneration !== execution.generation + 1 ||
    plan.result.report.replay
  )
    throw Error("INVALID_SELECTED_LOAD_CATALOG_DELTA");
  assertSelectedGmailLoadCatalog(
    plan,
    original,
    input.observedLedger,
    execution.startedAtEpochMs
  );
  return {
    disposition: "committed" as const,
    generation: input.observedGeneration,
    ledgerRevision: ledgerDigest(input.observedLedger),
    importRunId: plan.receipt.importRunId,
    loadAllowed: false as const,
  };
}
