import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Venue, VenueId, VenueMapLocation } from "../../types/events.js";
import {
  applyProjectVenueMaps,
  applyVenueMaps,
  decodeVenueMaps,
  type VenueMapDetail,
} from "../../lib/ingestion/venue-maps.js";

const location: VenueMapLocation = {
  latitude: 37.7749,
  longitude: -122.4194,
  precision: "address",
  sourceUrl: "https://venue.example.org/contact",
  matchedAddress: "123 Main Street, San Francisco",
};

function venue(id = 1): Venue {
  return {
    id: id as VenueId,
    name: "Music Hall",
    slug: `music-hall-${id}`,
    normalizedName: "music hall",
    city: "San Francisco",
    address: "123 Main Street",
    ageRestriction: "all-ages",
    upcomingEvents: [],
    upcomingEventCount: 0,
    totalEventCount: 3,
    createdAtEpochMs: 100,
    updatedAtEpochMs: 200,
    sourceLineNumber: 12,
  };
}

function detail(venueId = 1): VenueMapDetail {
  return {
    venueId,
    venueName: "Music Hall",
    queryAddress: "123 Main Street, San Francisco",
    location: { ...location },
    notes: "Reviewed venue coordinates.",
    checkedOn: "2026-10-02",
  };
}

describe("reviewed venue map registry", () => {
  it("keeps same-name venues separate and preserves counts and timestamps", () => {
    const venues = [venue(), venue(2)];
    const before = structuredClone(venues);
    const second = {
      ...detail(2),
      location: { ...location, latitude: 38, precision: "site" as const },
    };
    const registry = { schemaVersion: 1 as const, venues: [detail(), second] };
    expect(applyVenueMaps(venues, registry)).toEqual([1, 2]);
    expect(venues).toEqual([
      { ...before[0], mapLocation: location },
      { ...before[1], mapLocation: second.location },
    ]);
    expect(venues[0].mapLocation).not.toBe(registry.venues[0].location);
    expect(applyVenueMaps(venues, registry)).toEqual([]);
  });

  it("clears stale pins for authoritative null observations without changing metadata", () => {
    const venues = [{ ...venue(), mapLocation: { ...location } }, venue(2)];
    const before = structuredClone(venues);
    expect(
      applyVenueMaps(venues, {
        schemaVersion: 1,
        venues: [
          { ...detail(), location: null },
          { ...detail(2), location: null, queryAddress: null },
        ],
      })
    ).toEqual([1]);
    expect(venues).toEqual([venue(), before[1]]);
    expect(
      applyVenueMaps(venues, {
        schemaVersion: 1,
        venues: [{ ...detail(), location: null }],
      })
    ).toEqual([]);
  });

  it("rejects unknown or renamed identities before applying any row", () => {
    for (const invalid of [
      { ...detail(2), venueName: "Other venue" },
      detail(99),
    ]) {
      const venues = [venue(), venue(2)];
      const before = structuredClone(venues);
      expect(() =>
        applyVenueMaps(venues, {
          schemaVersion: 1,
          venues: [detail(), invalid],
        })
      ).toThrow("identity mismatch");
      expect(venues).toEqual(before);
    }
  });

  it.each([
    { ...location, latitude: NaN },
    { ...location, latitude: Infinity },
    { ...location, latitude: 90.01 },
    { ...location, latitude: -90.01 },
    { ...location, longitude: 180.01 },
    { ...location, longitude: -180.01 },
    { ...location, longitude: -Infinity },
    { ...location, latitude: "37" },
    { ...location, precision: "guessed" },
    { ...location, precision: ["address"] },
    { ...location, sourceUrl: "javascript:alert(1)" },
    { ...location, sourceUrl: "https://user:secret@venue.example.org/" },
    { ...location, matchedAddress: " " },
  ])(
    "rejects invalid coordinates and unsafe evidence before mutation",
    (bad) => {
      const venues = [venue(), venue(2)];
      const before = structuredClone(venues);
      const registry = {
        schemaVersion: 1,
        venues: [detail(), { ...detail(2), location: bad }],
      };
      expect(() => decodeVenueMaps(registry)).toThrow(
        "Invalid venue maps entry"
      );
      expect(() =>
        applyVenueMaps(
          venues,
          registry as unknown as Parameters<typeof applyVenueMaps>[1]
        )
      ).toThrow("Invalid venue maps entry");
      expect(venues).toEqual(before);
    }
  );

  it("rejects duplicate IDs before applying coordinates", () => {
    const venues = [venue()];
    expect(() =>
      applyVenueMaps(venues, {
        schemaVersion: 1,
        venues: [detail(), detail()],
      })
    ).toThrow("Invalid venue maps entry");
    expect(venues[0].mapLocation).toBeUndefined();
  });

  it("loads the optional project registry without changing any other metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "zivv-venue-maps-"));
    try {
      const venues = [venue()];
      expect(applyProjectVenueMaps(root, venues)).toEqual([]);
      venues[0].mapLocation = { ...location };
      expect(applyProjectVenueMaps(root, venues)).toEqual([]);
      expect(venues[0].mapLocation).toEqual(location);
      delete venues[0].mapLocation;
      mkdirSync(join(root, "data"));
      writeFileSync(
        join(root, "data/venue-maps.json"),
        JSON.stringify({ schemaVersion: 1, venues: [detail()] })
      );
      expect(applyProjectVenueMaps(root, venues)).toEqual([1]);
      expect(venues[0]).toEqual({ ...venue(), mapLocation: location });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
