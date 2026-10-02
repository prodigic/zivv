import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Venue } from "../../types/events.js";

interface VenueLocationCorrection {
  venueId: number;
  venueName: string;
  city: string;
  address?: string;
  sources: string[];
}

/** Apply reviewed location metadata to known IDs without changing event identity.
 * The name guard prevents a registry entry from silently targeting another venue.
 * This also runs during export so an older private ledger retains the corrections.
 */
export function applyVenueLocationCorrections(
  root: string,
  venues: Venue[]
): void {
  const path = join(root, "data/venue-location-corrections.json");
  if (!existsSync(path)) return;
  const corrections: VenueLocationCorrection[] = JSON.parse(
    readFileSync(path, "utf8")
  );
  if (!Array.isArray(corrections))
    throw new Error("Invalid venue location corrections");
  const ids = new Set<number>();
  for (const correction of corrections) {
    if (
      !Number.isSafeInteger(correction.venueId) ||
      ids.has(correction.venueId) ||
      typeof correction.venueName !== "string" ||
      typeof correction.city !== "string" ||
      !correction.city.trim() ||
      !Array.isArray(correction.sources) ||
      !correction.sources.length ||
      correction.sources.some(
        (source) =>
          typeof source !== "string" ||
          (!source.startsWith("https://") && source !== "data/events.txt")
      ) ||
      (correction.address !== undefined &&
        typeof correction.address !== "string")
    ) {
      throw new Error(
        `Invalid venue location correction: ${correction.venueId}`
      );
    }
    ids.add(correction.venueId);
    const venue = venues.find((v) => v.id === correction.venueId);
    if (!venue) continue;
    if (venue.name !== correction.venueName)
      throw new Error(
        `Venue location correction name mismatch: ${correction.venueId}`
      );
    venue.city = correction.city;
    if (correction.address !== undefined) venue.address = correction.address;
  }
}
