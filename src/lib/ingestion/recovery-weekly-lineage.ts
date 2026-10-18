import {
  validateOperatorRecoveryCheckpoint,
  type OperatorRecoveryCheckpoint,
} from "./operator-recovery.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { validateLedger, reconcileCandidates } from "./ledger.js";
import { prepareSteveBatch } from "./imports.js";
import {
  preflightSteveContent,
  sha256,
  type LineCorrection,
} from "./steve-preflight.js";
import {
  CURRENT_STEVE_IMPORTER,
  importReportDigest,
  parseSteveImportReview,
} from "./steve-import-review.js";
import { applyVenueLocationCorrectionEntries } from "./venue-location-corrections.js";
import {
  parseWeeklyEditionLedger,
  createEmptyWeeklyEditionLedger,
  prepareWeeklyEdition,
  serializeWeeklyEditionLedger,
} from "./weekly.js";

function fail(code: string): never {
  throw new Error(`RECOVERY_WEEKLY_LINEAGE_${code}`);
}
function same(a: unknown, b: unknown, code = "LINEAGE_MISMATCH"): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail(code);
}
function object(
  value: unknown,
  keys?: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_LINEAGE");
  if (keys)
    same(Object.keys(value).sort(), [...keys].sort(), "INVALID_LINEAGE");
  return value as Record<string, unknown>;
}
function decoded(value: unknown): Buffer {
  if (typeof value !== "string") fail("INVALID_LINEAGE");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("INVALID_LINEAGE");
  return bytes;
}

/** Authenticate one clean captured import and its exact frozen edition, without effects. */
export function proveRecoveryWeeklyLineage(input: {
  checkpoint: OperatorRecoveryCheckpoint;
  runId: string;
  stage: "frozen" | "validated" | "pending-dispatch";
}) {
  if (!["frozen", "validated", "pending-dispatch"].includes(input.stage))
    fail("INVALID_STAGE");
  const checkpoint = validateOperatorRecoveryCheckpoint(input.checkpoint);
  const journal = validateWeeklyJournalRecoverySnapshot(
    decoded(checkpoint.journal)
  );
  const row = journal.runState.find(
    (item) =>
      item.id === input.runId && item.scope === "prodigic/zivv/production"
  );
  if (!row) fail("RUN_NOT_RETAINED");
  const run = parseWeeklyRunState(JSON.parse(row.payload));
  const prefix = input.stage === "frozen" ? 5 : 8;
  if (
    run.stages.slice(0, prefix).some((stage) => stage.status !== "succeeded") ||
    (input.stage === "pending-dispatch"
      ? run.stages[8].status !== "running" ||
        run.stages.slice(9).some((stage) => stage.status !== "pending")
      : run.stages.slice(prefix).some((stage) => stage.status !== "pending"))
  )
    fail(
      input.stage === "frozen"
        ? "FROZEN_RUN_REQUIRED"
        : input.stage === "pending-dispatch"
          ? "PENDING_DISPATCH_RUN_REQUIRED"
          : "VALIDATED_RUN_REQUIRED"
    );
  if (
    input.stage === "pending-dispatch" &&
    journal.stageArtifacts.some(
      (row) =>
        row.runId === run.runId && ["verify", "acknowledge"].includes(row.stage)
    )
  )
    fail("UNEXPECTED_LATER_ARTIFACT");
  if (
    input.stage === "frozen" &&
    journal.stageArtifacts.some(
      (row) =>
        row.runId === run.runId &&
        !run.stages.slice(0, prefix).some((stage) => stage.stage === row.stage)
    )
  )
    fail("UNEXPECTED_LATER_ARTIFACT");
  const optionalArtifact = (stage: (typeof run.stages)[number]["stage"]) => {
    const item = run.stages.find((item) => item.stage === stage)!;
    const row = journal.stageArtifacts.find(
      (row) =>
        row.runId === run.runId &&
        row.stage === stage &&
        row.attempt === item.attempt
    );
    return row ? decoded(row.bytes) : null;
  };
  const artifact = (stage: (typeof run.stages)[number]["stage"]) => {
    const bytes = optionalArtifact(stage);
    if (!bytes) fail("MISSING_STAGE_ARTIFACT");
    return bytes;
  };
  const files = new Map(
    checkpoint.files.map((file) => [
      file.area + "/" + file.path,
      file.bytes === null ? null : decoded(file.bytes),
    ])
  );
  const required = (path: string): Buffer => {
    const bytes = files.get(path);
    if (!bytes) fail("MISSING_RETAINED_FILE");
    return bytes;
  };
  const configJson = (path: string, fallback: unknown): unknown => {
    const bytes = files.get("checkout/data/" + path);
    return bytes ? JSON.parse(bytes.toString("utf8")) : fallback;
  };
  const configHash = sha256(
    canonicalJson(
      [
        "venue-aliases.json",
        "line-corrections.json",
        "venue-location-corrections.json",
        "ingestion/historical-batches.json",
        "ingestion/migration.json",
      ].map((path) => ({
        path,
        sha256: files.get("checkout/data/" + path)
          ? sha256(required("checkout/data/" + path))
          : null,
      }))
    )
  );
  same(
    run.source.rulesSha256,
    sha256(
      canonicalJson({
        runner: "weekly-import-v1",
        runtimeSha256: checkpoint.runtime.workerSha256,
        packageLockSha256: checkpoint.runtime.lockfileSha256,
        configurationSha256: configHash,
        node: checkpoint.runtime.node,
        icu: checkpoint.runtime.icu,
      })
    ),
    "RULES_CHANGED"
  );
  const raw = artifact("acquire");
  same(sha256(raw), run.source.rawSha256);
  same(run.stages[0].evidence, {
    rawSha256: run.source.rawSha256,
    deliveryId: run.source.deliveryId,
  });
  const prepared = object(JSON.parse(artifact("prepare").toString("utf8")), [
    "schemaVersion",
    "configurationSha256",
    "ledgerRevision",
    "ledger",
    "preflight",
  ]);
  const reviewed = object(JSON.parse(artifact("reconcile").toString("utf8")), [
    "schemaVersion",
    "receipt",
    "report",
    "preflightContext",
  ]);
  const receipt = parseSteveImportReview(reviewed.receipt);
  same(reviewed.schemaVersion, 1);
  if (receipt.importer !== CURRENT_STEVE_IMPORTER)
    fail("UNSUPPORTED_IMPORT_LINEAGE");
  const context = object(reviewed.preflightContext, [
    "schemaVersion",
    "configurationSha256",
    "ledgerRevision",
    "ledger",
    "preflight",
  ]);
  const baseline = context.ledger;
  validateLedger(baseline);
  same(prepared.ledger, baseline);
  const aliases = object(configJson("venue-aliases.json", {})) as Record<
    string,
    string
  >;
  if (Object.values(aliases).some((value) => typeof value !== "string"))
    fail("INVALID_LINEAGE");
  const correctionValues = configJson("line-corrections.json", []);
  if (!Array.isArray(correctionValues)) fail("INVALID_LINEAGE");
  const corrections: LineCorrection[] = correctionValues.map((value) => {
    const row = object(value, ["pattern", "replacement"]);
    if (typeof row.pattern !== "string" || typeof row.replacement !== "string")
      fail("INVALID_LINEAGE");
    return { pattern: row.pattern, replacement: row.replacement };
  });
  const fresh = preflightSteveContent(
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
    baseline,
    aliases,
    corrections
  );
  fresh.rawSha256 = sha256(raw);
  if (
    fresh.errors.length ||
    fresh.preparedContent === null ||
    fresh.preparedSha256 === null ||
    !fresh.issueDate
  )
    fail("UNCLEAN_IMPORT");
  same(
    new Date(Date.parse(fresh.issueDate + " 12:00:00 GMT"))
      .toISOString()
      .slice(0, 10),
    run.source.editionId
  );
  const expectedContext = {
    schemaVersion: 1,
    configurationSha256: configHash,
    ledgerRevision: ledgerDigest(baseline),
    ledger: baseline,
    preflight: fresh,
  };
  same(prepared, expectedContext);
  same(context, expectedContext);
  same(receipt.inputSha256, fresh.preparedSha256);
  same(receipt.ledgerRevision, ledgerDigest(baseline));
  same(receipt.configurationSha256, configHash);
  same(receipt.observedAtEpochMs, run.source.importObservedAtEpochMs);
  const expectedBaseline = structuredClone(baseline);
  applyVenueLocationCorrectionEntries(
    expectedBaseline.venues,
    configJson("venue-location-corrections.json", [])
  );
  const corrected = corrections.reduce(
    (text, entry) =>
      text.replace(new RegExp(entry.pattern, "gim"), entry.replacement),
    fresh.preparedContent
  );
  const result = reconcileCandidates(
    expectedBaseline,
    prepareSteveBatch(
      expectedBaseline,
      corrected,
      run.source.importObservedAtEpochMs,
      aliases,
      { requireCompleteNormalization: true }
    )
  );
  if (result.report.review.length || result.report.conflicts.length)
    fail("UNCLEAN_IMPORT");
  same(reviewed.report, result.report);
  same(importReportDigest(result.report), receipt.reportSha256);
  same(result.report.runId, receipt.importRunId);
  same(run.stages[1].evidence, {
    preparedSha256: fresh.preparedSha256,
    rulesSha256: run.source.rulesSha256,
  });
  same(run.stages[2].evidence, {
    ledgerRevision: receipt.ledgerRevision,
    reportSha256: receipt.reportSha256,
    preparedSha256: fresh.preparedSha256,
  });
  const load = object(JSON.parse(artifact("load").toString("utf8")), [
    "schemaVersion",
    "ledger",
    "evidence",
  ]);
  validateLedger(load.ledger);
  if (!result.report.replay) {
    const saved = load.ledger.runs.find(
        (item) => item.runId === receipt.importRunId
      ),
      expected = result.ledger.runs.find(
        (item) => item.runId === receipt.importRunId
      )!;
    if (
      !saved ||
      saved.status !== "committed" ||
      saved.committedAtEpochMs === null ||
      saved.committedAtEpochMs < run.source.importObservedAtEpochMs ||
      saved.committedAtEpochMs > checkpoint.createdAtEpochMs ||
      saved.publishedAtEpochMs !== null
    )
      fail("INVALID_COMMIT_LINEAGE");
    expected.status = "committed";
    expected.committedAtEpochMs = saved.committedAtEpochMs;
    // Legacy normalization observes the wall clock for newly allocated entity
    // metadata. Preserve those authenticated observations, not replay-time clocks.
    // IDs, names, counts, all existing entities and event/source times still have
    // to reproduce exactly from the reviewed baseline and original input.
    for (const table of ["artists", "venues"] as const) {
      const priorIds = new Set<number>(
        baseline[table].map((entity) => entity.id)
      );
      for (const entity of result.ledger[table]) {
        if (priorIds.has(entity.id)) continue;
        const original = load.ledger[table].find(
          (item) => item.id === entity.id
        );
        if (
          !original ||
          original.createdAtEpochMs < run.source.importObservedAtEpochMs ||
          original.updatedAtEpochMs < original.createdAtEpochMs ||
          original.updatedAtEpochMs > saved.committedAtEpochMs
        )
          fail("INVALID_ENTITY_CLOCK_LINEAGE");
        entity.createdAtEpochMs = original.createdAtEpochMs;
        entity.updatedAtEpochMs = original.updatedAtEpochMs;
      }
    }
  }
  same(load.ledger, result.ledger, "UNPROVEN_LEDGER_ADVANCEMENT");
  same(load.ledger, checkpoint.ledger, "UNPROVEN_LEDGER_ADVANCEMENT");
  const loadEvidence = {
    ledgerRevision: ledgerDigest(load.ledger),
    importRunId: receipt.importRunId,
    reviewedLedgerRevision: receipt.ledgerRevision,
    reportSha256: receipt.reportSha256,
    preparedSha256: fresh.preparedSha256,
  };
  same(load.schemaVersion, 1);
  same(load.evidence, loadEvidence);
  same(run.stages[3].evidence, loadEvidence);
  const frozen = object(JSON.parse(artifact("freeze").toString("utf8")), [
    "schemaVersion",
    "mode",
    "before",
    "after",
    "ledger",
    "ledgerRevision",
    "evidence",
  ]);
  same(frozen.schemaVersion, 1);
  same(frozen.ledger, load.ledger);
  same(frozen.ledgerRevision, checkpoint.ledgerRevision);
  const before = frozen.before === null ? null : decoded(frozen.before),
    after = decoded(frozen.after);
  const weekly = parseWeeklyEditionLedger(JSON.parse(after.toString("utf8"))),
    edition = weekly.editions.find(
      (item) => item.editionId === run.source.editionId
    );
  if (!edition || edition.endEpochMs > checkpoint.createdAtEpochMs)
    fail("INVALID_FREEZE");
  const beforeWeekly = before
    ? parseWeeklyEditionLedger(JSON.parse(before.toString("utf8")))
    : createEmptyWeeklyEditionLedger();
  const rebuilt = prepareWeeklyEdition(
    beforeWeekly,
    load.ledger.events.map((event) => ({ ...event })),
    {
      editionId: run.source.editionId,
      cutoffEpochMs: edition.endEpochMs,
      datasetVersion: `ingestion-v${load.ledger.version}`,
    }
  );
  same(
    Buffer.from(serializeWeeklyEditionLedger(rebuilt.ledger)).toString(
      "base64"
    ),
    frozen.after
  );
  const mode =
    beforeWeekly.editions.some(
      (item) => item.editionId === edition.editionId
    ) && run.source.importObservedAtEpochMs >= edition.endEpochMs
      ? "correction"
      : "initial";
  if (
    mode === "initial" &&
    edition.endEpochMs <= run.source.importObservedAtEpochMs
  )
    fail("INVALID_FREEZE");
  const freezeEvidence = {
    editionId: edition.editionId,
    cutoffEpochMs: edition.endEpochMs,
    membershipSha256: sha256(canonicalJson(edition.eventIds)),
    preCutoffPendingCount: 0,
    mode,
    ledgerRevision: checkpoint.ledgerRevision,
  };
  same(frozen.mode, mode);
  same(frozen.evidence, freezeEvidence);
  same(run.stages[4].evidence, freezeEvidence);
  same(
    required("checkout/data/ingestion/weekly-editions.json").toString("base64"),
    frozen.after,
    "WEEKLY_STATE_CHANGED"
  );
  return {
    checkpoint,
    run,
    baseline,
    loadedLedger: load.ledger,
    frozenWeeklyBytes: Buffer.from(after),
    freezeEvidence,
    files,
    artifact,
    optionalArtifact,
    readRetainedFile: required,
  };
}
