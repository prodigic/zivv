import { join, resolve } from "node:path";
import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import { proveSelectedLoadRunDelta } from "./recovery-gmail-selected-journal-delta.js";
import { reconstructSelectedLoadCompletionJournals } from "./recovery-gmail-selected-load-completion-intent.js";
import { regenerateSelectedLoadCompletionPlan } from "./recovery-gmail-selected-load-completion-plan.js";
import {
  observeSelectedLoadCompletionIntentFile,
  observeSelectedLoadCompletionPrefix,
} from "./recovery-gmail-selected-load-completion-prefix.js";
import { assertSelectedGmailLoadCatalog } from "./recovery-gmail-selected-load-effects.js";
import { selectedLoadBackupPath } from "./recovery-gmail-selected-load-historical-predecessor.js";
import { assertRecordedCompletionInventory } from "./recovery-gmail-selected-load-next-replay.js";
import { readSelectedLoadEntry } from "./recovery-gmail-selected-load-physical-reader.js";
import type { RecoveryGmailThirdSelectedLoadFrameInput } from "./recovery-gmail-selected-load-third-framing.js";
import { readThirdSelectedLoadPlanFromHistory } from "./recovery-gmail-selected-load-third-start.js";
import { verifySelectedLoadResult } from "./recovery-gmail-selected-result-proof.js";
import { openPreparedRuntimeForAdmission } from "./recovery-runtime.js";
import {
  canonicalJson,
  ledgerDigest,
  readCanonicalSqliteLedgerReadOnly,
} from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";

function invalid(): never {
  throw Error("INVALID_RECOVERY_GMAIL_THIRD_SELECTED_LOAD_COMPLETION");
}

/** Verify one fully released third load against the exact expected live delta.
 * Partial starts and interrupted completions require separate evidence. */
export function inspectThirdSelectedLoadCompletion(
  input: RecoveryGmailThirdSelectedLoadFrameInput,
  executionBaseline: Buffer
) {
  try {
    const { baseline, effective } = readThirdSelectedLoadPlanFromHistory(
      input,
      executionBaseline
    );
    const {
      recoveryKey: key,
      selector: _selector,
      ...host
    } = input.family.prior;
    const { plan, proof, raw } = effective;
    const opened = openPreparedRuntimeForAdmission({
      ...host,
      recoveryKey: key,
    });
    if (opened.receiptSha256 !== baseline.preparedReceiptSha256)
      return invalid();
    const root = resolve(host.destination);
    const entries = opened.inventoryGmailSelectedLoadExecution();
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    if (byPath.size !== entries.length) return invalid();
    const read = (path: string, limit: number) =>
      readSelectedLoadEntry(root, byPath.get(path), limit);
    const loadPath = "recovery-gmail-load/" + baseline.runId;
    if (
      !read(loadPath + "/execution-baseline.json", 16 * 1024 * 1024).equals(
        executionBaseline
      ) ||
      !read(loadPath + "/admission.json", 65536).equals(input.admission)
    )
      return invalid();
    const catalogPath = join(root, "operator/ledger.sqlite");
    const journalPath = join(root, "operator/weekly-runs.sqlite");
    const catalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
    const observedJournal =
      readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    if (catalog.generation !== baseline.generation + 1) return invalid();
    assertSelectedGmailLoadCatalog(
      plan,
      effective.catalog.ledger,
      catalog.ledger,
      baseline.startedAtEpochMs
    );
    const identity = {
      runId: baseline.runId,
      admissionSha256: baseline.admissionSha256,
      executionBaselineSha256: sha256(executionBaseline),
      priorFamilySha256: baseline.completedPrefixSha256,
      ledgerRevision: ledgerDigest(catalog.ledger),
      generation: catalog.generation,
    };
    const completion = observeSelectedLoadCompletionIntentFile({
      destination: root,
      entries,
      identity,
      key,
    });
    if (completion.state !== "settled") return invalid();
    const commitTime = catalog.ledger.runs.find(
      ({ runId }) => runId === plan.receipt.importRunId
    )?.committedAtEpochMs;
    if (
      typeof commitTime !== "number" ||
      commitTime >= completion.fields.owner.expiresAtEpochMs
    )
      return invalid();
    const journals = reconstructSelectedLoadCompletionJournals(
      observedJournal,
      completion.fields
    );
    if (!observedJournal.equals(journals.releasedJournal)) return invalid();
    const journal = validateWeeklyJournalRecoverySnapshot(observedJournal);
    const row = journal.runState.find(
      ({ id, scope }) =>
        id === identity.runId && scope === "prodigic/zivv/production"
    );
    if (!row) return invalid();
    const state = parseWeeklyRunState(JSON.parse(row.payload));
    const delta = proveSelectedLoadRunDelta({
      priorJournal: effective.journal,
      observedJournal: journals.guardedJournal,
      startedAtEpochMs: baseline.startedAtEpochMs,
      admissionSha256: identity.admissionSha256,
      plan,
      source: proof.source,
      runId: identity.runId,
      raw,
      observedLedger: catalog.ledger,
      catalogDisposition: "committed",
    });
    if (
      delta.status !== "committed" ||
      state.stages.find(({ stage }) => stage === "load")?.status !== "succeeded"
    )
      return invalid();
    const snapshot = read(selectedLoadBackupPath, 512 * 1024 * 1024);
    const reportPath =
      "checkout/data/ingestion/reports/" +
      sha256(plan.receipt.importRunId) +
      ".json";
    if (baseline.entries.some(({ path }) => path === reportPath))
      return invalid();
    const report = read(reportPath, 64 * 1024 * 1024);
    if (
      canonicalJson(decryptLedgerSnapshot(snapshot, key)) !==
        canonicalJson(catalog.ledger) ||
      !report.equals(
        Buffer.from(JSON.stringify(plan.result.report, null, 2) + "\n")
      )
    )
      return invalid();
    const runStateSha256 = sha256(canonicalJson(state));
    const sealed = regenerateSelectedLoadCompletionPlan({
      encryptedCatalog: snapshot,
      entries,
      runStateSha256,
      reportSha256: plan.receipt.reportSha256,
      intent: completion.fields,
      observedJournal,
      key,
    });
    assertRecordedCompletionInventory({
      loadPath,
      prior: baseline.entries,
      inventory: sealed.inventory,
      execution: executionBaseline,
      snapshot,
      reportPath,
      report,
    });
    const prefix = observeSelectedLoadCompletionPrefix({
      destination: root,
      runId: identity.runId,
      entries,
      files: sealed.files,
      result: sealed.result,
    });
    if (prefix.next) return invalid();
    const result = verifySelectedLoadResult(sealed.result, key, {
      runId: identity.runId,
      admissionSha256: identity.admissionSha256,
      executionBaselineSha256: identity.executionBaselineSha256,
      ledgerRevision: identity.ledgerRevision,
      generation: identity.generation,
      journalSha256: sha256(journals.releasedJournal),
      guardedJournalSha256: sha256(journals.guardedJournal),
      runStateSha256,
      reportSha256: plan.receipt.reportSha256,
      historyManifestSha256: completion.fields.historyManifestSha256,
    });
    if (
      result.resultSha256 !== completion.fields.resultSha256 ||
      canonicalJson(entries) !==
        canonicalJson(opened.inventoryGmailSelectedLoadExecution()) ||
      canonicalJson(catalog) !==
        canonicalJson(readCanonicalSqliteLedgerReadOnly(catalogPath)) ||
      !observedJournal.equals(
        readWeeklyJournalRecoverySnapshotReadOnly(journalPath)
      )
    )
      return invalid();
    return {
      status: "selected-load-complete" as const,
      runId: identity.runId,
      generation: identity.generation,
      ledgerRevision: identity.ledgerRevision,
      resultSha256: result.resultSha256,
      admissionSha256: identity.admissionSha256,
      accepted: plan.result.report.acceptedEventIds.length,
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
    };
  } catch {
    return invalid();
  }
}
