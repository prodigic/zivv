#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { decodeVenueDetails } from "../dist/lib/ingestion/venue-details.js";

const registry = decodeVenueDetails(
  JSON.parse(readFileSync("data/venue-details.json", "utf8"))
);
const venues = JSON.parse(readFileSync("public/data/venues.json", "utf8"));
const details = new Map(registry.venues.map((row) => [row.venueId, row]));
const failures = [];
if (venues.length !== details.size)
  failures.push(
    `Coverage mismatch: ${venues.length} exported venues, ${details.size} researched IDs`
  );
for (const venue of venues) {
  const row = details.get(venue.id);
  if (!row || row.venueName !== venue.name) {
    failures.push(`Missing or mismatched research identity: ${venue.id}`);
    continue;
  }
  if (/research pending/i.test(row.notes))
    failures.push(`Research is unfinished: ${venue.id}`);
  if (row.status === "unresolved") continue;
  for (const [field, value] of [
    ["address", row.streetAddress],
    ["city", row.city],
    ["website", row.website],
  ]) {
    if (value !== null && venue[field] !== value)
      failures.push(`Export does not contain reviewed ${field}: ${venue.id}`);
  }
}
if (failures.length) throw new Error(failures.join("\n"));
console.log(
  JSON.stringify(
    {
      venues: venues.length,
      verified: registry.venues.filter((row) => row.status === "verified")
        .length,
      partial: registry.venues.filter((row) => row.status === "partial").length,
      unresolved: registry.venues.filter((row) => row.status === "unresolved")
        .length,
      researchedAddresses: registry.venues.filter(
        (row) => row.status !== "unresolved" && row.streetAddress !== null
      ).length,
      researchedWebsites: registry.venues.filter(
        (row) => row.status !== "unresolved" && row.website !== null
      ).length,
    },
    null,
    2
  )
);
