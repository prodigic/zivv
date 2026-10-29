import { createHmac } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { verifySelectedLoadIntentChain } from "./recovery-gmail-selected-intent-chain.js";
import { reconstructSelectedLoadAcquiredIntentJournal } from "./recovery-gmail-selected-acquired-intent-journal.js";

/** Prepare one authenticated successor from a supplied observation. No file is
 * installed and no retry is authorized: the caller must independently prove
 * the source, catalog and physical inventory, then repeat all observations and
 * actual-time expiry checks under both journal and catalog writer locks. */
export function prepareSelectedLoadIntentSuccessor(input: {
  initial: Buffer;
  successors: Buffer[];
  observedJournal: Buffer;
  key: Buffer;
  nowEpochMs: number;
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_SUCCESSOR_PREPARATION");
  };
  const chain = verifySelectedLoadIntentChain(
    input.initial,
    input.successors,
    input.key
  );
  if (chain.successorCount && !chain.latestV2Successor) return fail();
  const previous = chain.latestV2Successor ?? chain.initialIntent;
  const journal = validateWeeklyJournalRecoverySnapshot(input.observedJournal);
  const owner = journal.ownership.find(
    (row) => row.scope === "prodigic/zivv/production"
  );
  if (
    !owner ||
    !Number.isSafeInteger(input.nowEpochMs) ||
    input.nowEpochMs < previous.deadlineEpochMs ||
    owner.expiresAtEpochMs > input.nowEpochMs
  )
    return fail();
  if (sha256(input.observedJournal) === previous.journalSha256) {
    if (canonicalJson(owner) !== canonicalJson(previous.previousOwner))
      return fail();
  } else {
    const reconstructed = reconstructSelectedLoadAcquiredIntentJournal({
      observedJournal: input.observedJournal,
      intent: previous,
    });
    if (canonicalJson(reconstructed.observedOwner) !== canonicalJson(owner))
      return fail();
  }
  const fence = owner.fence + 1,
    deadline = input.nowEpochMs + 180000,
    sequence = chain.successorCount + 1;
  if (
    !Number.isSafeInteger(fence) ||
    !Number.isSafeInteger(deadline) ||
    sequence > 10000
  )
    return fail();
  const body = {
    kind: "zivv-selected-load-intent-successor",
    version: 2,
    initialSha256: chain.initialSha256,
    parentSha256: chain.lastSha256,
    sequence,
    journalSha256: sha256(input.observedJournal),
    previousOwner: owner,
    fence,
    owner: chain.initialIntent.owner,
    startedAtEpochMs: input.nowEpochMs,
    deadlineEpochMs: deadline,
  };
  const signature = createHmac("sha256", input.key)
    .update("zivv-selected-load-intent-successor/v2\0")
    .update(canonicalJson(body))
    .digest("hex");
  const bytes = Buffer.from(canonicalJson({ ...body, signature }) + "\n");
  verifySelectedLoadIntentChain(
    input.initial,
    [...input.successors, bytes],
    input.key
  );
  return {
    bytes,
    successorSha256: sha256(bytes),
    sequence,
    loadAllowed: false as const,
    activationAllowed: false as const,
  };
}
