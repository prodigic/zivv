import type { Artist, Event, Venue } from "@/domain/entities.ts";
import { matchesEventFilters, type EventQuery } from "@/domain/filters.ts";
import type { EventId, VenueId } from "@/domain/identifiers.ts";
import type { EventDetail, EventSummary } from "@/domain/projections.ts";
import type { EventRepository, Page } from "@/domain/repository.ts";
import type { Event as LegacyEvent } from "@/types/events.js";
import type { DatasetReader } from "../ports.ts";
import { toDomainArtist, toDomainEvent, toDomainVenue } from "./legacyMapper.ts";

export interface JsonEventRepositoryOptions {
  readonly defaultPageSize?: number;
}

export class JsonEventRepository implements EventRepository {
  private readonly defaultPageSize: number;
  private readonly reader: DatasetReader;

  constructor(
    reader: DatasetReader,
    options: JsonEventRepositoryOptions = {},
  ) {
    this.reader = reader;
    this.defaultPageSize = options.defaultPageSize ?? 50;
  }

  async getById(id: EventId): Promise<EventDetail | null> {
    const raw = await this.findRawById(id);
    return raw ? this.toDetail(raw) : null;
  }

  async getBySlug(slug: string): Promise<EventDetail | null> {
    const likelyChunk = await this.reader.getEventChunkForSlug(slug);
    const chunkIds = likelyChunk ? [likelyChunk] : (await this.reader.getManifest()).chunks.events.map((chunk) => chunk.chunkId);
    for (const chunkId of chunkIds) {
      const raw = (await this.reader.getEventChunk(chunkId)).events.find((event) => event.slug === slug);
      if (raw) return this.toDetail(raw);
    }
    return null;
  }

  async list(query: EventQuery = {}): Promise<Page<EventSummary>> {
    const events = await this.loadMatchingEvents(query);
    const summaries = await this.toSummaries(events);
    const sorted = sortSummaries(summaries, query);
    return paginate(sorted, query.offset, query.limit ?? this.defaultPageSize);
  }

  async listByMonth(month: string, query: EventQuery = {}): Promise<Page<EventSummary>> {
    const chunk = await this.reader.getEventChunk(month);
    const events = await this.filterEvents(chunk.events.map(toDomainEvent), query);
    const summaries = await this.toSummaries(events);
    const sorted = sortSummaries(summaries, query);
    return paginate(sorted, query.offset, query.limit ?? this.defaultPageSize);
  }

  private async findRawById(id: EventId): Promise<LegacyEvent | null> {
    const chunkId = await this.reader.getEventChunkForId(id);
    if (!chunkId) return null;
    return (await this.reader.getEventChunk(chunkId)).events.find((event) => String(event.id) === id) ?? null;
  }

  private async loadMatchingEvents(query: EventQuery): Promise<Event[]> {
    const candidates = query.text ? await this.reader.findEventIds(query.text) : undefined;
    const chunkIds = candidates
      ? await this.chunkIdsForIds(candidates)
      : (await this.reader.getManifest()).chunks.events.map((chunk) => chunk.chunkId);

    const rawEvents: LegacyEvent[] = [];
    for (const chunkId of chunkIds) rawEvents.push(...(await this.reader.getEventChunk(chunkId)).events);
    const candidateSet = candidates ? new Set(candidates) : null;
    const events = rawEvents
      .filter((event) => candidateSet === null || candidateSet.has(String(event.id) as EventId))
      .map(toDomainEvent);
    return this.filterEvents(events, query);
  }

  private async chunkIdsForIds(ids: readonly EventId[]): Promise<string[]> {
    const chunks = new Set<string>();
    for (const id of ids) {
      const chunkId = await this.reader.getEventChunkForId(id);
      if (chunkId) chunks.add(chunkId);
    }
    return [...chunks];
  }

  private async filterEvents(events: readonly Event[], query: EventQuery): Promise<Event[]> {
    if (!query.filters) return [...events];
    const venues = (await this.reader.getVenues()).map(toDomainVenue);
    const cityByVenueId = new Map<string, string>(venues.map((venue) => [venue.id, venue.city]));
    return events.filter((event) => matchesEventFilters(event, query.filters!, { cityByVenueId }));
  }

  private async toSummaries(events: readonly Event[]): Promise<EventSummary[]> {
    const [artists, venues] = await Promise.all([this.reader.getArtists(), this.reader.getVenues()]);
    const artistById = new Map<string, Artist>(artists.map((artist) => {
      const domain = toDomainArtist(artist);
      return [domain.id, domain];
    }));
    const venueById = new Map<string, Venue>(venues.map((venue) => {
      const domain = toDomainVenue(venue);
      return [domain.id, domain];
    }));
    return events.map((event) => {
      const headliner = artistById.get(event.headlinerArtistId);
      const venue = venueById.get(event.venueId);
      return {
        id: event.id,
        slug: event.slug,
        date: event.date,
        ...(event.startTime === undefined ? {} : { startTime: event.startTime }),
        headlinerName: headliner?.name ?? "Unknown artist",
        venueName: venue?.name ?? "Unknown venue",
        venueCity: venue?.city ?? "Unknown city",
        priceLabel: priceLabel(event),
        isFree: event.price.isFree,
        status: event.status,
      };
    });
  }

  private async toDetail(raw: LegacyEvent): Promise<EventDetail> {
    const event = toDomainEvent(raw);
    const [rawArtists, rawVenues] = await Promise.all([this.reader.getArtists(), this.reader.getVenues()]);
    const artists = rawArtists.map(toDomainArtist);
    const venue = rawVenues.map(toDomainVenue).find((candidate) => candidate.id === event.venueId);
    if (!venue) return { ...event, artists: [], venue: missingVenue(event.venueId), credits: [] };
    const eventArtists = artists.filter((artist) => event.artistIds.includes(artist.id));
    return {
      ...event,
      artists: eventArtists,
      venue,
      credits: eventArtists.map((artist, index) => ({
        eventId: event.id,
        artistId: artist.id,
        billingOrder: index,
        isHeadliner: artist.id === event.headlinerArtistId,
      })),
    };
  }
}

function priceLabel(event: Event): string {
  if (event.price.isFree) return "Free";
  if (event.price.min === undefined && event.price.max === undefined) return "Price unavailable";
  if (event.price.min !== undefined && event.price.max !== undefined && event.price.min !== event.price.max) {
    return `$${event.price.min}–$${event.price.max}`;
  }
  return `$${event.price.min ?? event.price.max}`;
}

function sortSummaries(items: readonly EventSummary[], query: EventQuery): EventSummary[] {
  const order = query.order === "desc" ? -1 : 1;
  return [...items].sort((a, b) => {
    let result = 0;
    if (query.sort === "price") result = Number.parseFloat(a.priceLabel.replace(/[^0-9.]/g, "") || "0") - Number.parseFloat(b.priceLabel.replace(/[^0-9.]/g, "") || "0");
    else if (query.sort === "venue") result = a.venueName.localeCompare(b.venueName);
    else result = a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? "");
    return result * order || a.id.localeCompare(b.id);
  });
}

function paginate<T>(items: readonly T[], offset = 0, limit = items.length): Page<T> {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(0, limit);
  const page = items.slice(safeOffset, safeOffset + safeLimit);
  return {
    items: page,
    total: items.length,
    ...(safeOffset + page.length < items.length ? { nextOffset: safeOffset + page.length } : {}),
  };
}

function missingVenue(id: VenueId): Venue {
  return {
    id,
    stableKey: `missing-venue:${id}` as Venue["stableKey"],
    name: "Unknown venue",
    slug: "unknown-venue",
    normalizedName: "unknown venue",
    address: "",
    city: "",
    ageRestriction: "all-ages",
    provenance: [{ sourceName: "missing-reference" }],
  };
}
