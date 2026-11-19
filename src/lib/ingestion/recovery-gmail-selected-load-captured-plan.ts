import type { RecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import { createSelectedGmailLoadEffectPlan } from "./recovery-gmail-selected-load-effects.js";
import type { SelectedLoadInterruptionEvidence } from "./recovery-gmail-selected-load-interruption-inspection.js";
import { proveRecoveryGmailSelectedLoadBaseline } from "./recovery-gmail-selected-load-proof.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";

interface CapturedLoadPlanInput {
  originalBaseline: SelectedLoadInterruptionEvidence["originalBaseline"];
  observedCatalog: SelectedLoadInterruptionEvidence["observedCatalog"];
  observedJournal: Buffer;
  physicalEntries: SelectedLoadInterruptionEvidence["physicalEntries"];
  predecessorRunId: string;
  selector: RecoveryGmailSelectedReceiptSelector;
  key: Buffer;
}

function invalid(): never {
  throw Error("RECOVERY_GMAIL_CAPTURED_LOAD_PLAN_UNVERIFIED");
}

/** Plan a distinct capture against the observed catalog after a verified load. */
export function planCapturedLoadAfterPredecessor({
  originalBaseline,
  observedCatalog,
  observedJournal,
  physicalEntries,
  predecessorRunId,
  selector,
  key,
}: CapturedLoadPlanInput) {
  const proof = proveRecoveryGmailSelectedLoadBaseline({
    ...originalBaseline,
    selector,
    recoveryKey: key,
  });
  const journal = validateWeeklyJournalRecoverySnapshot(observedJournal);
  const scope = "prodigic/zivv/production";
  if (
    proof.runDisposition !== "new" ||
    journal.runState.some((row) => row.id === proof.runState.runId)
  )
    return invalid();

  const physical = new Map(physicalEntries.map((entry) => [entry.path, entry]));
  if (physical.size !== physicalEntries.length) return invalid();
  for (const file of proof.selection.canonicalEvidence) {
    const entry = physical.get("operator/" + file.path);
    if (entry?.kind !== "file" || entry.sha256 !== file.sha256)
      return invalid();
  }
  const body = proof.selection.canonicalEvidence.find(({ path }) =>
    path.endsWith("/bodies/" + selector.receiptId + "/source.txt")
  );
  const source = originalBaseline.current.files.find(
    (file) => file.area === "operator" && file.path === body?.path
  );
  if (!source?.bytes || source.sha256 !== body?.sha256) return invalid();

  const predecessor = journal.runState.find(
    (row) => row.scope === scope && row.id === predecessorRunId
  );
  if (!predecessor) return invalid();
  const load = parseWeeklyRunState(JSON.parse(predecessor.payload)).stages.find(
    (stage) => stage.stage === "load"
  );
  if (load?.status !== "succeeded") return invalid();
  const predecessorImportId = load.evidence?.importRunId;

  const ledger = observedCatalog.ledger;
  const predecessorCommit = ledger.runs.find(
    (run) => run.runId === predecessorImportId
  )?.committedAtEpochMs;
  if (typeof predecessorCommit !== "number") return invalid();

  const raw = Buffer.from(source.bytes, "base64");
  const plan = createSelectedGmailLoadEffectPlan(
    { files: originalBaseline.checkpoint.files, ledger },
    proof,
    raw
  );
  return {
    proof,
    plan,
    raw,
    earliestAdmissionEpochMs: Math.max(
      originalBaseline.checkpoint.createdAtEpochMs,
      predecessorCommit,
      proof.source.importObservedAtEpochMs
    ),
  };
}
