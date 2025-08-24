/**
 * Web Worker for data processing operations
 * Handles JSON parsing, filtering, sorting, and search index building off the main thread
 */

import type {
  Event,
  Artist,
  Venue,
  EventFilters,
  EventId,
} from "@/types/events.js";
import type {
  WorkerMessage,
  WorkerResponse,
  ParseJsonPayload,
  FilterEventsPayload,
} from "@/types/frontend.js";

// Import type guards for validation
import {
  validateEventArray,
  validateArtistArray,
  validateVenueArray,
  validateManifest,
  validateEventChunk,
} from "../utils/typeGuards.js";

/**
 * Main worker message handler
 */
self.onmessage = function(e: MessageEvent<WorkerMessage>) {
  const { id, type, payload } = e.data;

  try {
    switch (type) {
      case "PARSE_JSON":
        handleParseJson(id, payload as ParseJsonPayload);
        break;
      
      case "FILTER_EVENTS":
        handleFilterEvents(id, payload as FilterEventsPayload);
        break;
      
      case "SORT_EVENTS":
        handleSortEvents(id, payload as { events: Event[]; sortField: string; sortOrder: string });
        break;
      
      case "BUILD_SEARCH_INDEX":
        handleBuildSearchIndex(id, payload as { events: Event[]; artists: Artist[]; venues: Venue[] });
        break;
      
      case "CALCULATE_STATS":
        handleCalculateStats(id, payload as { events: Event[] });
        break;
      
      default:
        sendError(id, `Unknown message type: ${type}`);
    }
  } catch (error) {
    sendError(id, `Worker error: ${error}`);
  }
};

/**
 * Parse and validate JSON data
 */
function handleParseJson(id: string, payload: ParseJsonPayload) {
  const { jsonString, expectedType } = payload;
  
  try {
    // Parse JSON
    const rawData = JSON.parse(jsonString);
    
    // Validate based on expected type
    let validationResult;
    
    switch (expectedType) {
      case "events":
        if (Array.isArray(rawData)) {
          validationResult = validateEventArray(rawData);
        } else {
          // Could be an event chunk
          validationResult = validateEventChunk(rawData);
        }
        break;
      
      case "artists":
        validationResult = validateArtistArray(rawData);
        break;
      
      case "venues":
        validationResult = validateVenueArray(rawData);
        break;
      
      case "manifest":
        validationResult = validateManifest(rawData);
        break;
      
      case "indexes":
        // For indexes, we'll do basic object validation
        validationResult = {
          isValid: typeof rawData === "object" && rawData !== null,
          data: rawData,
          errors: typeof rawData === "object" && rawData !== null ? [] : ["Indexes must be an object"],
        };
        break;
      
      default:
        throw new Error(`Unsupported data type: ${expectedType}`);
    }
    
    if (validationResult.isValid) {
      sendSuccess(id, {
        data: validationResult.data,
        type: expectedType,
        size: jsonString.length,
      });
    } else {
      sendError(id, `Validation failed: ${validationResult.errors.join(", ")}`);
    }
    
  } catch (error) {
    sendError(id, `JSON parsing failed: ${error}`);
  }
}

/**
 * Filter events based on criteria
 */
function handleFilterEvents(id: string, payload: FilterEventsPayload) {
  const { events, filters, searchQuery } = payload;
  
  try {
    let filteredEvents = [...events];
    
    // Apply city filter
    if (filters.cities && filters.cities.length > 0) {
      filteredEvents = filteredEvents.filter(event =>
        filters.cities!.some(city => 
          event.venueId && getVenueCity(event.venueId) === city
        )
      );
    }
    
    // Apply date range filter
    if (filters.dateRange?.startDate || filters.dateRange?.endDate) {
      filteredEvents = filteredEvents.filter(event => {
        const eventDate = new Date(event.dateEpochMs).toISOString().split('T')[0];
        
        if (filters.dateRange?.startDate && eventDate < filters.dateRange.startDate) {
          return false;
        }
        
        if (filters.dateRange?.endDate && eventDate > filters.dateRange.endDate) {
          return false;
        }
        
        return true;
      });
    }
    
    // Apply price range filter
    if (filters.priceRange?.min !== undefined || filters.priceRange?.max !== undefined) {
      filteredEvents = filteredEvents.filter(event => {
        if (event.isFree) {
          return filters.priceRange?.min === undefined || filters.priceRange.min <= 0;
        }
        
        const price = event.priceMin || 0;
        
        if (filters.priceRange?.min !== undefined && price < filters.priceRange.min) {
          return false;
        }
        
        if (filters.priceRange?.max !== undefined && price > filters.priceRange.max) {
          return false;
        }
        
        return true;
      });
    }
    
    // Apply free events filter
    if (filters.isFree === true) {
      filteredEvents = filteredEvents.filter(event => event.isFree);
    }
    
    // Apply age restrictions filter
    if (filters.ageRestrictions && filters.ageRestrictions.length > 0) {
      filteredEvents = filteredEvents.filter(event =>
        filters.ageRestrictions!.includes(event.ageRestriction)
      );
    }
    
    // Apply tags filter
    if (filters.tags && filters.tags.length > 0) {
      filteredEvents = filteredEvents.filter(event =>
        filters.tags!.some(tag => event.tags?.includes(tag))
      );
    }
    
    // Apply text search if provided
    if (searchQuery && searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filteredEvents = filteredEvents.filter(event => {
        // Search in artist names (would need artist data)
        // For now, search in available event data
        const searchableText = [
          // Would add artist names here if available
        ].join(" ").toLowerCase();
        
        return searchableText.includes(query);
      });
    }
    
    sendSuccess(id, {
      events: filteredEvents,
      totalCount: filteredEvents.length,
      originalCount: events.length,
    });
    
  } catch (error) {
    sendError(id, `Filtering failed: ${error}`);
  }
}

/**
 * Sort events by specified field and order
 */
function handleSortEvents(id: string, payload: { events: Event[]; sortField: string; sortOrder: string }) {
  const { events, sortField, sortOrder } = payload;
  
  try {
    const sortedEvents = [...events].sort((a, b) => {
      let aValue: string | number | Date;
      let bValue: string | number | Date;
      
      switch (sortField) {
        case "date":
          aValue = a.dateEpochMs;
          bValue = b.dateEpochMs;
          break;
        
        case "price":
          aValue = a.isFree ? 0 : (a.priceMin || 0);
          bValue = b.isFree ? 0 : (b.priceMin || 0);
          break;
        
        case "artist":
          // Would need artist data to sort by artist name
          aValue = a.headlinerArtistId;
          bValue = b.headlinerArtistId;
          break;
        
        case "venue":
          // Would need venue data to sort by venue name
          aValue = a.venueId;
          bValue = b.venueId;
          break;
        
        default:
          throw new Error(`Unsupported sort field: ${sortField}`);
      }
      
      let comparison = 0;
      if (aValue < bValue) comparison = -1;
      else if (aValue > bValue) comparison = 1;
      
      return sortOrder === "desc" ? -comparison : comparison;
    });
    
    sendSuccess(id, {
      events: sortedEvents,
      sortField,
      sortOrder,
    });
    
  } catch (error) {
    sendError(id, `Sorting failed: ${error}`);
  }
}

/**
 * Build search index from entities
 */
function handleBuildSearchIndex(id: string, payload: { events: Event[]; artists: Artist[]; venues: Venue[] }) {
  const { events, artists, venues } = payload;
  
  try {
    const searchDocuments: Array<{
      id: string;
      type: "event" | "artist" | "venue";
      title: string;
      content: string;
      boost: number;
    }> = [];
    
    // Index artists
    artists.forEach(artist => {
      const aliases = artist.aliases?.join(" ") || "";
      searchDocuments.push({
        id: `artist-${artist.id}`,
        type: "artist",
        title: artist.name,
        content: `${artist.name} ${artist.normalizedName} ${aliases}`,
        boost: artist.upcomingEventCount > 0 ? 1.5 : 1.0,
      });
    });
    
    // Index venues
    venues.forEach(venue => {
      searchDocuments.push({
        id: `venue-${venue.id}`,
        type: "venue",
        title: venue.name,
        content: `${venue.name} ${venue.normalizedName} ${venue.city} ${venue.neighborhood || ""}`,
        boost: venue.upcomingEventCount > 0 ? 1.3 : 1.0,
      });
    });
    
    // Index events (basic - would be enhanced with artist/venue names)
    events.forEach(event => {
      searchDocuments.push({
        id: `event-${event.id}`,
        type: "event",
        title: `Event ${event.id}`,
        content: `${event.description || ""} ${event.notes || ""}`,
        boost: event.dateEpochMs > Date.now() ? 1.2 : 0.8, // Boost future events
      });
    });
    
    // Extract search terms for autocomplete
    const terms = new Set<string>();
    
    searchDocuments.forEach(doc => {
      const words = doc.content
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(word => word.length > 2);
      
      words.forEach(word => terms.add(word));
    });
    
    sendSuccess(id, {
      documents: searchDocuments,
      terms: Array.from(terms).sort(),
      totalDocuments: searchDocuments.length,
    });
    
  } catch (error) {
    sendError(id, `Search index building failed: ${error}`);
  }
}

/**
 * Calculate statistics from events data
 */
function handleCalculateStats(id: string, payload: { events: Event[] }) {
  const { events } = payload;
  
  try {
    const now = Date.now();
    const upcomingEvents = events.filter(event => event.dateEpochMs > now);
    const pastEvents = events.filter(event => event.dateEpochMs <= now);
    
    // City statistics
    const cityCounts = new Map<string, number>();
    const venueIds = new Set<number>();
    const artistIds = new Set<number>();
    
    events.forEach(event => {
      // Count venues and artists
      venueIds.add(event.venueId);
      event.artistIds.forEach(artistId => artistIds.add(artistId));
    });
    
    // Price statistics
    const pricedEvents = events.filter(event => !event.isFree && event.priceMin);
    const prices = pricedEvents.map(event => event.priceMin!);
    
    const priceStats = prices.length > 0 ? {
      min: Math.min(...prices),
      max: Math.max(...prices),
      average: prices.reduce((sum, price) => sum + price, 0) / prices.length,
      median: calculateMedian(prices),
    } : null;
    
    // Age restriction distribution
    const ageRestrictionCounts = new Map<string, number>();
    events.forEach(event => {
      const count = ageRestrictionCounts.get(event.ageRestriction) || 0;
      ageRestrictionCounts.set(event.ageRestriction, count + 1);
    });
    
    // Date range
    const eventDates = events.map(event => event.dateEpochMs).sort();
    const dateRange = eventDates.length > 0 ? {
      start: eventDates[0],
      end: eventDates[eventDates.length - 1],
    } : null;
    
    sendSuccess(id, {
      totalEvents: events.length,
      upcomingEvents: upcomingEvents.length,
      pastEvents: pastEvents.length,
      uniqueVenues: venueIds.size,
      uniqueArtists: artistIds.size,
      freeEvents: events.filter(event => event.isFree).length,
      priceStats,
      ageRestrictionDistribution: Object.fromEntries(ageRestrictionCounts),
      dateRange,
    });
    
  } catch (error) {
    sendError(id, `Statistics calculation failed: ${error}`);
  }
}

/**
 * Utility functions
 */

function calculateMedian(numbers: number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function getVenueCity(venueId: number): string {
  // This would need venue data to be passed to the worker
  // For now, return empty string
  return "";
}

function sendSuccess<T>(id: string, data: T): void {
  const response: WorkerResponse<T> = {
    id,
    success: true,
    data,
  };
  
  self.postMessage(response);
}

function sendError(id: string, error: string): void {
  const response: WorkerResponse = {
    id,
    success: false,
    error,
  };
  
  self.postMessage(response);
}

function sendProgress(id: string, progress: number): void {
  const response: WorkerResponse = {
    id,
    success: true,
    progress,
  };
  
  self.postMessage(response);
}

export {}; // Make this a module