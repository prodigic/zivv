import type { Event } from "@/types/events.js";
import { stableEventIdentityKey, artistIdentityKey, venueIdentityKey } from "@/lib/etl/identity/keys.js";
import type { StagedSnapshot, CanonicalEventRow, CanonicalArtistRow, CanonicalVenueRow } from "./types.js";

export function stageSnapshot(snapshot: StagedSnapshot): StagedSnapshot {
  // Clone the collections at the boundary so later parser mutations cannot
  // change the rows that a store is about to commit.
  return {
    ...snapshot,
    model: {
      ...snapshot.model,
      events: snapshot.model.events.map((event) => ({ ...event, tags: [...event.tags], artistIds: [...event.artistIds] })),
      artists: snapshot.model.artists.map((artist) => ({ ...artist, aliases: [...artist.aliases] })),
      venues: snapshot.model.venues.map((venue) => ({ ...venue })),
    },
  };
}

export function eventStableKey(event: Event): string {
  return stableEventIdentityKey(event);
}

export function artistStableKey(name: string): string {
  return artistIdentityKey(name);
}

export function venueStableKey(name: string, city: string): string {
  return venueIdentityKey(name, city);
}

export function canonicalEvents(snapshot: StagedSnapshot): CanonicalEventRow[] {
  return snapshot.model.events.map((event) => ({ ...event, stableKey: eventStableKey(event) }));
}

export function canonicalArtists(snapshot: StagedSnapshot): CanonicalArtistRow[] {
  return snapshot.model.artists.map((artist) => ({ ...artist, stableKey: artistStableKey(artist.name) }));
}

export function canonicalVenues(snapshot: StagedSnapshot): CanonicalVenueRow[] {
  return snapshot.model.venues.map((venue) => ({ ...venue, stableKey: venueStableKey(venue.name, venue.city) }));
}
