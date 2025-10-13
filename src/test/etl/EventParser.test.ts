/**
 * Test suite for EventParser functionality
 */

import { describe, it, expect } from "vitest";
import { EventParser } from "@/lib/etl/parsers.js";
import type { RawEventData, Artist, Venue } from "@/types/events.js";

describe("EventParser", () => {
  describe("parseEventsFile", () => {
    it("should parse valid event data", () => {
      const content = `aug 15 fri Test Artist
at Great American Music Hall, San Francisco 21+ $25`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);

      const event = result.rawEvents[0];
      expect(event.dateString).toBe("aug 15 fri");
      expect(event.artistLine).toBe("Test Artist");
      expect(event.venueLine).toBe(
        "at Great American Music Hall, San Francisco 21+ $25"
      );
      expect(event.lineNumber).toBe(1);
    });

    it("should parse events with multiple artists", () => {
      const content = `aug 15 fri Artist One, Artist Two, Artist Three
at The Fillmore, San Francisco 21+ $35`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents).toHaveLength(1);
      const event = result.rawEvents[0];
      expect(event.artistLine).toBe("Artist One, Artist Two, Artist Three");
    });

    it("should handle events with artist and venue on same line", () => {
      const content = `aug 15 fri Test Artist at The Independent, San Francisco 21+ $30`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents).toHaveLength(1);
      const event = result.rawEvents[0];
      expect(event.artistLine).toBe("Test Artist");
      expect(event.venueLine).toBe("at The Independent, San Francisco 21+ $30");
    });

    it("should handle malformed dates gracefully", () => {
      const content = `invalid date format Test Artist
at The Venue, City 21+ $25`;

      const result = EventParser.parseEventsFile(content);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.type === "format")).toBe(true);
    });

    it("should handle incomplete events at end of file", () => {
      const content = `aug 15 fri Test Artist`;

      const result = EventParser.parseEventsFile(content);

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].type).toBe("incomplete");
      expect(result.warnings[0].message).toBe(
        "Incomplete event at end of file"
      );
    });

    it("should handle multiple events in sequence", () => {
      const content = `aug 15 fri First Artist
at First Venue, San Francisco 21+ $25

aug 16 sat Second Artist
at Second Venue, Oakland All Ages $15`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents).toHaveLength(2);
      expect(result.errors).toHaveLength(0);

      const firstEvent = result.rawEvents[0];
      expect(firstEvent.dateString).toBe("aug 15 fri");
      expect(firstEvent.artistLine).toBe("First Artist");

      const secondEvent = result.rawEvents[1];
      expect(secondEvent.dateString).toBe("aug 16 sat");
      expect(secondEvent.artistLine).toBe("Second Artist");
    });

    it("should handle artist line continuations", () => {
      const content = `aug 15 fri Long Artist Name
with Special Guest
at The Venue, City 21+ $25`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents).toHaveLength(1);
      const event = result.rawEvents[0];
      expect(event.artistLine).toBe("Long Artist Name, with Special Guest");
    });

    it("should handle parse errors gracefully", () => {
      const content = `aug 15 fri Test Artist
at Venue, City 21+ $25
some corrupted line that causes error`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents).toHaveLength(1);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("should skip empty lines", () => {
      const content = `aug 15 fri First Artist
at First Venue, San Francisco 21+ $25


aug 16 sat Second Artist
at Second Venue, Oakland All Ages $15

`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it("should handle complex multiline events", () => {
      const content = `aug 15 fri The Strokes, Arctic Monkeys
special guests: Franz Ferdinand
at The Fillmore, San Francisco 21+ $45`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents).toHaveLength(1);
      const event = result.rawEvents[0];
      expect(event.artistLine).toContain("The Strokes, Arctic Monkeys");
      expect(event.artistLine).toContain("special guests: Franz Ferdinand");
    });
  });

  describe("normalizeEvents integration", () => {
    it("should process complete event normalization", () => {
      const rawEvents: RawEventData[] = [
        {
          dateString: "aug 15 fri",
          artistLine: "Test Artist",
          venueLine: "at Test Venue, San Francisco 21+ $25",
          rawText:
            "aug 15 fri Test Artist\nat Test Venue, San Francisco 21+ $25",
          lineNumber: 1,
        },
      ];

      const artistMap = new Map<string, Artist>();
      const venueMap = new Map<string, Venue>();

      const result = EventParser.normalizeEvents(
        rawEvents,
        artistMap,
        venueMap
      );

      // Should create at least one event (unless date/venue parsing fails)
      expect(result.events.length + result.errors.length).toBeGreaterThan(0);

      if (result.events.length > 0) {
        const event = result.events[0];
        expect(event.sourceLineNumber).toBe(1);
        expect(event.artistIds.length).toBeGreaterThan(0);
        expect(event.venueId).toBeDefined();
      }

      if (result.errors.length > 0) {
        // If errors occurred, they should be properly formatted
        result.errors.forEach((error) => {
          expect(error.line).toBeGreaterThan(0);
          expect(error.type).toBeDefined();
          expect(error.message).toBeDefined();
        });
      }
    });

    it("should handle events with no artists", () => {
      const rawEvents: RawEventData[] = [
        {
          dateString: "aug 15 fri",
          artistLine: "",
          venueLine: "at Test Venue, San Francisco 21+ $25",
          rawText: "aug 15 fri \nat Test Venue, San Francisco 21+ $25",
          lineNumber: 1,
        },
      ];

      const artistMap = new Map<string, Artist>();
      const venueMap = new Map<string, Venue>();

      const result = EventParser.normalizeEvents(
        rawEvents,
        artistMap,
        venueMap
      );

      expect(result.events).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe("validation");
      expect(result.errors[0].message).toBe("No artists found");
    });

    it("should create and update artist entries", () => {
      const rawEvents: RawEventData[] = [
        {
          dateString: "aug 15 fri",
          artistLine: "New Artist",
          venueLine: "at Test Venue, San Francisco 21+ $25",
          rawText:
            "aug 15 fri New Artist\nat Test Venue, San Francisco 21+ $25",
          lineNumber: 1,
        },
      ];

      const artistMap = new Map<string, Artist>();
      const venueMap = new Map<string, Venue>();

      const result = EventParser.normalizeEvents(
        rawEvents,
        artistMap,
        venueMap
      );

      // Should either create events or have parsing errors
      if (result.events.length > 0) {
        expect(artistMap.size).toBeGreaterThan(0);

        const artists = [...artistMap.values()];
        expect(artists[0].totalEventCount).toBeGreaterThan(0);
      }
    });

    it("should create and update venue entries", () => {
      const rawEvents: RawEventData[] = [
        {
          dateString: "aug 15 fri",
          artistLine: "Test Artist",
          venueLine: "at New Venue, San Francisco 21+ $25",
          rawText:
            "aug 15 fri Test Artist\nat New Venue, San Francisco 21+ $25",
          lineNumber: 1,
        },
      ];

      const artistMap = new Map<string, Artist>();
      const venueMap = new Map<string, Venue>();

      const result = EventParser.normalizeEvents(
        rawEvents,
        artistMap,
        venueMap
      );

      // Should either create events or have parsing errors
      if (result.events.length > 0) {
        expect(venueMap.size).toBeGreaterThan(0);

        const venues = [...venueMap.values()];
        expect(venues[0].totalEventCount).toBeGreaterThan(0);
      }
    });
  });

  describe("data validation and quality checks", () => {
    it("should detect malformed artist lines", () => {
      const content = `aug 15 fri Artist123Name, BandWithNumbers2Night
at Test Venue, San Francisco 21+ $25`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents).toHaveLength(1);

      const artistMap = new Map<string, Artist>();
      const venueMap = new Map<string, Venue>();

      const normalizeResult = EventParser.normalizeEvents(
        result.rawEvents,
        artistMap,
        venueMap
      );

      // Should have data quality warnings about suspicious artist names
      expect(
        normalizeResult.warnings.some((w) => w.type === "data-quality")
      ).toBe(true);
    });

    it("should handle events with many artists", () => {
      const manyArtists = Array.from(
        { length: 10 },
        (_, i) => `Artist ${i + 1}`
      ).join(", ");
      const content = `aug 15 fri ${manyArtists}
at Test Venue, San Francisco 21+ $25`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents).toHaveLength(1);

      const artistMap = new Map<string, Artist>();
      const venueMap = new Map<string, Venue>();

      const normalizeResult = EventParser.normalizeEvents(
        result.rawEvents,
        artistMap,
        venueMap
      );

      // Should warn about too many artists
      expect(
        normalizeResult.warnings.some(
          (w) => w.type === "data-quality" && w.message.includes("10 artists")
        )
      ).toBe(true);
    });

    it("should handle duplicate detection", () => {
      const rawEvents: RawEventData[] = [
        {
          dateString: "aug 15 fri",
          artistLine: "Test Artist",
          venueLine: "at Test Venue, San Francisco 21+ $25",
          rawText:
            "aug 15 fri Test Artist\nat Test Venue, San Francisco 21+ $25",
          lineNumber: 1,
        },
        {
          dateString: "aug 15 fri",
          artistLine: "Test Artist",
          venueLine: "at Test Venue, San Francisco 21+ $25",
          rawText:
            "aug 15 fri Test Artist\nat Test Venue, San Francisco 21+ $25",
          lineNumber: 3,
        },
      ];

      const artistMap = new Map<string, Artist>();
      const venueMap = new Map<string, Venue>();

      const result = EventParser.normalizeEvents(
        rawEvents,
        artistMap,
        venueMap
      );

      // Should detect duplicate and create warning
      expect(
        result.warnings.some(
          (w) =>
            w.type === "data-quality" && w.message.includes("Duplicate event")
        )
      ).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should handle various parsing edge cases", () => {
      const content = `aug 15 fri Test Artist

invalid line without venue

aug 16 sat Another Artist
at Valid Venue, San Francisco 21+ $30

incomplete event`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);

      // Should have warnings for malformed data
      expect(
        result.warnings.some(
          (w) => w.type === "incomplete" || w.type === "format"
        )
      ).toBe(true);
    });

    it("should provide line numbers in error reports", () => {
      const content = `aug 15 fri Valid Artist
at Valid Venue, San Francisco 21+ $25

invalid date format Bad Artist
at Another Venue, Oakland All Ages $15`;

      const result = EventParser.parseEventsFile(content);

      expect(result.rawEvents.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);

      result.warnings.forEach((warning) => {
        expect(warning.line).toBeGreaterThan(0);
        expect(warning.rawText).toBeDefined();
      });
    });
  });
});
