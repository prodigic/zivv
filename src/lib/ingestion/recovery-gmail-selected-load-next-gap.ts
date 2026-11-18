import {
  nextSelectedLoadResumeGap,
  observeNextSelectedLoadResumeIntent,
  type NextSelectedLoadResumeGap,
} from "./recovery-gmail-selected-load-next-resume-intent.js";
import {
  readNextSelectedLoadResumeSuccessors,
  rewindNextSelectedLoadAcquiredRetries,
} from "./recovery-gmail-selected-load-next-successors.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
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
  ledgerDigest,
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

/** Derive the pre-resume inventory from the signed execution baseline and the
 * three paths the running load may have installed before its load artifact. */
export function nextSelectedLoadGapInventory(input: {
  entries: RecoveryRuntimeEntry[];
  loadPath: string;
  executionBytes: Buffer;
  backupSha256: string;
  backupSize: number;
  reportPath: string;
  report: Buffer | undefined;
}) {
  const prior = new Map(input.entries.map((entry) => [entry.path, entry]));
  if (prior.size !== input.entries.length) return fail();
  const executionPath = input.loadPath + "/execution-baseline.json";
  const executionStage = executionPath + "-stage";
  prior.set(executionStage, { path: executionStage, kind: "directory" });
  prior.set(executionPath, {
    path: executionPath,
    kind: "file",
    size: input.executionBytes.length,
    sha256: sha256(input.executionBytes),
  });
  prior.set(selectedLoadBackupPath, {
    path: selectedLoadBackupPath,
    kind: "file",
    size: input.backupSize,
    sha256: input.backupSha256,
  });
  if (input.report)
    prior.set(input.reportPath, {
      path: input.reportPath,
      kind: "file",
      size: input.report.length,
      sha256: sha256(input.report),
    });
  return [...prior.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
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
    const saved = observeNextSelectedLoadResumeIntent(
      root,
      loadPath,
      entries,
      input.recoveryKey
    );
    const successors = readNextSelectedLoadResumeSuccessors({
      loadPath,
      entries,
      read,
      initial: saved,
      key: input.recoveryKey,
    });
    if (
      successors.length &&
      (!saved?.observed.target || saved.observed.candidate)
    )
      return fail();
    const records = saved ? [saved, ...successors] : [];
    const latest = records.at(-1);
    const acquired =
      !!latest && latest.intent.journalSha256 !== sha256(journal);
    if (
      (latest && latest.intent.startedAtEpochMs > Date.now()) ||
      (acquired && (!saved?.observed.target || saved.observed.candidate))
    )
      return fail();
    const originalJournal = rewindNextSelectedLoadAcquiredRetries(
      journal,
      acquired ? records : records.slice(0, -1)
    );

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
      observedJournal: originalJournal,
      startedAtEpochMs: execution.startedAtEpochMs,
      admissionSha256,
      plan,
      source: proof.source,
      runId,
      raw,
      observedLedger: catalog.ledger,
      catalogDisposition: status,
    });
    const retained = validateWeeklyJournalRecoverySnapshot(originalJournal);
    const owner = validateWeeklyJournalRecoverySnapshot(journal).ownership.find(
      (item) => item.scope === "prodigic/zivv/production"
    );
    const row = retained.runState.find((item) => item.id === runId);
    const originalOwner = retained.ownership.find(
      (item) => item.scope === "prodigic/zivv/production"
    );
    if (
      delta.status !== status ||
      !row ||
      !owner ||
      !originalOwner ||
      (latest &&
        !acquired &&
        canonicalJson(owner) !== canonicalJson(latest.intent.previousOwner)) ||
      originalOwner.expiresAtEpochMs < execution.startedAtEpochMs
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

    const backup = read(selectedLoadBackupPath, 512 * 1024 * 1024);
    const backupSha256 = sha256(backup);
    const backupLedger = canonicalJson(
      decryptLedgerSnapshot(backup, input.recoveryKey)
    );
    const previousBackup = execution.entries.find(
      (entry) => entry.path === selectedLoadBackupPath
    );
    const inheritedBackup =
      previousBackup?.kind === "file" &&
      previousBackup.sha256 === backupSha256 &&
      previousBackup.size === backup.length;
    if (
      !inheritedBackup &&
      (rolledBack || backupLedger !== canonicalJson(catalog.ledger))
    )
      return fail();
    if (
      inheritedBackup &&
      backupLedger !== canonicalJson(effective.catalog.ledger)
    )
      return fail();

    const reportPath =
      "checkout/data/ingestion/reports/" +
      sha256(plan.receipt.importRunId) +
      ".json";
    const expectedReport = Buffer.from(
      JSON.stringify(plan.result.report, null, 2) + "\n"
    );
    const storedReport = entries.some((entry) => entry.path === reportPath)
      ? read(reportPath, 64 * 1024 * 1024)
      : undefined;
    if (
      (!rolledBack && !storedReport) ||
      (storedReport && !storedReport.equals(expectedReport))
    )
      return fail();

    const inventory = nextSelectedLoadGapInventory({
      entries: execution.entries,
      loadPath,
      executionBytes,
      backupSha256,
      backupSize: backup.length,
      reportPath,
      report: storedReport,
    });
    const gap: NextSelectedLoadResumeGap = {
      runId,
      admissionSha256,
      executionBaselineSha256: sha256(executionBytes),
      priorLoadFamilySha256: record.priorLoadFamilySha256,
      journalSha256: delta.journalSha256,
      inventorySha256: sha256(canonicalJson(inventory)),
      ledgerRevision: ledgerDigest(catalog.ledger),
      generation: rolledBack ? 2 : 3,
      previousOwner: originalOwner,
      backupSha256,
      backupSize: backup.length,
      reportPresent: !!storedReport,
    };
    if (
      saved &&
      canonicalJson(nextSelectedLoadResumeGap(saved.intent)) !==
        canonicalJson(gap)
    )
      return fail();
    const retryPaths = new Set(saved?.paths);
    for (const { path, stage } of successors) {
      retryPaths.add(path);
      retryPaths.add(stage);
    }
    const inputEntries = entries.filter((entry) => !retryPaths.has(entry.path));
    if (
      canonicalJson(inventory) !== canonicalJson(inputEntries) ||
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
      journalSha256: sha256(journal),
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
      gap,
      saved,
      successors,
      latest,
      acquired,
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
