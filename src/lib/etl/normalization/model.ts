import type { Artist, Venue } from "@/types/events.js";
import type { ProcessingError, ProcessingWarning } from "@/types/data.js";
import { EventParser, VenueParser } from "../parsers.js";
import type {
  CanonicalArtist,
  CanonicalModel,
  CanonicalVenue,
  NormalizationStageResult,
  ProvenanceRecord,
  SourceBundle,
} from "../pipeline/types.js";

export interface NormalizationOptions {
  timestamp: number;
  venueAliases?: Record<string, string>;
}

/**
 * Normalize a source bundle without writing files. The legacy parsers remain
 * the semantic authority during this transition; this module owns the stage
 * boundary and removes time-dependent projections from the canonical model.
 */
export function normalizeSourceBundle(
  source: SourceBundle,
  options: NormalizationOptions
): NormalizationStageResult {
  const eventParsed = EventParser.parseEventsFile(source.eventsContent);
  const venueParsed = VenueParser.parseVenuesFile(source.venuesContent);
  const artistMap = new Map<string, Artist>();
  const venueMap = new Map<string, Venue>();

  const normalizedEvents = EventParser.normalizeEvents(
    eventParsed.rawEvents,
    artistMap,
    venueMap,
    options.venueAliases ?? source.aliases
  );
  const normalizedVenues = VenueParser.normalizeVenues(venueParsed.rawVenues, venueMap);

  const events = normalizedEvents.events.map((event) => ({
    ...event,
    createdAtEpochMs: options.timestamp,
    updatedAtEpochMs: options.timestamp,
  }));
  const artists = Array.from(artistMap.values()).map((artist) => canonicalArtist(artist, options.timestamp, source));
  const venues = normalizedVenues.venues.map((venue) => canonicalVenue(venue, options.timestamp, source));

  return {
    model: {
      events,
      artists,
      venues,
      provenance: {
        events: new Map(events.map((event) => [event.id as number, eventProvenance(event, source, options.timestamp)])),
        artists: new Map(artists.map((artist) => [artist.id as number, artist.provenance])),
        venues: new Map(venues.map((venue) => [venue.id as number, venue.provenance])),
      },
    },
    rawEventCount: eventParsed.rawEvents.length,
    rawVenueCount: venueParsed.rawVenues.length,
    errors: [
      ...eventParsed.errors,
      ...venueParsed.errors,
      ...normalizedEvents.errors,
      ...normalizedVenues.errors,
    ].map(toProcessingError),
    warnings: [
      ...eventParsed.warnings,
      ...venueParsed.warnings,
      ...normalizedEvents.warnings,
      ...normalizedVenues.warnings,
    ].map(toProcessingWarning),
  };
}

function canonicalArtist(artist: Artist, timestamp: number, source: SourceBundle): CanonicalArtist {
  const { upcomingEventCount: _count, upcomingEvents: _events, ...canonical } = artist;
  return {
    ...canonical,
    createdAtEpochMs: timestamp,
    updatedAtEpochMs: timestamp,
    provenance: {
      sourceFile: source.sourceFiles.events.filename,
      sourceLineNumber: 0,
      firstSeenEpochMs: timestamp,
      lastSeenEpochMs: timestamp,
    },
  };
}

function canonicalVenue(venue: Venue, timestamp: number, source: SourceBundle): CanonicalVenue {
  const { upcomingEventCount: _count, upcomingEvents: _events, ...canonical } = venue;
  return {
    ...canonical,
    createdAtEpochMs: timestamp,
    updatedAtEpochMs: timestamp,
    provenance: {
      sourceFile: source.sourceFiles.venues.filename,
      sourceLineNumber: canonical.sourceLineNumber,
      firstSeenEpochMs: timestamp,
      lastSeenEpochMs: timestamp,
    },
  };
}

function eventProvenance(event: CanonicalModel["events"][number], source: SourceBundle, timestamp: number): ProvenanceRecord {
  return {
    sourceFile: source.sourceFiles.events.filename,
    sourceLineNumber: event.sourceLineNumber,
    firstSeenEpochMs: timestamp,
    lastSeenEpochMs: timestamp,
  };
}

function toProcessingError(error: { type?: string; message: string; line?: number; rawText?: string }): ProcessingError {
  return {
    type: error.type === "validation" ? "validation" : "data",
    message: error.message,
    sourceFile: "events.txt",
    lineNumber: error.line,
    rawData: error.rawText,
  };
}

function toProcessingWarning(warning: { message: string; line?: number }): ProcessingWarning {
  return { type: "data-quality", message: warning.message, sourceFile: "events.txt", lineNumber: warning.line };
}
