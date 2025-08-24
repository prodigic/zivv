/**
 * Main data service for loading, caching, and managing application data
 * Handles chunked loading, caching, and provides a unified API for data access
 */

import type {
  Event,
  Artist,
  Venue,
  EventChunk,
  EventId,
  ArtistId,
  VenueId,
} from "@/types/events.js";
import type {
  DataManifest,
  DataIndexes,
} from "@/types/data.js";
import type {
  DataServiceConfig,
  LoadChunkOptions,
  AsyncState,
  DataError,
  ChunkMetadata,
  ChunkLoadMetrics,
} from "@/types/frontend.js";
import { CacheService } from "./CacheService.js";

export class DataService {
  private config: DataServiceConfig;
  private cache: CacheService;
  private loadedChunks = new Map<string, ChunkMetadata>();
  private manifest: DataManifest | null = null;
  private artists: Map<ArtistId, Artist> = new Map();
  private venues: Map<VenueId, Venue> = new Map();
  private events: Map<EventId, Event> = new Map();
  private indexes: DataIndexes | null = null;
  private abortControllers = new Map<string, AbortController>();

  constructor(config: Partial<DataServiceConfig> = {}) {
    this.config = {
      baseUrl: import.meta.env.DEV ? "/data" : "/zivv/data",
      cacheName: "zivv-data",
      maxCacheSize: 50 * 1024 * 1024, // 50MB
      maxCacheAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      retryAttempts: 3,
      retryDelay: 1000,
      ...config,
    };

    this.cache = new CacheService({
      dbName: this.config.cacheName,
      maxSize: this.config.maxCacheSize,
      maxAge: this.config.maxCacheAge,
    });
  }

  /**
   * Initialize the data service
   */
  async initialize(): Promise<void> {
    await this.cache.initialize();
    
    // Load manifest first to check data version
    await this.loadManifest();
    
    // Load core data (artists, venues, indexes)
    await Promise.all([
      this.loadArtists(),
      this.loadVenues(), 
      this.loadIndexes(),
    ]);
  }

  /**
   * Load the data manifest
   */
  async loadManifest(): Promise<DataManifest> {
    const cacheKey = "manifest";
    
    // Always load from network first to check for version changes
    const networkManifest = await this.fetchWithRetry<DataManifest>(
      `${this.config.baseUrl}/manifest.json`
    );

    // Check if we have cached data and if versions match
    const cached = await this.cache.get<DataManifest>(cacheKey);
    
    if (cached && cached.datasetVersion !== networkManifest.datasetVersion) {
      console.log(`🔄 Dataset version changed: ${cached.datasetVersion} → ${networkManifest.datasetVersion}`);
      // Clear old version from cache
      await this.cache.clearVersion(cached.datasetVersion);
      // Clear in-memory data
      this.artists.clear();
      this.venues.clear();
      this.events.clear();
      this.indexes = null;
      this.loadedChunks.clear();
    }

    // Cache the new manifest
    await this.cache.set(cacheKey, networkManifest, networkManifest.datasetVersion);
    
    this.manifest = networkManifest;
    return networkManifest;
  }

  /**
   * Load all artists
   */
  async loadArtists(): Promise<Artist[]> {
    if (this.artists.size > 0) {
      return Array.from(this.artists.values());
    }

    const cacheKey = "artists";
    const manifest = await this.loadManifest();
    
    // Try cache first
    const cached = await this.cache.get<Artist[]>(cacheKey);
    if (cached) {
      cached.forEach(artist => this.artists.set(artist.id, artist));
      return cached;
    }

    // Load from network
    const artists = await this.fetchWithRetry<Artist[]>(
      `${this.config.baseUrl}/artists.json`
    );

    // Cache and store
    await this.cache.set(cacheKey, artists, manifest.datasetVersion);
    artists.forEach(artist => this.artists.set(artist.id, artist));
    
    return artists;
  }

  /**
   * Load all venues
   */
  async loadVenues(): Promise<Venue[]> {
    if (this.venues.size > 0) {
      return Array.from(this.venues.values());
    }

    const cacheKey = "venues";
    const manifest = await this.loadManifest();
    
    // Try cache first
    const cached = await this.cache.get<Venue[]>(cacheKey);
    if (cached) {
      cached.forEach(venue => this.venues.set(venue.id, venue));
      return cached;
    }

    // Load from network
    const venues = await this.fetchWithRetry<Venue[]>(
      `${this.config.baseUrl}/venues.json`
    );

    // Cache and store
    await this.cache.set(cacheKey, venues, manifest.datasetVersion);
    venues.forEach(venue => this.venues.set(venue.id, venue));
    
    return venues;
  }

  /**
   * Load search indexes
   */
  async loadIndexes(): Promise<DataIndexes> {
    if (this.indexes) {
      return this.indexes;
    }

    const cacheKey = "indexes";
    const manifest = await this.loadManifest();
    
    // Try cache first
    const cached = await this.cache.get<DataIndexes>(cacheKey);
    if (cached) {
      this.indexes = cached;
      return cached;
    }

    // Load from network
    const indexes = await this.fetchWithRetry<DataIndexes>(
      `${this.config.baseUrl}/indexes.json`
    );

    // Cache and store
    await this.cache.set(cacheKey, indexes, manifest.datasetVersion);
    this.indexes = indexes;
    
    return indexes;
  }

  /**
   * Load a specific event chunk
   */
  async loadChunk(
    chunkId: string,
    options: LoadChunkOptions = {}
  ): Promise<Event[]> {
    const {
      useCache = true,
      priority = "normal",
      signal,
    } = options;

    // Check if already loaded in memory
    if (this.loadedChunks.has(chunkId)) {
      const chunk = this.getEventsForChunk(chunkId);
      this.updateChunkAccess(chunkId);
      return chunk;
    }

    const cacheKey = `chunk-${chunkId}`;
    const startTime = Date.now();
    let fromCache = false;
    
    try {
      const manifest = await this.loadManifest();
      
      // Try cache first if enabled
      let chunkData: EventChunk | null = null;
      if (useCache) {
        chunkData = await this.cache.get<EventChunk>(cacheKey);
        if (chunkData) {
          fromCache = true;
        }
      }

      // Load from network if not in cache
      if (!chunkData) {
        chunkData = await this.fetchWithRetry<EventChunk>(
          `${this.config.baseUrl}/events-${chunkId}.json`,
          { signal }
        );

        // Cache the chunk
        if (useCache) {
          await this.cache.set(cacheKey, chunkData, manifest.datasetVersion);
        }
      }

      // Store events in memory
      const events = chunkData.events;
      events.forEach(event => this.events.set(event.id, event));

      // Track chunk metadata
      const metadata: ChunkMetadata = {
        chunkId,
        size: JSON.stringify(chunkData).length,
        eventCount: events.length,
        loadedAt: Date.now(),
        lastAccessed: Date.now(),
        priority: this.getPriorityValue(priority),
      };
      this.loadedChunks.set(chunkId, metadata);

      // Record metrics
      const metrics: ChunkLoadMetrics = {
        chunkId,
        loadTime: Date.now() - startTime,
        size: metadata.size,
        fromCache,
      };
      this.recordMetrics(metrics);

      return events;

    } catch (error) {
      throw this.createDataError(
        "NETWORK_ERROR",
        `Failed to load chunk ${chunkId}`,
        { chunkId, error }
      );
    }
  }

  /**
   * Get events for a specific month
   */
  async getEventsForMonth(yearMonth: string): Promise<Event[]> {
    return this.loadChunk(yearMonth);
  }

  /**
   * Get events by date range
   */
  async getEventsByDateRange(
    startDate: string,
    endDate: string
  ): Promise<Event[]> {
    const indexes = await this.loadIndexes();
    const eventIds: EventId[] = [];

    // Find all dates in range and collect event IDs
    for (const [date, ids] of Object.entries(indexes.eventsByDate)) {
      if (date >= startDate && date <= endDate) {
        eventIds.push(...ids);
      }
    }

    // Load required chunks and return events
    const chunks = this.getChunksForEventIds(eventIds);
    await Promise.all(chunks.map(chunkId => this.loadChunk(chunkId)));

    return eventIds
      .map(id => this.events.get(id))
      .filter((event): event is Event => event !== undefined);
  }

  /**
   * Get a specific event by ID
   */
  async getEvent(eventId: EventId): Promise<Event | null> {
    // Check if already in memory
    const event = this.events.get(eventId);
    if (event) {
      return event;
    }

    // Find which chunk contains this event
    const indexes = await this.loadIndexes();
    const chunkId = this.findChunkForEvent(eventId);
    
    if (!chunkId) {
      return null;
    }

    // Load the chunk
    await this.loadChunk(chunkId);
    return this.events.get(eventId) || null;
  }

  /**
   * Get artist by ID
   */
  getArtist(artistId: ArtistId): Artist | null {
    return this.artists.get(artistId) || null;
  }

  /**
   * Get venue by ID
   */
  getVenue(venueId: VenueId): Venue | null {
    return this.venues.get(venueId) || null;
  }

  /**
   * Search events by artist or venue name
   */
  async searchEvents(query: string): Promise<Event[]> {
    const indexes = await this.loadIndexes();
    const normalizedQuery = query.toLowerCase().trim();
    
    if (!normalizedQuery) {
      return [];
    }

    const matchingEventIds = new Set<EventId>();

    // Search artist names
    for (const [name, artistId] of Object.entries(indexes.artistsByName)) {
      if (name.includes(normalizedQuery)) {
        const eventIds = indexes.eventsByArtist[artistId] || [];
        eventIds.forEach(id => matchingEventIds.add(id));
      }
    }

    // Search venue names
    for (const [name, venueId] of Object.entries(indexes.venuesByName)) {
      if (name.includes(normalizedQuery)) {
        const eventIds = indexes.eventsByVenue[venueId] || [];
        eventIds.forEach(id => matchingEventIds.add(id));
      }
    }

    // Load required chunks
    const chunks = this.getChunksForEventIds(Array.from(matchingEventIds));
    await Promise.all(chunks.map(chunkId => this.loadChunk(chunkId)));

    // Return matching events
    return Array.from(matchingEventIds)
      .map(id => this.events.get(id))
      .filter((event): event is Event => event !== undefined);
  }

  /**
   * Refresh data by clearing cache and reloading
   */
  async refresh(): Promise<void> {
    // Clear cache for current version before clearing manifest
    if (this.manifest) {
      await this.cache.clearVersion(this.manifest.datasetVersion);
    }
    
    // Clear current data
    this.manifest = null;
    this.artists.clear();
    this.venues.clear();
    this.events.clear();
    this.indexes = null;
    this.loadedChunks.clear();

    // Reload core data
    await this.initialize();
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Cleanup old cache entries
   */
  async cleanupCache(): Promise<void> {
    await this.cache.cleanup();
  }

  /**
   * Get memory usage statistics
   */
  getMemoryStats() {
    return {
      loadedChunks: this.loadedChunks.size,
      eventsInMemory: this.events.size,
      artistsInMemory: this.artists.size,
      venuesInMemory: this.venues.size,
      estimatedSize: this.calculateEstimatedMemorySize(),
    };
  }

  /**
   * Unload a specific chunk from memory
   */
  unloadChunk(chunkId: string): void {
    const metadata = this.loadedChunks.get(chunkId);
    if (!metadata) {
      return;
    }

    // Remove events from this chunk
    const chunkEvents = this.getEventsForChunk(chunkId);
    chunkEvents.forEach(event => this.events.delete(event.id));

    // Remove chunk metadata
    this.loadedChunks.delete(chunkId);
  }

  /**
   * Private helper methods
   */

  private async fetchWithRetry<T>(
    url: string,
    options: RequestInit = {}
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            'Accept': 'application/json',
            ...options.headers,
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json() as T;

      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on abort
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }

        // Wait before retry (except on last attempt)
        if (attempt < this.config.retryAttempts) {
          await new Promise(resolve => 
            setTimeout(resolve, this.config.retryDelay * attempt)
          );
        }
      }
    }

    throw lastError;
  }

  private getEventsForChunk(chunkId: string): Event[] {
    return Array.from(this.events.values()).filter(event => {
      const eventDate = new Date(event.dateEpochMs);
      const eventChunkId = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}`;
      return eventChunkId === chunkId;
    });
  }

  private getChunksForEventIds(eventIds: EventId[]): string[] {
    const chunks = new Set<string>();
    
    for (const eventId of eventIds) {
      const event = this.events.get(eventId);
      if (event) {
        const eventDate = new Date(event.dateEpochMs);
        const chunkId = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}`;
        chunks.add(chunkId);
      }
    }

    return Array.from(chunks);
  }

  private findChunkForEvent(eventId: EventId): string | null {
    // This would need to be implemented based on the manifest
    // For now, return null - would need to enhance manifest with event->chunk mapping
    return null;
  }

  private updateChunkAccess(chunkId: string): void {
    const metadata = this.loadedChunks.get(chunkId);
    if (metadata) {
      metadata.lastAccessed = Date.now();
    }
  }

  private getPriorityValue(priority: "high" | "normal" | "low"): number {
    switch (priority) {
      case "high": return 3;
      case "normal": return 2;
      case "low": return 1;
      default: return 2;
    }
  }

  private calculateEstimatedMemorySize(): number {
    // Rough estimate of memory usage
    const eventSize = 1000; // Average bytes per event
    const artistSize = 200; // Average bytes per artist
    const venueSize = 300; // Average bytes per venue

    return (
      this.events.size * eventSize +
      this.artists.size * artistSize +
      this.venues.size * venueSize
    );
  }

  private recordMetrics(metrics: ChunkLoadMetrics): void {
    // Store metrics for monitoring - could be enhanced with analytics
    console.debug('Chunk load metrics:', metrics);
  }

  private createDataError(
    type: "NETWORK_ERROR" | "PARSE_ERROR" | "CACHE_ERROR",
    message: string,
    details?: Record<string, unknown>
  ): DataError {
    return {
      type,
      message,
      details,
      timestamp: Date.now(),
      retryable: type === "NETWORK_ERROR",
    };
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    // Cancel any pending requests
    this.abortControllers.forEach(controller => controller.abort());
    this.abortControllers.clear();

    // Clear data
    this.events.clear();
    this.artists.clear();
    this.venues.clear();
    this.loadedChunks.clear();

    // Close cache
    this.cache.close();
  }
}