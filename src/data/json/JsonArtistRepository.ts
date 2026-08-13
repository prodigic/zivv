import type { Artist as DomainArtist } from "@/domain/entities.ts";
import type { EventQuery } from "@/domain/filters.ts";
import type { ArtistId } from "@/domain/identifiers.ts";
import type { ArtistRepository, Page } from "@/domain/repository.ts";
import type { ArtistSummary } from "@/domain/projections.ts";
import type { DatasetReader } from "../ports.ts";
import { toDomainArtist } from "./legacyMapper.ts";

export class JsonArtistRepository implements ArtistRepository {
  private readonly reader: DatasetReader;

  constructor(reader: DatasetReader) {
    this.reader = reader;
  }

  async getById(id: ArtistId): Promise<DomainArtist | null> {
    const artists = await this.load();
    return artists.find((artist) => artist.id === id) ?? null;
  }

  async getBySlug(slug: string): Promise<DomainArtist | null> {
    const artists = await this.load();
    return artists.find((artist) => artist.slug === slug) ?? null;
  }

  async list(query: EventQuery = {}): Promise<Page<ArtistSummary>> {
    const started = await this.load();
    const text = query.text?.trim().toLocaleLowerCase();
    const matches = text
      ? started.filter((artist) => `${artist.name} ${artist.normalizedName} ${artist.aliases.join(" ")}`
        .toLocaleLowerCase().includes(text))
      : started;
    const sorted = [...matches].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return paginate(sorted.map((artist) => ({
      id: artist.id,
      name: artist.name,
      slug: artist.slug,
      upcomingEventCount: 0,
      totalEventCount: 0,
    })), query.offset, query.limit);
  }

  private async load(): Promise<DomainArtist[]> {
    return (await this.reader.getArtists()).map(toDomainArtist);
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
