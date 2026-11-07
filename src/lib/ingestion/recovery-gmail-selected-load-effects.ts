import type { StageEvidence } from "./weekly-run-state.js";
import type { IngestionLedger } from "../../types/ingestion.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { reconcileCandidates, validateLedger } from "./ledger.js";
import { prepareSteveBatch } from "./imports.js";
import {
  preflightSteveContent,
  sha256,
  type LineCorrection,
} from "./steve-preflight.js";
import { applyVenueLocationCorrectionEntries } from "./venue-location-corrections.js";
import {
  createSteveImportReview,
  CURRENT_STEVE_IMPORTER,
  importReportDigest,
} from "./steve-import-review.js";
import type { OperatorRecoveryCheckpoint } from "./operator-recovery.js";
import type { proveRecoveryGmailSelectedLoadBaseline } from "./recovery-gmail-selected-load-proof.js";

type Proof = ReturnType<typeof proveRecoveryGmailSelectedLoadBaseline>;
function fail(): never {
  throw Error("RECOVERY_GMAIL_SELECTED_LOAD_EFFECT_CHANGED");
}
/** Deterministic normal-import expectations only; no permission, handle or writer. */
export function createSelectedGmailLoadEffectPlan(
  checkpoint: Pick<OperatorRecoveryCheckpoint, "files" | "ledger">,
  proof: Proof,
  raw: Buffer
) {
  if (sha256(raw) !== proof.source.rawSha256) fail();
  const config = <T>(name: string, fallback: T): T => {
    const file = checkpoint.files.find(
      (file) => file.area === "checkout" && file.path === "data/" + name
    );
    return file?.bytes
      ? (JSON.parse(Buffer.from(file.bytes, "base64").toString("utf8")) as T)
      : fallback;
  };
  const aliases = config<Record<string, string>>("venue-aliases.json", {}),
    corrections = config<LineCorrection[]>("line-corrections.json", []);
  const preflight = preflightSteveContent(
    new TextDecoder("utf8", { fatal: true }).decode(raw),
    checkpoint.ledger,
    aliases,
    corrections
  );
  preflight.rawSha256 = sha256(raw);
  if (
    preflight.errors.length ||
    preflight.preparedContent === null ||
    preflight.preparedSha256 === null ||
    !preflight.issueDate ||
    new Date(Date.parse(preflight.issueDate + " 12:00:00 GMT"))
      .toISOString()
      .slice(0, 10) !== proof.source.editionId
  )
    fail();
  const baseline = structuredClone(checkpoint.ledger);
  applyVenueLocationCorrectionEntries(
    baseline.venues,
    config("venue-location-corrections.json", [])
  );
  const corrected = corrections.reduce(
    (text, item) =>
      text.replace(new RegExp(item.pattern, "gim"), item.replacement),
    preflight.preparedContent
  );
  const result = reconcileCandidates(
    baseline,
    prepareSteveBatch(
      baseline,
      corrected,
      proof.source.importObservedAtEpochMs,
      aliases,
      { requireCompleteNormalization: true }
    )
  );
  if (result.report.review.length || result.report.conflicts.length) fail();
  const context = {
    schemaVersion: 1,
    configurationSha256: proof.rulesContext.configurationSha256,
    ledgerRevision: ledgerDigest(checkpoint.ledger),
    ledger: structuredClone(checkpoint.ledger),
    preflight,
  };
  const receipt = createSteveImportReview({
    schemaVersion: 1,
    importer: CURRENT_STEVE_IMPORTER,
    inputSha256: preflight.preparedSha256,
    configurationSha256: context.configurationSha256,
    ledgerRevision: context.ledgerRevision,
    reportSha256: importReportDigest(result.report),
    importRunId: result.report.runId,
    observedAtEpochMs: proof.source.importObservedAtEpochMs,
  });
  return {
    context,
    receipt,
    result,
    prepared: preflight.preparedContent,
    preparedSha256: preflight.preparedSha256,
  };
}
export type SelectedGmailLoadEffectPlan = ReturnType<
  typeof createSelectedGmailLoadEffectPlan
>;
/** Only the normal import's new entity/commit wall-clock observations may vary. */
export function assertSelectedGmailLoadCatalog(
  plan: SelectedGmailLoadEffectPlan,
  original: IngestionLedger,
  actual: IngestionLedger,
  startedAt: number
) {
  validateLedger(actual);
  const expected = structuredClone(plan.result.ledger);
  if (!plan.result.report.replay) {
    const run = actual.runs.find(
        (run) => run.runId === plan.receipt.importRunId
      ),
      target = expected.runs.find(
        (run) => run.runId === plan.receipt.importRunId
      );
    if (
      !run ||
      !target ||
      run.status !== "committed" ||
      run.committedAtEpochMs === null ||
      run.committedAtEpochMs < startedAt ||
      run.committedAtEpochMs > Date.now() ||
      run.publishedAtEpochMs !== null
    )
      fail();
    target.status = "committed";
    target.committedAtEpochMs = run.committedAtEpochMs;
    for (const table of ["artists", "venues"] as const) {
      const prior = new Set(original[table].map((item) => item.id));
      for (const item of expected[table])
        if (!prior.has(item.id)) {
          const observed = actual[table].find((value) => value.id === item.id);
          if (
            !observed ||
            observed.createdAtEpochMs < startedAt ||
            observed.updatedAtEpochMs < observed.createdAtEpochMs ||
            observed.updatedAtEpochMs > run.committedAtEpochMs
          )
            fail();
          item.createdAtEpochMs = observed.createdAtEpochMs;
          item.updatedAtEpochMs = observed.updatedAtEpochMs;
        }
    }
  }
  if (canonicalJson(expected) !== canonicalJson(actual)) fail();
}
export function selectedGmailLoadEvidence(
  plan: SelectedGmailLoadEffectPlan,
  source: Proof["source"],
  stage: string,
  ledger: IngestionLedger
): StageEvidence {
  if (stage === "acquire")
    return {
      rawSha256: source.rawSha256,
      deliveryId: source.deliveryId,
    };
  if (stage === "prepare")
    return {
      preparedSha256: plan.preparedSha256,
      rulesSha256: source.rulesSha256,
    };
  if (stage === "reconcile")
    return {
      ledgerRevision: plan.receipt.ledgerRevision,
      reportSha256: plan.receipt.reportSha256,
      preparedSha256: plan.preparedSha256,
    };
  if (stage === "load")
    return {
      ledgerRevision: ledgerDigest(ledger),
      importRunId: plan.receipt.importRunId,
      reviewedLedgerRevision: plan.receipt.ledgerRevision,
      reportSha256: plan.receipt.reportSha256,
      preparedSha256: plan.preparedSha256,
    };
  return fail();
}
export function assertSelectedGmailLoadArtifact(
  plan: SelectedGmailLoadEffectPlan,
  stage: string,
  bytes: Buffer,
  raw: Buffer,
  ledger: IngestionLedger
) {
  if (stage === "acquire") {
    if (!bytes.equals(raw)) fail();
    return;
  }
  let expected: unknown;
  if (stage === "prepare") expected = plan.context;
  else if (stage === "reconcile")
    expected = {
      schemaVersion: 1,
      receipt: plan.receipt,
      report: plan.result.report,
      preflightContext: plan.context,
    };
  else if (stage === "load")
    expected = {
      schemaVersion: 1,
      ledger,
      evidence: selectedGmailLoadEvidence(
        plan,
        { rawSha256: sha256(raw) } as Proof["source"],
        stage,
        ledger
      ),
    };
  else fail();
  if (!bytes.equals(Buffer.from(canonicalJson(expected) + "\n"))) fail();
}
