import { isArtistLink } from "../../utils/artist-links.js";
import { isEventPoster, isPosterUrl } from "../../utils/event-poster.js";
import { inspectFridayVerifiedRelease } from "./friday-verified-release.js";
import { parseReleaseCandidate } from "./release-candidate.js";
import { sha256 } from "./steve-preflight.js";

type PublicRecord = Record<string, unknown>;
type CoverageInput = Parameters<typeof inspectFridayVerifiedRelease>[0] & {
  publicFiles: ReadonlyMap<string, Buffer>;
};

function invalid(): never {
  throw Error("FRIDAY_PUBLICATION_COVERAGE_UNVERIFIED");
}

function object(value: unknown): PublicRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as PublicRecord)
    : null;
}

function records(value: unknown): PublicRecord[] {
  if (!Array.isArray(value)) return invalid();
  return value.map((entry) => object(entry) ?? invalid());
}

function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return invalid();
  return value;
}

function index(rows: PublicRecord[]): Map<number, PublicRecord> {
  const byId = new Map(rows.map((entry) => [id(entry.id), entry]));
  if (byId.size !== rows.length) return invalid();
  return byId;
}

function hasCitedReview(artist: PublicRecord): boolean {
  const vibe = object(artist.vibe);
  return (
    typeof vibe?.summary === "string" &&
    vibe.summary.trim().length > 0 &&
    Array.isArray(vibe.reviews) &&
    vibe.reviews.some((row) => isPosterUrl(object(row)?.url))
  );
}

function hasMapLocation(venue: PublicRecord): boolean {
  const map = object(venue.mapLocation);
  return (
    typeof map?.latitude === "number" &&
    Math.abs(map.latitude) <= 90 &&
    typeof map.longitude === "number" &&
    Math.abs(map.longitude) <= 180 &&
    (map.precision === "address" ||
      map.precision === "site" ||
      map.precision === "area") &&
    isPosterUrl(map.sourceUrl)
  );
}

function countMissing(
  members: ReadonlySet<number>,
  byId: ReadonlyMap<number, PublicRecord>,
  available: (record: PublicRecord) => boolean
): number {
  let missing = 0;
  for (const member of members) {
    const record = byId.get(member) ?? invalid();
    if (!available(record)) missing++;
  }
  return missing;
}

/** Summarize optional fields for the frozen weekly membership in the verified
 * public artifacts. This uses retained bytes and performs no research or send. */
export function inspectFridayVerifiedReleaseCoverage(input: CoverageInput) {
  const release = inspectFridayVerifiedRelease(input);
  if (!release) return null;
  try {
    const candidate = parseReleaseCandidate(input.candidate);
    if (candidate.candidateId !== release.candidateId) return invalid();
    const inventory = new Map(candidate.files.map((file) => [file.path, file]));
    const decode = (bytes: Buffer): unknown =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const read = (filename: string) => {
      const path = "data/" + filename;
      const file = inventory.get(path);
      const bytes = input.publicFiles.get(path);
      if (
        !file ||
        !Buffer.isBuffer(bytes) ||
        bytes.length !== file.size ||
        sha256(bytes) !== file.sha256
      )
        return invalid();
      return decode(bytes);
    };

    const manifest = object(read("manifest.json")) ?? invalid();
    const weekly = object(manifest.weeklyEdition) ?? invalid();
    const chunks = object(manifest.chunks) ?? invalid();
    if (
      inventory.get("data/manifest.json")?.sha256 !==
        candidate.manifestSha256 ||
      !Array.isArray(weekly.eventIds) ||
      object(chunks.artists)?.filename !== "artists.json" ||
      object(chunks.venues)?.filename !== "venues.json"
    )
      return invalid();
    const members = new Set(weekly.eventIds.map(id));
    if (members.size !== release.addedEventCount) return invalid();

    const usedFiles = new Set<string>();
    const editionEvents: PublicRecord[] = [];
    for (const chunk of records(chunks.events)) {
      const { filename } = chunk;
      if (
        typeof filename !== "string" ||
        !/^events-\d{4}-(?:0[1-9]|1[0-2])\.json$/.test(filename) ||
        usedFiles.has(filename)
      )
        return invalid();
      usedFiles.add(filename);
      const file = object(read(filename)) ?? invalid();
      for (const event of records(file.events)) {
        if (members.has(id(event.id))) editionEvents.push(event);
      }
    }
    if (index(editionEvents).size !== members.size) return invalid();

    const artistIds = new Set<number>();
    const venueIds = new Set<number>();
    for (const event of editionEvents) {
      if (!Array.isArray(event.artistIds)) return invalid();
      artistIds.add(id(event.headlinerArtistId));
      for (const artist of event.artistIds) artistIds.add(id(artist));
      venueIds.add(id(event.venueId));
    }
    const artists = index(records(read("artists.json")));
    const venues = index(records(read("venues.json")));
    return {
      ...release,
      coverage: {
        missingShowArtwork: editionEvents.filter(
          (event) => !isEventPoster(event.poster)
        ).length,
        distinctArtists: artistIds.size,
        artistsWithoutLinks: countMissing(
          artistIds,
          artists,
          (artist) =>
            Array.isArray(artist.links) && artist.links.some(isArtistLink)
        ),
        artistsWithoutReviews: countMissing(artistIds, artists, hasCitedReview),
        distinctVenues: venueIds.size,
        venuesWithoutMapLocation: countMissing(
          venueIds,
          venues,
          hasMapLocation
        ),
      },
    };
  } catch {
    return invalid();
  }
}
