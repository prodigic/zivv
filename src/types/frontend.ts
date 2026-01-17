/**
 * Frontend-specific types for data loading, caching, and state management
 */

import type {
  Event,
  Artist,
  Venue,
  EventId,
  ArtistId,
  VenueId,
  EventFilters,
} from "./events.js";
import type {
  DataManifest,
  DataIndexes,
} from "./data.js";

// Loading states
export type LoadingState = "idle" | "loading" | "success" | "error";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
}

// Data service interfaces
export interface DataServiceConfig {
  baseUrl: string;
  cacheName: string;
  maxCacheSize: number; // in MB
  maxCacheAge: number; // in milliseconds
  retryAttempts: number;
  retryDelay: number;
}

export interface LoadChunkOptions {
  useCache?: boolean;
  priority?: "high" | "normal" | "low";
  signal?: AbortSignal;
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  size: number;
  version: string;
  checksum?: string;
}

export interface CacheStats {
  totalSize: number;
  entryCount: number;
  hitRate: number;
  lastCleanup: number;
}

// Search and filtering state
export interface SearchState {
  query: string;
  filters: EventFilters;
  results: EventId[];
  loading: boolean;
  error: string | null;
  totalResults: number;
  appliedAt: number;
}

export interface FilterState {
  cities: string[];
  dateRange: {
    startDate?: string; // ISO date
    endDate?: string; // ISO date
  };
  priceRange: {
    min?: number;
    max?: number;
  };
  ageRestrictions: string[];
  isFree?: boolean;
  tags: string[];
}

// UI state management
export interface ViewState {
  currentView: "list" | "calendar-month" | "calendar-week" | "calendar-agenda";
  selectedDate?: string; // ISO date
  selectedEvent?: EventId;
  scrollPosition: number;
  lastVisited: number;
}

export interface CalendarState {
  currentDate: Date;
  viewMode: "month" | "week" | "agenda";
  selectedDates: Set<string>; // ISO dates
  loadedMonths: Set<string>; // YYYY-MM format
  eventsVisible: boolean;
}

// Data chunk management
export interface ChunkMetadata {
  chunkId: string;
  size: number;
  eventCount: number;
  loadedAt: number;
  lastAccessed: number;
  priority: number; // for LRU eviction
}

export interface DataSnapshot {
  events: Map<EventId, Event>;
  artists: Map<ArtistId, Artist>;
  venues: Map<VenueId, Venue>;
  indexes: DataIndexes;
  manifest: DataManifest;
  loadedChunks: Map<string, ChunkMetadata>;
}

// Worker communication types
export type WorkerMessageType =
  | "PARSE_JSON"
  | "BUILD_SEARCH_INDEX"
  | "FILTER_EVENTS"
  | "SORT_EVENTS"
  | "CALCULATE_STATS";

export interface WorkerMessage<T = unknown> {
  id: string;
  type: WorkerMessageType;
  payload: T;
}

export interface WorkerResponse<T = unknown> {
  id: string;
  success: boolean;
  data?: T;
  error?: string;
  progress?: number;
}

export interface ParseJsonPayload {
  jsonString: string;
  expectedType: "events" | "artists" | "venues" | "indexes" | "manifest";
}

export interface FilterEventsPayload {
  events: Event[];
  filters: EventFilters;
  searchQuery?: string;
}

// Error types
export interface FrontendError extends Error {
  code: string;
  context?: Record<string, unknown>;
  recoverable: boolean;
}

export type DataErrorType =
  | "NETWORK_ERROR"
  | "PARSE_ERROR"
  | "CACHE_ERROR"
  | "VALIDATION_ERROR"
  | "QUOTA_EXCEEDED"
  | "TIMEOUT_ERROR";

export interface DataError {
  type: DataErrorType;
  message: string;
  details?: Record<string, unknown>;
  timestamp: number;
  retryable: boolean;
}

// Performance monitoring
export interface PerformanceMetrics {
  dataLoadTime: number;
  parseTime: number;
  renderTime: number;
  memoryUsage: number;
  cacheHitRate: number;
  errorRate: number;
}

export interface ChunkLoadMetrics {
  chunkId: string;
  loadTime: number;
  size: number;
  fromCache: boolean;
  parseTime?: number;
}

// Type guards
export interface TypeGuardResult<T> {
  isValid: boolean;
  data?: T;
  errors: string[];
}

// Utility types for frontend operations
export type EventsGroupedByDate = Map<string, Event[]>;
export type EventsGroupedByVenue = Map<VenueId, Event[]>;
export type EventsGroupedByArtist = Map<ArtistId, Event[]>;

export interface GroupedEvents {
  byDate: EventsGroupedByDate;
  byVenue: EventsGroupedByVenue;
  byArtist: EventsGroupedByArtist;
}

// Pagination
export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: PaginationState;
}

// Sorting options
export type SortField = "date" | "artist" | "venue" | "price" | "city";
export type SortOrder = "asc" | "desc";

export interface SortOptions {
  field: SortField;
  order: SortOrder;
}

// Calendar-specific types
export interface CalendarEvent {
  id: EventId;
  title: string;
  start: Date;
  end?: Date;
  allDay: boolean;
  backgroundColor?: string;
  borderColor?: string;
  textColor?: string;
  extendedProps: {
    event: Event;
    venue: Venue;
    artists: Artist[];
  };
}

export interface CalendarViewProps {
  events: CalendarEvent[];
  currentDate: Date;
  onDateSelect: (date: Date) => void;
  onEventClick: (eventId: EventId) => void;
  onViewChange: (view: string) => void;
}

// Export all types from base modules for convenience
export type {
  Event,
  Artist,
  Venue,
  EventId,
  ArtistId,
  VenueId,
  EventFilters,
  SearchQuery,
} from "./events.js";

export type {
  DataManifest,
  DataIndexes,
  DataLoadError,
} from "./data.js";

export type {
  ProcessingResult,
  ProcessingStats,
  ChunkInfo,
  FileInfo,
} from "./data.js";