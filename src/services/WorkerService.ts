/**
 * Service for managing Web Worker communication and operations
 * Provides a promise-based API for worker operations with fallbacks
 */

import type {
  WorkerMessage,
  WorkerResponse,
  ParseJsonPayload,
  FilterEventsPayload,
} from "@/types/frontend.js";
import type { Event, Artist, Venue } from "@/types/events.js";

export class WorkerService {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private requestIdCounter = 0;
  private isWorkerSupported = typeof Worker !== "undefined";

  constructor() {
    if (this.isWorkerSupported) {
      this.initializeWorker();
    }
  }

  /**
   * Initialize the Web Worker
   */
  private initializeWorker(): void {
    try {
      // Create worker from the data worker script
      this.worker = new Worker(
        new URL("../workers/dataWorker.ts", import.meta.url),
        { type: "module" }
      );

      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        this.handleWorkerMessage(e.data);
      };

      this.worker.onerror = (error) => {
        console.error("Worker error:", error);
        this.cleanup();
      };

    } catch (error) {
      console.warn("Failed to initialize worker, falling back to main thread:", error);
      this.worker = null;
    }
  }

  /**
   * Handle messages from the worker
   */
  private handleWorkerMessage(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.id);
    
    if (!pending) {
      console.warn("Received response for unknown request:", response.id);
      return;
    }

    // Clear timeout
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.success) {
      if (response.progress !== undefined) {
        // Progress update - don't resolve yet
        // Could emit progress events here
        return;
      }
      pending.resolve(response.data);
    } else {
      pending.reject(new Error(response.error || "Worker operation failed"));
    }
  }

  /**
   * Send a message to the worker with timeout handling
   */
  private async sendWorkerMessage<T>(
    message: Omit<WorkerMessage, "id">,
    timeoutMs = 30000
  ): Promise<T> {
    if (!this.worker) {
      throw new Error("Worker not available");
    }

    const id = `req-${++this.requestIdCounter}`;
    const fullMessage: WorkerMessage = { ...message, id };

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("Worker operation timed out"));
      }, timeoutMs);

      // Store pending request
      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });

      // Send message to worker
      this.worker!.postMessage(fullMessage);
    });
  }

  /**
   * Parse JSON data with validation
   */
  async parseJson<T>(
    jsonString: string,
    expectedType: "events" | "artists" | "venues" | "manifest" | "indexes"
  ): Promise<T> {
    if (!this.isWorkerSupported || !this.worker) {
      // Fallback to main thread parsing
      return this.parseJsonMainThread<T>(jsonString, expectedType);
    }

    try {
      const payload: ParseJsonPayload = { jsonString, expectedType };
      const result = await this.sendWorkerMessage<{ data: T }>({
        type: "PARSE_JSON",
        payload,
      });
      
      return result.data;
    } catch (error) {
      console.warn("Worker parsing failed, falling back to main thread:", error);
      return this.parseJsonMainThread<T>(jsonString, expectedType);
    }
  }

  /**
   * Filter events using worker
   */
  async filterEvents(
    events: Event[],
    filters: Record<string, unknown>,
    searchQuery?: string
  ): Promise<{ events: Event[]; totalCount: number }> {
    if (!this.isWorkerSupported || !this.worker) {
      // Fallback to main thread filtering
      return this.filterEventsMainThread(events, filters, searchQuery);
    }

    try {
      const payload: FilterEventsPayload = { events, filters, searchQuery };
      return await this.sendWorkerMessage({
        type: "FILTER_EVENTS",
        payload,
      });
    } catch (error) {
      console.warn("Worker filtering failed, falling back to main thread:", error);
      return this.filterEventsMainThread(events, filters, searchQuery);
    }
  }

  /**
   * Sort events using worker
   */
  async sortEvents(
    events: Event[],
    sortField: string,
    sortOrder: "asc" | "desc"
  ): Promise<{ events: Event[] }> {
    if (!this.isWorkerSupported || !this.worker) {
      // Fallback to main thread sorting
      return this.sortEventsMainThread(events, sortField, sortOrder);
    }

    try {
      const payload = { events, sortField, sortOrder };
      return await this.sendWorkerMessage({
        type: "SORT_EVENTS",
        payload,
      });
    } catch (error) {
      console.warn("Worker sorting failed, falling back to main thread:", error);
      return this.sortEventsMainThread(events, sortField, sortOrder);
    }
  }

  /**
   * Build search index using worker
   */
  async buildSearchIndex(
    events: Event[],
    artists: Artist[],
    venues: Venue[]
  ): Promise<{
    documents: unknown[];
    terms: string[];
    totalDocuments: number;
  }> {
    if (!this.isWorkerSupported || !this.worker) {
      // Fallback to main thread processing
      return this.buildSearchIndexMainThread(events, artists, venues);
    }

    try {
      const payload = { events, artists, venues };
      return await this.sendWorkerMessage({
        type: "BUILD_SEARCH_INDEX",
        payload,
      });
    } catch (error) {
      console.warn("Worker search index building failed, falling back to main thread:", error);
      return this.buildSearchIndexMainThread(events, artists, venues);
    }
  }

  /**
   * Calculate statistics using worker
   */
  async calculateStats(events: Event[]): Promise<Record<string, unknown>> {
    if (!this.isWorkerSupported || !this.worker) {
      // Fallback to main thread calculation
      return this.calculateStatsMainThread(events);
    }

    try {
      const payload = { events };
      return await this.sendWorkerMessage({
        type: "CALCULATE_STATS",
        payload,
      });
    } catch (error) {
      console.warn("Worker stats calculation failed, falling back to main thread:", error);
      return this.calculateStatsMainThread(events);
    }
  }

  /**
   * Fallback implementations for main thread
   */

  private parseJsonMainThread<T>(jsonString: string, _expectedType: string): T {
    try {
      const data = JSON.parse(jsonString);
      // Basic validation could be added here
      return data as T;
    } catch (error) {
      throw new Error(`JSON parsing failed: ${error}`);
    }
  }

  private filterEventsMainThread(
    events: Event[],
    filters: Record<string, unknown>,
    _searchQuery?: string
  ): { events: Event[]; totalCount: number } {
    // Simple filtering implementation
    let filtered = [...events];
    
    // Apply basic filters
    if (filters.isFree) {
      filtered = filtered.filter(event => event.isFree);
    }
    
    // Add more filter logic as needed
    
    return {
      events: filtered,
      totalCount: filtered.length,
    };
  }

  private sortEventsMainThread(
    events: Event[],
    sortField: string,
    sortOrder: "asc" | "desc"
  ): { events: Event[] } {
    const sorted = [...events].sort((a, b) => {
      let aValue: string | number;
      let bValue: string | number;
      
      switch (sortField) {
        case "date":
          aValue = a.dateEpochMs;
          bValue = b.dateEpochMs;
          break;
        case "price":
          aValue = a.isFree ? 0 : (a.priceMin || 0);
          bValue = b.isFree ? 0 : (b.priceMin || 0);
          break;
        default:
          return 0;
      }
      
      let comparison = 0;
      if (aValue < bValue) comparison = -1;
      else if (aValue > bValue) comparison = 1;
      
      return sortOrder === "desc" ? -comparison : comparison;
    });
    
    return { events: sorted };
  }

  private buildSearchIndexMainThread(
    _events: Event[],
    artists: Artist[],
    _venues: Venue[]
  ): { documents: unknown[]; terms: string[]; totalDocuments: number } {
    // Basic search index implementation
    const documents: unknown[] = [];
    const terms = new Set<string>();
    
    artists.forEach(artist => {
      documents.push({
        id: `artist-${artist.id}`,
        type: "artist",
        title: artist.name,
        content: artist.name,
        boost: 1.0,
      });
      
      // Extract terms
      artist.name.toLowerCase().split(/\s+/).forEach(term => {
        if (term.length > 2) terms.add(term);
      });
    });
    
    return {
      documents,
      terms: Array.from(terms).sort(),
      totalDocuments: documents.length,
    };
  }

  private calculateStatsMainThread(events: Event[]): Record<string, number> {
    const now = Date.now();
    const upcoming = events.filter(event => event.dateEpochMs > now);
    const past = events.filter(event => event.dateEpochMs <= now);
    
    return {
      totalEvents: events.length,
      upcomingEvents: upcoming.length,
      pastEvents: past.length,
      freeEvents: events.filter(event => event.isFree).length,
    };
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    // Reject all pending requests
    this.pendingRequests.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error("Worker terminated"));
    });
    this.pendingRequests.clear();

    // Terminate worker
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /**
   * Dispose of the service
   */
  dispose(): void {
    this.cleanup();
  }
}