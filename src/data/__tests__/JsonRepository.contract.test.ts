import { describe, expect, it } from "vitest";
import type { CachePort } from "../cache/CachePort.ts";
import { JsonDatasetReader } from "../json/JsonDatasetReader.ts";
import { JsonQueryRepository } from "../json/JsonQueryRepository.ts";
import type { DataIndexes, DataManifest } from "@/types/data.js";

class MemoryCache implements CachePort {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return this.values.has(key) ? this.values.get(key) as T : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async clearVersion(_version: string): Promise<void> {}

  async clear(): Promise<void> {
    this.values.clear();
  }

  close(): void {}
}

const manifest = {
  version: "1.1.0",
  datasetVersion: "test-version",
  lastUpdated: 1,
  latestIngestionDate: "2026-08-02",
  totalEvents: 2,
  totalArtists: 1,
  totalVenues: 1,
  dateRange: { startEpochMs: 0, endEpochMs: 1, startDate: "2026-08-02", endDate: "2026-08-02" },
  chunks: {
    events: [{ filename: "events-2026-08.json", chunkId: "2026-08", size: 1, checksum: "test", eventCount: 2, dateRange: { startEpochMs: 0, endEpochMs: 1 } }],
    artists: { filename: "artists.json", size: 1, checksum: "test" },
    venues: { filename: "venues.json", size: 1, checksum: "test" },
    indexes: { filename: "indexes.json", size: 1, checksum: "test" },
  },
  processedAt: 1,
  sourceFiles: {
    events: { filename: "latest.txt", size: 1, lastModified: 1, lineCount: 1, checksum: "test" },
    venues: { filename: "venues.txt", size: 1, lastModified: 1, lineCount: 1, checksum: "test" },
  },
  schemaVersion: "1",
} as DataManifest;

const indexes = {
  eventsByDate: { "2026-08-02": [101, 102] },
  eventsByVenue: { "77": [101, 102] },
  eventsByArtist: { "55": [101, 102] },
  eventsByCity: { Oakland: [101, 102] },
  artistsByName: { "the test band": 55 },
  venuesByName: { "test hall": 77 },
  venuesByCity: { Oakland: [77] },
  cities: [],
  ageRestrictions: [],
  priceRanges: { min: 0, max: 20, buckets: { free: 1, under20: 1, under50: 2, under100: 2, over100: 0 } },
  searchIndex: { indexedAt: 1, totalDocuments: 2, fields: ["title", "content"], size: 1 },
} as unknown as DataIndexes;

const events = {
  chunkId: "2026-08",
  dateRange: { startEpochMs: 0, endEpochMs: 1 },
  events: [
    {
      id: 102, slug: "2026-08-02-later-test-hall", date: "2026-08-02", dateEpochMs: 1, timezone: "America/Los_Angeles",
      artistIds: [55], headlinerArtistId: 55, venueId: 77, isFree: false, priceMin: 20, priceMax: 20,
      ageRestriction: "all-ages", status: "confirmed", tags: [], venueType: "club", createdAtEpochMs: 1, updatedAtEpochMs: 1, sourceLineNumber: 2,
    },
    {
      id: 101, slug: "2026-08-02-punk-test-hall", date: "2026-08-02", dateEpochMs: 0, timezone: "America/Los_Angeles",
      artistIds: [55], headlinerArtistId: 55, venueId: 77, isFree: true,
      ageRestriction: "all-ages", status: "confirmed", tags: ["free"], venueType: "club", createdAtEpochMs: 1, updatedAtEpochMs: 1, sourceLineNumber: 1,
    },
  ],
};

const artists = [{ id: 55, name: "The Test Band", slug: "the-test-band", normalizedName: "the test band", aliases: [], upcomingEventCount: 2, totalEventCount: 2, upcomingEvents: [], createdAtEpochMs: 1, updatedAtEpochMs: 1 }];
const venues = [{ id: 77, name: "Test Hall", slug: "test-hall", normalizedName: "test hall", address: "1 Main", city: "Oakland", ageRestriction: "all-ages", upcomingEventCount: 2, totalEventCount: 2, upcomingEvents: [], createdAtEpochMs: 1, updatedAtEpochMs: 1, sourceLineNumber: 1 }];
const documents = [{ id: 0, type: "event" as const, entityId: "101", title: "Punk show", content: "Punk The Test Band Test Hall", city: "Oakland", date: "2026-08-02", tags: [] }];

function readerWithFixtures() {
  const requests: Request[] = [];
  const files: Record<string, unknown> = {
    "manifest.json": manifest,
    "indexes.json": indexes,
    "artists.json": artists,
    "venues.json": venues,
    "events-2026-08.json": events,
    "search-documents.json": documents,
  };
  const reader = new JsonDatasetReader({
    cache: new MemoryCache(),
    retryAttempts: 1,
    fetcher: async (request) => {
      requests.push(request);
      const filename = request.url.split("/").pop() ?? "";
      const value = files[filename];
      return new Response(JSON.stringify(value), { status: value === undefined ? 404 : 200, headers: { "Content-Type": "application/json" } });
    },
  });
  return { reader, requests };
}

describe("JSON repository contract", () => {
  it("resolves an event ID and slug from a cold start without preloading all chunks", async () => {
    const { reader } = readerWithFixtures();
    const repository = new JsonQueryRepository(reader);

    const byId = await repository.events.getById("101" as never);
    const bySlug = await repository.events.getBySlug("2026-08-02-punk-test-hall");

    expect(byId?.slug).toBe("2026-08-02-punk-test-hall");
    expect(bySlug?.id).toBe("101");
    expect(reader.getMetrics().chunksLoaded).toBe(1);
  });

  it("uses search document IDs to resolve event chunks and centralizes ordering and pagination", async () => {
    const { reader, requests } = readerWithFixtures();
    const repository = new JsonQueryRepository(reader);

    const result = await repository.events.list({ text: "punk", limit: 1 });
    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("101");
    expect(requests.every((request) => request.method === "GET" && request.referrerPolicy === "no-referrer")).toBe(true);
    expect(reader.getMetrics().queryCount).toBe(1);
  });
});
