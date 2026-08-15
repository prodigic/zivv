/**
 * Storage-independent identifiers used by the domain layer.
 *
 * These are intentionally distinct from the legacy numeric IDs in
 * `src/types/events.ts`. Adapters can map between them until all consumers
 * have migrated.
 */

export type StableKey = string & { readonly __brand: "StableKey" };
export type EventId = string & { readonly __brand: "DomainEventId" };
export type ArtistId = string & { readonly __brand: "DomainArtistId" };
export type VenueId = string & { readonly __brand: "DomainVenueId" };

function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

export function stableKey(value: string): StableKey {
  return assertNonEmpty(value, "Stable key") as StableKey;
}

export function eventId(value: string): EventId {
  return assertNonEmpty(value, "Event ID") as EventId;
}

export function artistId(value: string): ArtistId {
  return assertNonEmpty(value, "Artist ID") as ArtistId;
}

export function venueId(value: string): VenueId {
  return assertNonEmpty(value, "Venue ID") as VenueId;
}

export interface SourceProvenance {
  sourceName: string;
  sourceLine?: number;
  rawText?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
}
