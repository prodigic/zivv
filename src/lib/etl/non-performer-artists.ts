import { StringNormalizer } from "./utils.js";

/** Names that describe event amenities or programming, rather than performers. */
const NON_PERFORMER_ARTIST_NAMES = new Set([
  "and the cast",
  "art",
  "artists",
  "castro street fair",
  "cholos vs vampires",
  "cholos vs. vampires",
  "cholos vs vampiers",
  "cholos vs. vampiers",
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
  "kexp vinelands live",
  "live cast",
  "lucha libre",
  "membership meeting",
  "punks parade craft fair",
  "rock'n roll flea market",
  "screening of latest rhosl episode",
  "scuff queer line dancing f. jail preacher",
  "street",
  "vendors",
  "volunteer orientation",
]);

export function isNonPerformerArtistName(name: string): boolean {
  return NON_PERFORMER_ARTIST_NAMES.has(StringNormalizer.normalizeName(name));
}
