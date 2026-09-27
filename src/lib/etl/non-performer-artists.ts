import { StringNormalizer } from "./utils.js";

/** Names that describe event amenities or programming, rather than performers. */
const NON_PERFORMER_ARTIST_NAMES = new Set([
  "and the cast",
  "art",
  "artists",
  "castro street fair",
  "clothing swap",
  "country fair",
  "craft brew",
  "crafts",
  "djs",
  "emo nite",
  "emo night",
  "fencing",
  "folsom street fair",
  "hamdi fc vs. san francisco",
  "lucha libre",
  "membership meeting",
  "punks parade craft fair",
  "street",
  "vendors",
  "volunteer orientation",
]);

export function isNonPerformerArtistName(name: string): boolean {
  return NON_PERFORMER_ARTIST_NAMES.has(StringNormalizer.normalizeName(name));
}
