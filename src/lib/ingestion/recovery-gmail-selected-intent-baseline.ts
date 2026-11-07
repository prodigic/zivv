import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { reconstructSelectedLoadAcquiredIntentJournal } from "./recovery-gmail-selected-acquired-intent-journal.js";
import type { SelectedLoadResumeIntent } from "./recovery-gmail-selected-resume-intent.js";
import type { SelectedLoadIntentV2SuccessorEvidence } from "./recovery-gmail-selected-intent-chain.js";

/** Reconstruct the initial intent's journal when the latest authenticated
 * attempt is unacquired or has only acquired its owner fence. The caller must
 * authenticate the records and independently prove physical and catalog state. */
export function reconstructSelectedLoadIntentBaseline(input: {
  observedJournal: Buffer;
  initial: SelectedLoadResumeIntent;
  latest?: SelectedLoadIntentV2SuccessorEvidence;
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_INTENT_BASELINE");
  };
  const current = validateWeeklyJournalRecoverySnapshot(input.observedJournal);
  const owner = current.ownership.find(
    (row) => row.scope === "prodigic/zivv/production"
  );
  if (!owner) return fail();
  const effective = input.latest ?? input.initial;
  const unacquired = sha256(input.observedJournal) === effective.journalSha256;
  if (unacquired) {
    if (canonicalJson(owner) !== canonicalJson(effective.previousOwner))
      return fail();
  } else {
    reconstructSelectedLoadAcquiredIntentJournal({
      observedJournal: input.observedJournal,
      intent: effective,
    });
  }
  const prior = structuredClone(current);
  Object.assign(
    prior.ownership.find((row) => row.scope === owner.scope)!,
    input.initial.previousOwner
  );
  const { digest: _digest, ...body } = prior;
  const baselineJournal = Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  );
  validateWeeklyJournalRecoverySnapshot(baselineJournal);
  if (sha256(baselineJournal) !== input.initial.journalSha256) return fail();
  return {
    baselineJournal,
    acquired: !unacquired,
    loadAllowed: false as const,
    activationAllowed: false as const,
  };
}
