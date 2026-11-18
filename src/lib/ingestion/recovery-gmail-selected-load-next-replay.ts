import { join, resolve } from "node:path";
import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import type { RecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import { verifySelectedNextLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import { proveSelectedLoadRunDelta } from "./recovery-gmail-selected-journal-delta.js";
import { reconstructSelectedLoadCompletionJournals } from "./recovery-gmail-selected-load-completion-intent.js";
import { observeSelectedLoadCompletionIntentFile } from "./recovery-gmail-selected-load-completion-prefix.js";
import { assertSelectedGmailLoadCatalog } from "./recovery-gmail-selected-load-effects.js";
import {
  decodeRecoveryGmailSelectedLoadFrame,
  encodeRecoveryGmailSelectedLoadFrame,
  type RecoveryGmailSelectedLoadFrameInput,
} from "./recovery-gmail-selected-load-framing.js";
import { selectedLoadBackupPath } from "./recovery-gmail-selected-load-historical-predecessor.js";
import { readSelectedLoadHistoryFiles } from "./recovery-gmail-selected-load-history.js";
import {
  readNextSelectedLoadAdmissionForReplay,
  readNextSelectedLoadAdmissionRunId,
} from "./recovery-gmail-selected-load-next-admission.js";
import { selectedLoadCompletionIntentFilename } from "./recovery-gmail-selected-load-paths.js";
import { readSelectedLoadEntry } from "./recovery-gmail-selected-load-physical-reader.js";
import { verifySelectedLoadResult } from "./recovery-gmail-selected-result-proof.js";
import {
  openPreparedRuntimeForAdmission,
  type RecoveryRuntimeEntry,
} from "./recovery-runtime.js";
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

function assertRecordedCompletionInventory(input: {
  loadPath: string;
  prior: RecoveryRuntimeEntry[];
  actual: RecoveryRuntimeEntry[];
  history: Buffer;
  execution: Buffer;
  snapshot: Buffer;
  reportPath: string;
  report: Buffer;
}) {
  const { loadPath, prior, actual } = input;
  const result = loadPath + "/load-result.json";
  const stage = result + "-stage";
  const intent = loadPath + "/" + selectedLoadCompletionIntentFilename;
  if (
    !actual.some((entry) => entry.path === stage && entry.kind === "directory")
  )
    return fail();
  const projected = actual.filter(
    (entry) =>
      entry.path !== result &&
      entry.path !== stage &&
      !entry.path.startsWith(loadPath + "/history-") &&
      !entry.path.startsWith(intent)
  );
  // Intent/history names were independently verified against their exact files.
  // No extra files (including children of the result stage) are projected out.
  if (!input.history.equals(Buffer.from(canonicalJson(projected) + "\n")))
    return fail();
  const expected = new Map(prior.map((entry) => [entry.path, entry]));
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
  if (canonicalJson(ordered) !== canonicalJson(projected)) return fail();
}

/** Return a completed successor's original result only after independently
 * proving the predecessor and the successor's entire live delta. No writes. */
export function replayRecoveredGmailNextSelectedLoad(
  supplied: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  signedAdmission: Buffer
) {
  let wire: Buffer | undefined,
    input: RecoveryGmailSelectedLoadFrameInput | undefined;
  try {
    if (!Buffer.isBuffer(signedAdmission) || signedAdmission.length > 65536)
      return fail();
    const admission = Buffer.from(signedAdmission);
    wire = encodeRecoveryGmailSelectedLoadFrame(supplied);
    input = decodeRecoveryGmailSelectedLoadFrame(wire);
    const { selector: _selector, recoveryKey: key, ...host } = input;
    const opened = openPreparedRuntimeForAdmission({
      ...host,
      recoveryKey: key,
    });
    const root = resolve(host.destination);
    const entries = opened.inventoryGmailSelectedLoadExecution();
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    if (byPath.size !== entries.length) return fail();
    const read = (path: string, limit: number) =>
      readSelectedLoadEntry(root, byPath.get(path), limit);

    const runId = readNextSelectedLoadAdmissionRunId(admission, key);
    const loadPath = "recovery-gmail-load/" + runId;
    if (!read(loadPath + "/admission.json", 65536).equals(admission))
      return fail();
    const executionBytes = read(
      loadPath + "/execution-baseline.json",
      32 * 1024 * 1024
    );
    const execution = verifySelectedNextLoadExecutionBaseline(
      executionBytes,
      key
    );
    const { record, effective } = readNextSelectedLoadAdmissionForReplay(
      input,
      next,
      admission,
      executionBytes
    );
    const admissionSha256 = sha256(admission);
    if (
      execution.admissionSha256 !== admissionSha256 ||
      execution.priorLoadFamilySha256 !== record.priorLoadFamilySha256 ||
      execution.catalogSha256 !== record.catalogSha256 ||
      execution.journalSha256 !== record.journalSha256 ||
      execution.startedAtEpochMs < record.admittedAtEpochMs ||
      execution.startedAtEpochMs > Date.now()
    )
      return fail();

    const catalogPath = join(root, "operator/ledger.sqlite");
    const journalPath = join(root, "operator/weekly-runs.sqlite");
    const catalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
    const observedJournal =
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
    const completion = observeSelectedLoadCompletionIntentFile({
      destination: root,
      entries,
      identity,
      key,
    });
    if (
      completion.state !== "settled" ||
      (completion.fields.owner.expiresAtEpochMs > Date.now() &&
        sha256(observedJournal) !== completion.fields.releasedJournalSha256)
    )
      return fail();
    const journals = reconstructSelectedLoadCompletionJournals(
      observedJournal,
      completion.fields
    );
    const history = readSelectedLoadHistoryFiles({
      loadPath,
      entries,
      read,
      identity,
      key,
    });
    const snapshot = read(selectedLoadBackupPath, 512 * 1024 * 1024);
    if (
      history.manifestSha256 !== completion.fields.historyManifestSha256 ||
      !history.parts.encryptedCatalog.equals(snapshot) ||
      !history.parts.guardedJournal.equals(journals.guardedJournal) ||
      canonicalJson(decryptLedgerSnapshot(snapshot, key)) !==
        canonicalJson(catalog.ledger)
    )
      return fail();

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
    });
    const row = validateWeeklyJournalRecoverySnapshot(
      observedJournal
    ).runState.find((entry) => entry.id === runId);
    if (delta.status !== "committed" || !row) return fail();
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
    assertRecordedCompletionInventory({
      loadPath,
      prior: execution.entries,
      actual: entries,
      history: history.parts.inventory,
      execution: executionBytes,
      snapshot,
      reportPath,
      report,
    });

    const result = verifySelectedLoadResult(
      read(loadPath + "/load-result.json", 65536),
      key,
      {
        runId,
        admissionSha256,
        executionBaselineSha256: identity.executionBaselineSha256,
        ledgerRevision,
        generation: catalog.generation,
        journalSha256: sha256(journals.releasedJournal),
        guardedJournalSha256: sha256(journals.guardedJournal),
        runStateSha256: sha256(canonicalJson(state)),
        reportSha256: plan.receipt.reportSha256,
        historyManifestSha256: history.manifestSha256,
      }
    );
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
      return fail();
    return {
      status: "selected-load-complete" as const,
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
      runId,
      ledgerRevision,
      generation: catalog.generation,
      resultSha256: result.resultSha256,
      admissionSha256,
      accepted: plan.result.report.acceptedEventIds.length,
    };
  } catch {
    return fail();
  } finally {
    input?.recoveryKey.fill(0);
    wire?.fill(0);
  }
}
