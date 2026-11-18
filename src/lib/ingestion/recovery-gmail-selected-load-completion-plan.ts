import {
  reconstructSelectedLoadCompletionJournals,
  type SelectedLoadCompletionIntent,
} from "./recovery-gmail-selected-load-completion-intent.js";
import { prepareSelectedLoadHistoryFiles } from "./recovery-gmail-selected-load-history.js";
import { selectedLoadCompletionIntentFilename } from "./recovery-gmail-selected-load-paths.js";
import { signSelectedLoadHistoricalResult } from "./recovery-gmail-selected-result-proof.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

/** Recreate the exact files pinned by authenticated completion intent.
 * The caller must independently prove current canonical state, verify the
 * installed prefix and recheck both stores under their writer guards. */
export function regenerateSelectedLoadCompletionPlan(input: {
  intent: SelectedLoadCompletionIntent;
  observedJournal: Buffer;
  encryptedCatalog: Buffer;
  entries: RecoveryRuntimeEntry[];
  runStateSha256: string;
  reportSha256: string;
  successorSha256?: string;
  key: Buffer;
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_COMPLETION_PLAN");
  };
  const { intent, entries } = input;
  if (new Set(entries.map(({ path }) => path)).size !== entries.length)
    return fail();
  const journals = reconstructSelectedLoadCompletionJournals(
    input.observedJournal,
    intent
  );
  const root = "recovery-gmail-load/" + intent.identity.runId + "/";
  const resultPath = root + "load-result.json";
  const resultStage = resultPath + "-stage";
  const completionPath = root + selectedLoadCompletionIntentFilename;
  const projection = entries.filter(
    ({ path }) =>
      !path.startsWith(root + "history-") &&
      path !== completionPath &&
      path !== completionPath + "-stage" &&
      !path.startsWith(completionPath + "-stage/") &&
      path !== resultPath &&
      !path.startsWith(resultStage + "/")
  );
  const projections = [projection];
  if (projection.some(({ path }) => path === resultStage))
    projections.push(projection.filter(({ path }) => path !== resultStage));
  const candidates = projections
    .map((inventory) => ({
      ...prepareSelectedLoadHistoryFiles(
        intent.identity,
        {
          encryptedCatalog: input.encryptedCatalog,
          guardedJournal: journals.guardedJournal,
          inventory: Buffer.from(canonicalJson(inventory) + "\n"),
        },
        input.key
      ),
      inventory,
    }))
    .filter(
      ({ manifestSha256 }) => manifestSha256 === intent.historyManifestSha256
    );
  if (candidates.length !== 1) return fail();
  const { files, inventory } = candidates[0]!;
  const { priorFamilySha256: _priorFamilySha256, ...resultIdentity } =
    intent.identity;
  const result = signSelectedLoadHistoricalResult(
    {
      ...resultIdentity,
      journalSha256: intent.releasedJournalSha256,
      guardedJournalSha256: intent.guardedJournalSha256,
      runStateSha256: input.runStateSha256,
      reportSha256: input.reportSha256,
      historyManifestSha256: intent.historyManifestSha256,
      ...(input.successorSha256
        ? { successorSha256: input.successorSha256 }
        : {}),
    },
    input.key
  );
  if (sha256(result) !== intent.resultSha256) return fail();
  return {
    files,
    result,
    releasedJournal: journals.releasedJournal,
    guardedJournal: journals.guardedJournal,
    inventory,
    loadAllowed: false as const,
  };
}
