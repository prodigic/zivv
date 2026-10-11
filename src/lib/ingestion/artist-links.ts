import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Artist } from "../../types/events.js";
import type { ArtistLink } from "../../types/artist-links.js";
import { isArtistLink } from "../../utils/artist-links.js";
import { isPosterUrl } from "../../utils/event-poster.js";

export interface ReviewedArtistLink extends ArtistLink {
  sourceUrl: string;
  checkedOn: string;
  evidence: string;
}
export interface ArtistLinksRegistry {
  schemaVersion: 1;
  artists: {
    artistId: number;
    artistName: string;
    links: ReviewedArtistLink[];
  }[];
}

/** Reject malformed or conflicting evidence before mutating any public artist. */
export function decodeArtistLinks(value: unknown): ArtistLinksRegistry {
  const registry = value as Partial<ArtistLinksRegistry> | null;
  if (
    !registry ||
    registry.schemaVersion !== 1 ||
    !Array.isArray(registry.artists)
  )
    throw new Error("Invalid artist link registry");
  const ids = new Set<number>();
  for (const row of registry.artists) {
    if (
      !row ||
      !Number.isSafeInteger(row.artistId) ||
      row.artistId <= 0 ||
      ids.has(row.artistId) ||
      typeof row.artistName !== "string" ||
      !row.artistName.trim() ||
      !Array.isArray(row.links) ||
      !row.links.length
    )
      throw new Error("Invalid artist link entry");
    const urls = new Set<string>();
    for (const link of row.links) {
      if (
        !isArtistLink(link) ||
        !isPosterUrl(link.sourceUrl) ||
        typeof link.evidence !== "string" ||
        !link.evidence.trim() ||
        typeof link.checkedOn !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(link.checkedOn) ||
        Number.isNaN(Date.parse(link.checkedOn)) ||
        new Date(link.checkedOn).toISOString().slice(0, 10) !==
          link.checkedOn ||
        urls.has(link.url)
      )
        throw new Error(`Invalid artist link source: ${row.artistId}`);
      urls.add(link.url);
    }
    ids.add(row.artistId);
  }
  return registry as ArtistLinksRegistry;
}

/** Keep researched links independent of whether the act has a published review. */
export function applyArtistLinks(artists: Artist[], value: unknown): number[] {
  const registry = decodeArtistLinks(value);
  const byId = new Map(artists.map((artist) => [Number(artist.id), artist]));
  const stale: number[] = [];
  for (const row of registry.artists) {
    const artist = byId.get(row.artistId);
    if (!artist || artist.name !== row.artistName) {
      if (artist) delete artist.links;
      stale.push(row.artistId);
      continue;
    }
    artist.links = row.links.map(({ kind, url, embed }) => ({
      kind,
      url,
      ...(embed
        ? { embed: { albumId: embed.albumId, title: embed.title } }
        : {}),
    }));
  }
  return stale;
}

export function applyProjectArtistLinks(
  projectRoot: string,
  artists: Artist[]
): number[] {
  const path = join(projectRoot, "data/artist-links.json");
  return existsSync(path)
    ? applyArtistLinks(artists, JSON.parse(readFileSync(path, "utf8")))
    : [];
}
