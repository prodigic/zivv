import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Venue, VenueMapLocation } from "../../types/events.js";

export interface VenueMapDetail {
  venueId: number;
  venueName: string;
  queryAddress: string | null;
  location: VenueMapLocation | null;
  notes: string;
  checkedOn: string;
}

export interface VenueMapsRegistry {
  schemaVersion: 1;
  venues: VenueMapDetail[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSourceUrl(value: unknown): boolean {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isLocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.latitude === "number" &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    typeof value.longitude === "number" &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    typeof value.precision === "string" &&
    ["address", "site", "area"].includes(value.precision) &&
    isSourceUrl(value.sourceUrl) &&
    (value.matchedAddress === undefined || isText(value.matchedAddress))
  );
}

/** Validate every observation before allowing any venue mutation. */
export function decodeVenueMaps(value: unknown): VenueMapsRegistry {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.venues)
  )
    throw new Error("Invalid venue maps registry");
  const ids = new Set<number>();
  for (const row of value.venues) {
    if (
      !isRecord(row) ||
      typeof row.venueId !== "number" ||
      !Number.isSafeInteger(row.venueId) ||
      ids.has(row.venueId) ||
      !isText(row.venueName) ||
      (row.queryAddress !== null && !isText(row.queryAddress)) ||
      (row.location !== null && !isLocation(row.location)) ||
      typeof row.notes !== "string" ||
      typeof row.checkedOn !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.checkedOn)
    )
      throw new Error(
        `Invalid venue maps entry: ${String(isRecord(row) ? row.venueId : "unknown")}`
      );
    ids.add(row.venueId);
  }
  return value as unknown as VenueMapsRegistry;
}

function sameLocation(
  first: VenueMapLocation | undefined,
  second: VenueMapLocation
): boolean {
  return (
    first?.latitude === second.latitude &&
    first.longitude === second.longitude &&
    first.precision === second.precision &&
    first.sourceUrl === second.sourceUrl &&
    first.matchedAddress === second.matchedAddress
  );
}

/** Apply exact identities; authoritative null observations remove stale pins. */
export function applyVenueMaps(
  venues: Venue[],
  registry: VenueMapsRegistry
): number[] {
  const { venues: details } = decodeVenueMaps(registry);
  const byId = new Map(venues.map((venue) => [venue.id as number, venue]));
  for (const detail of details) {
    const venue = byId.get(detail.venueId);
    if (!venue || venue.name !== detail.venueName)
      throw new Error(`Venue maps identity mismatch: ${detail.venueId}`);
  }
  const changed: number[] = [];
  for (const detail of details) {
    const venue = byId.get(detail.venueId)!;
    if (detail.location === null) {
      if (venue.mapLocation !== undefined) {
        delete venue.mapLocation;
        changed.push(detail.venueId);
      }
      continue;
    }
    if (sameLocation(venue.mapLocation, detail.location)) continue;
    venue.mapLocation = { ...detail.location };
    changed.push(detail.venueId);
  }
  return changed;
}

/** Optional reviewed registry hook for deterministic ETL exports. */
export function applyProjectVenueMaps(root: string, venues: Venue[]): number[] {
  const path = join(root, "data/venue-maps.json");
  if (!existsSync(path)) return [];
  return applyVenueMaps(
    venues,
    decodeVenueMaps(JSON.parse(readFileSync(path, "utf8")))
  );
}
