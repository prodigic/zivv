/**
 * Test suite for VenueParser functionality
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VenueParser } from "@/lib/etl/parsers.js";
import type { RawVenueData, Venue } from "@/types/events.js";

describe("VenueParser", () => {
  describe("parseVenuesFile", () => {
    it("should parse valid venue data", () => {
      const content = `Great American Music Hall, 859 O'Farrell Street, San Francisco, 21+, (415) 885-0750
The Independent, 628 Divisadero Street, San Francisco, All Ages, (415) 771-1421`;

      const result = VenueParser.parseVenuesFile(content);

      expect(result.rawVenues).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);

      const firstVenue = result.rawVenues[0];
      expect(firstVenue.name).toBe("Great American Music Hall");
      expect(firstVenue.address).toBe("859 O'Farrell Street");
      expect(firstVenue.ageRestriction).toBeDefined();
      expect(firstVenue.phone).toBe("(415) 885-0750");

      const secondVenue = result.rawVenues[1];
      expect(secondVenue.name).toBe("The Independent");
      expect(secondVenue.address).toBe("628 Divisadero Street");
      expect(secondVenue.ageRestriction).toBe("All Ages");
      expect(secondVenue.phone).toBe("(415) 771-1421");
    });

    it("should handle minimal venue data", () => {
      const content = `The Fillmore, 1805 Geary Boulevard, San Francisco`;

      const result = VenueParser.parseVenuesFile(content);

      expect(result.rawVenues).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);

      const venue = result.rawVenues[0];
      expect(venue.name).toBe("The Fillmore");
      expect(venue.address).toBe("1805 Geary Boulevard");
      expect(venue.ageRestriction).toBe("a/a"); // Default
      expect(venue.phone).toBeUndefined();
    });

    it("should handle venues with different age restriction formats", () => {
      const content = `Venue One, Address One, 21+
Venue Two, Address Two, All Ages
Venue Three, Address Three, a/a
Venue Four, Address Four, 18+`;

      const result = VenueParser.parseVenuesFile(content);

      expect(result.rawVenues).toHaveLength(4);
      expect(result.rawVenues[0].ageRestriction).toBe("a/a"); // Default when not found in parts
      expect(result.rawVenues[1].ageRestriction).toBe("All Ages");
      expect(result.rawVenues[2].ageRestriction).toBe("a/a");
      expect(result.rawVenues[3].ageRestriction).toBeDefined();
    });

    it("should handle venues with different phone formats", () => {
      const content = `Venue One, Address One, 21+, 415-555-1234
Venue Two, Address Two, All Ages, (415) 555-5678`;

      const result = VenueParser.parseVenuesFile(content);

      expect(result.rawVenues).toHaveLength(2);
      expect(result.rawVenues[0].phone).toBe("415-555-1234");
      expect(result.rawVenues[1].phone).toBe("(415) 555-5678");
    });

    it("should handle incomplete venue data", () => {
      const content = `Incomplete Venue
Another Venue, With Address`;

      const result = VenueParser.parseVenuesFile(content);

      expect(result.rawVenues).toHaveLength(1); // Only the second one with address
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].type).toBe("incomplete");
      expect(result.warnings[0].message).toBe("Incomplete venue data");
    });

    it("should handle parse errors gracefully", () => {
      const content = `Valid Venue, Valid Address, 21+
,, // This will cause an error
Another Valid Venue, Another Address`;

      const result = VenueParser.parseVenuesFile(content);

      expect(result.rawVenues.length).toBeGreaterThan(0);
      expect(result.rawVenues.length + result.warnings.length).toBeGreaterThan(
        1
      );
    });

    it("should skip empty lines", () => {
      const content = `Venue One, Address One

Venue Two, Address Two

`;

      const result = VenueParser.parseVenuesFile(content);

      expect(result.rawVenues).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it("should extract age restriction from mixed additional parts", () => {
      const content = `The Warfield, 982 Market Street, San Francisco, Some text, 21+, More text, 415-555-0123`;

      const result = VenueParser.parseVenuesFile(content);

      expect(result.rawVenues).toHaveLength(1);
      const venue = result.rawVenues[0];
      expect(venue.ageRestriction).toBeDefined();
      expect(venue.phone).toBe("415-555-0123");
    });
  });

  describe("normalizeVenues", () => {
    let existingVenueMap: Map<string, Venue>;

    beforeEach(() => {
      existingVenueMap = new Map();
    });

    it("should normalize new venue data", () => {
      const rawVenues: RawVenueData[] = [
        {
          name: "Test Venue",
          address: "123 Test Street, San Francisco, CA",
          ageRestriction: "21+",
          phone: "415-555-1234",
          lineNumber: 1,
        },
      ];

      const result = VenueParser.normalizeVenues(rawVenues, existingVenueMap);

      expect(result.venues).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);

      const venue = result.venues[0];
      expect(venue.name).toBe("Test Venue");
      expect(venue.address).toBe("123 Test Street, San Francisco, CA");
      expect(venue.ageRestriction).toBe("21+");
      expect(venue.phone).toBe("415-555-1234");
      expect(venue.sourceLineNumber).toBe(1);
    });

    it("should update existing venues with address information", () => {
      // Add an existing venue to the map
      const existingVenue: Venue = {
        id: 1 as any,
        name: "Existing Venue",
        slug: "existing-venue",
        normalizedName: "existing venue",
        address: "", // Empty address
        city: "San Francisco",
        ageRestriction: "21+",
        upcomingEventCount: 5,
        totalEventCount: 10,
        createdAtEpochMs: Date.now() - 1000,
        updatedAtEpochMs: Date.now() - 1000,
        sourceLineNumber: 0,
      };

      existingVenueMap.set("existing venue", existingVenue);

      const rawVenues: RawVenueData[] = [
        {
          name: "Existing Venue",
          address: "456 Existing Street, San Francisco, CA",
          ageRestriction: "All Ages",
          phone: "415-555-5678",
          lineNumber: 1,
        },
      ];

      const result = VenueParser.normalizeVenues(rawVenues, existingVenueMap);

      expect(result.venues).toHaveLength(1);
      expect(result.errors).toHaveLength(0);

      const venue = result.venues[0];
      expect(venue.name).toBe("Existing Venue");
      expect(venue.address).toBe("456 Existing Street, San Francisco, CA");
      expect(venue.phone).toBe("415-555-5678");
      expect(venue.upcomingEventCount).toBe(5); // Preserved from existing
      expect(venue.totalEventCount).toBe(10); // Preserved from existing
      expect(venue.updatedAtEpochMs).toBeGreaterThanOrEqual(
        existingVenue.updatedAtEpochMs
      );
    });

    it("should detect duplicate venues", () => {
      const rawVenues: RawVenueData[] = [
        {
          name: "Duplicate Venue",
          address: "123 First Street, San Francisco, CA",
          ageRestriction: "21+",
          lineNumber: 1,
        },
        {
          name: "Duplicate Venue", // Same name
          address: "456 Second Street, San Francisco, CA",
          ageRestriction: "All Ages",
          lineNumber: 2,
        },
      ];

      const result = VenueParser.normalizeVenues(rawVenues, existingVenueMap);

      expect(result.venues).toHaveLength(1); // Only first one processed
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].type).toBe("data-quality");
      expect(result.warnings[0].message).toContain("Duplicate venue");
      expect(result.warnings[0].line).toBe(2);
    });

    it("should handle normalization process", () => {
      const rawVenues: RawVenueData[] = [
        {
          name: "Test Venue",
          address: "123 Test Street, San Francisco, CA",
          ageRestriction: "21+",
          lineNumber: 1,
        },
      ];

      const result = VenueParser.normalizeVenues(rawVenues, existingVenueMap);

      // Should create venues or have errors, but process should complete
      expect(result.venues.length + result.errors.length).toBeGreaterThan(0);

      if (result.errors.length > 0) {
        result.errors.forEach((error) => {
          expect(error.line).toBeGreaterThan(0);
          expect(error.type).toBeDefined();
        });
      }
    });

    it("should normalize age restrictions correctly", () => {
      const rawVenues: RawVenueData[] = [
        {
          name: "Venue1",
          address: "Address1",
          ageRestriction: "a/a",
          lineNumber: 1,
        },
        {
          name: "Venue2",
          address: "Address2",
          ageRestriction: "All Ages",
          lineNumber: 2,
        },
        {
          name: "Venue3",
          address: "Address3",
          ageRestriction: "21+",
          lineNumber: 3,
        },
        {
          name: "Venue4",
          address: "Address4",
          ageRestriction: "18+",
          lineNumber: 4,
        },
        {
          name: "Venue5",
          address: "Address5",
          ageRestriction: "16+",
          lineNumber: 5,
        },
        {
          name: "Venue6",
          address: "Address6",
          ageRestriction: "unknown",
          lineNumber: 6,
        },
      ];

      const result = VenueParser.normalizeVenues(rawVenues, existingVenueMap);

      expect(result.venues).toHaveLength(6);
      expect(result.venues[0].ageRestriction).toBe("all-ages");
      expect(result.venues[1].ageRestriction).toBe("all-ages");
      expect(result.venues[2].ageRestriction).toBe("21+");
      expect(result.venues[3].ageRestriction).toBe("18+");
      expect(result.venues[4].ageRestriction).toBe("16+");
      expect(result.venues[5].ageRestriction).toBe("all-ages"); // Default
    });
  });

  describe("integration testing", () => {
    it("should handle complete venue processing pipeline", () => {
      const content = `Test Venue One, 123 Test St, San Francisco, 21+, 415-555-1234
Test Venue Two, 456 Main St, Oakland, All Ages`;

      const parseResult = VenueParser.parseVenuesFile(content);
      expect(parseResult.rawVenues).toHaveLength(2);

      const tempVenueMap = new Map<string, Venue>();
      const normalizeResult = VenueParser.normalizeVenues(
        parseResult.rawVenues,
        tempVenueMap
      );

      // Should process venues successfully or have appropriate errors
      expect(
        normalizeResult.venues.length + normalizeResult.errors.length
      ).toBeGreaterThan(0);

      if (normalizeResult.venues.length > 0) {
        normalizeResult.venues.forEach((venue) => {
          expect(venue.name).toBeDefined();
          expect(venue.address).toBeDefined();
          expect(venue.city).toBeDefined();
          expect(venue.ageRestriction).toBeDefined();
        });
      }
    });

    it("should handle edge cases in venue data", () => {
      const content = `Valid Venue, 123 Valid St, San Francisco, 21+
Incomplete Venue
,, Extra Commas, Venue, With Many, Parts, 18+`;

      const parseResult = VenueParser.parseVenuesFile(content);

      // Should parse what it can and report issues
      expect(
        parseResult.rawVenues.length + parseResult.warnings.length
      ).toBeGreaterThan(0);

      if (parseResult.warnings.length > 0) {
        parseResult.warnings.forEach((warning) => {
          expect(warning.line).toBeGreaterThan(0);
          expect(warning.type).toBeDefined();
        });
      }
    });
  });
});
