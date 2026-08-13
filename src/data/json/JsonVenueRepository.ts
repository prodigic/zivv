import type { Venue as DomainVenue } from "@/domain/entities.ts";
import type { EventQuery } from "@/domain/filters.ts";
import type { VenueId } from "@/domain/identifiers.ts";
import type { Page, VenueRepository } from "@/domain/repository.ts";
import type { VenueSummary } from "@/domain/projections.ts";
import type { DatasetReader } from "../ports.ts";
import { toDomainVenue } from "./legacyMapper.ts";

export class JsonVenueRepository implements VenueRepository {
  private readonly reader: DatasetReader;

  constructor(reader: DatasetReader) {
    this.reader = reader;
  }

  async getById(id: VenueId): Promise<DomainVenue | null> {
    const venues = await this.load();
    return venues.find((venue) => venue.id === id) ?? null;
  }

  async getBySlug(slug: string): Promise<DomainVenue | null> {
    const venues = await this.load();
    return venues.find((venue) => venue.slug === slug) ?? null;
  }

  async list(query: EventQuery = {}): Promise<Page<VenueSummary>> {
    const venues = await this.load();
    const text = query.text?.trim().toLocaleLowerCase();
    const matches = text
      ? venues.filter((venue) => `${venue.name} ${venue.normalizedName} ${venue.city}`.toLocaleLowerCase().includes(text))
      : venues;
    const sorted = [...matches].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return paginate(sorted.map((venue) => ({
      id: venue.id,
      name: venue.name,
      city: venue.city,
      upcomingEventCount: 0,
      totalEventCount: 0,
    })), query.offset, query.limit);
  }

  private async load(): Promise<DomainVenue[]> {
    return (await this.reader.getVenues()).map(toDomainVenue);
  }
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
