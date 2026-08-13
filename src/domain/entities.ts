import type { ArtistId, EventId, SourceProvenance, StableKey, VenueId } from "./identifiers.ts";

export type AgeRestriction = "all-ages" | "5+" | "6+" | "8+" | "16+" | "18+" | "21+";
export type EventStatus = "confirmed" | "sold-out" | "cancelled" | "postponed" | "rescheduled";
export type EventTag =
  | "sold-out"
  | "free"
  | "tribute"
  | "hip-hop"
  | "reggae"
  | "festival"
  | "outdoor"
  | "all-ages"
  | "matinee"
  | "late-show";
export type VenueType = "major" | "club" | "diy" | "outdoor" | "festival" | "unknown";

export interface Event {
  id: EventId;
  stableKey: StableKey;
  slug: string;
  date: string;
  timezone: string;
  startTime?: string;
  artistIds: readonly ArtistId[];
  headlinerArtistId: ArtistId;
  venueId: VenueId;
  price: Price;
  ageRestriction: AgeRestriction;
  status: EventStatus;
  tags: readonly EventTag[];
  venueType: VenueType;
  description?: string;
  notes?: string;
  ticketUrl?: string;
  provenance: readonly SourceProvenance[];
}

export interface Artist {
  id: ArtistId;
  stableKey: StableKey;
  name: string;
  slug: string;
  normalizedName: string;
  aliases: readonly string[];
  provenance: readonly SourceProvenance[];
}

export interface Venue {
  id: VenueId;
  stableKey: StableKey;
  name: string;
  slug: string;
  normalizedName: string;
  address: string;
  city: string;
  neighborhood?: string;
  zipCode?: string;
  ageRestriction: AgeRestriction;
  capacity?: number;
  phone?: string;
  website?: string;
  provenance: readonly SourceProvenance[];
}

export interface Price {
  readonly isFree: boolean;
  readonly min?: number;
  readonly max?: number;
}

export interface EventArtistCredit {
  readonly eventId: EventId;
  readonly artistId: ArtistId;
  readonly billingOrder: number;
  readonly isHeadliner: boolean;
}
