import {
  copyRecoveryGmailSelectedReceiptSelector,
  type RecoveryGmailSelectedReceiptSelector,
} from "./recovery-gmail-capture-admission-proof.js";
import { planCapturedLoadAfterPredecessor } from "./recovery-gmail-selected-load-captured-plan.js";
import type { RecoveryGmailNextSelectedLoadFrameInput } from "./recovery-gmail-selected-load-next-framing.js";
import { readNextSelectedLoadCompletionEvidence } from "./recovery-gmail-selected-load-next-replay.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

function invalid(): never {
  throw Error("INVALID_THIRD_RECOVERY_GMAIL_SELECTED_LOAD_INSPECTION");
}

/**
 * Prove the completed first and second loads and plan one distinct retained
 * capture against their observed ledger. Return only the read-only commitments.
 */
export function readThirdSelectedLoadAdmissionEvidence(
  family: RecoveryGmailNextSelectedLoadFrameInput,
  third: RecoveryGmailSelectedReceiptSelector
) {
  let key: Buffer | undefined;
  try {
    const selector = copyRecoveryGmailSelectedReceiptSelector(third);
    const first = copyRecoveryGmailSelectedReceiptSelector(
      family.prior.selector
    );
    const second = copyRecoveryGmailSelectedReceiptSelector(family.next);
    if ([first.receiptId, second.receiptId].includes(selector.receiptId))
      return invalid();

    const completed = readNextSelectedLoadCompletionEvidence(
      family.prior,
      second,
      family.admission
    );
    const {
      report,
      observedCatalog,
      observedJournal,
      physicalEntries,
      completionIdentity,
    } = completed;
    if (
      report.status !== "selected-load-complete" ||
      report.lease.status !== "released" ||
      observedCatalog.generation !== 3 ||
      !completionIdentity
    )
      return invalid();

    key = Buffer.from(family.prior.recoveryKey);
    const planned = planCapturedLoadAfterPredecessor({
      originalBaseline: completed.effective.originalBaseline,
      observedCatalog,
      observedJournal,
      physicalEntries,
      predecessorRunId: report.runId,
      selector,
      key,
    });
    const journalSha256 = sha256(observedJournal);
    const inventorySha256 = sha256(canonicalJson(physicalEntries));
    const completedPrefixSha256 = sha256(
      canonicalJson({
        domain: "zivv-recovery-gmail-selected-load-prefix/v1",
        firstLoadFamilySha256: completionIdentity.priorFamilySha256,
        second: {
          runId: report.runId,
          admissionSha256: report.admissionSha256,
          executionBaselineSha256: completionIdentity.executionBaselineSha256,
          historyManifestSha256: completionIdentity.historyManifestSha256,
          resultSha256: report.resultSha256,
        },
        catalogSha256: report.ledgerRevision,
        generation: report.generation,
        journalSha256,
        inventorySha256,
      })
    );
    const reportCommitments = {
      status: "third-selected-load-inspected" as const,
      previousRunId: report.runId,
      completedPrefixSha256,
      generation: report.generation,
      catalogSha256: report.ledgerRevision,
      journalSha256,
      inventorySha256,
      anchorBaselineSha256: planned.proof.baselineSha256,
      selectionSha256: planned.proof.selection.selectionSha256,
      captureFamilySha256: planned.proof.selection.familySha256,
      runId: planned.proof.runState.runId,
      importRunId: planned.plan.receipt.importRunId,
      reportSha256: planned.plan.receipt.reportSha256,
      earliestAdmissionEpochMs: planned.earliestAdmissionEpochMs,
      physicalValidationRequired: true as const,
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
      freezeAllowed: false as const,
    };
    return {
      report: reportCommitments,
      firstSelector: completed.effective.originalBaseline.selector,
      secondSelector: completed.effective.proof.selection.selector,
      secondAdmissionSha256: report.admissionSha256,
      selector: planned.proof.selection.selector,
      source: planned.proof.source,
      runtimeIdentitySha256: planned.proof.runtimeIdentitySha256,
      archiveSha256: completionIdentity.archiveSha256,
      retirementReceiptSha256: completionIdentity.retirementReceiptSha256,
      preparedReceiptSha256: completionIdentity.preparedReceiptSha256,
    };
  } catch {
    return invalid();
  } finally {
    key?.fill(0);
  }
}

/** Report the independent observation while retaining the private selector and source. */
export function inspectThirdRecoveryGmailSelectedLoad(
  family: RecoveryGmailNextSelectedLoadFrameInput,
  third: RecoveryGmailSelectedReceiptSelector
) {
  return readThirdSelectedLoadAdmissionEvidence(family, third).report;
}
