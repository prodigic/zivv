import { WorkerService } from "@/services/WorkerService.ts";
import type { Event, Artist, Venue } from "@/types/events.ts";
import type { ParseJsonPayload, FilterEventsPayload } from "@/types/frontend.ts";

/**
 * CPU work that may be moved off the UI thread. It intentionally has no
 * network, cache, navigation, or user/session state responsibilities.
 */
export interface DataWorkerPort {
  parseJson<T>(jsonString: string, expectedType: ParseJsonPayload["expectedType"]): Promise<T>;
  filterEvents(
    events: Event[],
    filters: FilterEventsPayload["filters"],
    searchQuery?: string
  ): Promise<{ events: Event[]; totalCount: number }>;
  sortEvents(
    events: Event[],
    sortField: string,
    sortOrder: "asc" | "desc"
  ): Promise<{ events: Event[] }>;
  buildSearchIndex(
    events: Event[],
    artists: Artist[],
    venues: Venue[]
  ): Promise<{ documents: unknown[]; terms: string[]; totalDocuments: number }>;
  calculateStats(events: Event[]): Promise<Record<string, unknown>>;
  dispose(): void;
}

/** Adapter exposing the existing WorkerService behind a data-layer port. */
export class WorkerDataProcessor implements DataWorkerPort {
  private readonly service: WorkerService;

  constructor(service: WorkerService = new WorkerService()) {
    this.service = service;
  }

  parseJson<T>(jsonString: string, expectedType: ParseJsonPayload["expectedType"]): Promise<T> {
    return this.service.parseJson<T>(jsonString, expectedType);
  }

  filterEvents(
    events: Event[],
    filters: FilterEventsPayload["filters"],
    searchQuery?: string
  ): Promise<{ events: Event[]; totalCount: number }> {
    return this.service.filterEvents(events, filters, searchQuery);
  }

  sortEvents(events: Event[], sortField: string, sortOrder: "asc" | "desc"): Promise<{ events: Event[] }> {
    return this.service.sortEvents(events, sortField, sortOrder);
  }

  buildSearchIndex(
    events: Event[],
    artists: Artist[],
    venues: Venue[]
  ): Promise<{ documents: unknown[]; terms: string[]; totalDocuments: number }> {
    return this.service.buildSearchIndex(events, artists, venues);
  }

  calculateStats(events: Event[]): Promise<Record<string, unknown>> {
    return this.service.calculateStats(events);
  }

  dispose(): void {
    this.service.dispose();
  }
}
