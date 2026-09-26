import { StringNormalizer } from "./utils.js";

/** Names that describe event amenities or programming, rather than performers. */
const NON_PERFORMER_ARTIST_NAMES = new Set([
  "art",
  "artists",
  "clothing swap",
  "craft brew",
  "djs",
  "fencing",
  "lucha libre",
  "punks parade craft fair",
  "vendors",
  "volunteer orientation",
]);

export function isNonPerformerArtistName(name: string): boolean {
  return NON_PERFORMER_ARTIST_NAMES.has(StringNormalizer.normalizeName(name));
}
