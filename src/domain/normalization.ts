const CITY_ALIASES: Readonly<Record<string, string>> = {
  sf: "San Francisco",
  "s.f.": "San Francisco",
  "san fran": "San Francisco",
  "san francisco": "San Francisco",
  oakland: "Oakland",
  berkeley: "Berkeley",
};

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeName(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeCity(value: string): string {
  const cleaned = normalizeWhitespace(value).replace(/[.,]+$/, "");
  return CITY_ALIASES[cleaned.toLocaleLowerCase()] ?? cleaned;
}

export function createSlug(value: string): string {
  const normalized = normalizeName(value);
  return normalized.replace(/\s+/g, "-");
}

export interface ArtistNameInput {
  readonly name: string;
  readonly aliasOf?: string;
}

export interface NormalizedArtistName {
  readonly displayName: string;
  readonly normalizedName: string;
  readonly aliasOf?: string;
}

export function normalizeArtistNames(names: readonly ArtistNameInput[]): NormalizedArtistName[] {
  return names
    .map(({ name, aliasOf }) => ({
      displayName: normalizeWhitespace(name),
      normalizedName: normalizeName(name),
      ...(aliasOf === undefined ? {} : { aliasOf: normalizeName(aliasOf) }),
    }))
    .filter((artist) => artist.normalizedName.length > 0);
}
