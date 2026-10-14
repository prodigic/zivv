import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Artist } from "../../types/events.js";
import type { ArtistVibe } from "../../types/artist-reviews.js";
import { isPosterUrl } from "../../utils/event-poster.js";

export interface ReviewedArtistVibe extends ArtistVibe {
  artistId: number;
  artistName: string;
  identityEvidence: string;
}
export interface ArtistReviewRegistry {
  schemaVersion: 1;
  artists: ReviewedArtistVibe[];
}
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const date = (value: unknown): value is string =>
  text(value) &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

/** Validate the whole registry before applying any reviewed description. */
export function decodeArtistReviews(value: unknown): ArtistReviewRegistry {
  if (!value || typeof value !== "object")
    throw new Error("Invalid artist review registry");
  const registry = value as Record<string, unknown>;
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.artists))
    throw new Error("Invalid artist review registry");
  const ids = new Set<number>();
  for (const input of registry.artists) {
    const row = input as Partial<ReviewedArtistVibe> | null;
    if (
      !row ||
      !Number.isSafeInteger(row.artistId) ||
      row.artistId! <= 0 ||
      ids.has(row.artistId!) ||
      !text(row.artistName) ||
      !text(row.summary) ||
      !text(row.identityEvidence) ||
      !date(row.checkedOn) ||
      !["release", "live", "mixed"].includes(String(row.basis)) ||
      !Array.isArray(row.reviews) ||
      !row.reviews.length
    ) {
      throw new Error("Invalid artist review entry");
    }
    const urls = new Set<string>();
    for (const review of row.reviews) {
      if (
        !review ||
        !isPosterUrl(review.url) ||
        urls.has(review.url) ||
        !text(review.title) ||
        !text(review.publication) ||
        !text(review.reviewedWork) ||
        (review.author !== null && !text(review.author)) ||
        (review.publishedOn !== null &&
          (!date(review.publishedOn) || review.publishedOn > row.checkedOn)) ||
        !["live", "release"].includes(review.kind)
      )
        throw new Error("Invalid artist review source");
      urls.add(review.url);
    }
    const kinds = new Set(row.reviews.map((review) => review.kind));
    const basis = kinds.size === 2 ? "mixed" : row.reviews[0].kind;
    if (row.basis !== basis)
      throw new Error("Artist review basis does not match its sources");
    ids.add(row.artistId!);
  }
  return value as ArtistReviewRegistry;
}

/** Preserve canonical artist identity; renamed or missing records need re-review. */
export function applyArtistReviews(
  artists: Artist[],
  value: unknown
): number[] {
  const registry = decodeArtistReviews(value);
  const byId = new Map(artists.map((artist) => [Number(artist.id), artist]));
  const stale: number[] = [];
  for (const row of registry.artists) {
    const artist = byId.get(row.artistId);
    if (!artist || artist.name !== row.artistName) {
      if (artist) delete artist.vibe;
      stale.push(row.artistId);
      continue;
    }
    artist.vibe = {
      summary: row.summary,
      basis: row.basis,
      checkedOn: row.checkedOn,
      reviews: row.reviews,
    };
  }
  return stale;
}

export function applyProjectArtistReviews(
  projectRoot: string,
  artists: Artist[]
): number[] {
  const path = join(projectRoot, "data/artist-reviews.json");
  return existsSync(path)
    ? applyArtistReviews(artists, JSON.parse(readFileSync(path, "utf8")))
    : [];
}
