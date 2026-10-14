import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type {
  IngestionBatch,
  IngestionLedger,
  ReconciliationResult,
} from "../../types/ingestion.js";
import { loadLedger, reconcileCandidates, saveLedgerAtomic } from "./ledger.js";
import { withIngestionLock } from "./lock.js";
import { writeJsonAtomic } from "./persistence.js";
import { findHistoricalSteveReceipt } from "./historical.js";
import { EventParser } from "../etl/parsers.js";
import { EventSanitizer } from "../etl/sanitizer.js";
import { normalizeLatestContent } from "../etl/latest-content.js";
import { legacyWallClockToInstant } from "../discovery.js";
import { applyVenueLocationCorrections } from "./venue-location-corrections.js";
import { ledgerDigest } from "./sqlite-store.js";
import {
  createSteveImportReview,
  parseSteveImportReview,
  importConfigurationDigest,
  importDigest,
  importReportDigest,
  SteveImportReviewError,
  type SteveImportReview,
} from "./steve-import-review.js";
export type { SteveImportReview } from "./steve-import-review.js";
import { projectLedgerLocation } from "./store-location.js";

/** Bump the importer version when parsing/normalization semantics change. */
export function steveRunId(
  content: string,
  aliases: Record<string, string>
): string {
  const identity = {
    importer: "steveslist-v4",
    schema: 1,
    content: normalizeLatestContent(content),
    aliases: Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)),
  };
  return `steveslist-v4-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** Pure construction of a weekly candidate batch; shared reconciler owns acceptance. */
export function prepareSteveBatch(
  ledger: IngestionLedger,
  content: string,
  observedAtEpochMs: number,
  aliases: Record<string, string> = {},
  options: { requireCompleteNormalization?: boolean } = {}
): IngestionBatch {
  const normalized = normalizeLatestContent(content);
  const hash = createHash("sha256").update(normalized).digest("hex");
  const runId = steveRunId(normalized, aliases);
  const prior = ledger.runs.find((r) => r.runId === runId);
  const timestamp = prior?.observedAtEpochMs ?? observedAtEpochMs;
  const headerDate = normalized.match(
    /Upcoming shows of Interest\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i
  )?.[1];
  const reference = headerDate
    ? new Date(`${headerDate} 12:00:00 GMT`)
    : new Date(timestamp);
  if (!Number.isFinite(reference.getTime()))
    throw new Error("Invalid Steve's List issue date");
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const entries = EventSanitizer.collapseToSingleLines(normalized).map((line) =>
    line.replace(
      /^([a-z]{3})\s+(\d{1,2})\s+([a-z]{2,3})\s+/i,
      (_, month: string, day: string) => {
        const monthIndex = months.indexOf(month.toLowerCase());
        let year = reference.getUTCFullYear();
        // Dated issues list upcoming shows. A spring/summer date before the
        // issue belongs to next year even when it is less than six months ago.
        if (
          Date.UTC(year, monthIndex, Number(day)) <
          (headerDate
            ? Date.UTC(year, reference.getUTCMonth(), reference.getUTCDate())
            : reference.getTime() - 180 * 86400000)
        )
          year++;
        return `${month} ${day} ${year} `;
      }
    )
  );
  const parsed = EventParser.parseEventsFile(entries.join("\n"));
  const diagnostics = [...parsed.errors, ...parsed.warnings];
  if (
    !entries.length ||
    parsed.errors.length ||
    parsed.warnings.length ||
    parsed.rawEvents.length !== entries.length
  ) {
    const detail = diagnostics
      .slice(0, 5)
      .map(
        (item) =>
          `line ${item.line} [${item.type}] ${item.message}: ${JSON.stringify(item.rawText.slice(0, 240))}`
      )
      .join("; ");
    const suffix = detail.length > 0 ? ` Diagnostics: ${detail}` : "";
    throw new Error(
      `Steve's List parse is incomplete; no events accepted (${entries.length} entries, ${parsed.rawEvents.length} parsed).${suffix}`
    );
  }
  const artistMap = new Map(
    structuredClone(ledger.artists).map((a) => [a.normalizedName, a])
  );
  const venueMap = new Map(
    structuredClone(ledger.venues).map((v) => [v.normalizedName, v])
  );
  const normalizedEvents = EventParser.normalizeEvents(
    parsed.rawEvents,
    artistMap,
    venueMap,
    aliases
  );
  if (
    options.requireCompleteNormalization &&
    (normalizedEvents.warnings.some((warning) => {
      const name =
        /^(?:Artist name contains numbers|Unusual capitalization in artist name|Unusually long single-word artist name|Possible concatenated artist name): "([^"]+)"/.exec(
          warning.message
        )?.[1];
      // Existing exact canonical names resolve formatting-only heuristics.
      // Duplicate bills/performers and count loss always remain blockers.
      return !name || !ledger.artists.some((artist) => artist.name === name);
    }) ||
      normalizedEvents.events.length !== parsed.rawEvents.length)
  )
    throw new SteveImportReviewError("CORE_RECONCILIATION_REQUIRED");
  if (normalizedEvents.errors.length)
    throw new Error(
      `Steve's List normalization failed: ${normalizedEvents.errors.map((e) => e.message).join("; ")}`
    );
  for (const event of normalizedEvents.events) {
    if (event.startTimeEpochMs !== undefined) {
      const converted = legacyWallClockToInstant(
        event.date,
        event.startTimeEpochMs
      );
      if (converted === null)
        throw new Error(`Invalid local show time for ${event.slug}`);
      event.startTimeEpochMs = converted;
    }
    event.timeBasis = "instant";
  }
  const usedArtists = new Set(
    normalizedEvents.events.flatMap((e) => e.artistIds)
  );
  const usedVenues = new Set(normalizedEvents.events.map((e) => e.venueId));
  return {
    runId,
    origin: "steveslist",
    sourceId: "steveslist",
    observedAtEpochMs: timestamp,
    contentHash: hash,
    events: normalizedEvents.events,
    artists: [...artistMap.values()].filter((a) => usedArtists.has(a.id)),
    venues: [...venueMap.values()].filter((v) => usedVenues.has(v.id)),
  };
}

async function commitResult(
  root: string,
  result: ReconciliationResult,
  dryRun: boolean,
  batch: IngestionBatch
): Promise<ReconciliationResult> {
  if (!dryRun && !result.report.replay) {
    const run = result.ledger.runs.find((r) => r.runId === result.report.runId);
    if (!run) throw new Error("Reconciled run is missing from the ledger");
    run.status = "committed";
    run.committedAtEpochMs = Date.now();
    const directory = join(root, "data/ingestion/reports");
    mkdirSync(directory, { recursive: true });
    // Reports use a hash filename; external run IDs never become filesystem paths.
    const name = createHash("sha256").update(result.report.runId).digest("hex");
    writeJsonAtomic(join(directory, `${name}.json`), result.report);
    if (result.report.review.length)
      writeJsonAtomic(join(directory, `${name}.candidates.json`), batch);
    await saveLedgerAtomic(
      join(root, "data/ingestion/ledger.json"),
      result.ledger
    );
  }
  return result;
}

export async function importSteveContent(
  root: string,
  content: string,
  options: { observedAtEpochMs?: number; dryRun?: boolean } = {}
): Promise<ReconciliationResult> {
  return (await executeSteveImport(root, content, options)).result;
}

/** Review all core rows under the same catalog writer lock used by loading. */
export async function reviewSteveImport(
  root: string,
  content: string,
  observedAtEpochMs: number
) {
  if (!Number.isSafeInteger(observedAtEpochMs) || observedAtEpochMs < 0)
    throw new SteveImportReviewError("INVALID_IMPORT_REVIEW");
  const reviewed = await executeSteveImport(root, content, {
    dryRun: true,
    observedAtEpochMs,
    requireClean: true,
  });
  const receipt = createSteveImportReview({
    schemaVersion: 1,
    importer: "steveslist-v4",
    inputSha256: importDigest(content),
    configurationSha256: reviewed.configurationSha256,
    ledgerRevision: reviewed.inputLedgerRevision,
    reportSha256: importReportDigest(reviewed.result.report),
    importRunId: reviewed.result.report.runId,
    observedAtEpochMs,
  });
  return { receipt, report: reviewed.result.report };
}

/** Load exactly the clean reviewed decision, or recover its verified committed replay. */
export async function loadReviewedSteveImport(
  root: string,
  content: string,
  receipt: SteveImportReview,
  assertOwnership: () => void
): Promise<ReconciliationResult> {
  const reviewed = parseSteveImportReview(receipt);
  if (typeof assertOwnership !== "function")
    throw new SteveImportReviewError("INVALID_IMPORT_REVIEW");
  return (
    await executeSteveImport(root, content, {
      observedAtEpochMs: reviewed.observedAtEpochMs,
      requireClean: true,
      reviewed,
      assertOwnership,
    })
  ).result;
}

async function executeSteveImport(
  root: string,
  content: string,
  options: {
    observedAtEpochMs?: number;
    dryRun?: boolean;
    requireClean?: boolean;
    reviewed?: SteveImportReview;
    assertOwnership?: () => void;
  }
) {
  if (options.requireClean && projectLedgerLocation(root).backend !== "sqlite")
    throw new SteveImportReviewError("SHARED_SQLITE_REQUIRED");
  return withIngestionLock(root, async () => {
    const ledger = await loadLedger(join(root, "data/ingestion/ledger.json"));
    const inputLedgerRevision = ledgerDigest(ledger);
    const configurationSha256 = options.requireClean
      ? importConfigurationDigest(root)
      : "";
    if (options.reviewed) {
      options.assertOwnership?.();
      if (importDigest(content) !== options.reviewed.inputSha256)
        throw new SteveImportReviewError("IMPORT_INPUT_CHANGED");
      if (configurationSha256 !== options.reviewed.configurationSha256)
        throw new SteveImportReviewError("IMPORT_CONFIGURATION_CHANGED");
    }
    async function finish(
      result: ReconciliationResult,
      batch?: IngestionBatch
    ) {
      if (
        options.requireClean &&
        (result.report.review.length || result.report.conflicts.length)
      )
        throw new SteveImportReviewError("CORE_RECONCILIATION_REQUIRED");
      const reviewed = options.reviewed;
      if (reviewed) {
        if (
          result.report.runId !== reviewed.importRunId ||
          importReportDigest(result.report) !== reviewed.reportSha256
        )
          throw new SteveImportReviewError("IMPORT_REPORT_CHANGED");
        if (
          !result.report.replay &&
          inputLedgerRevision !== reviewed.ledgerRevision
        )
          throw new SteveImportReviewError("IMPORT_LEDGER_CHANGED");
      }
      options.assertOwnership?.();
      if (
        options.requireClean &&
        importConfigurationDigest(root) !== configurationSha256
      )
        throw new SteveImportReviewError("IMPORT_CONFIGURATION_CHANGED");
      const committed = batch
        ? await commitResult(root, result, options.dryRun ?? false, batch)
        : result;
      options.assertOwnership?.();
      if (
        options.requireClean &&
        importConfigurationDigest(root) !== configurationSha256
      )
        throw new SteveImportReviewError("IMPORT_CONFIGURATION_CHANGED");
      return { result: committed, inputLedgerRevision, configurationSha256 };
    }
    applyVenueLocationCorrections(root, ledger.venues);
    const historical = findHistoricalSteveReceipt(root, content, ledger);
    if (historical) {
      if (options.requireClean)
        throw new SteveImportReviewError("HISTORICAL_IMPORT_NOT_ALLOWED");
      return finish({
        ledger,
        report: {
          runId: `historical-steveslist-${historical.contentSha256}`,
          replay: true,
          historicalBatch: {
            sourceCommit: historical.sourceCommit,
            datasetVersion: historical.datasetVersion,
            processedAtEpochMs: historical.processedAtEpochMs,
          },
          acceptedEventIds: [],
          newEventIds: [],
          updatedEventIds: [],
          linkedEventIds: [],
          review: [],
          conflicts: [],
        },
      });
    }
    const aliasPath = join(root, "data/venue-aliases.json");
    const aliases: Record<string, string> = existsSync(aliasPath)
      ? JSON.parse(readFileSync(aliasPath, "utf8"))
      : {};
    const correctionsPath = join(root, "data/line-corrections.json");
    const corrections: { pattern: string; replacement: string }[] = existsSync(
      correctionsPath
    )
      ? JSON.parse(readFileSync(correctionsPath, "utf8"))
      : [];
    const corrected = corrections.reduce(
      (text, c) => text.replace(new RegExp(c.pattern, "gim"), c.replacement),
      content
    );
    const prior = ledger.runs.find(
      (r) => r.runId === steveRunId(corrected, aliases)
    );
    if (prior) {
      if (options.requireClean && !options.reviewed)
        prepareSteveBatch(
          ledger,
          corrected,
          options.observedAtEpochMs ?? Date.now(),
          aliases,
          { requireCompleteNormalization: true }
        );
      if (
        options.requireClean &&
        prior.observedAtEpochMs !== options.observedAtEpochMs
      )
        throw new SteveImportReviewError("IMPORT_OBSERVATION_CHANGED");
      if (
        options.requireClean &&
        !["committed", "published"].includes(prior.status)
      )
        throw new SteveImportReviewError("IMPORT_REPORT_CHANGED");
      // Bind replay to the exact source content and importer version, before
      // parsing against a catalog whose entity IDs may since have changed.
      const reportName = createHash("sha256").update(prior.runId).digest("hex");
      const reportPath = join(
        root,
        "data/ingestion/reports",
        `${reportName}.json`
      );
      if (!existsSync(reportPath)) {
        if (options.requireClean)
          throw new SteveImportReviewError("IMPORT_REPORT_CHANGED");
        throw new Error(
          `Missing saved report for ${prior.runId}; restore ingestion history`
        );
      }
      let report: ReconciliationResult["report"];
      try {
        if (options.requireClean) {
          const stat = lstatSync(reportPath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
            throw new SteveImportReviewError("IMPORT_REPORT_CHANGED");
        }
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch (error) {
        if (options.requireClean)
          throw new SteveImportReviewError("IMPORT_REPORT_CHANGED");
        throw error;
      }
      if (
        !report ||
        report.runId !== prior.runId ||
        !Array.isArray(report.review) ||
        report.review.length !== prior.reviewCount ||
        !Array.isArray(report.conflicts) ||
        report.conflicts.length !== prior.conflictCount
      ) {
        if (options.requireClean)
          throw new SteveImportReviewError("IMPORT_REPORT_CHANGED");
        throw new Error(
          `Invalid saved report for ${prior.runId}; restore ingestion history`
        );
      }
      for (const key of [
        "acceptedEventIds",
        "newEventIds",
        "updatedEventIds",
        "linkedEventIds",
      ] as const) {
        if (JSON.stringify(report[key]) !== JSON.stringify(prior[key])) {
          if (options.requireClean)
            throw new SteveImportReviewError("IMPORT_REPORT_CHANGED");
          throw new Error(
            `Saved report disagrees with durable run ${prior.runId}`
          );
        }
      }
      return finish({ ledger, report: { ...report, replay: true } });
    }
    if (
      options.reviewed &&
      inputLedgerRevision !== options.reviewed.ledgerRevision
    )
      throw new SteveImportReviewError("IMPORT_LEDGER_CHANGED");
    const batch = prepareSteveBatch(
      ledger,
      corrected,
      options.observedAtEpochMs ?? Date.now(),
      aliases,
      { requireCompleteNormalization: options.requireClean }
    );
    return finish(reconcileCandidates(ledger, batch), batch);
  });
}

/** Structured venue candidates enter the same ledger; this does not crawl sites. */
export async function importVenueBatch(
  root: string,
  batch: IngestionBatch,
  dryRun = false
): Promise<ReconciliationResult> {
  return withIngestionLock(root, async () => {
    const registry = JSON.parse(
      readFileSync(join(root, "data/venue-sources.json"), "utf8")
    );
    const source = registry.sources.find(
      (s: { sourceId: string }) => s.sourceId === batch.sourceId
    );
    if (!source || batch.origin !== "zivv-venue-import")
      throw new Error(
        "Venue batch needs a registered source and zivv-venue-import origin"
      );
    // An explicit structured batch may be reviewed while its scheduled crawler is disabled.
    for (const candidate of batch.events) {
      const event = "event" in candidate ? candidate.event : candidate;
      if (event.venueId !== source.venueId)
        throw new Error(
          `Source ${batch.sourceId} cannot assign venue ${event.venueId}; resolve room/move mapping first`
        );
      if (event.startTimeEpochMs !== undefined && event.timeBasis !== "instant")
        throw new Error("Venue event start time requires timeBasis: instant");
    }
    const ledger = await loadLedger(join(root, "data/ingestion/ledger.json"));
    applyVenueLocationCorrections(root, ledger.venues);
    return commitResult(
      root,
      reconcileCandidates(ledger, batch),
      dryRun,
      batch
    );
  });
}
