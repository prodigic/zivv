import { createHash } from "node:crypto";
import type {
  Artist,
  ArtistId,
  Event,
  EventId,
  VenueId,
} from "../../types/events.js";
import type {
  IngestionBatch,
  IngestionCandidateEvent,
  IngestionLedger,
} from "../../types/ingestion.js";
import { StringNormalizer } from "../etl/utils.js";
import { isNonPerformerArtistName } from "../etl/non-performer-artists.js";
import {
  actualStartEpochMs,
  localDateKey,
  localWallClockToEpochMs,
} from "../discovery.js";
import { reconcileCandidates } from "./ledger.js";
import type {
  VenueAdapterResult,
  VenueListing,
  VenueSource,
} from "./venue-types.js";

export interface CoverageItem {
  key: string;
  title: string;
  date: string;
  url: string;
  outcome: "matched" | "missing-from-db" | "review" | "excluded";
  eventIds: number[];
  reason?: string;
}

export interface VenueCoverageReport {
  sourceId: string;
  adapterVersion: string;
  observedAtEpochMs: number;
  sourceStatus: "complete" | "partial";
  databaseStatus:
    "up-to-date" | "gaps-found" | "review-required" | "not-verified";
  horizon: { from: string | null; through: string | null };
  counts: Record<CoverageItem["outcome"], number> & { discovered: number };
  items: CoverageItem[];
  databaseEventsNotOnSource: { eventId: number; date: string; slug: string }[];
  inventoryDifferences: {
    inventory: string;
    missingFromPrimary: string[];
    missingFromInventory: string[];
  }[];
  issues: string[];
  importEligible: boolean;
  modelCalls: 0;
}

const normalized = (name: string) => StringNormalizer.normalizeName(name);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fillmoreTitlePerformer(title: string): string {
  const text = title.trim();
  const spacedDash = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(text);
  const colon = /^(.+?):\s+(.+)$/u.exec(text);
  const parts = spacedDash ?? colon;
  if (parts) return parts[1].trim();

  const lastDash = text.lastIndexOf("-");
  const prefix = lastDash >= 0 ? text.slice(0, lastDash).trim() : "";
  return lastDash > 0 && /\s/u.test(prefix) ? prefix : text;
}

function normalizedTitleAct(name: string): string {
  return normalized(name)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/^the/u, "");
}

/** Produce an import batch and a full accounting, without changing the ledger. */
export function assessVenueCoverage(
  ledger: IngestionLedger,
  source: VenueSource,
  result: VenueAdapterResult,
  observedAtEpochMs: number
) {
  if (result.sourceId !== source.sourceId)
    throw new Error("Adapter returned the wrong source");
  const venue = ledger.venues.find((v) => v.id === source.venueId);
  if (!venue || normalized(venue.name) !== normalized(source.venueName))
    throw new Error(`Registered venue identity mismatch: ${source.sourceId}`);
  const issues = [...result.warnings];
  const today = localDateKey(observedAtEpochMs, source.timezone)!;
  const items: CoverageItem[] = [];
  const artists = new Map<string, Artist>(
    ledger.artists.map((a) => [a.normalizedName, a])
  );
  let nextArtist = Math.max(0, ...ledger.artists.map((a) => a.id)) + 1;
  let nextCandidate = Math.max(0, ...ledger.events.map((e) => e.id)) + 1;
  const usedArtists = new Map<ArtistId, Artist>();
  const candidates: IngestionCandidateEvent[] = [];
  const candidateItems: CoverageItem[] = [];
  const listingKeys = new Map<string, VenueListing>();
  const duplicateKeys = new Set<string>();
  for (const listing of result.listings) {
    if (
      listingKeys.has(listing.key) &&
      digest(listingKeys.get(listing.key)) !== digest(listing)
    )
      duplicateKeys.add(listing.key);
    else listingKeys.set(listing.key, listing);
  }
  for (const listing of listingKeys.values()) {
    const item: CoverageItem = {
      key: listing.key,
      title: listing.title,
      date: listing.date,
      url: listing.url,
      outcome: "review",
      eventIds: [],
    };
    items.push(item);
    if (duplicateKeys.has(listing.key)) {
      item.reason = "Conflicting occurrences share one source key";
      continue;
    }
    if (
      source.sourceId === "fillmore-sf" &&
      listing.kind === "review" &&
      !listing.artists.length &&
      /missing explicit performer markup/i.test(listing.reason ?? "") &&
      !/package|pass/i.test(listing.reason ?? "")
    ) {
      const hintedAct = normalizedTitleAct(
        fillmoreTitlePerformer(listing.title)
      );
      const hintDay = localWallClockToEpochMs(
        listing.date,
        12,
        0,
        0,
        0,
        source.timezone
      );
      const sameDayActMatches =
        hintDay !== null && listing.date >= today
          ? ledger.events.filter(
              (event) =>
                event.venueId === source.venueId &&
                event.date === listing.date &&
                event.artistIds.some(
                  (id) =>
                    normalizedTitleAct(
                      ledger.artists.find((artist) => artist.id === id)?.name ??
                        ""
                    ) === hintedAct
                )
            )
          : [];
      if (sameDayActMatches.length === 1) {
        item.outcome = "matched";
        item.eventIds = [sameDayActMatches[0].id];
        item.reason =
          "Matched existing Zivv event by parsed title act, date, and venue";
        continue;
      }
      if (sameDayActMatches.length > 1) {
        item.eventIds = sameDayActMatches.map((event) => event.id);
        item.reason =
          "Parsed title act matches multiple same-day Zivv events; performance needs review";
        continue;
      }
    }
    if (listing.kind === "non-music" || listing.kind === "package") {
      item.outcome = "excluded";
      item.reason = listing.reason ?? listing.kind;
      continue;
    }
    if (
      listing.kind !== "live" ||
      !listing.artists.length ||
      listing.artists.some((name) => !name.trim())
    ) {
      item.reason = listing.reason ?? "Performer identity requires review";
      continue;
    }
    const day = localWallClockToEpochMs(
      listing.date,
      12,
      0,
      0,
      0,
      source.timezone
    );
    if (day === null || !listing.key || !/^https:\/\//i.test(listing.url)) {
      item.reason = "Missing source identity, valid date, or canonical URL";
      continue;
    }
    if (listing.date < today) {
      item.outcome = "excluded";
      item.reason = "Historical listing outside this upcoming-show audit";
      continue;
    }
    if (
      listing.startTimeEpochMs !== undefined &&
      (!Number.isFinite(listing.startTimeEpochMs) ||
        localDateKey(listing.startTimeEpochMs, source.timezone) !==
          listing.date)
    ) {
      item.reason = "Start instant disagrees with the local show date";
      continue;
    }
    const performerNames = listing.artists.filter(
      (name) => !isNonPerformerArtistName(name)
    );
    if (!performerNames.length) {
      item.outcome = "excluded";
      item.reason = "Listing contains no performer artists";
      continue;
    }
    const names = [...new Set(performerNames.map(normalized))];
    const directlyLinked = ledger.events.filter((e) =>
      e.sources.some(
        (s) =>
          (s.sourceId === source.sourceId &&
            s.externalEventId === listing.key) ||
          s.canonicalUrl === listing.url
      )
    );
    const nearMatches = ledger.events.filter(
      (e) =>
        e.venueId === source.venueId &&
        e.date === listing.date &&
        e.artistIds.some((id) =>
          names.includes(
            ledger.artists.find((a) => a.id === id)?.normalizedName ?? ""
          )
        )
    );
    // Source fields cannot prove which unlinked legacy performance is meant.
    // Leave uncertain timings/lineups for review instead of creating duplicates.
    if (
      !directlyLinked.length &&
      nearMatches.some((e) => {
        const lineup = e.artistIds.map(
          (id) => ledger.artists.find((a) => a.id === id)?.normalizedName ?? ""
        );
        return (
          (e.timeBasis === "legacy-wall-clock" &&
            actualStartEpochMs(e) !== (listing.startTimeEpochMs ?? null)) ||
          lineup.length !== names.length ||
          lineup.some((name) => !names.includes(name))
        );
      })
    ) {
      item.eventIds = nearMatches.map((e) => e.id);
      item.reason = "Existing same-day lineup needs source-link/time review";
      continue;
    }
    const artistIds: ArtistId[] = [];
    const priorFacts =
      directlyLinked.length === 1
        ? directlyLinked[0]
        : nearMatches.find(
            (e) => actualStartEpochMs(e) === (listing.startTimeEpochMs ?? null)
          );
    for (const name of performerNames) {
      const key = normalized(name);
      let artist = artists.get(key);
      if (!artist) {
        artist = {
          id: nextArtist++ as ArtistId,
          name: name.trim(),
          normalizedName: key,
          slug: StringNormalizer.createSlug(name),
          aliases: [],
          upcomingEvents: [],
          totalEventCount: 0,
          upcomingEventCount: 0,
          createdAtEpochMs: observedAtEpochMs,
          updatedAtEpochMs: observedAtEpochMs,
        };
        artists.set(key, artist);
      }
      if (!artistIds.includes(artist.id)) artistIds.push(artist.id);
      usedArtists.set(artist.id, artist);
    }
    const event: Event = {
      id: nextCandidate++ as EventId,
      slug: `${listing.date}-${StringNormalizer.createSlug(performerNames[0])}-${venue.slug}-${digest(listing.key).slice(0, 8)}`,
      date: listing.date,
      dateEpochMs: Date.parse(`${listing.date}T12:00:00Z`),
      timezone: source.timezone,
      ...(listing.startTimeEpochMs === undefined
        ? {}
        : {
            startTimeEpochMs: listing.startTimeEpochMs,
            startTime: new Date(listing.startTimeEpochMs).toISOString(),
          }),
      timeBasis: "instant",
      headlinerArtistId: artistIds[0],
      artistIds,
      venueId: source.venueId as VenueId,
      ageRestriction:
        listing.ageRestriction ?? priorFacts?.ageRestriction ?? "unknown",
      status: listing.status ?? priorFacts?.status ?? "confirmed",
      isFree: listing.isFree ?? priorFacts?.isFree ?? false,
      ...(listing.priceMin === undefined ? {} : { priceMin: listing.priceMin }),
      ...(listing.priceMax === undefined ? {} : { priceMax: listing.priceMax }),
      ...(listing.ticketUrl ? { ticketUrl: listing.ticketUrl } : {}),
      notes:
        [
          listing.notes,
          listing.doorsTimeEpochMs === undefined
            ? null
            : `Doors: ${new Date(listing.doorsTimeEpochMs).toISOString()}`,
        ]
          .filter(Boolean)
          .join("; ") || undefined,
      tags: [
        ...new Set([
          ...(priorFacts?.tags ?? []),
          ...(listing.status === "sold-out" ? ["sold-out" as const] : []),
        ]),
      ],
      venueType: priorFacts?.venueType ?? "club",
      createdAtEpochMs: observedAtEpochMs,
      updatedAtEpochMs: observedAtEpochMs,
      sourceLineNumber: 0,
    };
    candidates.push({
      event,
      externalEventId: listing.key,
      canonicalUrl: listing.url,
      session: listing.session,
      evidence: listing.evidence,
    });
    candidateItems.push(item);
  }
  const batch: IngestionBatch = {
    runId: `venue-${source.sourceId}-${digest({ adapter: result.adapterVersion, listings: result.listings, observedAtEpochMs })}`,
    origin: "zivv-venue-import",
    sourceId: source.sourceId,
    sourceUrl: source.calendarUrl,
    observedAtEpochMs,
    events: candidates,
    artists: [...usedArtists.values()],
    venues: [venue],
  };
  const reconciliation = reconcileCandidates(ledger, batch);
  const reviews = new Map(
    reconciliation.report.review.map((r) => [r.candidateIndex, r])
  );
  for (let index = 0; index < candidateItems.length; index++) {
    const item = candidateItems[index];
    const review = reviews.get(index);
    if (review) {
      item.reason = review.message;
      item.eventIds = review.existingEventIds;
      continue;
    }
    const event = reconciliation.ledger.events.find((e) =>
      e.sources.some(
        (s) => s.sourceId === source.sourceId && s.externalEventId === item.key
      )
    );
    if (!event) {
      item.reason = "Candidate has no reconciled source link";
      continue;
    }
    item.outcome = reconciliation.report.newEventIds.includes(event.id)
      ? "missing-from-db"
      : "matched";
    item.eventIds = item.outcome === "matched" ? [event.id] : [];
  }
  const primary = new Set(result.inventories[0]?.keys ?? []);
  const unaccounted = [...primary].filter((key) => !listingKeys.has(key));
  if (unaccounted.length)
    issues.push(
      `${unaccounted.length} discovered keys have no parsed/classified listing`
    );
  if (!result.inventories.length || !primary.size)
    issues.push("No non-empty primary inventory established");
  if (duplicateKeys.size)
    issues.push(
      `${duplicateKeys.size} source keys have conflicting occurrences`
    );
  const counts = {
    discovered: items.length,
    matched: 0,
    "missing-from-db": 0,
    review: 0,
    excluded: 0,
  };
  items.forEach((item) => counts[item.outcome]++);
  const from = result.coverageStart ?? today;
  const through = result.coverageEnd ?? null;
  const validHorizon =
    through !== null &&
    through >= from &&
    localWallClockToEpochMs(from, 12, 0, 0, 0, source.timezone) !== null &&
    localWallClockToEpochMs(through, 12, 0, 0, 0, source.timezone) !== null;
  if (!validHorizon)
    issues.push("No valid source coverage horizon established");
  const sourceComplete =
    result.complete &&
    validHorizon &&
    result.inventories.length > 0 &&
    result.inventories[0].complete &&
    primary.size > 0 &&
    !unaccounted.length &&
    !duplicateKeys.size &&
    result.inventories.every(
      (i) => i.complete || i.requiredForCoverage === false
    );
  const accountedIds = new Set(items.flatMap((item) => item.eventIds));
  const databaseEventsNotOnSource =
    validHorizon && through
      ? ledger.events
          .filter(
            (e) =>
              e.venueId === source.venueId &&
              e.date >= from &&
              e.date <= through &&
              !accountedIds.has(e.id)
          )
          .map((e) => ({ eventId: e.id, date: e.date, slug: e.slug }))
      : [];
  const report: VenueCoverageReport = {
    sourceId: source.sourceId,
    adapterVersion: result.adapterVersion,
    observedAtEpochMs,
    sourceStatus: sourceComplete ? "complete" : "partial",
    databaseStatus: !sourceComplete
      ? "not-verified"
      : counts.review || databaseEventsNotOnSource.length
        ? "review-required"
        : counts["missing-from-db"]
          ? "gaps-found"
          : "up-to-date",
    horizon: { from, through },
    counts,
    items,
    databaseEventsNotOnSource,
    inventoryDifferences: result.inventories.slice(1).map((inventory) => ({
      inventory: inventory.name,
      missingFromPrimary: inventory.keys.filter((key) => !primary.has(key)),
      missingFromInventory: [...primary].filter(
        (key) => !inventory.keys.includes(key)
      ),
    })),
    issues,
    importEligible:
      sourceComplete && !counts.review && !databaseEventsNotOnSource.length,
    modelCalls: 0,
  };
  return { report, batch, reconciliation: reconciliation.report };
}
