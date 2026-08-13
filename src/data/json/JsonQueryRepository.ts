import type { EventQuery } from "@/domain/filters.ts";
import type { EventSummary, ArtistSummary, VenueSummary } from "@/domain/projections.ts";
import type { Page, QueryRepository } from "@/domain/repository.ts";
import type { DatasetReader } from "../ports.ts";
import { JsonArtistRepository } from "./JsonArtistRepository.ts";
import { JsonEventRepository } from "./JsonEventRepository.ts";
import { JsonVenueRepository } from "./JsonVenueRepository.ts";

type SearchResult = EventSummary | ArtistSummary | VenueSummary;

/** Composition root for UI-facing repository queries. */
export class JsonQueryRepository implements QueryRepository {
  readonly events: JsonEventRepository;
  readonly artists: JsonArtistRepository;
  readonly venues: JsonVenueRepository;

  constructor(reader: DatasetReader) {
    this.events = new JsonEventRepository(reader);
    this.artists = new JsonArtistRepository(reader);
    this.venues = new JsonVenueRepository(reader);
  }

  async search(query: EventQuery = {}): Promise<Page<SearchResult>> {
    const unpaged = { ...query, offset: 0, limit: undefined };
    const [events, artists, venues] = await Promise.all([
      this.events.list(unpaged),
      this.artists.list(unpaged),
      this.venues.list(unpaged),
    ]);
    const items: SearchResult[] = [...events.items, ...artists.items, ...venues.items];
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(0, query.limit ?? items.length);
    const page = items.slice(offset, offset + limit);
    return {
      items: page,
      total: items.length,
      ...(offset + page.length < items.length ? { nextOffset: offset + page.length } : {}),
    };
  }
}

export function createJsonQueryRepository(reader: DatasetReader): QueryRepository {
  return new JsonQueryRepository(reader);
}
