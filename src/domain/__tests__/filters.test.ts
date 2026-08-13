import { describe, expect, it } from "vitest";
import { dateOnly } from "../dates.ts";
import type { Event } from "../entities.ts";
import { matchesEventFilters } from "../filters.ts";
import { eventId, artistId, stableKey, venueId } from "../identifiers.ts";
import { paidPrice } from "../prices.ts";

const event: Event = {
  id: eventId("event-1"),
  stableKey: stableKey("event:artist:venue:2026-04-04"),
  slug: "headliner-at-venue",
  date: "2026-04-04",
  timezone: "America/Los_Angeles",
  artistIds: [artistId("artist-1"), artistId("artist-2")],
  headlinerArtistId: artistId("artist-1"),
  venueId: venueId("venue-1"),
  price: paidPrice(20, 35),
  ageRestriction: "21+",
  status: "confirmed",
  tags: ["late-show"],
  venueType: "club",
  provenance: [],
};

describe("domain event filters", () => {
  it("applies city, date, price, age, and tag filters consistently", () => {
    expect(matchesEventFilters(event, {
      cities: ["SF"],
      dates: [dateOnly("2026-04-04")],
      priceRange: { max: 25 },
      ageRestrictions: ["21+"],
      tags: ["late-show"],
    }, { cityByVenueId: new Map([[event.venueId, "San Francisco"]]) })).toBe(true);
  });

  it("does not match unrelated venue or city filters", () => {
    expect(matchesEventFilters(event, { cities: ["Oakland"] }, {
      cityByVenueId: new Map([[event.venueId, "San Francisco"]]),
    })).toBe(false);
    expect(matchesEventFilters(event, { venueIds: ["venue-2"] }, {
      cityByVenueId: new Map(),
    })).toBe(false);
  });
});
