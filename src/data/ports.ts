import type { DataIndexes, DataManifest } from "@/types/data.js";
import type { Artist as LegacyArtist, EventChunk, Event as LegacyEvent, Venue as LegacyVenue } from "@/types/events.js";
import type { CachePort } from "./cache/CachePort.ts";
import type { EventId } from "@/domain/identifiers.ts";

export interface SearchDocumentRecord {
  readonly id: number;
  readonly type: "event" | "artist" | "venue";
  readonly entityId: string;
  readonly title: string;
  readonly content: string;
  readonly city?: string;
  readonly date?: string;
  readonly tags?: readonly string[];
}

export interface DatasetMetrics {
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly chunksLoaded: number;
  readonly bytesLoaded: number;
  readonly queryCount: number;
  readonly queryDurationMs: number;
}

export interface DatasetReader {
  getManifest(): Promise<DataManifest>;
  getIndexes(): Promise<DataIndexes>;
  getArtists(): Promise<LegacyArtist[]>;
  getVenues(): Promise<LegacyVenue[]>;
  getEventChunk(chunkId: string): Promise<EventChunk>;
  getSearchDocuments(): Promise<SearchDocumentRecord[]>;
  getEventChunkForId(id: EventId): Promise<string | null>;
  getEventChunkForSlug(slug: string): Promise<string | null>;
  findEventIds(text: string): Promise<readonly EventId[]>;
  getMetrics(): DatasetMetrics;
}

/** Optional metadata accepted by a future manifest without changing filenames. */
export interface DatasetLocationMetadata {
  eventIds?: Record<string, string>;
  eventSlugs?: Record<string, string>;
}

export type { CachePort, DataIndexes, DataManifest, EventChunk, LegacyArtist, LegacyEvent, LegacyVenue };
