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
  type SelectedGmailLoadEffectPlan,
} from "./recovery-gmail-selected-load-effects.js";
import {
  validateWeeklyJournalRecoverySnapshot,
  type WeeklyRunLease,
} from "./weekly-run-journal.js";
import {
  parseWeeklyRunState,
  type WeeklyRunSource,
} from "./weekly-run-state.js";
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
  return proveSelectedLoadRunDelta({
    priorJournal: Buffer.from(input.baseline.current.journal, "base64"),
    observedJournal: input.observedJournal,
    startedAtEpochMs: execution.startedAtEpochMs,
    admissionSha256: input.admissionSha256,
    plan,
    source: proof.source,
    runId: proof.runState.runId,
    raw: input.raw,
    observedLedger: input.observedLedger,
    catalogDisposition: catalog.disposition,
  });
}

/** Explain the selected run only, using an independently proved prior catalog
 * and journal. Reusable for the first run and an authenticated successor. */
export function proveSelectedLoadRunDelta(input: {
  priorJournal: Buffer;
  observedJournal: Buffer;
  startedAtEpochMs: number;
  admissionSha256: string;
  plan: SelectedGmailLoadEffectPlan;
  source: WeeklyRunSource;
  runId: string;
  raw: Buffer;
  observedLedger: IngestionLedger;
  catalogDisposition: "unchanged" | "committed";
  successor?: {
    previousOwner: WeeklyRunLease;
    count: number;
    deadlineEpochMs: number;
  };
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_JOURNAL_DELTA");
  };
  const same = (a: unknown, b: unknown) => {
    if (canonicalJson(a) !== canonicalJson(b)) fail();
  };
  const original = validateWeeklyJournalRecoverySnapshot(input.priorJournal);
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
  const successor = input.successor;
  if (
    successor &&
    (!Number.isSafeInteger(successor.count) ||
      successor.count < 1 ||
      successor.previousOwner.scope !== production ||
      successor.previousOwner.owner !== expectedOwner ||
      successor.previousOwner.fence !== prior.fence + 1 ||
      successor.previousOwner.expiresAtEpochMs >
        input.startedAtEpochMs + 180000 ||
      successor.previousOwner.expiresAtEpochMs <= input.startedAtEpochMs)
  )
    return fail();
  const held =
    owner.owner === expectedOwner &&
    owner.fence === prior.fence + 1 + (successor?.count ?? 0) &&
    owner.expiresAtEpochMs <=
      (successor?.deadlineEpochMs ?? input.startedAtEpochMs + 180000);
  if (!held && canonicalJson(owner) !== canonicalJson(prior)) return fail();
  const selected = current.runState.find((row) => row.id === input.runId);
  same(
    current.runState.filter((row) => row.id !== input.runId),
    original.runState
  );
  const oldArtifacts = original.stageArtifacts;
  same(
    current.stageArtifacts.filter((row) => row.runId !== input.runId),
    oldArtifacts
  );
  if (!selected) {
    if (
      input.catalogDisposition !== "unchanged" ||
      current.stageArtifacts.some((row) => row.runId === input.runId)
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
  if (state.runId !== selected.id || state.revision !== selected.revision)
    return fail();
  same(state.source, input.source);
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
          input.plan,
          input.source,
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
      input.plan,
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
    input.catalogDisposition === "committed" &&
    (stages.slice(0, 3).some((item) => item.status !== "succeeded") ||
      !["running", "succeeded"].includes(load.status))
  )
    return fail();
  if (input.catalogDisposition === "unchanged" && load.status === "succeeded")
    return fail();
  return {
    status: input.catalogDisposition,
    runId: state.runId,
    revision: state.revision,
    journalSha256: sha256(input.observedJournal),
    loadAllowed: false as const,
  };
}
