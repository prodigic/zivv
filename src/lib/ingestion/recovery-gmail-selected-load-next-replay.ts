import {
  nextSelectedLoadGapInventory,
  proveNextSelectedLoadCommittedRollback,
  proveNextSelectedLoadRollbackBackup,
} from "./recovery-gmail-selected-load-next-gap.js";
import { readInstalledNextSelectedLoadResumeIntent } from "./recovery-gmail-selected-load-next-resume-intent.js";
import {
  readNextSelectedLoadResumeSuccessors,
  rewindNextSelectedLoadAcquiredRetries,
} from "./recovery-gmail-selected-load-next-successors.js";
import { reconstructSelectedLoadResumeJournal } from "./recovery-gmail-selected-resume-journal.js";
import { join } from "node:path";
import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import type { RecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import { proveSelectedLoadRunDelta } from "./recovery-gmail-selected-journal-delta.js";
import {
  projectSelectedLoadReleasedJournal,
  reconstructSelectedLoadCompletionJournals,
  verifySelectedLoadCompletionIntent,
} from "./recovery-gmail-selected-load-completion-intent.js";
import {
  observeSelectedLoadCompletionIntentFile,
  observeSelectedLoadCompletionPrefix,
} from "./recovery-gmail-selected-load-completion-prefix.js";
import {
  prepareSelectedLoadCompletionSeal,
  regenerateSelectedLoadCompletionPlan,
} from "./recovery-gmail-selected-load-completion-plan.js";
import { selectedLoadCompletionIntentFilename } from "./recovery-gmail-selected-load-paths.js";
import { observeSelectedLoadLease } from "./recovery-gmail-selected-lease-observation.js";
import { assertSelectedGmailLoadCatalog } from "./recovery-gmail-selected-load-effects.js";
import {
  decodeRecoveryGmailSelectedLoadFrame,
  encodeRecoveryGmailSelectedLoadFrame,
  type RecoveryGmailSelectedLoadFrameInput,
} from "./recovery-gmail-selected-load-framing.js";
import { selectedLoadBackupPath } from "./recovery-gmail-selected-load-historical-predecessor.js";
import { readThirdSelectedLoadPredecessorHistory } from "./recovery-gmail-selected-load-third-history.js";
import type { SelectedThirdLoadEvidenceTail } from "./recovery-gmail-selected-load-third-start-tail.js";
import { readNextSelectedLoadFamily } from "./recovery-gmail-selected-load-next-family.js";
import { verifySelectedLoadResult } from "./recovery-gmail-selected-result-proof.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
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
  throw Error("INVALID_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_REPLAY");
}

export function assertRecordedCompletionInventory(input: {
  loadPath: string;
  prior: RecoveryRuntimeEntry[];
  inventory: RecoveryRuntimeEntry[];
  execution: Buffer;
  snapshot: Buffer;
  reportPath: string;
  report: Buffer;
}) {
  const { loadPath, prior } = input;
  const expected = new Map(prior.map((entry) => [entry.path, entry]));
  if (expected.size !== prior.length) return fail();
  const execution = loadPath + "/execution-baseline.json";
  const executionStage = execution + "-stage";
  expected.set(executionStage, { path: executionStage, kind: "directory" });
  for (const [path, bytes] of [
    [execution, input.execution],
    [selectedLoadBackupPath, input.snapshot],
    [input.reportPath, input.report],
  ] as const)
    expected.set(path, {
      path,
      kind: "file",
      size: bytes.length,
      sha256: sha256(bytes),
    });
  const ordered = [...expected.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  if (canonicalJson(ordered) !== canonicalJson(input.inventory)) return fail();
}

function verifyCompletedNextResume(input: {
  saved: NonNullable<
    ReturnType<typeof readInstalledNextSelectedLoadResumeIntent>
  >;
  successors: ReturnType<typeof readNextSelectedLoadResumeSuccessors>;
  family: ReturnType<typeof readNextSelectedLoadFamily>;
  releasedJournal: Buffer;
  catalog: ReturnType<typeof readCanonicalSqliteLedgerReadOnly>;
  backup: Buffer;
  reportPath: string;
  report: Buffer;
}) {
  const { saved, successors, family, catalog } = input;
  const records = [saved, ...successors];
  const latest = successors.at(-1) ?? saved;
  const { intent } = saved;
  const {
    execution,
    executionBytes,
    effective,
    loadPath,
    runId,
    admissionSha256,
  } = family;
  const { plan, proof, raw } = effective;
  const resumedCatalog = intent.generation === 2 ? effective.catalog : catalog;
  if (
    intent.runId !== runId ||
    intent.admissionSha256 !== admissionSha256 ||
    intent.executionBaselineSha256 !== sha256(executionBytes) ||
    intent.priorLoadFamilySha256 !== execution.priorLoadFamilySha256 ||
    intent.ledgerRevision !== ledgerDigest(resumedCatalog.ledger) ||
    intent.startedAtEpochMs <= execution.startedAtEpochMs ||
    latest.intent.startedAtEpochMs > Date.now()
  )
    return fail();

  const inherited = execution.entries.find(
    (entry) => entry.path === selectedLoadBackupPath
  );
  const originallyInherited =
    inherited?.kind === "file" &&
    inherited.size === intent.backupSize &&
    inherited.sha256 === intent.backupSha256;
  const originallyCommitted =
    intent.generation === 3 &&
    input.backup.length === intent.backupSize &&
    sha256(input.backup) === intent.backupSha256;
  if (!originallyInherited && !originallyCommitted) return fail();
  if (intent.generation === 2) {
    proveNextSelectedLoadRollbackBackup(family, intent);
    if (
      !intent.reportPresent &&
      execution.entries.some((entry) => entry.path === input.reportPath)
    )
      return fail();
    const transitionIndex = successors.findIndex(
      (record) => record.intent.committedRollback
    );
    const transition = successors[transitionIndex];
    if (transition) {
      const parent = records[transitionIndex];
      if (
        !parent ||
        canonicalJson(transition.intent.committedRollback) !==
          canonicalJson(
            proveNextSelectedLoadCommittedRollback({
              family,
              original: intent,
              catalog,
              reportPath: input.reportPath,
              report: input.report,
              parent: parent.intent,
              previousOwner: transition.intent.previousOwner,
            })
          )
      )
        return fail();
    } else {
      const commitTime = catalog.ledger.runs.find(
        (run) => run.runId === plan.receipt.importRunId
      )?.committedAtEpochMs;
      if (
        typeof commitTime !== "number" ||
        commitTime < latest.intent.startedAtEpochMs ||
        commitTime >= latest.intent.deadlineEpochMs
      )
        return fail();
      assertSelectedGmailLoadCatalog(
        plan,
        effective.catalog.ledger,
        catalog.ledger,
        latest.intent.startedAtEpochMs
      );
    }
  }
  const previousInventory = nextSelectedLoadGapInventory({
    entries: execution.entries,
    loadPath,
    executionBytes,
    backupSha256: intent.backupSha256,
    backupSize: intent.backupSize,
    reportPath: input.reportPath,
    report: intent.reportPresent ? input.report : undefined,
  });
  if (sha256(canonicalJson(previousInventory)) !== intent.inventorySha256)
    return fail();

  const beforeCompletionRetry = reconstructSelectedLoadResumeJournal({
    completedJournal: input.releasedJournal,
    intent: latest.intent,
    runId,
  });
  const previous = rewindNextSelectedLoadAcquiredRetries(
    beforeCompletionRetry,
    records.slice(0, -1)
  );
  const disposition = intent.generation === 2 ? "unchanged" : "committed";
  const delta = proveSelectedLoadRunDelta({
    priorJournal: effective.journal,
    observedJournal: previous,
    startedAtEpochMs: execution.startedAtEpochMs,
    admissionSha256,
    plan,
    source: proof.source,
    runId,
    raw,
    observedLedger: resumedCatalog.ledger,
    catalogDisposition: disposition,
  });
  if (
    delta.status !== disposition ||
    validateWeeklyJournalRecoverySnapshot(previous).stageArtifacts.some(
      (entry) => entry.runId === runId && entry.stage === "load"
    )
  )
    return fail();
  return {
    successor: {
      previousOwner: intent.previousOwner,
      count: records.length,
      deadlineEpochMs: latest.intent.deadlineEpochMs,
    },
    successorSha256: sha256(latest.bytes),
    addedEntries: records.flatMap(({ path, bytes, stage }) => [
      {
        path,
        kind: "file" as const,
        size: bytes.length,
        sha256: sha256(bytes),
      },
      { path: stage, kind: "directory" as const },
    ]),
  };
}

interface ThirdStartHistoryRequest {
  selector: RecoveryGmailSelectedReceiptSelector;
  admission: Buffer;
  executionBaseline: Buffer;
}

/** Authenticate the second load's completed journal and its exact signed file
 * prefix. This detached observation supplies no writer permission. */
function readNextSelectedLoadCompletion(
  supplied: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  signedAdmission: Buffer,
  thirdTail?: SelectedThirdLoadEvidenceTail,
  historical?: ThirdStartHistoryRequest
) {
  let wire: Buffer | undefined,
    input: RecoveryGmailSelectedLoadFrameInput | undefined;
  try {
    if (!Buffer.isBuffer(signedAdmission) || signedAdmission.length > 65536)
      return fail();
    const admission = Buffer.from(signedAdmission);
    wire = encodeRecoveryGmailSelectedLoadFrame(supplied);
    input = decodeRecoveryGmailSelectedLoadFrame(wire);
    const key = input.recoveryKey;
    const witness = historical
      ? readThirdSelectedLoadPredecessorHistory(
          {
            family: { prior: input, next, admission },
            third: historical.selector,
            admission: historical.admission,
          },
          historical.executionBaseline
        )
      : undefined;
    const family =
      witness?.family ??
      readNextSelectedLoadFamily(input, next, admission, thirdTail);
    const {
      opened,
      root,
      entries,
      allEntries,
      beforeThirdStartEntries,
      thirdStartPresence,
      thirdAdmissionPresence,
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
    const catalog =
      witness?.history.catalog ??
      readCanonicalSqliteLedgerReadOnly(catalogPath);
    const observedJournal =
      witness?.history.journal ??
      readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    if (catalog.generation !== execution.generation + 1) return fail();
    const { plan, proof, raw } = effective;
    assertSelectedGmailLoadCatalog(
      plan,
      effective.catalog.ledger,
      catalog.ledger,
      execution.startedAtEpochMs
    );

    const ledgerRevision = ledgerDigest(catalog.ledger);
    const identity = {
      runId,
      admissionSha256,
      executionBaselineSha256: sha256(executionBytes),
      priorFamilySha256: record.priorLoadFamilySha256,
      ledgerRevision,
      generation: catalog.generation,
    };
    const intentPath = loadPath + "/" + selectedLoadCompletionIntentFilename;
    const hasIntentStage = entries.some(
      ({ path }) => path === intentPath + "-stage"
    );
    let installed:
      | ReturnType<typeof observeSelectedLoadCompletionIntentFile>
      | undefined;
    if (entries.some(({ path }) => path.startsWith(intentPath))) {
      try {
        installed = observeSelectedLoadCompletionIntentFile({
          destination: root,
          entries,
          identity,
          key,
        });
      } catch (error) {
        // A canonical intent can only be authenticated from its existing bytes.
        if (!hasIntentStage || entries.some(({ path }) => path === intentPath))
          throw error;
      }
    }
    const journals = installed
      ? reconstructSelectedLoadCompletionJournals(
          observedJournal,
          installed.fields
        )
      : {
          ...projectSelectedLoadReleasedJournal(observedJournal),
          guardedJournal: observedJournal,
        };
    const snapshot =
      witness?.history.snapshot ??
      read(selectedLoadBackupPath, 512 * 1024 * 1024);
    if (
      canonicalJson(decryptLedgerSnapshot(snapshot, key)) !==
      canonicalJson(catalog.ledger)
    )
      return fail();

    const observed = validateWeeklyJournalRecoverySnapshot(observedJournal);
    const owner = observed.ownership.find(
      (entry) => entry.scope === "prodigic/zivv/production"
    );
    const row = observed.runState.find((entry) => entry.id === runId);
    if (!owner || !row) return fail();
    const state = parseWeeklyRunState(JSON.parse(row.payload));
    if (
      state.stages.find((item) => item.stage === "load")?.status !== "succeeded"
    )
      return fail();
    const reportPath =
      "checkout/data/ingestion/reports/" +
      sha256(plan.receipt.importRunId) +
      ".json";
    const report = read(reportPath, 64 * 1024 * 1024);
    if (
      !report.equals(
        Buffer.from(JSON.stringify(plan.result.report, null, 2) + "\n")
      )
    )
      return fail();
    const saved = readInstalledNextSelectedLoadResumeIntent(
      loadPath,
      entries,
      read,
      key
    );
    const successors = readNextSelectedLoadResumeSuccessors({
      loadPath,
      entries,
      read,
      initial: saved,
      key,
    });
    const resumed = saved
      ? verifyCompletedNextResume({
          saved,
          successors,
          family,
          releasedJournal: journals.releasedJournal,
          catalog,
          backup: snapshot,
          reportPath,
          report,
        })
      : undefined;
    const delta = proveSelectedLoadRunDelta({
      priorJournal: effective.journal,
      observedJournal: journals.guardedJournal,
      startedAtEpochMs: execution.startedAtEpochMs,
      admissionSha256,
      plan,
      source: proof.source,
      runId,
      raw,
      observedLedger: catalog.ledger,
      catalogDisposition: "committed",
      ...(resumed ? { successor: resumed.successor } : {}),
    });
    if (delta.status !== "committed") return fail();
    const runStateSha256 = sha256(canonicalJson(state));
    const signedInput = {
      encryptedCatalog: snapshot,
      entries,
      runStateSha256,
      reportSha256: plan.receipt.reportSha256,
      successorSha256: resumed?.successorSha256,
      key,
    };
    const inventoryInput = {
      loadPath,
      prior: resumed
        ? [...execution.entries, ...resumed.addedEntries]
        : execution.entries,
      execution: executionBytes,
      snapshot,
      reportPath,
      report,
    };
    const preIntentInventory = entries.filter(
      ({ path }) => !path.startsWith(intentPath)
    );
    if (!installed) {
      assertRecordedCompletionInventory({
        ...inventoryInput,
        inventory: preIntentInventory,
      });
      const retry = successors.at(-1)?.intent ?? saved?.intent;
      const started = retry?.startedAtEpochMs ?? execution.startedAtEpochMs;
      const commitTime = catalog.ledger.runs.find(
        (run) => run.runId === plan.receipt.importRunId
      )?.committedAtEpochMs;
      if (
        owner.expiresAtEpochMs <= started ||
        typeof commitTime !== "number" ||
        commitTime >= owner.expiresAtEpochMs
      )
        return fail();
    }
    const proposed = installed
      ? undefined
      : prepareSelectedLoadCompletionSeal({
          ...signedInput,
          entries: preIntentInventory,
          identity,
          guardedJournal: observedJournal,
        });
    const completion =
      installed ??
      (hasIntentStage
        ? observeSelectedLoadCompletionIntentFile({
            destination: root,
            entries,
            identity,
            key,
            expectedBytes: proposed!.completionBytes,
          })
        : {
            ...verifySelectedLoadCompletionIntent(
              proposed!.completionBytes,
              key,
              identity
            ),
            state: "absent" as const,
            candidate: undefined,
          });
    const completionPlan =
      proposed ??
      regenerateSelectedLoadCompletionPlan({
        ...signedInput,
        intent: completion.fields,
        observedJournal,
      });
    const prefix = observeSelectedLoadCompletionPrefix({
      destination: root,
      runId,
      entries,
      files: completionPlan.files,
      result: completionPlan.result,
    });
    if (
      completion.state !== "settled" &&
      (prefix.settledCount !== 0 || prefix.next?.state !== "absent")
    )
      return fail();

    if (installed)
      assertRecordedCompletionInventory({
        ...inventoryInput,
        inventory: completionPlan.inventory,
      });

    const result = verifySelectedLoadResult(completionPlan.result, key, {
      runId,
      admissionSha256,
      executionBaselineSha256: identity.executionBaselineSha256,
      ledgerRevision,
      generation: catalog.generation,
      journalSha256: sha256(journals.releasedJournal),
      guardedJournalSha256: sha256(journals.guardedJournal),
      runStateSha256,
      reportSha256: plan.receipt.reportSha256,
      historyManifestSha256: completion.fields.historyManifestSha256,
      ...(resumed ? { successorSha256: resumed.successorSha256 } : {}),
    });
    if (
      result.resultSha256 !== completion.fields.resultSha256 ||
      canonicalJson(allEntries) !==
        canonicalJson(opened.inventoryGmailSelectedLoadExecution()) ||
      (!witness &&
        (canonicalJson(catalog) !==
          canonicalJson(readCanonicalSqliteLedgerReadOnly(catalogPath)) ||
          !observedJournal.equals(
            readWeeklyJournalRecoverySnapshotReadOnly(journalPath)
          )))
    )
      return fail();
    const lease = observeSelectedLoadLease(owner.expiresAtEpochMs);
    if (
      witness &&
      (prefix.next ||
        completion.state !== "settled" ||
        lease.status !== "released" ||
        result.resultSha256 !== witness.history.resultSha256 ||
        completion.fields.historyManifestSha256 !==
          witness.history.historyManifestSha256)
    )
      return fail();
    return {
      ...(witness ? { historicalOnly: true as const } : {}),
      report: {
        status: prefix.next
          ? ("completion-pending" as const)
          : ("selected-load-complete" as const),
        lease,
        activationAllowed: false as const,
        captureAllowed: false as const,
        loadAllowed: false as const,
        runId,
        ledgerRevision,
        generation: catalog.generation,
        resultSha256: result.resultSha256,
        admissionSha256,
        accepted: plan.result.report.acceptedEventIds.length,
      },
      ...(prefix.next
        ? {
            completionPending: {
              intent: completion,
              plan: completionPlan,
              prefix,
            },
          }
        : {}),
      effective,
      raw,
      ...(!prefix.next && lease.status === "released"
        ? {
            completionIdentity: {
              preparedReceiptSha256: opened.receiptSha256,
              archiveSha256: sha256(input.archive),
              retirementReceiptSha256: sha256(input.retirementReceipt),
              priorFamilySha256: identity.priorFamilySha256,
              executionBaselineSha256: identity.executionBaselineSha256,
              historyManifestSha256: completion.fields.historyManifestSha256,
            },
          }
        : {}),
      physicalEntries: entries,
      allPhysicalEntries: beforeThirdStartEntries,
      ...(thirdStartPresence ? { thirdStartPresence } : {}),
      ...(thirdAdmissionPresence ? { thirdAdmissionPresence } : {}),
      observedCatalog: catalog,
      observedJournal,
    };
  } catch {
    return fail();
  } finally {
    input?.recoveryKey.fill(0);
    wire?.fill(0);
  }
}

export function readNextSelectedLoadCompletionEvidence(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer
) {
  return readNextSelectedLoadCompletion(prior, next, admission);
}

/** Internal predecessor evidence. The caller checks the full v3 intent
 * against the projected released state before granting any installation. */
export function readNextSelectedLoadCompletionBeforeThirdAdmission(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer,
  tail: SelectedThirdLoadEvidenceTail
) {
  return readNextSelectedLoadCompletion(prior, next, admission, tail);
}

/** Reprove the completed second load against its authenticated historical view.
 * This path supplies no present catalog or writer permission. */
export function readNextSelectedLoadCompletionFromThirdHistory(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer,
  historical: ThirdStartHistoryRequest
) {
  return readNextSelectedLoadCompletion(
    prior,
    next,
    admission,
    undefined,
    historical
  );
}

export function inspectNextSelectedLoadCompletion(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer
) {
  return readNextSelectedLoadCompletionEvidence(prior, next, admission).report;
}

/** Return only an already settled result after re-proving the complete family. */
export function replayRecoveredGmailNextSelectedLoad(
  prior: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer
) {
  const { report } = readNextSelectedLoadCompletionEvidence(
    prior,
    next,
    admission
  );
  if (
    report.status !== "selected-load-complete" ||
    report.lease.status === "active"
  )
    return fail();
  const { lease: _lease, ...completed } = report;
  return { ...completed, status: "selected-load-complete" as const };
}
