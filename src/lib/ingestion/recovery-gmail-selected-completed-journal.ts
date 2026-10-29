import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { observeSelectedLoadLease } from "./recovery-gmail-selected-lease-observation.js";
import type { SelectedLoadResumeIntent } from "./recovery-gmail-selected-resume-intent.js";

/** Detached observation only. The returned hash must be checked against the
 * authenticated result before treating the normalized journal as evidence. */
export function observeSelectedLoadCompletedJournal(
  bytes: Buffer,
  intent: SelectedLoadResumeIntent
) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_COMPLETED_JOURNAL");
  };
  const snapshot = validateWeeklyJournalRecoverySnapshot(bytes);
  const owner = snapshot.ownership.find(
    (row) => row.scope === "prodigic/zivv/production"
  );
  if (
    !owner ||
    owner.owner !== intent.owner ||
    owner.fence !== intent.fence ||
    owner.expiresAtEpochMs > intent.deadlineEpochMs
  )
    return fail();
  const lease = observeSelectedLoadLease(owner.expiresAtEpochMs);
  if (lease.status === "active")
    throw Error("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
  if (lease.status === "released")
    return {
      releasedJournal: Buffer.from(bytes),
      guardedJournalSha256: null,
      lease,
    };
  owner.expiresAtEpochMs = 0;
  const { digest: _digest, ...body } = snapshot;
  const releasedJournal = Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  );
  validateWeeklyJournalRecoverySnapshot(releasedJournal);
  return { releasedJournal, guardedJournalSha256: sha256(bytes), lease };
}
