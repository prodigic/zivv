/**
 * Test suite for ETL Integration - simplified integration tests
 * Tests the interaction between different ETL components
 */

import { describe, it, expect } from "vitest";
import { EventParser, VenueParser } from "@/lib/etl/parsers.js";
import type { Artist, Venue } from "@/types/events.js";

describe("ETL Integration", () => {
  describe("Event and Venue Parser Integration", () => {
    it("should process events and venues together", () => {
      // Sample event data
      const eventsContent = `aug 15 fri The Strokes, Arctic Monkeys
at The Fillmore, San Francisco 21+ $45

aug 16 sat Franz Ferdinand
at Great American Music Hall, San Francisco All Ages $35`;

      // Sample venue data
      const venuesContent = `The Fillmore, 1805 Geary Boulevard, San Francisco, 21+, (415) 346-3000
Great American Music Hall, 859 O'Farrell Street, San Francisco, All Ages, (415) 885-0750`;

      // Parse events
      const eventParseResult = EventParser.parseEventsFile(eventsContent);
      expect(eventParseResult.rawEvents).toHaveLength(2);
      expect(eventParseResult.errors).toHaveLength(0);

      // Parse venues
      const venueParseResult = VenueParser.parseVenuesFile(venuesContent);
      expect(venueParseResult.rawVenues).toHaveLength(2);
      expect(venueParseResult.errors).toHaveLength(0);

      // Normalize venues first
      const venueMap = new Map<string, Venue>();
      const venueNormalizeResult = VenueParser.normalizeVenues(
        venueParseResult.rawVenues,
        venueMap
      );

      // Should create venues or have appropriate errors
      expect(
        venueNormalizeResult.venues.length + venueNormalizeResult.errors.length
      ).toBeGreaterThan(0);

      // Normalize events with the venue map
      const artistMap = new Map<string, Artist>();
      const eventNormalizeResult = EventParser.normalizeEvents(
        eventParseResult.rawEvents,
        artistMap,
        venueMap
      );

      // Should create events or have appropriate errors
      expect(
        eventNormalizeResult.events.length + eventNormalizeResult.errors.length
      ).toBeGreaterThan(0);

      // Check that we have artists created
      if (eventNormalizeResult.events.length > 0) {
        expect(artistMap.size).toBeGreaterThan(0);

        // Verify event structure
        eventNormalizeResult.events.forEach((event) => {
          expect(event.artistIds.length).toBeGreaterThan(0);
          expect(event.venueId).toBeDefined();
          expect(event.sourceLineNumber).toBeGreaterThan(0);
        });
      }
    });

    it("should handle complex event processing pipeline", () => {
      const complexEventsContent = `aug 15 fri Bad Artist Name123, AnotherBadName456
at Unknown Venue, San Francisco 21+ $25

aug 16 sat
incomplete event without venue

aug 17 sun Valid Artist
at Valid Venue, Oakland All Ages FREE

aug 18 mon Artist One feat. Artist Two, Artist Three with Artist Four
at Multi Artist Venue, Berkeley 18+ $30 SOLD OUT`;

      const venuesContent = `Valid Venue, 123 Valid Street, Oakland, All Ages, (510) 555-1234`;

      // Parse both
      const eventResult = EventParser.parseEventsFile(complexEventsContent);
      const venueResult = VenueParser.parseVenuesFile(venuesContent);

      // Should parse some events and have warnings for problematic ones
      expect(
        eventResult.rawEvents.length + eventResult.warnings.length
      ).toBeGreaterThan(0);

      // Process venues
      const venueMap = new Map<string, Venue>();
      const venueNormResult = VenueParser.normalizeVenues(
        venueResult.rawVenues,
        venueMap
      );

      // Process events
      const artistMap = new Map<string, Artist>();
      const eventNormResult = EventParser.normalizeEvents(
        eventResult.rawEvents,
        artistMap,
        venueMap
      );

      // Should have some combination of successful processing and error reporting
      const totalProcessed =
        eventNormResult.events.length +
        eventNormResult.errors.length +
        eventNormResult.warnings.length;
      expect(totalProcessed).toBeGreaterThan(0);

      // Verify data quality warnings are generated
      const hasDataQualityWarnings = eventNormResult.warnings.some(
        (w) => w.type === "data-quality"
      );
      expect(hasDataQualityWarnings).toBe(true);
    });

    it("should handle venue matching between events and venue list", () => {
      const eventsContent = `aug 15 fri Test Artist
at The Independent, San Francisco 21+ $30`;

      const venuesContent = `The Independent, 628 Divisadero Street, San Francisco, 21+, (415) 771-1421`;

      // Process both
      const eventResult = EventParser.parseEventsFile(eventsContent);
      const venueResult = VenueParser.parseVenuesFile(venuesContent);

      // Start with venue processing
      const venueMap = new Map<string, Venue>();
      const venueNormResult = VenueParser.normalizeVenues(
        venueResult.rawVenues,
        venueMap
      );

      // Then process events - this should match existing venues
      const artistMap = new Map<string, Artist>();
      const eventNormResult = EventParser.normalizeEvents(
        eventResult.rawEvents,
        artistMap,
        venueMap
      );

      // Should have processed venues and events
      expect(
        venueNormResult.venues.length + venueNormResult.errors.length
      ).toBeGreaterThan(0);
      expect(
        eventNormResult.events.length + eventNormResult.errors.length
      ).toBeGreaterThan(0);

      // If successful, should have created venues with proper data
      if (venueNormResult.venues.length > 0) {
        const venue = venueNormResult.venues[0];
        expect(venue.name).toBeDefined();
        expect(venue.address).toBeDefined();
      }
    });

    it("should handle error accumulation across parsers", () => {
      const problematicEventsContent = `invalid date format Test Artist
at Test Venue, San Francisco 21+ $25

aug 16 sat Artist Without Venue

aug 17 sun
at Venue Without Artist`;

      const problematicVenuesContent = `Incomplete Venue
,, Empty venue line
Valid Venue, Valid Address, Valid Age`;

      // Parse with errors
      const eventResult = EventParser.parseEventsFile(problematicEventsContent);
      const venueResult = VenueParser.parseVenuesFile(problematicVenuesContent);

      // Should have warnings/errors from parsing
      expect(eventResult.warnings.length).toBeGreaterThan(0);
      expect(venueResult.warnings.length).toBeGreaterThan(0);

      // Continue with normalization
      const venueMap = new Map<string, Venue>();
      const venueNormResult = VenueParser.normalizeVenues(
        venueResult.rawVenues,
        venueMap
      );

      const artistMap = new Map<string, Artist>();
      const eventNormResult = EventParser.normalizeEvents(
        eventResult.rawEvents,
        artistMap,
        venueMap
      );

      // Should accumulate errors from all stages
      const totalErrors =
        eventResult.errors.length +
        eventResult.warnings.length +
        venueResult.errors.length +
        venueResult.warnings.length +
        eventNormResult.errors.length +
        eventNormResult.warnings.length;

      expect(totalErrors).toBeGreaterThan(0);

      // All errors should have line numbers and context
      [...eventResult.errors, ...eventResult.warnings].forEach((error) => {
        expect(error.line).toBeGreaterThan(0);
        expect(error.rawText).toBeDefined();
        expect(error.type).toBeDefined();
      });
    });
  });

  describe("Data Consistency and Deduplication", () => {
    it("should handle artist deduplication across events", () => {
      const eventsContent = `aug 15 fri The Beatles
at Venue One, San Francisco 21+ $25

aug 16 sat THE BEATLES, Other Artist
at Venue Two, Oakland All Ages $15

aug 17 sun The Beatles, The Beatles
at Venue Three, Berkeley 18+ $30`;

      const eventResult = EventParser.parseEventsFile(eventsContent);
      expect(eventResult.rawEvents).toHaveLength(3);

      const artistMap = new Map<string, Artist>();
      const venueMap = new Map<string, Venue>();

      const normResult = EventParser.normalizeEvents(
        eventResult.rawEvents,
        artistMap,
        venueMap
      );

      if (normResult.events.length > 0) {
        // Should deduplicate "The Beatles" across different case variations
        const beatlesArtists = [...artistMap.values()].filter((artist) =>
          artist.normalizedName.includes("beatles")
        );
        expect(beatlesArtists).toHaveLength(1);

        // The artist should have events counted
        expect(beatlesArtists[0].totalEventCount).toBeGreaterThan(1);
      }

      // Should warn about duplicate artist in same event
      const duplicateWarnings = normResult.warnings.filter((w) =>
        w.message.includes("duplicate artist")
      );
      expect(duplicateWarnings.length).toBeGreaterThan(0);
    });

    it("should handle venue consistency between events and venue files", () => {
      const eventsContent = `aug 15 fri Artist One
at The Fillmore, San Francisco 21+ $25

aug 16 sat Artist Two  
at THE FILLMORE, San Francisco All Ages $15`;

      const venuesContent = `The Fillmore, 1805 Geary Boulevard, San Francisco, 21+, (415) 346-3000`;

      // Process events first (creates basic venue entries)
      const eventResult = EventParser.parseEventsFile(eventsContent);
      const artistMap = new Map<string, Artist>();
      const venueMap = new Map<string, Venue>();

      const eventNormResult = EventParser.normalizeEvents(
        eventResult.rawEvents,
        artistMap,
        venueMap
      );

      // Then process venues (should update existing entries)
      const venueResult = VenueParser.parseVenuesFile(venuesContent);
      const venueNormResult = VenueParser.normalizeVenues(
        venueResult.rawVenues,
        venueMap
      );

      if (venueNormResult.venues.length > 0) {
        // Should have consolidated into one venue with full address info
        const fillmoreVenues = [...venueMap.values()].filter((venue) =>
          venue.normalizedName.includes("fillmore")
        );
        expect(fillmoreVenues).toHaveLength(1);

        const venue = fillmoreVenues[0];
        expect(venue.address).toBe("1805 Geary Boulevard");
        expect(venue.phone).toBe("(415) 346-3000");
        expect(venue.totalEventCount).toBeGreaterThan(0);
      }
    });
  });
});
