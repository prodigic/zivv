import {
  nextSelectedLoadResumeGap,
  observeNextSelectedLoadResumeIntent,
  type NextSelectedLoadResumeGap,
  type NextSelectedLoadResumeIntent,
} from "./recovery-gmail-selected-load-next-resume-intent.js";
import {
  readNextSelectedLoadResumeSuccessors,
  rewindNextSelectedLoadAcquiredRetries,
  type NextSelectedLoadCommittedRollback,
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
  type WeeklyRunLease,
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

/** Bind the original encrypted A snapshot to both independently proved B baselines. */
export function proveNextSelectedLoadRollbackBackup(
  family: ReturnType<typeof readNextSelectedLoadFamily>,
  initial: NextSelectedLoadResumeIntent
): Buffer {
  const snapshot = family.effective.snapshot;
  if (!snapshot) return fail();
  const hash = sha256(snapshot);
  if (
    initial.generation !== 2 ||
    initial.backupSha256 !== hash ||
    initial.backupSize !== snapshot.length ||
    [family.execution.entries, family.effective.entries].some((entries) => {
      const entry = entries.find(
        (item) => item.path === selectedLoadBackupPath
      );
      return (
        entry?.kind !== "file" ||
        entry.sha256 !== hash ||
        entry.size !== snapshot.length
      );
    })
  )
    return fail();
  return snapshot;
}

/** Prove that the committed delta belongs to the exact acquired retry, and that
 * only its canonical report was added to the pre-artifact file inventory. */
export function proveNextSelectedLoadCommittedRollback(input: {
  family: ReturnType<typeof readNextSelectedLoadFamily>;
  original: NextSelectedLoadResumeIntent;
  catalog: ReturnType<typeof readCanonicalSqliteLedgerReadOnly>;
  reportPath: string;
  report: Buffer;
  parent: Pick<
    NextSelectedLoadResumeIntent,
    "startedAtEpochMs" | "deadlineEpochMs" | "owner" | "fence"
  >;
  previousOwner: WeeklyRunLease;
}): NextSelectedLoadCommittedRollback {
  const { family, original, catalog, parent, previousOwner } = input;
  const backup = proveNextSelectedLoadRollbackBackup(family, original);
  const committed = catalog.ledger.runs.find(
    (run) => run.runId === family.effective.plan.receipt.importRunId
  )?.committedAtEpochMs;
  if (
    catalog.generation !== family.execution.generation + 1 ||
    original.ledgerRevision !== ledgerDigest(family.effective.catalog.ledger) ||
    previousOwner.owner !== parent.owner ||
    previousOwner.fence !== parent.fence ||
    typeof committed !== "number" ||
    committed < parent.startedAtEpochMs ||
    committed >= (previousOwner.expiresAtEpochMs || parent.deadlineEpochMs)
  )
    return fail();
  assertSelectedGmailLoadCatalog(
    family.effective.plan,
    family.effective.catalog.ledger,
    catalog.ledger,
    parent.startedAtEpochMs
  );
  const inventory = nextSelectedLoadGapInventory({
    entries: family.execution.entries,
    loadPath: family.loadPath,
    executionBytes: family.executionBytes,
    backupSha256: original.backupSha256,
    backupSize: backup.length,
    reportPath: input.reportPath,
    report: input.report,
  });
  return {
    ledgerRevision: ledgerDigest(catalog.ledger),
    inventorySha256: sha256(canonicalJson(inventory)),
  };
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
    const family = readNextSelectedLoadFamily(
      input,
      next,
      Buffer.from(signedAdmission)
    );
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
    } = family;
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
    const crossedCommit = !rolledBack && saved?.intent.generation === 2;
    if (rolledBack) {
      if (
        canonicalJson(catalog.ledger) !==
        canonicalJson(effective.catalog.ledger)
      )
        return fail();
    } else {
      if (catalog.generation !== execution.generation + 1) return fail();
      if (!crossedCommit)
        assertSelectedGmailLoadCatalog(
          plan,
          effective.catalog.ledger,
          catalog.ledger,
          execution.startedAtEpochMs
        );
    }
    const status = rolledBack ? "unchanged" : "committed";
    const transitionIndex = successors.findIndex(
      (record) => record.intent.committedRollback
    );
    if (transitionIndex >= 0 && !crossedCommit) return fail();
    const originalCatalog = crossedCommit ? effective.catalog : catalog;
    const originalStatus =
      originalCatalog.generation === execution.generation
        ? "unchanged"
        : "committed";
    const delta = proveSelectedLoadRunDelta({
      priorJournal: effective.journal,
      observedJournal: originalJournal,
      startedAtEpochMs: execution.startedAtEpochMs,
      admissionSha256,
      plan,
      source: proof.source,
      runId,
      raw,
      observedLedger: originalCatalog.ledger,
      catalogDisposition: originalStatus,
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
      delta.status !== originalStatus ||
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
    let originalInventory = inventory;
    let committedRollback: NextSelectedLoadCommittedRollback | undefined;
    if (crossedCommit) {
      if (!saved || !storedReport || !latest) return fail();
      const inherited = proveNextSelectedLoadRollbackBackup(
        family,
        saved.intent
      );
      if (
        !backup.equals(inherited) ||
        (!saved.intent.reportPresent &&
          execution.entries.some((entry) => entry.path === reportPath))
      )
        return fail();
      originalInventory = nextSelectedLoadGapInventory({
        entries: execution.entries,
        loadPath,
        executionBytes,
        backupSha256,
        backupSize: backup.length,
        reportPath,
        report: saved.intent.reportPresent ? storedReport : undefined,
      });
      const transition = successors[transitionIndex];
      if (!transition && !acquired) return fail();
      const parent = transition ? records[transitionIndex] : latest;
      if (!parent) return fail();
      const proof = proveNextSelectedLoadCommittedRollback({
        family,
        original: saved.intent,
        catalog,
        reportPath,
        report: storedReport,
        parent: parent.intent,
        previousOwner: transition?.intent.previousOwner ?? owner,
      });
      if (transition) {
        if (
          canonicalJson(transition.intent.committedRollback) !==
          canonicalJson(proof)
        )
          return fail();
      } else committedRollback = proof;
    }
    const gap: NextSelectedLoadResumeGap = {
      runId,
      admissionSha256,
      executionBaselineSha256: sha256(executionBytes),
      priorLoadFamilySha256: record.priorLoadFamilySha256,
      journalSha256: delta.journalSha256,
      inventorySha256: sha256(canonicalJson(originalInventory)),
      ledgerRevision: ledgerDigest(originalCatalog.ledger),
      generation: originalStatus === "unchanged" ? 2 : 3,
      previousOwner: originalOwner,
      backupSha256,
      backupSize: backup.length,
      reportPresent: crossedCommit
        ? saved!.intent.reportPresent
        : !!storedReport,
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
      committedRollback,
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
