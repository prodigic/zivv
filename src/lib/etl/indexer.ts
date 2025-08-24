import type {
  Event,
  Artist,
  Venue,
  EventId,
  ArtistId,
  VenueId,
  EventChunk,
} from "@/types/events.js";
import type {
  DataIndexes,
  CityInfo,
  PriceRangeInfo,
  SearchIndexInfo,
  ChunkInfo,
} from "@/types/data.js";
import { StringNormalizer } from "./utils.js";

export class DataIndexer {
  /**
   * Build all indexes for efficient data access
   */
  static buildIndexes(
    events: Event[],
    artists: Artist[],
    venues: Venue[]
  ): DataIndexes {
    const eventsByDate: Record<string, EventId[]> = {};
    const eventsByVenue: Record<VenueId, EventId[]> = {};
    const eventsByArtist: Record<ArtistId, EventId[]> = {};
    const eventsByCity: Record<string, EventId[]> = {};

    // Build primary indexes
    for (const event of events) {
      // By date
      if (!eventsByDate[event.date]) {
        eventsByDate[event.date] = [];
      }
      eventsByDate[event.date].push(event.id);

      // By venue
      if (!eventsByVenue[event.venueId]) {
        eventsByVenue[event.venueId] = [];
      }
      eventsByVenue[event.venueId].push(event.id);

      // By artists
      for (const artistId of event.artistIds) {
        if (!eventsByArtist[artistId]) {
          eventsByArtist[artistId] = [];
        }
        eventsByArtist[artistId].push(event.id);
      }

      // By city (need to look up venue)
      const venue = venues.find((v) => v.id === event.venueId);
      if (venue) {
        if (!eventsByCity[venue.city]) {
          eventsByCity[venue.city] = [];
        }
        eventsByCity[venue.city].push(event.id);
      }
    }

    // Build secondary indexes
    const artistsByName: Record<string, ArtistId> = {};
    for (const artist of artists) {
      artistsByName[artist.normalizedName] = artist.id;
    }

    const venuesByName: Record<string, VenueId> = {};
    const venuesByCity: Record<string, VenueId[]> = {};
    for (const venue of venues) {
      venuesByName[venue.normalizedName] = venue.id;

      if (!venuesByCity[venue.city]) {
        venuesByCity[venue.city] = [];
      }
      venuesByCity[venue.city].push(venue.id);
    }

    // Build aggregated data
    const cities = this.buildCityInfo(events, venues);
    const ageRestrictions = this.extractAgeRestrictions(events);
    const priceRanges = this.buildPriceRangeInfo(events);
    const searchIndex = this.buildSearchIndexInfo(events, artists, venues);

    return {
      eventsByDate,
      eventsByVenue,
      eventsByArtist,
      eventsByCity,
      artistsByName,
      venuesByName,
      venuesByCity,
      cities,
      ageRestrictions,
      priceRanges,
      searchIndex,
    };
  }

  private static buildCityInfo(events: Event[], venues: Venue[]): CityInfo[] {
    const cityStats: Record<
      string,
      {
        eventCount: number;
        venueCount: number;
        upcomingEventCount: number;
      }
    > = {};

    // Count venues per city
    for (const venue of venues) {
      if (!cityStats[venue.city]) {
        cityStats[venue.city] = {
          eventCount: 0,
          venueCount: 0,
          upcomingEventCount: 0,
        };
      }
      cityStats[venue.city].venueCount++;
    }

    // Count events per city
    const now = Date.now();
    for (const event of events) {
      const venue = venues.find((v) => v.id === event.venueId);
      if (!venue) continue;

      if (!cityStats[venue.city]) {
        cityStats[venue.city] = {
          eventCount: 0,
          venueCount: 0,
          upcomingEventCount: 0,
        };
      }

      cityStats[venue.city].eventCount++;

      if (event.dateEpochMs > now) {
        cityStats[venue.city].upcomingEventCount++;
      }
    }

    return Object.entries(cityStats)
      .map(([city, stats]) => ({
        name: city,
        slug: StringNormalizer.createSlug(city),
        ...stats,
      }))
      .sort((a, b) => b.eventCount - a.eventCount);
  }

  private static extractAgeRestrictions(events: Event[]): string[] {
    const restrictions = new Set<string>();
    for (const event of events) {
      restrictions.add(event.ageRestriction);
    }
    return Array.from(restrictions).sort();
  }

  private static buildPriceRangeInfo(events: Event[]): PriceRangeInfo {
    const prices: number[] = [];
    let free = 0;

    for (const event of events) {
      if (event.isFree) {
        free++;
      } else {
        if (event.priceMin !== undefined) prices.push(event.priceMin);
        if (event.priceMax !== undefined) prices.push(event.priceMax);
      }
    }

    if (prices.length === 0) {
      return {
        min: 0,
        max: 0,
        buckets: { free, under20: 0, under50: 0, under100: 0, over100: 0 },
      };
    }

    const min = Math.min(...prices);
    const max = Math.max(...prices);

    const buckets = {
      free,
      under20: prices.filter((p) => p > 0 && p < 20).length,
      under50: prices.filter((p) => p >= 20 && p < 50).length,
      under100: prices.filter((p) => p >= 50 && p < 100).length,
      over100: prices.filter((p) => p >= 100).length,
    };

    return { min, max, buckets };
  }

  private static buildSearchIndexInfo(
    events: Event[],
    artists: Artist[],
    venues: Venue[]
  ): SearchIndexInfo {
    const totalDocuments = events.length + artists.length + venues.length;
    const fields = ["name", "description", "city", "tags"];

    // Rough estimate of index size (will be more accurate after actual indexing)
    const estimatedSize = totalDocuments * 200; // bytes per document average

    return {
      indexedAt: Date.now(),
      totalDocuments,
      fields,
      size: estimatedSize,
    };
  }
}

export class DataChunker {
  /**
   * Split events into monthly chunks for efficient loading
   */
  static chunkEventsByMonth(events: Event[]): {
    chunks: EventChunk[];
    chunkInfos: ChunkInfo[];
  } {
    // Group events by year-month
    const monthlyGroups: Record<string, Event[]> = {};

    for (const event of events) {
      const date = new Date(event.dateEpochMs);
      const yearMonth = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;

      if (!monthlyGroups[yearMonth]) {
        monthlyGroups[yearMonth] = [];
      }
      monthlyGroups[yearMonth].push(event);
    }

    const chunks: EventChunk[] = [];
    const chunkInfos: ChunkInfo[] = [];

    for (const [yearMonth, monthEvents] of Object.entries(monthlyGroups)) {
      // Sort events by date within month
      monthEvents.sort((a, b) => a.dateEpochMs - b.dateEpochMs);

      const startEpochMs = monthEvents[0].dateEpochMs;
      const endEpochMs = monthEvents[monthEvents.length - 1].dateEpochMs;

      const chunk: EventChunk = {
        chunkId: yearMonth,
        dateRange: { startEpochMs, endEpochMs },
        events: monthEvents,
      };

      chunks.push(chunk);

      // Calculate chunk size estimate (JSON serialized)
      const serialized = JSON.stringify(chunk);
      const size = new Blob([serialized]).size;
      const checksum = this.calculateChecksum(serialized);

      chunkInfos.push({
        filename: `events-${yearMonth}.json`,
        chunkId: yearMonth,
        size,
        checksum,
        eventCount: monthEvents.length,
        dateRange: { startEpochMs, endEpochMs },
      });
    }

    // Sort by date
    chunks.sort((a, b) => a.dateRange.startEpochMs - b.dateRange.startEpochMs);
    chunkInfos.sort(
      (a, b) => a.dateRange.startEpochMs - b.dateRange.startEpochMs
    );

    return { chunks, chunkInfos };
  }

  /**
   * Calculate simple checksum for data integrity
   */
  private static calculateChecksum(data: string): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `sha256-${Math.abs(hash).toString(16)}`;
  }
}

export class SearchIndexBuilder {
  /**
   * Build search index data structure (simplified - full implementation would use proper search library)
   */
  static buildSearchIndex(
    events: Event[],
    artists: Artist[],
    venues: Venue[]
  ): {
    documents: SearchDocument[];
    terms: Record<string, number[]>; // term -> document IDs
  } {
    const documents: SearchDocument[] = [];
    const terms: Record<string, number[]> = {};

    let docId = 0;

    // Index events
    for (const event of events) {
      const venue = venues.find((v) => v.id === event.venueId);
      const headliner = artists.find((a) => a.id === event.headlinerArtistId);

      const doc: SearchDocument = {
        id: docId++,
        type: "event",
        entityId: String(event.id),
        title: headliner?.name || "Unknown Artist",
        content: [
          headliner?.name || "",
          venue?.name || "",
          venue?.city || "",
          event.tags.join(" "),
          event.notes || "",
        ]
          .filter(Boolean)
          .join(" "),
        city: venue?.city || "",
        date: event.date,
        tags: event.tags,
      };

      documents.push(doc);
      this.indexDocument(doc, terms);
    }

    // Index artists
    for (const artist of artists) {
      const doc: SearchDocument = {
        id: docId++,
        type: "artist",
        entityId: String(artist.id),
        title: artist.name,
        content: [artist.name, ...artist.aliases].join(" "),
        city: "", // Artists don't have cities
        date: "",
        tags: [],
      };

      documents.push(doc);
      this.indexDocument(doc, terms);
    }

    // Index venues
    for (const venue of venues) {
      const doc: SearchDocument = {
        id: docId++,
        type: "venue",
        entityId: String(venue.id),
        title: venue.name,
        content: [
          venue.name,
          venue.address,
          venue.city,
          venue.neighborhood || "",
        ]
          .filter(Boolean)
          .join(" "),
        city: venue.city,
        date: "",
        tags: [],
      };

      documents.push(doc);
      this.indexDocument(doc, terms);
    }

    return { documents, terms };
  }

  private static indexDocument(
    doc: SearchDocument,
    terms: Record<string, number[]>
  ): void {
    const text = (doc.title + " " + doc.content).toLowerCase();
    const words = text.match(/\b\w+\b/g) || [];

    for (const word of words) {
      if (word.length < 3) continue; // Skip very short words

      if (!terms[word]) {
        terms[word] = [];
      }

      if (!terms[word].includes(doc.id)) {
        terms[word].push(doc.id);
      }
    }
  }
}

interface SearchDocument {
  id: number;
  type: "event" | "artist" | "venue";
  entityId: string;
  title: string;
  content: string;
  city: string;
  date: string;
  tags: string[];
}
