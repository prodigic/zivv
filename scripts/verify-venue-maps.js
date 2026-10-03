#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeVenueMaps } from "../dist/lib/ingestion/venue-maps.js";
import { getVenueMapTile } from "../dist/utils/venue-map.js";

const registry = decodeVenueMaps(
  JSON.parse(readFileSync("data/venue-maps.json", "utf8"))
);
const venues = JSON.parse(readFileSync("public/data/venues.json", "utf8"));
const exported = new Map(venues.map((venue) => [venue.id, venue]));
assert.equal(exported.size, registry.venues.length, "Incomplete map coverage");
for (const row of registry.venues) {
  const venue = exported.get(row.venueId);
  assert.equal(
    venue?.name,
    row.venueName,
    `Map identity mismatch ${row.venueId}`
  );
  if (!row.location) {
    assert.equal(
      venue.mapLocation,
      undefined,
      `Unexpected unreviewed map point ${row.venueId}`
    );
    continue;
  }
  assert.deepEqual(
    venue.mapLocation,
    row.location,
    `Map export mismatch ${row.venueId}`
  );
  const tile = getVenueMapTile(row.location);
  assert.ok(
    tile &&
      tile.x >= 0 &&
      tile.x < 2 ** tile.zoom &&
      tile.y >= 0 &&
      tile.y < 2 ** tile.zoom,
    `Invalid tile ${row.venueId}`
  );
  assert.ok(
    tile.markerX >= 0 &&
      tile.markerX < 256 &&
      tile.markerY >= 0 &&
      tile.markerY < 256,
    `Invalid marker ${row.venueId}`
  );
}
console.log(
  JSON.stringify({
    venues: venues.length,
    located: registry.venues.filter((row) => row.location).length,
    unlocated: registry.venues.filter((row) => !row.location).length,
    tileReferencesValidated: registry.venues.filter((row) => row.location)
      .length,
  })
);
