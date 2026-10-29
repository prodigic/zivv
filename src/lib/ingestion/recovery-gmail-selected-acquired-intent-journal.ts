import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import type { SelectedLoadResumeIntent } from "./recovery-gmail-selected-resume-intent.js";

/** Reconstruct the signed pre-intent journal when the only durable change is
 * acquisition (or release) of the intent's exact fence. This is detached
 * evidence: the caller must authenticate the intent, prove the original
 * journal and physical state, and observe expiry under the real locks. */
export function reconstructSelectedLoadAcquiredIntentJournal(input: {
  observedJournal: Buffer;
  intent: SelectedLoadResumeIntent;
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_ACQUIRED_INTENT_JOURNAL");
  };
  const current = validateWeeklyJournalRecoverySnapshot(input.observedJournal);
  const owner = current.ownership.find(
    (row) => row.scope === "prodigic/zivv/production"
  );
  if (
    !owner ||
    owner.owner !== input.intent.owner ||
    owner.fence !== input.intent.fence ||
    (owner.expiresAtEpochMs !== 0 &&
      (owner.expiresAtEpochMs < input.intent.startedAtEpochMs ||
        owner.expiresAtEpochMs > input.intent.deadlineEpochMs))
  )
    return fail();
  const previous = structuredClone(current);
  Object.assign(
    previous.ownership.find((row) => row.scope === owner.scope)!,
    input.intent.previousOwner
  );
  const { digest: _digest, ...body } = previous;
  const bytes = Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  );
  validateWeeklyJournalRecoverySnapshot(bytes);
  if (sha256(bytes) !== input.intent.journalSha256) return fail();
  return {
    previousJournal: bytes,
    observedOwner: { ...owner },
    loadAllowed: false as const,
    activationAllowed: false as const,
  };
}
