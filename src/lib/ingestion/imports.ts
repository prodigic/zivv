import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
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

/** Bump the importer version when parsing/normalization semantics change. */
export function steveRunId(
  content: string,
  aliases: Record<string, string>
): string {
  const identity = {
    importer: "steveslist-v3",
    schema: 1,
    content: normalizeLatestContent(content),
    aliases: Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)),
  };
  return `steveslist-v3-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** Pure construction of a weekly candidate batch; shared reconciler owns acceptance. */
export function prepareSteveBatch(
  ledger: IngestionLedger,
  content: string,
  observedAtEpochMs: number,
  aliases: Record<string, string> = {}
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
        if (
          Date.UTC(year, monthIndex, Number(day)) <
          reference.getTime() - 180 * 86400000
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
  return withIngestionLock(root, async () => {
    const ledger = await loadLedger(join(root, "data/ingestion/ledger.json"));
    applyVenueLocationCorrections(root, ledger.venues);
    const historical = findHistoricalSteveReceipt(root, content, ledger);
    if (historical)
      return {
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
      };
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
      // Bind replay to the exact source content and importer version, before
      // parsing against a catalog whose entity IDs may since have changed.
      const reportName = createHash("sha256").update(prior.runId).digest("hex");
      const reportPath = join(
        root,
        "data/ingestion/reports",
        `${reportName}.json`
      );
      if (!existsSync(reportPath))
        throw new Error(
          `Missing saved report for ${prior.runId}; restore ingestion history`
        );
      const report: ReconciliationResult["report"] = JSON.parse(
        readFileSync(reportPath, "utf8")
      );
      if (
        !report ||
        report.runId !== prior.runId ||
        !Array.isArray(report.review) ||
        report.review.length !== prior.reviewCount ||
        !Array.isArray(report.conflicts) ||
        report.conflicts.length !== prior.conflictCount
      )
        throw new Error(
          `Invalid saved report for ${prior.runId}; restore ingestion history`
        );
      for (const key of [
        "acceptedEventIds",
        "newEventIds",
        "updatedEventIds",
        "linkedEventIds",
      ] as const) {
        if (JSON.stringify(report[key]) !== JSON.stringify(prior[key]))
          throw new Error(
            `Saved report disagrees with durable run ${prior.runId}`
          );
      }
      return { ledger, report: { ...report, replay: true } };
    }
    const batch = prepareSteveBatch(
      ledger,
      corrected,
      options.observedAtEpochMs ?? Date.now(),
      aliases
    );
    return commitResult(
      root,
      reconcileCandidates(ledger, batch),
      options.dryRun ?? false,
      batch
    );
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
