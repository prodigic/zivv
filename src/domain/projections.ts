import type { Artist, Event, EventArtistCredit, Venue } from "./entities.ts";
import type { ArtistId, EventId, VenueId } from "./identifiers.ts";

export interface EventSummary {
  readonly id: EventId;
  readonly slug: string;
  readonly date: string;
  readonly startTime?: string;
  readonly headlinerName: string;
  readonly venueName: string;
  readonly venueCity: string;
  readonly priceLabel: string;
  readonly isFree: boolean;
  readonly status: Event["status"];
}

export interface EventDetail extends Event {
  readonly artists: readonly Artist[];
  readonly venue: Venue;
  readonly credits: readonly EventArtistCredit[];
}

export interface ArtistSummary {
  readonly id: ArtistId;
  readonly name: string;
  readonly slug: string;
  readonly upcomingEventCount: number;
  readonly totalEventCount: number;
}

export interface VenueSummary {
  readonly id: VenueId;
  readonly name: string;
  readonly city: string;
  readonly upcomingEventCount: number;
  readonly totalEventCount: number;
}

export interface SearchDocument {
  readonly entityType: "event" | "artist" | "venue";
  readonly entityId: string;
  readonly text: string;
}
