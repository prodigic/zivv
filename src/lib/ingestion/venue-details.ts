import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Venue } from "../../types/events.js";

export interface VenueDetail {
  venueId: number;
  venueName: string;
  streetAddress: string | null;
  city: string | null;
  website: string | null;
  status: "verified" | "partial" | "unresolved";
  sources: string[];
  notes: string;
  checkedOn: string;
}

export interface VenueDetailsRegistry {
  schemaVersion: 1;
  venues: VenueDetail[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isWebAddress(value: unknown): value is string {
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

function isEvidenceSource(value: unknown): value is string {
  return (
    isWebAddress(value) ||
    value === "data/events.txt" ||
    value === "data/venues.txt"
  );
}

/** Validate the complete research registry before changing any venue metadata. */
export function decodeVenueDetails(value: unknown): VenueDetailsRegistry {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.venues)
  )
    throw new Error("Invalid venue details registry");
  const ids = new Set<number>();
  for (const row of value.venues) {
    if (
      !isRecord(row) ||
      !Number.isSafeInteger(row.venueId) ||
      typeof row.venueId !== "number" ||
      ids.has(row.venueId) ||
      !isText(row.venueName) ||
      !["verified", "partial", "unresolved"].includes(String(row.status)) ||
      ![row.streetAddress, row.city].every(
        (field) => field === null || isText(field)
      ) ||
      (row.website !== null && !isWebAddress(row.website)) ||
      !Array.isArray(row.sources) ||
      !row.sources.every(isEvidenceSource) ||
      typeof row.notes !== "string" ||
      typeof row.checkedOn !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.checkedOn) ||
      (row.status !== "unresolved" && !row.sources.length) ||
      (row.status === "verified" &&
        (!isText(row.streetAddress) ||
          !isText(row.city) ||
          !isWebAddress(row.website) ||
          !row.sources.some(isWebAddress)))
    )
      throw new Error(
        `Invalid venue details entry: ${String(isRecord(row) ? row.venueId : "unknown")}`
      );
    ids.add(row.venueId);
  }
  return value as unknown as VenueDetailsRegistry;
}

/** Resolve reviewed metadata by stable ID and exact name, without merging venues. */
export function applyVenueDetails(
  venues: Venue[],
  registry: VenueDetailsRegistry
): number[] {
  const { venues: details } = decodeVenueDetails(registry);
  const byId = new Map(venues.map((venue) => [venue.id as number, venue]));
  for (const detail of details) {
    const venue = byId.get(detail.venueId);
    if (!venue || venue.name !== detail.venueName)
      throw new Error(`Venue details identity mismatch: ${detail.venueId}`);
  }
  const changed: number[] = [];
  for (const detail of details) {
    if (detail.status === "unresolved") continue;
    const venue = byId.get(detail.venueId)!;
    let updated = false;
    for (const [field, value] of [
      ["address", detail.streetAddress],
      ["city", detail.city],
      ["website", detail.website],
    ] as const) {
      if (value !== null && venue[field] !== value) {
        venue[field] = value;
        updated = true;
      }
    }
    if (updated) changed.push(detail.venueId);
  }
  return changed;
}

/** Reapply reviewed details during export so stale snapshots cannot lose them. */
export function applyProjectVenueDetails(
  root: string,
  venues: Venue[]
): number[] {
  const path = join(root, "data/venue-details.json");
  if (!existsSync(path)) return [];
  return applyVenueDetails(
    venues,
    decodeVenueDetails(JSON.parse(readFileSync(path, "utf8")))
  );
}
