import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Artist, Event, EventPoster, Venue } from "../../types/events.js";
import { isEventPoster } from "../../utils/event-poster.js";

/** Reviewed source evidence bound to one canonical show, not a venue default. */
export interface ReviewedEventPoster extends EventPoster {
  eventId: number;
  eventSlug: string;
  venueId: number;
  venueName: string;
  date: string;
  headlinerArtistId: number;
  headlinerName: string;
  evidence: string;
}

export interface EventPosterRegistry {
  schemaVersion: 1;
  events: ReviewedEventPoster[];
}

/** Reject malformed or conflicting research before applying any poster. */
export function decodeEventPosters(value: unknown): EventPosterRegistry {
  if (!value || typeof value !== "object")
    throw new Error("Invalid event poster registry");
  const registry = value as Record<string, unknown>;
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.events))
    throw new Error("Invalid event poster registry");
  const ids = new Set<number>();
  for (const value of registry.events) {
    const row = value as Partial<ReviewedEventPoster> | null;
    const hasPoster = isEventPoster(value);
    if (
      !row ||
      !hasPoster ||
      ![row.eventId, row.venueId, row.headlinerArtistId].every(
        (id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ) ||
      ids.has(row.eventId!) ||
      ![row.eventSlug, row.venueName, row.headlinerName, row.evidence].every(
        (text) => typeof text === "string" && text.trim().length > 0
      ) ||
      typeof row.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      Number.isNaN(Date.parse(row.date)) ||
      new Date(row.date).toISOString().slice(0, 10) !== row.date
    )
      throw new Error(
        `Invalid event poster entry: ${row?.eventId ?? "unknown"}`
      );
    ids.add(row.eventId!);
  }
  return value as EventPosterRegistry;
}

/**
 * Apply artwork only while the complete reviewed show identity still matches.
 * A reschedule, move or rename makes the old poster stale; it must not block
 * subsequent imports or silently attach an outdated flyer to the changed show.
 * Canonical IDs, source observations and immutable date-added fields are untouched.
 */
export function applyEventPosters(
  events: Event[],
  venues: Venue[],
  artists: Artist[],
  value: EventPosterRegistry
): { applied: number[]; stale: number[] } {
  const registry = decodeEventPosters(value);
  const byId = new Map(events.map((event) => [Number(event.id), event]));
  const venueById = new Map(venues.map((venue) => [Number(venue.id), venue]));
  const artistById = new Map(
    artists.map((artist) => [Number(artist.id), artist])
  );
  const applied: number[] = [];
  const stale: number[] = [];
  for (const row of registry.events) {
    const event = byId.get(row.eventId);
    if (
      !event ||
      event.slug !== row.eventSlug ||
      event.date !== row.date ||
      event.venueId !== row.venueId ||
      venueById.get(row.venueId)?.name !== row.venueName ||
      event.headlinerArtistId !== row.headlinerArtistId ||
      artistById.get(row.headlinerArtistId)?.name !== row.headlinerName
    ) {
      if (event) delete event.poster;
      stale.push(row.eventId);
      continue;
    }
    event.poster = {
      imageUrl: row.imageUrl,
      eventUrl: row.eventUrl,
      kind: row.kind,
      checkedOn: row.checkedOn,
    };
    applied.push(row.eventId);
  }
  return { applied, stale };
}

export function applyProjectEventPosters(
  projectRoot: string,
  events: Event[],
  venues: Venue[],
  artists: Artist[]
): { applied: number[]; stale: number[] } {
  const path = join(projectRoot, "data/event-posters.json");
  if (!existsSync(path)) return { applied: [], stale: [] };
  return applyEventPosters(
    events,
    venues,
    artists,
    decodeEventPosters(JSON.parse(readFileSync(path, "utf8")))
  );
}
