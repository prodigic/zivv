import { describe, expect, it, vi } from "vitest";
import type { CachePort } from "../CachePort.ts";
import { datasetCacheKey } from "../cacheKeys.ts";
import { JsonDatasetReader } from "../../json/JsonDatasetReader.ts";
import type { DataManifest } from "@/types/data.ts";
import type { DataWorkerPort } from "../../worker/WorkerDataProcessor.ts";

class VersionedMemoryCache implements CachePort {
  private readonly values = new Map<string, { value: unknown; version: string }>();

  async get<T>(key: string, version?: string): Promise<T | null> {
    const entry = this.values.get(key);
    if (!entry || (version !== undefined && entry.version !== version)) return null;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, version: string): Promise<void> {
    this.values.set(key, { value, version });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async clearVersion(version: string): Promise<void> {
    for (const [key, entry] of this.values) {
      if (entry.version === version) this.values.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.values.clear();
  }

  close(): void {}

  seed<T>(key: string, value: T, version: string): void {
    this.values.set(key, { value, version });
  }
}

const manifest = {
  version: "1.1.0",
  datasetVersion: "new-version",
  lastUpdated: 1,
  latestIngestionDate: "2026-08-02",
  totalEvents: 1,
  totalArtists: 0,
  totalVenues: 0,
  dateRange: { startEpochMs: 0, endEpochMs: 1, startDate: "2026-08-02", endDate: "2026-08-02" },
  chunks: {
    events: [{ filename: "events-2026-08.json", chunkId: "2026-08", size: 1, checksum: "test", eventCount: 1, dateRange: { startEpochMs: 0, endEpochMs: 1 } }],
    artists: { filename: "artists.json", size: 1, checksum: "test" },
    venues: { filename: "venues.json", size: 1, checksum: "test" },
    indexes: { filename: "indexes.json", size: 1, checksum: "test" },
  },
  processedAt: 1,
  sourceFiles: {},
  schemaVersion: "1",
} as unknown as DataManifest;

describe("worker/cache boundary", () => {
  it("uses stable dataset keys and treats a stale chunk as a miss", async () => {
    const cache = new VersionedMemoryCache();
    const requests: string[] = [];
    cache.seed(datasetCacheKey("manifest"), manifest, "manifest");
    cache.seed(datasetCacheKey("chunk:2026-08"), { stale: true }, "old-version");

    const reader = new JsonDatasetReader({
      cache,
      retryAttempts: 1,
      fetcher: async (request) => {
        requests.push(request.url);
        const body = request.url.endsWith("manifest.json")
          ? manifest
          : { chunkId: "2026-08", dateRange: { startEpochMs: 0, endEpochMs: 1 }, events: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });

    await reader.getEventChunk("2026-08");

    expect(requests).toEqual(["http://localhost:3000/data/events-2026-08.json"]);
    expect(datasetCacheKey("chunk:2026-08")).toBe("zivv:dataset:chunk:2026-08");
  });

  it("passes response parsing to the optional worker port without giving it I/O", async () => {
    const processor: DataWorkerPort = {
      parseJson: vi.fn(async (body: string) => JSON.parse(body)),
      filterEvents: vi.fn(),
      sortEvents: vi.fn(),
      buildSearchIndex: vi.fn(),
      calculateStats: vi.fn(),
      dispose: vi.fn(),
    };
    const reader = new JsonDatasetReader({
      cache: new VersionedMemoryCache(),
      processor,
      retryAttempts: 1,
      fetcher: async () => new Response(JSON.stringify(manifest), { status: 200 }),
    });

    await reader.getManifest();

    expect(processor.parseJson).toHaveBeenCalledWith(expect.any(String), "manifest");
    reader.close();
    expect(processor.dispose).toHaveBeenCalledOnce();
  });
});
