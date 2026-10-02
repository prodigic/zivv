import type { Artist, Venue } from "../../types/events.js";
import type { IngestionLedger } from "../../types/ingestion.js";
import { EventParser } from "../etl/parsers.js";

/** Split legacy HopMonk records using explicit cities in retained source rows.
 * Preserves event IDs, URLs, source observations, and immutable date-added fields.
 * Missing evidence stays unresolved; conflicting cities stop the repair.
 */
export function repairHopmonk(
  ledger: IngestionLedger,
  content: string,
  aliases: Record<string, string>,
  timestamp: number
) {
  const next = structuredClone(ledger);
  const legacyIds = new Set(
    next.venues
      .filter((v) =>
        /^(hopmonk(?: tavern)?|hopmonk tavern novato 21\+ 7pm\/8pm)$/i.test(
          v.name
        )
      )
      .map((v) => v.id)
  );
  const evidence = new Map<string, { venue: Venue; line: number }>();
  const artists = new Map<string, Artist>(
    next.artists.map((a) => [a.normalizedName, a])
  );
  content.split(/\r?\n/).forEach((line, index) => {
    if (
      !/\bat (?:hopmonk(?: tavern)?|hopmon|hopmok tavern), (?:Novato|Sebastopol)\b/i.test(
        line
      )
    )
      return;
    const parsed = EventParser.parseEventsFile(line);
    const venues = new Map<string, Venue>();
    const normalized = EventParser.normalizeEvents(
      parsed.rawEvents,
      artists,
      venues,
      aliases
    );
    if (
      parsed.errors.length ||
      normalized.errors.length ||
      normalized.events.length !== 1
    )
      throw new Error(`Cannot parse HopMonk evidence at line ${index + 1}`);
    const event = normalized.events[0];
    const venue = [...venues.values()][0];
    const key = `${event.date}|${event.headlinerArtistId}`;
    const prior = evidence.get(key);
    if (prior && prior.venue.city !== venue.city)
      throw new Error(`Conflicting HopMonk cities at line ${index + 1}`);
    evidence.set(key, { venue, line: index + 1 });
  });
  // Parsing evidence must not mutate the catalog's artist counts/metadata.
  next.artists = structuredClone(ledger.artists);
  const changes: {
    eventId: number;
    fromVenueId: number;
    toVenueId: number;
    city: string;
    sourceLine: number;
  }[] = [];
  const unresolved: number[] = [];
  for (const event of next.events) {
    if (!legacyIds.has(event.venueId)) continue;
    const match = evidence.get(`${event.date}|${event.headlinerArtistId}`);
    if (!match) {
      unresolved.push(event.id);
      continue;
    }
    const { venue, line } = match;
    const existingVenue = next.venues.find((v) => v.id === venue.id);
    if (
      existingVenue &&
      (existingVenue.name !== venue.name || existingVenue.city !== venue.city)
    )
      throw new Error(`Venue ID collision: ${venue.id}`);
    if (!existingVenue)
      next.venues.push({
        ...venue,
        address:
          venue.city === "Novato" ? "224 Vintage Way" : "230 Petaluma Ave",
        website: `https://www.hopmonk.com/${venue.city.toLowerCase()}/`,
        ageRestriction: venue.city === "Sebastopol" ? "21+" : "all-ages",
        createdAtEpochMs: timestamp,
        updatedAtEpochMs: timestamp,
        upcomingEvents: [],
        upcomingEventCount: 0,
        totalEventCount: 0,
      });
    changes.push({
      eventId: event.id,
      fromVenueId: event.venueId,
      toVenueId: venue.id,
      city: venue.city,
      sourceLine: line,
    });
    event.provenanceConflicts.push({
      field: "venueId",
      existingValue: event.venueId,
      incomingValue: venue.id,
      existingSource: "legacy-catalog",
      incomingSource: `hopmonk-city-repair:data/events.txt:${line}`,
      detectedAtEpochMs: timestamp,
      reason: "source-update",
    });
    event.venueId = venue.id;
    event.updatedAtEpochMs = timestamp;
  }
  if (changes.length) next.version = `${ledger.version}.hopmonk-city-repair`;
  return { ledger: next, changes, unresolved };
}
