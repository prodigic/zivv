import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import type { SelectedNextLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import { observeSelectedLoadCompletionIntentFile } from "./recovery-gmail-selected-load-completion-prefix.js";
import { reconstructSelectedLoadCompletionJournals } from "./recovery-gmail-selected-load-completion-intent.js";
import { readSelectedLoadHistoryFiles } from "./recovery-gmail-selected-load-history.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

export const selectedLoadBackupPath =
  "checkout/data/ingestion/backups/ledger.snapshot.enc";

/** Recover the first load's original view from its history. The caller still
 * proves its complete delta against the archived host and capture baseline. */
export function readSelectedLoadHistoricalPredecessor(input: {
  root: string;
  loadPath: string;
  admission: Buffer;
  executionBaseline: Buffer;
  nextExecution: SelectedNextLoadExecutionBaseline;
  entries: RecoveryRuntimeEntry[];
  read: (path: string, limit: number) => Buffer;
  key: Buffer;
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_HISTORICAL_PREDECESSOR");
  };
  const {
    root,
    entries,
    executionBaseline,
    nextExecution,
    loadPath,
    key,
    read,
  } = input;
  const identity = {
    runId: loadPath.slice("recovery-gmail-load/".length),
    admissionSha256: sha256(input.admission),
    executionBaselineSha256: sha256(executionBaseline),
    priorFamilySha256: sha256(canonicalJson([])),
    ledgerRevision: nextExecution.catalogSha256,
    generation: nextExecution.generation,
  };
  const completion = observeSelectedLoadCompletionIntentFile({
    destination: root,
    entries,
    identity,
    key,
  });
  if (completion.state !== "settled") return fail();
  const history = readSelectedLoadHistoryFiles({
    loadPath,
    entries,
    identity,
    read,
    key,
  });
  const { encryptedCatalog, guardedJournal } = history.parts;
  const ledger = decryptLedgerSnapshot(encryptedCatalog, key);
  const backup = entries.find((entry) => entry.path === selectedLoadBackupPath);
  const journals = reconstructSelectedLoadCompletionJournals(
    guardedJournal,
    completion.fields
  );
  if (
    ledgerDigest(ledger) !== nextExecution.catalogSha256 ||
    history.manifestSha256 !== completion.fields.historyManifestSha256 ||
    sha256(journals.releasedJournal) !== nextExecution.journalSha256 ||
    !journals.guardedJournal.equals(guardedJournal) ||
    backup?.kind !== "file" ||
    backup.size !== encryptedCatalog.length ||
    backup.sha256 !== sha256(encryptedCatalog)
  )
    return fail();
  return {
    catalog: { ledger, generation: identity.generation },
    journal: journals.releasedJournal,
    snapshot: encryptedCatalog,
  };
}
