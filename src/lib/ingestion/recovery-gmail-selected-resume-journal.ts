import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";
import type { SelectedLoadResumeIntent } from "./recovery-gmail-selected-resume-intent.js";

/** Reconstruct the unique pre-resume journal committed by an authenticated intent.
 * Detached evidence only: callers must independently authenticate the intent and
 * validate the result, catalog, files, and reconstructed first-attempt journal. */
export function reconstructSelectedLoadResumeJournal(input: {
  completedJournal: Buffer;
  intent: SelectedLoadResumeIntent;
  runId: string;
}): Buffer {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_RESUME_JOURNAL");
  };
  const current = validateWeeklyJournalRecoverySnapshot(input.completedJournal);
  const owner = current.ownership.find(
    (row) => row.scope === "prodigic/zivv/production"
  );
  if (
    !owner ||
    owner.owner !== input.intent.owner ||
    owner.fence !== input.intent.fence ||
    owner.expiresAtEpochMs !== 0
  )
    return fail();
  const selected = current.runState.find((row) => row.id === input.runId);
  if (!selected || selected.scope !== "prodigic/zivv/production") return fail();
  const state = parseWeeklyRunState(JSON.parse(selected.payload));
  const load = state.stages.find((item) => item.stage === "load");
  if (
    !load ||
    load.status !== "succeeded" ||
    load.attempt !== 1 ||
    state.revision < 1
  )
    return fail();
  const matchingArtifacts = current.stageArtifacts.filter(
    (item) =>
      item.runId === input.runId && item.stage === "load" && item.attempt === 1
  );
  if (matchingArtifacts.length !== 1) return fail();
  const candidates: Buffer[] = [];
  for (const removeArtifact of [false, true]) {
    const prior = structuredClone(current);
    const priorOwner = prior.ownership.find(
      (row) => row.scope === owner.scope
    )!;
    Object.assign(priorOwner, input.intent.previousOwner);
    const row = prior.runState.find((item) => item.id === input.runId)!;
    const priorState = structuredClone(state);
    const priorLoad = priorState.stages.find((item) => item.stage === "load")!;
    priorState.revision--;
    priorLoad.status = "running";
    priorLoad.evidence = null;
    priorLoad.errorCode = null;
    parseWeeklyRunState(priorState);
    row.revision = priorState.revision;
    row.payload = canonicalJson(priorState);
    if (removeArtifact)
      prior.stageArtifacts = prior.stageArtifacts.filter(
        (item) =>
          !(
            item.runId === input.runId &&
            item.stage === "load" &&
            item.attempt === 1
          )
      );
    const { digest: _digest, ...body } = prior;
    const bytes = Buffer.from(
      canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
    );
    validateWeeklyJournalRecoverySnapshot(bytes);
    if (sha256(bytes) === input.intent.journalSha256) candidates.push(bytes);
  }
  if (candidates.length !== 1) return fail();
  return candidates[0]!;
}
