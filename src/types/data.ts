import type {
  Event,
  Artist,
  Venue,
  EventId,
  ArtistId,
  VenueId,
} from "./events.js";

// Data manifest - describes the structure and metadata of processed data
export interface DataManifest {
  version: string; // e.g., "1.0.0"
  datasetVersion: string; // e.g., "2024-08-15T10:30:00Z"
  lastUpdated: number; // epoch milliseconds

  // Statistics
  totalEvents: number;
  totalArtists: number;
  totalVenues: number;

  // Date range covered
  dateRange: {
    startEpochMs: number;
    endEpochMs: number;
    startDate: string; // ISO date
    endDate: string; // ISO date
  };

  // File chunks and their metadata
  chunks: {
    events: ChunkInfo[];
    artists: FileInfo;
    venues: FileInfo;
    indexes: FileInfo;
  };

  // Processing metadata
  processedAt: number; // epoch milliseconds
  sourceFiles: {
    events: SourceFileInfo;
    venues: SourceFileInfo;
  };

  // Schema version for compatibility
  schemaVersion: string;
}

export interface ChunkInfo {
  filename: string; // e.g., "events-2024-08.json"
  chunkId: string; // e.g., "2024-08"
  size: number; // bytes
  checksum: string; // for integrity checking
  eventCount: number;
  dateRange: {
    startEpochMs: number;
    endEpochMs: number;
  };
}

export interface FileInfo {
  filename: string;
  size: number;
  checksum: string;
  recordCount?: number;
}

export interface SourceFileInfo {
  filename: string;
  size: number;
  lastModified: number;
  lineCount: number;
  checksum: string;
}

// Index structures for fast lookups and searches
export interface DataIndexes {
  // Primary lookups
  eventsByDate: Record<string, EventId[]>; // "2024-08-15" -> [event IDs]
  eventsByVenue: Record<VenueId, EventId[]>;
  eventsByArtist: Record<ArtistId, EventId[]>;
  eventsByCity: Record<string, EventId[]>;

  // Secondary indexes
  artistsByName: Record<string, ArtistId>; // normalized name -> ID
  venuesByName: Record<string, VenueId>; // normalized name -> ID
  venuesByCity: Record<string, VenueId[]>;

  // Aggregated data for UI
  cities: CityInfo[];
  ageRestrictions: string[];
  priceRanges: PriceRangeInfo;

  // Search index metadata
  searchIndex: SearchIndexInfo;
}

export interface CityInfo {
  name: string;
  slug: string;
  eventCount: number;
  venueCount: number;
  upcomingEventCount: number;
}

export interface PriceRangeInfo {
  min: number;
  max: number;
  buckets: {
    free: number;
    under20: number;
    under50: number;
    under100: number;
    over100: number;
  };
}

export interface SearchIndexInfo {
  indexedAt: number;
  totalDocuments: number;
  fields: string[];
  size: number; // bytes
}

// Full dataset for initial load
export interface Dataset {
  manifest: DataManifest;
  events: Record<string, Event[]>; // chunk ID -> events
  artists: Artist[];
  venues: Venue[];
  indexes: DataIndexes;
}

// Chunk loading types (EventChunk is defined in events.ts)
export interface LoadChunkRequest {
  chunkId: string;
  includeIndexes?: boolean;
}

export interface LoadChunkResponse {
  chunk: unknown; // EventChunk from events.ts
  indexes?: Partial<DataIndexes>;
}

// Error types for data loading
export interface DataLoadError {
  type: "network" | "parsing" | "validation" | "not-found";
  message: string;
  chunkId?: string;
  filename?: string;
  details?: Record<string, unknown>;
}

// Processing pipeline types
export interface ProcessingStats {
  sourceEvents: number;
  sourceVenues: number;

  parsedEvents: number;
  parsedVenues: number;
  parsedArtists: number;

  duplicateEventsRemoved: number;
  duplicateArtistsRemoved: number;
  duplicateVenuesRemoved: number;

  validationErrors: number;
  validationWarnings: number;

  processingTimeMs: number;

  chunks: {
    total: number;
    averageSize: number;
    largestSize: number;
  };
}

export interface ProcessingResult {
  success: boolean;
  manifest: DataManifest;
  stats: ProcessingStats;
  errors: ProcessingError[];
  warnings: ProcessingWarning[];
}

export interface ProcessingError {
  type: "critical" | "validation" | "data";
  message: string;
  sourceFile?: string;
  lineNumber?: number;
  rawData?: string;
}

export interface ProcessingWarning {
  type: "data-quality" | "format" | "performance";
  message: string;
  sourceFile?: string;
  lineNumber?: number;
  count?: number;
}
