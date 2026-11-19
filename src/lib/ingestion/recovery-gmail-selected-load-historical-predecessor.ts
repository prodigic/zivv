import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import type { SelectedNextLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import { observeSelectedLoadCompletionIntentFile } from "./recovery-gmail-selected-load-completion-prefix.js";
import { reconstructSelectedLoadCompletionJournals } from "./recovery-gmail-selected-load-completion-intent.js";
import {
  readSelectedLoadHistoryFiles,
  type SelectedLoadHistoryIdentity,
} from "./recovery-gmail-selected-load-history.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";

export const selectedLoadBackupPath =
  "checkout/data/ingestion/backups/ledger.snapshot.enc";

interface SelectedLoadHistoryReader {
  root: string;
  entries: RecoveryRuntimeEntry[];
  read: (path: string, limit: number) => Buffer;
  key: Buffer;
}

function invalid(): never {
  throw Error("INVALID_SELECTED_LOAD_HISTORICAL_PREDECESSOR");
}

/**
 * Reconstruct settled private history from the signed completion evidence.
 * The caller must bind the run identity and independently prove its full delta
 * and the live installation. This does not read the current SQL or backup.
 */
export function readSettledSelectedLoadHistory(
  input: SelectedLoadHistoryReader & { identity: SelectedLoadHistoryIdentity }
) {
  const { root, entries, identity, key, read } = input;
  const loadPath = "recovery-gmail-load/" + identity.runId;
  const completion = observeSelectedLoadCompletionIntentFile({
    destination: root,
    entries,
    identity,
    key,
  });
  if (completion.state !== "settled") return invalid();
  const history = readSelectedLoadHistoryFiles({
    loadPath,
    entries,
    identity,
    read,
    key,
  });
  const { encryptedCatalog, guardedJournal, inventory } = history.parts;
  const ledger = decryptLedgerSnapshot(encryptedCatalog, key);
  const { releasedJournal, guardedJournal: rebuiltGuardedJournal } =
    reconstructSelectedLoadCompletionJournals(
      guardedJournal,
      completion.fields
    );
  const resultPath = loadPath + "/load-result.json";
  const resultEntry = entries.find(({ path }) => path === resultPath);
  const result = read(resultPath, 65536);
  const resultSha256 = sha256(result);
  if (
    ledgerDigest(ledger) !== identity.ledgerRevision ||
    history.manifestSha256 !== completion.fields.historyManifestSha256 ||
    !rebuiltGuardedJournal.equals(guardedJournal) ||
    resultEntry?.kind !== "file" ||
    resultEntry.size !== result.length ||
    resultEntry.sha256 !== resultSha256 ||
    resultSha256 !== completion.fields.resultSha256
  )
    return invalid();

  const released = validateWeeklyJournalRecoverySnapshot(releasedJournal);
  const row = released.runState.find(
    ({ id, scope }) =>
      id === identity.runId && scope === "prodigic/zivv/production"
  );
  if (!row) return invalid();
  const state = parseWeeklyRunState(JSON.parse(row.payload));
  const load = state.stages.find(({ stage }) => stage === "load");
  if (
    state.runId !== identity.runId ||
    state.revision !== row.revision ||
    load?.status !== "succeeded" ||
    load.evidence?.ledgerRevision !== identity.ledgerRevision
  )
    return invalid();

  return {
    catalog: { ledger, generation: identity.generation },
    journal: releasedJournal,
    snapshot: encryptedCatalog,
    inventory,
    resultSha256,
    historyManifestSha256: history.manifestSha256,
    loadAllowed: false as const,
  };
}

/** Recover the first load's original view from its history and the next
 * execution's pinned start state. The full first delta is checked separately. */
export function readSelectedLoadHistoricalPredecessor(
  input: SelectedLoadHistoryReader & {
    loadPath: string;
    admission: Buffer;
    executionBaseline: Buffer;
    nextExecution: SelectedNextLoadExecutionBaseline;
  }
) {
  const { entries, executionBaseline, nextExecution, loadPath } = input;
  const identity = {
    runId: loadPath.slice("recovery-gmail-load/".length),
    admissionSha256: sha256(input.admission),
    executionBaselineSha256: sha256(executionBaseline),
    priorFamilySha256: sha256(canonicalJson([])),
    ledgerRevision: nextExecution.catalogSha256,
    generation: nextExecution.generation,
  };
  if (loadPath !== "recovery-gmail-load/" + identity.runId) return invalid();
  const historical = readSettledSelectedLoadHistory({ ...input, identity });
  const backup = entries.find((entry) => entry.path === selectedLoadBackupPath);
  if (
    sha256(historical.journal) !== nextExecution.journalSha256 ||
    backup?.kind !== "file" ||
    backup.size !== historical.snapshot.length ||
    backup.sha256 !== sha256(historical.snapshot)
  )
    return invalid();
  return {
    catalog: historical.catalog,
    journal: historical.journal,
    snapshot: historical.snapshot,
  };
}
