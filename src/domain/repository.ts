import type { Artist, Venue } from "./entities.ts";
import type { EventQuery } from "./filters.ts";
import type { EventDetail, EventSummary, ArtistSummary, VenueSummary } from "./projections.ts";
import type { ArtistId, EventId, VenueId } from "./identifiers.ts";

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly nextOffset?: number;
}

export interface EventRepository {
  getById(id: EventId): Promise<EventDetail | null>;
  getBySlug(slug: string): Promise<EventDetail | null>;
  list(query?: EventQuery): Promise<Page<EventSummary>>;
  listByMonth(month: string, query?: EventQuery): Promise<Page<EventSummary>>;
}

export interface ArtistRepository {
  getById(id: ArtistId): Promise<Artist | null>;
  getBySlug(slug: string): Promise<Artist | null>;
  list(query?: EventQuery): Promise<Page<ArtistSummary>>;
}

export interface VenueRepository {
  getById(id: VenueId): Promise<Venue | null>;
  getBySlug(slug: string): Promise<Venue | null>;
  list(query?: EventQuery): Promise<Page<VenueSummary>>;
}

export interface QueryRepository {
  readonly events: EventRepository;
  readonly artists: ArtistRepository;
  readonly venues: VenueRepository;
  search(query: EventQuery): Promise<Page<EventSummary | ArtistSummary | VenueSummary>>;
}
