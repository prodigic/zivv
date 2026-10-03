#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeVenueMaps } from "../dist/lib/ingestion/venue-maps.js";
import { getVenueMapTile } from "../dist/utils/venue-map.js";

/** Parse quoted Census CSV, including escaped quotes and embedded newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  assert.equal(quoted, false, "Unterminated quoted CSV field");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
const directory = "data/research/venue-maps";
const researched = JSON.parse(
  readFileSync("data/venue-details.json", "utf8")
).venues;
const queries = JSON.parse(
  readFileSync(`${directory}/census-queries.json`, "utf8")
).queries;
const response = parseCsv(
  readFileSync(`${directory}/census-response.csv`, "utf8")
);
const byQuery = new Map(response.map((row) => [row[0], row]));
assert.equal(
  response.length,
  queries.length,
  "Incomplete Census batch response"
);
assert.equal(
  byQuery.size,
  queries.length,
  "Duplicate Census response identity"
);
for (const query of queries)
  assert.ok(byQuery.has(query.id), `Missing Census query ${query.id}`);
const nonExactNotes = new Map([
  [
    1859422971,
    "Same house number and Homestead Road; Census includes its west direction.",
  ],
  [
    655578766,
    "Same house number and fairground campus; Census street name uses singular Fairground.",
  ],
  [
    954167517,
    "Same numbered street address; Building B is not a separate geocoder street.",
  ],
  [
    873142532,
    "Same house number and Telegraph corridor; Census omits Avenue suffix.",
  ],
  [1034390208, "Same house number and Broadway; Census adds Street suffix."],
  [
    1625417326,
    "Same house number and Octavia corridor; Census retains legacy Street suffix instead of Boulevard.",
  ],
  [
    72150299,
    "Same numbered building; above Tay Ho describes a separate room, not a different street.",
  ],
  [
    1958317139,
    "Same 401A Georgia Street address despite Census non-exact classification.",
  ],
  [
    2031130888,
    "Same house number and Telegraph corridor; Census omits Avenue suffix.",
  ],
  [
    2137851775,
    "Same house number and Telegraph corridor; Census omits Avenue suffix.",
  ],
]);
const normalizeCity = (value) =>
  value
    .toUpperCase()
    .replace(/^ST\.?\s/, "SAINT ")
    .replace(/[^A-Z0-9]/g, "");
const censusByVenue = new Map();
for (const query of queries) {
  const row = byQuery.get(query.id);
  let location = null;
  let notes = `Census result: ${row[2]}${row[3] ? ` / ${row[3]}` : ""}. No unique supported address coordinate was selected.`;
  const parts = row[4]?.split(",").map((value) => value.trim()) ?? [];
  const city = parts.at(-3),
    state = parts.at(-2);
  const supported =
    row[2] === "Match" &&
    (row[3] === "Exact" || nonExactNotes.has(Number(query.id)));
  if (
    supported &&
    city &&
    normalizeCity(city) === normalizeCity(query.city) &&
    state === "CA"
  ) {
    const [longitude, latitude] = row[5].split(",").map(Number);
    assert.ok(
      Number.isFinite(latitude) && Number.isFinite(longitude),
      "Invalid Census coordinates"
    );
    assert.ok(
      latitude >= 32 &&
        latitude <= 42 &&
        longitude >= -125 &&
        longitude <= -114,
      "Census match outside California"
    );
    const source = new URL(
      "https://geocoding.geo.census.gov/geocoder/locations/address"
    );
    source.search = new URLSearchParams({
      street: query.street,
      city: query.city,
      state: "CA",
      benchmark: "Public_AR_Current",
      format: "json",
    }).toString();
    location = {
      latitude,
      longitude,
      precision: "address",
      sourceUrl: source.href,
      matchedAddress: row[4],
    };
    notes =
      `Census ${row[3]} address match; interpolated street-address point, not a verified venue entrance. ${nonExactNotes.get(Number(query.id)) ?? ""}`.trim();
  } else if (supported)
    notes += " Returned postal city/state differed; requires review.";
  for (const id of query.venueIds) censusByVenue.set(id, { location, notes });
}
const manual = new Map();
for (const filename of [
  "manual-locations.json",
  "census-manual-locations.json",
]) {
  if (!existsSync(`${directory}/${filename}`)) continue;
  for (const row of JSON.parse(
    readFileSync(`${directory}/${filename}`, "utf8")
  )) {
    const identity = researched.find((venue) => venue.venueId === row.venueId);
    assert.equal(
      identity?.venueName,
      row.venueName,
      "Manual map identity mismatch"
    );
    if (identity.status === "unresolved" && row.location)
      throw new Error(
        `Ambiguous venue ${row.venueId} cannot receive a map point`
      );
    assert.ok(
      !manual.has(row.venueId),
      `Duplicate manual map identity ${row.venueId}`
    );
    manual.set(row.venueId, row);
  }
}
const venues = researched.map((row) => {
  const queryAddress =
    row.streetAddress && row.city
      ? `${row.streetAddress}, ${row.city}, CA`
      : null;
  const result =
    row.status === "unresolved"
      ? {
          location: null,
          notes: `Venue identity remains unresolved: ${row.notes}`,
        }
      : (manual.get(row.venueId) ??
        censusByVenue.get(row.venueId) ?? {
          location: null,
          notes: `No supported coordinates selected. Address research limitation: ${row.notes} Use the venue-specific OpenStreetMap search link.`,
        });
  return {
    venueId: row.venueId,
    venueName: row.venueName,
    queryAddress,
    location: result.location,
    notes: result.notes,
    checkedOn: "2026-10-02",
  };
});
const registry = decodeVenueMaps({ schemaVersion: 1, venues });
writeFileSync("data/venue-maps.json", JSON.stringify(registry, null, 2) + "\n");
const escape = (value) =>
  String(value ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
const lines = [
  "# Venue OpenStreetMap tile catalog",
  "",
  "Every catalog identity appears below. A tile URL is a reference to an on-demand map image; no tiles were bulk downloaded. Address coordinates are approximate street-address matches. Site/area points document their scope. Entries without coordinates link to map search instead of an invented marker.",
  "",
  "© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Tile usage: [OSMF policy](https://operations.osmfoundation.org/policies/tiles/). See [method and verification](venue-maps.md).",
  "",
  "| ID | Venue | Map precision | Coordinates | Open map | Tile | Source and notes |",
  "| --- | --- | --- | --- | --- | --- | --- |",
];
for (const row of [...venues].sort(
  (a, b) => a.venueName.localeCompare(b.venueName) || a.venueId - b.venueId
)) {
  const tile = getVenueMapTile(row.location);
  const query = new URLSearchParams({
    query: row.queryAddress ?? row.venueName,
  });
  const link = tile?.mapUrl ?? `https://www.openstreetmap.org/search?${query}`;
  lines.push(
    `| ${row.venueId} | ${escape(row.venueName)} | ${row.location?.precision ?? "unlocated"} | ${row.location ? `${row.location.latitude}, ${row.location.longitude}` : "—"} | [${tile ? "map" : "search"}](${link}) | ${tile ? `[${tile.zoom}/${tile.x}/${tile.y}](${tile.url})` : "—"} | ${row.location ? `[source](${row.location.sourceUrl}) ` : ""}${escape(row.notes)} |`
  );
}
writeFileSync("docs/research/venue-map-catalog.md", lines.join("\n") + "\n");
console.log(
  JSON.stringify({
    venues: venues.length,
    located: venues.filter((row) => row.location).length,
    unlocated: venues.filter((row) => !row.location).length,
    address: venues.filter((row) => row.location?.precision === "address")
      .length,
    site: venues.filter((row) => row.location?.precision === "site").length,
    area: venues.filter((row) => row.location?.precision === "area").length,
  })
);
