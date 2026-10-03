import { describe, expect, it } from "vitest";
import type { Venue, VenueId } from "../../types/events.js";
import {
  applyVenueDetails,
  decodeVenueDetails,
  type VenueDetail,
} from "../../lib/ingestion/venue-details.js";

function venue(id = 1): Venue {
  return {
    id: id as VenueId,
    name: "Music Hall",
    slug: `music-hall-${id}`,
    normalizedName: "music hall",
    city: "Legacy city",
    address: "Legacy address",
    ageRestriction: "all-ages",
    upcomingEvents: [],
    upcomingEventCount: 0,
    totalEventCount: 3,
    createdAtEpochMs: 100,
    updatedAtEpochMs: 200,
    sourceLineNumber: 12,
  };
}

function detail(venueId = 1): VenueDetail {
  return {
    venueId,
    venueName: "Music Hall",
    streetAddress: "123 Main Street",
    city: "Oakland",
    website: "https://venue.example.org/",
    status: "verified",
    sources: ["https://venue.example.org/contact"],
    notes: "Address and venue identity verified on the official contact page.",
    checkedOn: "2026-10-02",
  };
}

describe("reviewed venue details", () => {
  it("keeps same-name rooms separate, preserves identity and dates, and is repeatable", () => {
    const venues = [venue(), venue(2)];
    const second = {
      ...detail(2),
      streetAddress: "45 Second Street",
      city: "Berkeley",
    };
    const registry = { schemaVersion: 1 as const, venues: [detail(), second] };
    const before = structuredClone(venues);
    expect(applyVenueDetails(venues, registry)).toEqual([1, 2]);
    expect(venues[0]).toEqual({
      ...before[0],
      address: "123 Main Street",
      city: "Oakland",
      website: detail().website,
    });
    expect(venues[1]).toEqual({
      ...before[1],
      address: "45 Second Street",
      city: "Berkeley",
      website: second.website,
    });
    expect(applyVenueDetails(venues, registry)).toEqual([]);
  });

  it("retains existing values for unknown fields and never applies unresolved identities", () => {
    const venues = [venue(), venue(2)];
    const partial = {
      ...detail(),
      status: "partial" as const,
      streetAddress: null,
      city: null,
    };
    const unresolved = { ...detail(2), status: "unresolved" as const };
    expect(
      applyVenueDetails(venues, {
        schemaVersion: 1,
        venues: [partial, unresolved],
      })
    ).toEqual([1]);
    expect(venues[0].address).toBe("Legacy address");
    expect(venues[0].city).toBe("Legacy city");
    expect(venues[1]).toEqual(venue(2));
  });

  it("rejects a stale identity before applying any other row", () => {
    const venues = [venue(), venue(2)];
    const before = structuredClone(venues);
    expect(() =>
      applyVenueDetails(venues, {
        schemaVersion: 1,
        venues: [detail(), { ...detail(2), venueName: "Other venue" }],
      })
    ).toThrow("identity mismatch");
    expect(venues).toEqual(before);
    expect(() =>
      applyVenueDetails(venues, { schemaVersion: 1, venues: [detail(99)] })
    ).toThrow("identity mismatch");
  });

  it.each([
    { ...detail(), website: "javascript:alert(1)" },
    { ...detail(), website: "https://user:secret@venue.example.org/" },
    { ...detail(), sources: [] },
    { ...detail(), sources: ["file:///private"] },
    { ...detail(), streetAddress: null },
    { ...detail(), city: " " },
  ])("rejects incomplete verified records and unsafe links", (row) => {
    expect(() =>
      decodeVenueDetails({ schemaVersion: 1, venues: [row] })
    ).toThrow("Invalid venue details entry");
  });

  it("rejects duplicate IDs instead of choosing one conflicting observation", () => {
    expect(() =>
      decodeVenueDetails({ schemaVersion: 1, venues: [detail(), detail()] })
    ).toThrow("Invalid venue details entry");
  });

  it("allows explicitly partial retained-source addresses without calling them verified", () => {
    const row = {
      ...detail(),
      status: "partial",
      website: null,
      sources: ["data/events.txt"],
      notes:
        "Street address stated in the retained event listing; no owner page found.",
    };
    expect(
      decodeVenueDetails({ schemaVersion: 1, venues: [row] }).venues
    ).toEqual([row]);
    expect(() =>
      decodeVenueDetails({
        schemaVersion: 1,
        venues: [{ ...row, status: "verified", website: detail().website }],
      })
    ).toThrow("Invalid venue details entry");
  });
});
