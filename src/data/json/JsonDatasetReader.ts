import type { DataIndexes, DataManifest } from "@/types/data.js";
import type { Artist, EventChunk, Venue } from "@/types/events.js";
import { createStaticReadRequest } from "@/privacy/requestPolicy.ts";
import { IndexedDbCacheAdapter } from "../cache/IndexedDbCacheAdapter.ts";
import type { CachePort } from "../cache/CachePort.ts";
import type { DatasetMetrics, DatasetReader, SearchDocumentRecord } from "../ports.ts";
import type { EventId } from "@/domain/identifiers.ts";

export interface JsonDatasetReaderOptions {
  readonly baseUrl?: string;
  readonly cache?: CachePort;
  readonly fetcher?: (request: Request) => Promise<Response>;
  readonly retryAttempts?: number;
  readonly retryDelayMs?: number;
}

type JsonFile = DataManifest | DataIndexes | Artist[] | Venue[] | EventChunk | SearchDocumentRecord[];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export class JsonDatasetReader implements DatasetReader {
  private readonly baseUrl: string;
  private readonly cache: CachePort;
  private readonly fetcher: (request: Request) => Promise<Response>;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private manifest: DataManifest | null = null;
  private indexes: DataIndexes | null = null;
  private readonly metrics: MutableMetrics = {
    cacheHits: 0,
    cacheMisses: 0,
    chunksLoaded: 0,
    bytesLoaded: 0,
    queryCount: 0,
    queryDurationMs: 0,
  };

  constructor(options: JsonDatasetReaderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/data").replace(/\/$/, "");
    this.cache = options.cache ?? new IndexedDbCacheAdapter({ dbName: "zivv-data-v5" });
    this.fetcher = options.fetcher ?? fetch;
    this.retryAttempts = options.retryAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 250;
  }

  async getManifest(): Promise<DataManifest> {
    if (this.manifest) return this.manifest;
    this.manifest = await this.readFile<DataManifest>("manifest.json", "manifest");
    return this.manifest;
  }

  async getIndexes(): Promise<DataIndexes> {
    if (this.indexes) return this.indexes;
    this.indexes = await this.readFile<DataIndexes>("indexes.json", "indexes");
    return this.indexes;
  }

  getArtists(): Promise<Artist[]> {
    return this.readFile<Artist[]>("artists.json", "artists");
  }

  getVenues(): Promise<Venue[]> {
    return this.readFile<Venue[]>("venues.json", "venues");
  }

  async getEventChunk(chunkId: string): Promise<EventChunk> {
    const manifest = await this.getManifest();
    const chunkInfo = manifest.chunks.events.find((chunk) => chunk.chunkId === chunkId);
    if (!chunkInfo) throw new Error(`Event chunk ${chunkId} is not present in the manifest`);
    return this.readFile<EventChunk>(chunkInfo.filename, `chunk:${chunkId}`, true);
  }

  getSearchDocuments(): Promise<SearchDocumentRecord[]> {
    return this.readFile<SearchDocumentRecord[]>("search-documents.json", "search-documents");
  }

  async getEventChunkForId(id: EventId): Promise<string | null> {
    const metadata = await this.getLocationMetadata();
    const explicit = metadata.eventIds?.[id];
    if (explicit) return explicit;

    const indexes = await this.getIndexes();
    for (const [date, ids] of Object.entries(indexes.eventsByDate)) {
      if (ids.some((candidate) => String(candidate) === id)) {
        return this.chunkForDate(date);
      }
    }
    return null;
  }

  async getEventChunkForSlug(slug: string): Promise<string | null> {
    const metadata = await this.getLocationMetadata();
    const explicit = metadata.eventSlugs?.[slug];
    if (explicit) return explicit;

    // Current generated slugs begin with YYYY-MM-DD. This is a deterministic
    // location lookup and avoids loading every month for a deep link.
    const datePrefix = /^(\d{4}-\d{2})-\d{2}/.exec(slug)?.[1];
    return datePrefix && (await this.getManifest()).chunks.events.some((chunk) => chunk.chunkId === datePrefix)
      ? datePrefix
      : null;
  }

  async findEventIds(text: string): Promise<readonly EventId[]> {
    const startedAt = Date.now();
    const normalized = text.trim().toLocaleLowerCase();
    if (!normalized) return [];

    const documents = await this.getSearchDocuments();
    const ids = documents
      .filter((document) => document.type === "event")
      .filter((document) => [document.title, document.content, document.city ?? "", ...(document.tags ?? [])]
        .join(" ").toLocaleLowerCase().includes(normalized))
      .map((document) => String(document.entityId) as EventId);

    this.recordQuery(startedAt);
    return ids;
  }

  getMetrics(): DatasetMetrics {
    return { ...this.metrics };
  }

  private async getLocationMetadata(): Promise<{ eventIds?: Record<string, string>; eventSlugs?: Record<string, string> }> {
    const manifest = await this.getManifest();
    const record = asRecord(manifest);
    const locations = asRecord(record.locations);
    return {
      ...(typeof locations.eventIds === "object" && locations.eventIds !== null ? { eventIds: locations.eventIds as Record<string, string> } : {}),
      ...(typeof locations.eventSlugs === "object" && locations.eventSlugs !== null ? { eventSlugs: locations.eventSlugs as Record<string, string> } : {}),
    };
  }

  private async readFile<T extends JsonFile>(filename: string, cacheKey: string, isChunk = false): Promise<T> {
    const manifest = filename === "manifest.json" ? null : await this.getManifest();
    const version = manifest?.datasetVersion ?? "manifest";
    const cached = await this.cache.get<T>(cacheKey);
    if (cached !== null) {
      this.metrics.cacheHits += 1;
      return cached;
    }
    this.metrics.cacheMisses += 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        const request = createStaticReadRequest(`${this.baseUrl}/${filename}`, {
          headers: { Accept: "application/json" },
        });
        const response = await this.fetcher(request);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const value = await response.json() as T;
        await this.cache.set(cacheKey, value, version);
        const bytes = JSON.stringify(value).length;
        this.metrics.bytesLoaded += bytes;
        if (isChunk) this.metrics.chunksLoaded += 1;
        return value;
      } catch (error) {
        lastError = error;
        if (attempt < this.retryAttempts) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to read ${filename}`);
  }

  private chunkForDate(date: string): string | null {
    const chunk = this.manifest?.chunks.events.find((candidate) => candidate.chunkId === date.slice(0, 7));
    return chunk?.chunkId ?? null;
  }

  private recordQuery(startedAt: number): void {
    this.metrics.queryCount += 1;
    this.metrics.queryDurationMs += Date.now() - startedAt;
  }
}

interface MutableMetrics {
  cacheHits: number;
  cacheMisses: number;
  chunksLoaded: number;
  bytesLoaded: number;
  queryCount: number;
  queryDurationMs: number;
}
