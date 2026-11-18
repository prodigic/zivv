import {
  copyRecoveryGmailSelectedReceiptSelector,
  type RecoveryGmailSelectedReceiptSelector,
} from "./recovery-gmail-capture-admission-proof.js";
import { createSelectedGmailLoadEffectPlan } from "./recovery-gmail-selected-load-effects.js";
import type { RecoveryGmailSelectedLoadFrameInput } from "./recovery-gmail-selected-load-framing.js";
import { readSelectedLoadInterruptionEvidence } from "./recovery-gmail-selected-load-interruption-inspection.js";
import { proveRecoveryGmailSelectedLoadBaseline } from "./recovery-gmail-selected-load-proof.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";

function fail(): never {
  throw Error("INVALID_NEXT_RECOVERY_GMAIL_SELECTED_LOAD_INSPECTION");
}

/** Observe a distinct, already captured receipt after one fully released load.
 * The original checkpoint still anchors capture evidence. The prospective
 * import plan uses the prior load's independently verified canonical catalog.
 * This summary grants no installation, journal, or catalog writer authority. */
export function readNextSelectedLoadAdmissionEvidence(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector
) {
  let key: Buffer | undefined;
  try {
    const selector = copyRecoveryGmailSelectedReceiptSelector(next);
    const observed = readSelectedLoadInterruptionEvidence(prior);
    if (
      observed.report.status !== "completed" ||
      observed.report.lease.status !== "released" ||
      !observed.completedResultSha256 ||
      !observed.completedHistoryManifestSha256 ||
      selector.receiptId === observed.originalBaseline.selector.receiptId
    )
      return fail();

    key = Buffer.from(prior.recoveryKey);
    const baseline = observed.originalBaseline;
    const selected = proveRecoveryGmailSelectedLoadBaseline({
      ...baseline,
      selector,
      recoveryKey: key,
    });
    const journal = validateWeeklyJournalRecoverySnapshot(
      observed.observedJournal
    );
    if (
      selected.runState.runId === observed.report.runId ||
      selected.runDisposition !== "new" ||
      journal.runState.some((row) => row.id === selected.runState.runId)
    )
      return fail();

    const physical = new Map(
      observed.physicalEntries.map((entry) => [entry.path, entry])
    );
    for (const file of selected.selection.canonicalEvidence) {
      const entry = physical.get("operator/" + file.path);
      if (entry?.kind !== "file" || entry.sha256 !== file.sha256) return fail();
    }
    const body = selected.selection.canonicalEvidence.find(({ path }) =>
      path.endsWith("/bodies/" + selector.receiptId + "/source.txt")
    );
    const source = baseline.current.files.find(
      (file) => file.area === "operator" && file.path === body?.path
    );
    if (!source?.bytes || source.sha256 !== body?.sha256) return fail();

    const { ledger, generation } = observed.observedCatalog;
    const predecessor = journal.runState.find(
      (row) => row.id === observed.report.runId
    );
    if (!predecessor) return fail();
    const predecessorImportId = parseWeeklyRunState(
      JSON.parse(predecessor.payload)
    ).stages.find((stage) => stage.stage === "load")?.evidence?.importRunId;
    const predecessorCommit = ledger.runs.find(
      (run) => run.runId === predecessorImportId
    )?.committedAtEpochMs;
    if (typeof predecessorCommit !== "number") return fail();

    const plan = createSelectedGmailLoadEffectPlan(
      { files: baseline.checkpoint.files, ledger },
      selected,
      Buffer.from(source.bytes, "base64")
    );
    const catalogSha256 = ledgerDigest(ledger);
    const priorLoad = {
      runId: observed.report.runId,
      admissionSha256: observed.admissionSha256,
      executionBaselineSha256: sha256(observed.executionBaseline),
      resultSha256: observed.completedResultSha256,
      historyManifestSha256: observed.completedHistoryManifestSha256,
      catalogSha256,
      generation,
      journalSha256: sha256(observed.observedJournal),
    };
    const report = {
      status: "next-selected-load-inspected" as const,
      previousRunId: priorLoad.runId,
      priorLoadFamilySha256: sha256(canonicalJson([priorLoad])),
      generation,
      catalogSha256,
      journalSha256: priorLoad.journalSha256,
      inventorySha256: observed.report.inventorySha256,
      selectionSha256: selected.selection.selectionSha256,
      captureFamilySha256: selected.selection.familySha256,
      runId: selected.runState.runId,
      importRunId: plan.receipt.importRunId,
      reportSha256: plan.receipt.reportSha256,
      physicalValidationRequired: true as const,
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
    };
    return {
      report,
      selector: selected.selection.selector,
      source: selected.source,
      anchorBaselineSha256: selected.baselineSha256,
      runtimeIdentitySha256: selected.runtimeIdentitySha256,
      earliestAdmissionEpochMs: Math.max(
        baseline.checkpoint.createdAtEpochMs,
        predecessorCommit,
        selected.source.importObservedAtEpochMs
      ),
    };
  } catch {
    return fail();
  } finally {
    key?.fill(0);
  }
}

/** Report the observation without exposing private admission inputs. */
export function inspectNextRecoveryGmailSelectedLoad(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector
) {
  return readNextSelectedLoadAdmissionEvidence(prior, next).report;
}
