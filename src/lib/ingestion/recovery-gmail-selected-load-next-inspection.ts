import {
  copyRecoveryGmailSelectedReceiptSelector,
  type RecoveryGmailSelectedReceiptSelector,
} from "./recovery-gmail-capture-admission-proof.js";
import type { SelectedLoadAdmissionTail } from "./recovery-gmail-selected-load-admission-tail.js";
import { planCapturedLoadAfterPredecessor } from "./recovery-gmail-selected-load-captured-plan.js";
import type { RecoveryGmailSelectedLoadFrameInput } from "./recovery-gmail-selected-load-framing.js";
import { readSelectedLoadInterruptionEvidence } from "./recovery-gmail-selected-load-interruption-inspection.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

function fail(): never {
  throw Error("INVALID_NEXT_RECOVERY_GMAIL_SELECTED_LOAD_INSPECTION");
}

/** Observe a distinct, already captured receipt after one fully released load.
 * The original checkpoint still anchors capture evidence. The prospective
 * import plan uses the prior load's independently verified canonical catalog.
 * This summary grants no installation, journal, or catalog writer authority. */
export function readNextSelectedLoadAdmissionEvidence(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  nextAdmission?: SelectedLoadAdmissionTail,
  nextExecutionBaseline?: Buffer
) {
  let key: Buffer | undefined;
  try {
    const selector = copyRecoveryGmailSelectedReceiptSelector(next);
    const observed = readSelectedLoadInterruptionEvidence(
      prior,
      nextAdmission,
      nextExecutionBaseline
    );
    if (
      observed.report.status !== "completed" ||
      observed.report.lease.status !== "released" ||
      !observed.completedResultSha256 ||
      !observed.completedHistoryManifestSha256 ||
      selector.receiptId === observed.originalBaseline.selector.receiptId
    )
      return fail();

    key = Buffer.from(prior.recoveryKey);
    const { ledger, generation } = observed.observedCatalog;
    const {
      proof: selected,
      plan,
      raw,
      earliestAdmissionEpochMs,
    } = planCapturedLoadAfterPredecessor({
      originalBaseline: observed.originalBaseline,
      observedCatalog: observed.observedCatalog,
      observedJournal: observed.observedJournal,
      physicalEntries: observed.physicalEntries,
      predecessorRunId: observed.report.runId,
      selector,
      key,
    });
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
      effective: {
        originalBaseline: observed.originalBaseline,
        proof: selected,
        plan,
        raw,
        catalog: observed.observedCatalog,
        journal: observed.observedJournal,
        snapshot: observed.changedFiles.snapshot,
        entries: observed.physicalEntries,
      },
      earliestAdmissionEpochMs,
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
