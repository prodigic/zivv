import type { EventChunk } from "@/types/events.js";
import { canonicalArtists, canonicalEvents, canonicalVenues } from "./staging.js";
import type { DirectoryProjectionRow, EventArtistRow, EventProjectionRow, EventTagRow, SearchProjectionRow, StagedSnapshot } from "./types.js";

export function buildProjectionRows(snapshot: StagedSnapshot): {
  eventArtists: EventArtistRow[];
  eventTags: EventTagRow[];
  eventProjections: EventProjectionRow[];
  directoryProjections: DirectoryProjectionRow[];
  searchProjections: SearchProjectionRow[];
} {
  const events = canonicalEvents(snapshot);
  const artists = canonicalArtists(snapshot);
  const venues = canonicalVenues(snapshot);
  const artistById = new Map(artists.map((artist) => [artist.id as number, artist]));
  const eventArtists = events.flatMap((event) => event.artistIds.map((artistId, billingOrder) => ({
    eventStableKey: event.stableKey,
    artistStableKey: artistById.get(artistId as number)?.stableKey ?? `artist:${artistId}`,
    billingOrder,
    isHeadliner: artistId === event.headlinerArtistId,
  })));
  const eventTags = events.flatMap((event) => event.tags.map((tag) => ({ eventStableKey: event.stableKey, tag })));
  const eventProjections = events.map((event) => ({
    eventStableKey: event.stableKey,
    chunkId: event.date.slice(0, 7),
    asOfEpochMs: snapshot.projections.asOfEpochMs,
    isUpcoming: event.dateEpochMs >= snapshot.projections.asOfEpochMs,
  }));
  const directoryProjections = [
    ...artists.map((artist) => ({
      entityStableKey: artist.stableKey,
      entityType: "artist" as const,
      upcomingEventCount: snapshot.projections.artistUpcomingEventCount.get(artist.id as number) ?? 0,
      asOfEpochMs: snapshot.projections.asOfEpochMs,
    })),
    ...venues.map((venue) => ({
      entityStableKey: venue.stableKey,
      entityType: "venue" as const,
      upcomingEventCount: snapshot.projections.venueUpcomingEventCount.get(venue.id as number) ?? 0,
      asOfEpochMs: snapshot.projections.asOfEpochMs,
    })),
  ];
  const searchProjections = [
    ...events.map((event) => ({
      documentKey: `event:${event.stableKey}`,
      entityStableKey: event.stableKey,
      entityType: "event" as const,
      title: event.slug,
      content: `${event.slug} ${event.tags.join(" ")}`,
    })),
    ...artists.map((artist) => ({
      documentKey: `artist:${artist.stableKey}`,
      entityStableKey: artist.stableKey,
      entityType: "artist" as const,
      title: artist.name,
      content: `${artist.name} ${artist.aliases.join(" ")}`,
    })),
    ...venues.map((venue) => ({
      documentKey: `venue:${venue.stableKey}`,
      entityStableKey: venue.stableKey,
      entityType: "venue" as const,
      title: venue.name,
      content: `${venue.name} ${venue.city} ${venue.address}`,
    })),
  ];
  return { eventArtists, eventTags, eventProjections, directoryProjections, searchProjections };
}

export function buildMonthlyChunks(snapshot: StagedSnapshot): EventChunk[] {
  const chunks = new Map<string, EventChunk>();
  for (const event of snapshot.model.events) {
    const chunkId = event.date.slice(0, 7);
    const existing = chunks.get(chunkId);
    if (existing) {
      existing.events.push(event);
      existing.dateRange.startEpochMs = Math.min(existing.dateRange.startEpochMs, event.dateEpochMs);
      existing.dateRange.endEpochMs = Math.max(existing.dateRange.endEpochMs, event.dateEpochMs);
    } else {
      chunks.set(chunkId, {
        chunkId,
        dateRange: { startEpochMs: event.dateEpochMs, endEpochMs: event.dateEpochMs },
        events: [event],
      });
    }
  }
  return Array.from(chunks.values()).sort((left, right) => left.chunkId.localeCompare(right.chunkId));
}
