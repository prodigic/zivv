/**
 * Test suite for runtime type guards in src/utils/typeGuards.ts
 */

import { describe, it, expect } from "vitest";
import {
  isValidId,
  isEventId,
  isArtistId,
  isVenueId,
  isISODate,
  isEpochTimestamp,
  isAgeRestriction,
  isEventStatus,
  isEventTag,
  isVenueType,
  validateEvent,
  validateArtist,
  validateVenue,
  validateManifest,
  validateEventChunk,
  validateEventArray,
  validateArtistArray,
  validateVenueArray,
} from "@/utils/typeGuards";
import type { Event, Artist, Venue, EventChunk } from "@/types/events";
import type { DataManifest } from "@/types/data";
import type { DateRange } from "@/types/data";

// 2024-08-01T10:00:00Z, safely within the 1-year future window of
// isEpochTimestamp regardless of when the suite runs (CI ships data in the past)
const MID_2024_EPOCH = 1722506400000;

const validDateRange = (): DateRange => ({
  startEpochMs: MID_2024_EPOCH - 7 * 24 * 60 * 60 * 1000,
  endEpochMs: MID_2024_EPOCH + 7 * 24 * 60 * 60 * 1000,
  startDate: "2024-07-25",
  endDate: "2024-08-04",
});

const validEvent = (): unknown => ({
  id: 1001,
  slug: "the-smittens-at-fillmore",
  date: "2024-08-01",
  dateEpochMs: MID_2024_EPOCH,
  headlinerArtistId: 42,
  artistIds: [42, 43],
  venueId: 9000,
  isFree: false,
  ageRestriction: "all-ages",
  status: "confirmed",
  tags: ["all-ages", "matinee"],
  priceMin: 12,
  priceMax: 45,
});

const validArtist = (): unknown => ({
  id: 42,
  name: "The Smittens",
  slug: "the-smittens",
  normalizedName: "The Smittens",
  aliases: [],
  upcomingEventCount: 3,
  totalEventCount: 12,
  createdAtEpochMs: MID_2024_EPOCH - 365 * 24 * 60 * 60 * 1000,
  updatedAtEpochMs: MID_2024_EPOCH,
});

const validVenue = (): unknown => ({
  id: 9000,
  name: "The Fillmore",
  slug: "the-fillmore",
  address: "1805 Geary Blvd",
  city: "San Francisco",
  ageRestriction: "18+",
  upcomingEventCount: 5,
  totalEventCount: 40,
  phone: "(415) 346-6000",
  website: "https://thefillmore.com",
  capacity: 1200,
});

const validManifest = (): unknown => ({
  version: "1.0.0",
  datasetVersion: "2024-08-23T10:00:00Z",
  lastUpdated: MID_2024_EPOCH,
  totalEvents: 100,
  totalArtists: 50,
  totalVenues: 25,
  dateRange: validDateRange(),
});

const validChunk = (): unknown => ({
  chunkId: "events-2024-08",
  events: [validEvent()],
});

describe("typeGuards", () => {
  describe("isValidId", () => {
    it("accepts positive integers", () => {
      expect(isValidId(1)).toBe(true);
      expect(isValidId(12345)).toBe(true);
    });

    it("rejects non-positive, fractional and non-number values", () => {
      expect(isValidId(0)).toBe(false);
      expect(isValidId(-1)).toBe(false);
      expect(isValidId(1.5)).toBe(false);
      expect(isValidId("42")).toBe(false);
      expect(isValidId(null)).toBe(false);
      expect(isValidId(undefined)).toBe(false);
      expect(isValidId(Number.NaN)).toBe(false);
    });
  });

  describe("branded ID guards", () => {
    it("isEventId validates positive integers", () => {
      expect(isEventId(7)).toBe(true);
      expect(isEventId(0)).toBe(false);
      expect(isEventId("7")).toBe(false);
    });

    it("isArtistId validates positive integers", () => {
      expect(isArtistId(7)).toBe(true);
      expect(isArtistId(-7)).toBe(false);
      expect(isArtistId({})).toBe(false);
    });

    it("isVenueId validates positive integers", () => {
      expect(isVenueId(9)).toBe(true);
      expect(isVenueId(9.5)).toBe(false);
      expect(isVenueId(Boolean("true"))).toBe(false);
    });
  });

  describe("isISODate", () => {
    it("accepts valid YYYY-MM-DD date strings", () => {
      expect(isISODate("2024-08-01")).toBe(true);
      expect(isISODate("1970-01-01")).toBe(true);
    });

    it("rejects non-date strings and other types", () => {
      expect(isISODate("not-a-date")).toBe(false);
      expect(isISODate("2024-13-01")).toBe(false);
      // date-time strings round-trip differently and are not bare ISO dates
      expect(isISODate("2024-08-01T10:00:00Z")).toBe(false);
      expect(isISODate(20240801)).toBe(false);
      expect(isISODate(null)).toBe(false);
    });
  });

  describe("isEpochTimestamp", () => {
    it("accepts integer timestamps not more than one year in the future", () => {
      expect(isEpochTimestamp(MID_2024_EPOCH)).toBe(true);
      expect(isEpochTimestamp(Date.now() - 60_000)).toBe(true);
    });

    it("rejects non-, zero, negative, fractional and too-far-future values", () => {
      expect(isEpochTimestamp(0)).toBe(false);
      expect(isEpochTimestamp(-5)).toBe(false);
      expect(isEpochTimestamp(1722506400.5)).toBe(false);
      expect(isEpochTimestamp(Date.now() + 370 * 24 * 60 * 60 * 1000)).toBe(
        false
      );
      expect(isEpochTimestamp("1722506400000")).toBe(false);
      expect(isEpochTimestamp(null)).toBe(false);
    });
  });

  describe("enumeration guards", () => {
    it("isAgeRestriction accepts known ages only", () => {
      for (const age of ["all-ages", "18+", "21+", "16+", "unknown"]) {
        expect(isAgeRestriction(age)).toBe(true);
      }
      expect(isAgeRestriction("17+")).toBe(false);
      expect(isAgeRestriction(18)).toBe(false);
      expect(isAgeRestriction(null)).toBe(false);
    });

    it("isEventStatus accepts known statuses only", () => {
      for (const status of [
        "confirmed",
        "sold-out",
        "cancelled",
        "postponed",
        "rescheduled",
      ]) {
        expect(isEventStatus(status)).toBe(true);
      }
      expect(isEventStatus("maybe")).toBe(false);
      expect(isEventStatus("CONFIRMED")).toBe(false);
    });

    it("isEventTag accepts known tags only", () => {
      for (const tag of ["sold-out", "free", "festival", "all-ages"]) {
        expect(isEventTag(tag)).toBe(true);
      }
      expect(isEventTag("freee")).toBe(false);
      expect(isEventTag(["free"])).toBe(false);
    });

    it("isVenueType accepts known types only", () => {
      for (const type of ["major", "club", "diy", "outdoor", "festival"]) {
        expect(isVenueType(type)).toBe(true);
      }
      expect(isVenueType("stadium")).toBe(false);
      expect(isVenueType(undefined)).toBe(false);
    });
  });

  describe("validateEvent", () => {
    it("accepts a complete valid event", () => {
      const result = validateEvent(validEvent());
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(typeof result.data).toBe("object");
    });

    it("rejects non-object input", () => {
      expect(validateEvent(null).isValid).toBe(false);
      expect(validateEvent("event").isValid).toBe(false);
      expect(validateEvent(null).errors).toEqual(["Event must be an object"]);
    });

    it("collects one error per invalid required field", () => {
      const result = validateEvent({
        ...validEvent(),
        id: "not-a-number",
        dateEpochMs: -5,
        headlinerArtistId: 0,
        venueId: -3,
        isFree: "yes",
      });

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Event must have a valid numeric id");
      expect(result.errors).toContain(
        "Event must have a valid headlinerArtistId"
      );
      expect(result.errors).toContain("Event must have a valid venueId");
      expect(result.errors).toContain("Event must have a valid isFree boolean");
      expect(result.errors).toContain(
        "Event must have a valid dateEpochMs timestamp"
      );
    });

    it("flags invalid artistIds arrays", () => {
      const result = validateEvent({ ...validEvent(), artistIds: [42, "43"] });
      expect(result.errors).toContain(
        "Event must have a valid array of artistIds"
      );
    });

    it("flags invalid optional numeric ranges", () => {
      const result = validateEvent({
        ...validEvent(),
        priceMin: -1,
        priceMax: "free",
        startTimeEpochMs: -20,
      });

      expect(result.errors).toContain(
        "Event priceMin must be a non-negative number if provided"
      );
      expect(result.errors).toContain(
        "Event priceMax must be a non-negative number if provided"
      );
      expect(result.errors).toContain(
        "Event startTimeEpochMs must be a valid timestamp if provided"
      );
    });

    it("flags invalid optional status and tags", () => {
      const result = validateEvent({
        ...validEvent(),
        status: "rumoured",
        tags: ["free", "nope"],
      });

      expect(result.errors).toContain(
        "Event status must be a valid EventStatus if provided"
      );
      expect(result.errors).toContain(
        "Event tags must be an array of valid EventTags if provided"
      );
    });
  });

  describe("validateArtist", () => {
    it("accepts a complete valid artist", () => {
      const result = validateArtist(validArtist());
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects non-object input and missing required fields", () => {
      expect(validateArtist("artist").errors).toEqual([
        "Artist must be an object",
      ]);

      const result = validateArtist({
        ...validArtist(),
        name: "",
        normalizedName: 42,
      });
      expect(result.errors).toContain("Artist must have a valid name string");
      expect(result.errors).toContain(
        "Artist must have a valid normalizedName string"
      );
    });

    it("flags invalid alias arrays and counts", () => {
      const result = validateArtist({
        ...validArtist(),
        aliases: [1, "two"],
        upcomingEventCount: -1,
        totalEventCount: "many",
      });

      expect(result.errors).toContain(
        "Artist must have a valid array of alias strings"
      );
      expect(result.errors).toContain(
        "Artist must have a valid non-negative upcomingEventCount"
      );
      expect(result.errors).toContain(
        "Artist must have a valid non-negative totalEventCount"
      );
    });

    it("flags invalid lifecycle timestamps", () => {
      const result = validateArtist({
        ...validArtist(),
        createdAtEpochMs: 0,
        updatedAtEpochMs: Date.now() + 2 * 365 * 24 * 60 * 60 * 1000,
      });

      expect(result.errors).toContain(
        "Artist must have a valid createdAtEpochMs timestamp"
      );
      expect(result.errors).toContain(
        "Artist must have a valid updatedAtEpochMs timestamp"
      );
    });
  });

  describe("validateVenue", () => {
    it("accepts a complete valid venue", () => {
      const result = validateVenue(validVenue());
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects non-object input and missing required fields", () => {
      expect(validateVenue(42).errors).toEqual(["Venue must be an object"]);

      const result = validateVenue({
        ...validVenue(),
        address: "",
        city: 94110,
        ageRestriction: "kids",
      });
      expect(result.errors).toContain("Venue must have a valid address string");
      expect(result.errors).toContain("Venue must have a valid city string");
      expect(result.errors).toContain("Venue must have a valid ageRestriction");
    });

    it("flags invalid optional fields", () => {
      const result = validateVenue({
        ...validVenue(),
        phone: 415,
        website: 80,
        capacity: 0,
      });

      expect(result.errors).toContain(
        "Venue phone must be a string if provided"
      );
      expect(result.errors).toContain(
        "Venue website must be a string if provided"
      );
      expect(result.errors).toContain(
        "Venue capacity must be a positive number if provided"
      );
    });
  });

  describe("validateManifest", () => {
    it("accepts a complete valid manifest", () => {
      const result = validateManifest(validManifest());
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects non-object input and missing counts", () => {
      expect(validateManifest(undefined).errors).toEqual([
        "Manifest must be an object",
      ]);

      const result = validateManifest({
        ...validManifest(),
        totalEvents: -1,
        totalArtists: "many",
        totalVenues: null,
      });
      expect(result.errors).toContain(
        "Manifest must have a valid non-negative totalEvents count"
      );
      expect(result.errors).toContain(
        "Manifest must have a valid non-negative totalArtists count"
      );
      expect(result.errors).toContain(
        "Manifest must have a valid non-negative totalVenues count"
      );
    });

    it("flags a malformed dateRange block", () => {
      const result = validateManifest({
        ...validManifest(),
        dateRange: {
          startEpochMs: 0,
          endEpochMs: -5,
          startDate: "",
          endDate: 8,
        },
      });

      expect(result.errors).toContain(
        "Manifest dateRange must have a valid startEpochMs timestamp"
      );
      expect(result.errors).toContain(
        "Manifest dateRange must have a valid endEpochMs timestamp"
      );
      expect(result.errors).toContain(
        "Manifest dateRange must have a valid startDate string"
      );
      expect(result.errors).toContain(
        "Manifest dateRange must have a valid endDate string"
      );
    });

    it("flags a missing dateRange block", () => {
      const result = validateManifest({ ...validManifest(), dateRange: null });
      expect(result.errors).toContain(
        "Manifest must have a valid dateRange object"
      );
    });
  });

  describe("validateEventChunk", () => {
    it("accepts a chunk with valid events", () => {
      const result = validateEventChunk(validChunk());
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects non-object and non-array events fields", () => {
      expect(validateEventChunk("chunk").errors).toEqual([
        "EventChunk must be an object",
      ]);

      const result = validateEventChunk({
        chunkId: "events-2024-08",
        events: "not-an-array",
      });
      expect(result.errors).toEqual([
        "EventChunk must have a valid events array",
      ]);
    });

    it("reports per-index failures for invalid events", () => {
      const badEvent = { ...validEvent(), venueId: "the-fillmore" };

      const result = validateEventChunk({
        chunkId: "events-2024-08",
        events: [validEvent(), badEvent],
      });

      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^Event at index 1: /);
      expect(result.errors[0]).toContain("venueId");
    });

    it("flags a malformed optional chunk dateRange", () => {
      const result = validateEventChunk({
        ...validChunk(),
        dateRange: { startEpochMs: "x", endEpochMs: null },
      });

      expect(result.errors).toContain(
        "EventChunk dateRange must have a valid startEpochMs timestamp"
      );
      expect(result.errors).toContain(
        "EventChunk dateRange must have a valid endEpochMs timestamp"
      );

      const notObject = validateEventChunk({
        ...validChunk(),
        dateRange: "all-2024",
      });
      expect(notObject.errors).toEqual([
        "EventChunk dateRange must be an object if provided",
      ]);
    });
  });

  describe("array validators", () => {
    it("validateEventArray accepts valid events and indexes failures", () => {
      const good = validateEventArray([validEvent()]);
      expect(good.isValid).toBe(true);
      expect(good.data).toHaveLength(1);

      const mixed = validateEventArray([validEvent(), { id: 1 }]);
      expect(mixed.isValid).toBe(false);
      expect(mixed.data).toBeUndefined();
      expect(String(mixed.errors[0])).toMatch(/^Event at index 1: /);
      expect(mixed.errors).toHaveLength(1);
    });

    it("validateEventArray applies array validation to its input", () => {
      const result = validateEventArray("not-an-array");
      expect(result.isValid).toBe(false);
      expect(result.errors).toEqual(["Must be an array"]);
    });

    it("validateArtistArray accepts valid artists", () => {
      const result = validateArtistArray([validArtist(), validArtist()]) as {
        isValid: boolean;
        data: Artist[];
      };

      expect(result.isValid).toBe(true);
      expect(result.data).toHaveLength(2);

      const mixed = validateArtistArray([validArtist(), "nope"]);
      expect(mixed.isValid).toBe(false);
      expect(String(mixed.errors[0])).toMatch(/^Artist at index 1: /);
    });

    it("validateArtistArray requires an array input", () => {
      const result = validateArtistArray({});
      expect(result.errors).toEqual(["Must be an array"]);
    });

    it("validateVenueArray accepts valid venues", () => {
      const result = validateVenueArray([validVenue()]) as {
        isValid: boolean;
        data: Venue[];
      };

      expect(result.isValid).toBe(true);
      expect(result.data).toHaveLength(1);

      const mixed = validateVenueArray([validVenue(), 3]);
      expect(mixed.isValid).toBe(false);
      expect(String(mixed.errors[0])).toMatch(/^Venue at index 1: /);
    });

    it("validateVenueArray requires an array input", () => {
      const result = validateVenueArray({ length: 0 });
      expect(result.errors).toEqual(["Must be an array"]);
    });
  });

  it("provides typed data on success and undefined on failure", () => {
    const ok = validateEvent(validEvent()) as {
      isValid: boolean;
      data?: Event;
    };
    const bad = validateEvent(null) as { isValid: boolean; data?: Event };

    expect(typeof ok.data?.slug).toBe("string");
    expect(bad.data).toBeUndefined();
  });
});
