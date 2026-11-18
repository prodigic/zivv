import { join } from "node:path";
import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import type { RecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import { proveSelectedLoadRunDelta } from "./recovery-gmail-selected-journal-delta.js";
import { observeSelectedLoadLease } from "./recovery-gmail-selected-lease-observation.js";
import { assertSelectedGmailLoadCatalog } from "./recovery-gmail-selected-load-effects.js";
import {
  decodeRecoveryGmailSelectedLoadFrame,
  encodeRecoveryGmailSelectedLoadFrame,
  type RecoveryGmailSelectedLoadFrameInput,
} from "./recovery-gmail-selected-load-framing.js";
import { selectedLoadBackupPath } from "./recovery-gmail-selected-load-historical-predecessor.js";
import { readNextSelectedLoadFamily } from "./recovery-gmail-selected-load-next-family.js";
import {
  canonicalJson,
  readCanonicalSqliteLedgerReadOnly,
} from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";

function fail(): never {
  throw Error("INVALID_NEXT_SELECTED_LOAD_INTERRUPTION_INSPECTION");
}

/** Prove an interrupted second load before its load artifact or result exists.
 * This is detached evidence. A future resume must revalidate under both locks. */
export function readNextSelectedLoadInterruptionEvidence(
  supplied: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  signedAdmission: Buffer
) {
  let wire: Buffer | undefined,
    input: RecoveryGmailSelectedLoadFrameInput | undefined;
  try {
    if (!Buffer.isBuffer(signedAdmission) || signedAdmission.length > 65536)
      return fail();
    wire = encodeRecoveryGmailSelectedLoadFrame(supplied);
    input = decodeRecoveryGmailSelectedLoadFrame(wire);
    const {
      opened,
      root,
      entries,
      read,
      loadPath,
      runId,
      executionBytes,
      execution,
      record,
      effective,
      admissionSha256,
    } = readNextSelectedLoadFamily(input, next, Buffer.from(signedAdmission));
    const catalogPath = join(root, "operator/ledger.sqlite");
    const journalPath = join(root, "operator/weekly-runs.sqlite");
    const catalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
    const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    const { plan, proof, raw } = effective;

    const rolledBack = catalog.generation === execution.generation;
    if (rolledBack) {
      if (
        canonicalJson(catalog.ledger) !==
        canonicalJson(effective.catalog.ledger)
      )
        return fail();
    } else {
      if (catalog.generation !== execution.generation + 1) return fail();
      assertSelectedGmailLoadCatalog(
        plan,
        effective.catalog.ledger,
        catalog.ledger,
        execution.startedAtEpochMs
      );
    }
    const status = rolledBack ? "unchanged" : "committed";
    const delta = proveSelectedLoadRunDelta({
      priorJournal: effective.journal,
      observedJournal: journal,
      startedAtEpochMs: execution.startedAtEpochMs,
      admissionSha256,
      plan,
      source: proof.source,
      runId,
      raw,
      observedLedger: catalog.ledger,
      catalogDisposition: status,
    });
    const retained = validateWeeklyJournalRecoverySnapshot(journal);
    const row = retained.runState.find((item) => item.id === runId);
    const owner = retained.ownership.find(
      (item) => item.scope === "prodigic/zivv/production"
    );
    if (
      delta.status !== status ||
      !row ||
      !owner ||
      owner.expiresAtEpochMs < execution.startedAtEpochMs
    )
      return fail();
    const state = parseWeeklyRunState(JSON.parse(row.payload));
    const load = state.stages.find((item) => item.stage === "load");
    if (
      load?.status !== "running" ||
      load.attempt !== 1 ||
      state.stages.slice(0, 3).some((item) => item.status !== "succeeded") ||
      retained.stageArtifacts.some(
        (item) => item.runId === runId && item.stage === "load"
      )
    )
      return fail();

    const before = new Map(
      execution.entries.map((entry) => [entry.path, entry])
    );
    const executionPath = loadPath + "/execution-baseline.json";
    const executionStage = executionPath + "-stage";
    before.set(executionStage, { path: executionStage, kind: "directory" });
    before.set(executionPath, {
      path: executionPath,
      kind: "file",
      size: executionBytes.length,
      sha256: sha256(executionBytes),
    });
    const backup = read(selectedLoadBackupPath, 512 * 1024 * 1024);
    const backupLedger = canonicalJson(
      decryptLedgerSnapshot(backup, input.recoveryKey)
    );
    if (
      backupLedger !== canonicalJson(effective.catalog.ledger) &&
      (rolledBack || backupLedger !== canonicalJson(catalog.ledger))
    )
      return fail();
    before.set(selectedLoadBackupPath, {
      path: selectedLoadBackupPath,
      kind: "file",
      size: backup.length,
      sha256: sha256(backup),
    });

    const reportPath =
      "checkout/data/ingestion/reports/" +
      sha256(plan.receipt.importRunId) +
      ".json";
    const physicalReport = entries.find((entry) => entry.path === reportPath);
    if (physicalReport) {
      const report = read(reportPath, 64 * 1024 * 1024);
      if (
        !report.equals(
          Buffer.from(JSON.stringify(plan.result.report, null, 2) + "\n")
        )
      )
        return fail();
      before.set(reportPath, {
        path: reportPath,
        kind: "file",
        size: report.length,
        sha256: sha256(report),
      });
    }
    const expected = [...before.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );
    if (
      canonicalJson(expected) !== canonicalJson(entries) ||
      canonicalJson(entries) !==
        canonicalJson(opened.inventoryGmailSelectedLoadExecution()) ||
      canonicalJson(catalog) !==
        canonicalJson(readCanonicalSqliteLedgerReadOnly(catalogPath)) ||
      !journal.equals(readWeeklyJournalRecoverySnapshotReadOnly(journalPath))
    )
      return fail();
    const report = {
      status,
      runId,
      generation: catalog.generation,
      lease: observeSelectedLoadLease(owner.expiresAtEpochMs),
      journalSha256: delta.journalSha256,
      inventorySha256: sha256(canonicalJson(entries)),
      physicalValidationRequired: true as const,
      loadAllowed: false as const,
      activationAllowed: false as const,
      captureAllowed: false as const,
    };
    return {
      report,
      state,
      owner,
      catalog,
      journal,
      entries,
      executionBytes,
      execution,
      admissionSha256,
      record,
      effective,
      backup,
    };
  } catch {
    return fail();
  } finally {
    input?.recoveryKey.fill(0);
    wire?.fill(0);
  }
}

export function inspectNextSelectedLoadInterruption(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  signedAdmission: Buffer
) {
  return readNextSelectedLoadInterruptionEvidence(prior, next, signedAdmission)
    .report;
}
