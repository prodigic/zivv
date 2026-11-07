import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { verifySelectedLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import {
  proveRecoveryGmailSelectedLoadBaseline,
  type RecoveryGmailSelectedLoadBaselineInput,
} from "./recovery-gmail-selected-load-proof.js";
import { proveSelectedLoadCatalogDelta } from "./recovery-gmail-selected-catalog-delta.js";
import {
  createSelectedGmailLoadEffectPlan,
  assertSelectedGmailLoadArtifact,
  selectedGmailLoadEvidence,
} from "./recovery-gmail-selected-load-effects.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";
import type { IngestionLedger } from "../../types/ingestion.js";

/** Read-only first-attempt logical journal proof. Physical origin, SQL identity,
 * files and complete load-family authentication remain independent obligations. */
export function proveSelectedLoadJournalDelta(input: {
  baseline: RecoveryGmailSelectedLoadBaselineInput;
  executionBaseline: Buffer;
  admissionSha256: string;
  evidenceSha256: string;
  physicalSnapshotSha256: string;
  raw: Buffer;
  observedGeneration: number;
  observedLedger: IngestionLedger;
  observedJournal: Buffer;
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_JOURNAL_DELTA");
  };
  const same = (a: unknown, b: unknown) => {
    if (canonicalJson(a) !== canonicalJson(b)) fail();
  };
  const execution = verifySelectedLoadExecutionBaseline(
    input.executionBaseline,
    input.baseline.recoveryKey
  );
  const catalog = proveSelectedLoadCatalogDelta(input);
  const proof = proveRecoveryGmailSelectedLoadBaseline(input.baseline);
  if (proof.runDisposition !== "new") return fail();
  const plan = createSelectedGmailLoadEffectPlan(
    input.baseline.checkpoint,
    proof,
    input.raw
  );
  const original = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(input.baseline.current.journal, "base64")
  );
  const current = validateWeeklyJournalRecoverySnapshot(input.observedJournal);
  same(current.intakeEvidence, original.intakeEvidence);
  const production = "prodigic/zivv/production";
  same(
    current.ownership.filter((row) => row.scope !== production),
    original.ownership.filter((row) => row.scope !== production)
  );
  const prior = original.ownership.find((row) => row.scope === production),
    owner = current.ownership.find((row) => row.scope === production);
  if (!prior || !owner) return fail();
  const hash = sha256("selected-load/" + input.admissionSha256),
    expectedOwner = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join("-");
  const held =
    owner.owner === expectedOwner &&
    owner.fence === prior.fence + 1 &&
    owner.expiresAtEpochMs <= execution.startedAtEpochMs + 180000;
  if (!held && canonicalJson(owner) !== canonicalJson(prior)) return fail();
  const selected = current.runState.find(
    (row) => row.id === proof.runState.runId
  );
  same(
    current.runState.filter((row) => row.id !== proof.runState.runId),
    original.runState
  );
  const oldArtifacts = original.stageArtifacts;
  same(
    current.stageArtifacts.filter((row) => row.runId !== proof.runState.runId),
    oldArtifacts
  );
  if (!selected) {
    if (
      catalog.disposition !== "unchanged" ||
      current.stageArtifacts.some((row) => row.runId === proof.runState.runId)
    )
      return fail();
    return {
      status: "before-run" as const,
      journalSha256: sha256(input.observedJournal),
      loadAllowed: false as const,
    };
  }
  if (!held || selected.scope !== production) return fail();
  const state = parseWeeklyRunState(JSON.parse(selected.payload));
  same(state.source, proof.source);
  const stages = state.stages.slice(0, 4);
  for (const item of state.stages.slice(4))
    if (item.status !== "pending") return fail();
  for (const item of stages) {
    if (
      item.attempt > 1 ||
      item.status === "blocked" ||
      item.status === "failed"
    )
      return fail();
    if (item.status === "succeeded")
      same(
        item.evidence,
        selectedGmailLoadEvidence(
          plan,
          proof.source,
          item.stage,
          input.observedLedger
        )
      );
  }
  const artifacts = current.stageArtifacts.filter(
    (row) => row.runId === state.runId
  );
  for (const row of artifacts) {
    if (row.attempt > 1 || (row.attempt === 0 && row.stage !== "acquire"))
      return fail();
    assertSelectedGmailLoadArtifact(
      plan,
      row.stage,
      Buffer.from(row.bytes, "base64"),
      input.raw,
      input.observedLedger
    );
  }
  if (!artifacts.some((row) => row.stage === "acquire" && row.attempt === 0))
    return fail();
  for (const item of stages)
    if (
      item.status === "succeeded" &&
      !artifacts.some(
        (row) => row.stage === item.stage && row.attempt === item.attempt
      )
    )
      return fail();
  const load = stages[3]!;
  if (
    catalog.disposition === "committed" &&
    (stages.slice(0, 3).some((item) => item.status !== "succeeded") ||
      !["running", "succeeded"].includes(load.status))
  )
    return fail();
  if (catalog.disposition === "unchanged" && load.status === "succeeded")
    return fail();
  return {
    status: catalog.disposition,
    runId: state.runId,
    revision: state.revision,
    journalSha256: sha256(input.observedJournal),
    loadAllowed: false as const,
  };
}
