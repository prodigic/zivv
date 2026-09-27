import type { Artist, Event, EventId } from "../../types/events.js";
import { isNonPerformerArtistName } from "../etl/non-performer-artists.js";

export const LOCAL_ARTIST_VERIFICATION_SCHEMA_VERSION = 1 as const;

export type LocalArtistVerificationStatus =
  "local" | "non-local" | "unresolved";

export interface LocalArtistVerificationEntry {
  name: string;
  normalizedName: string;
  status: LocalArtistVerificationStatus;
  verifiedAtEpochMs: number;
  method: string;
  evidence?: string;
  location?: string;
  sources?: string[];
  lastSeenEditionId?: string;
}

export interface LocalArtistVerificationLedger {
  schemaVersion: typeof LOCAL_ARTIST_VERIFICATION_SCHEMA_VERSION;
  entries: LocalArtistVerificationEntry[];
}

export interface WeeklyLocalArtistCandidate {
  name: string;
  normalizedName: string;
  eventIds: EventId[];
}

/** Collapse role markers so one act is checked once across lineup revisions. */
export function normalizeVerifiedArtistName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase()
    .replace(/\s*\([^)]*\)\s*$/u, "")
    .replace(/\s+/gu, " ");
}

export function emptyLocalArtistVerificationLedger(): LocalArtistVerificationLedger {
  return {
    schemaVersion: LOCAL_ARTIST_VERIFICATION_SCHEMA_VERSION,
    entries: [],
  };
}

export function seedLocalArtistVerificationLedger(
  localNames: string[],
  nonLocalNames: string[],
  verifiedAtEpochMs: number
): LocalArtistVerificationLedger {
  const ledger = emptyLocalArtistVerificationLedger();
  for (const name of localNames)
    upsertLocalArtistVerification(ledger, {
      name,
      status: "local",
      verifiedAtEpochMs,
      method: "legacy-local-artist-list",
    });
  for (const name of nonLocalNames)
    upsertLocalArtistVerification(ledger, {
      name,
      status: "non-local",
      verifiedAtEpochMs,
      method: "legacy-local-artist-exclude-list",
    });
  return ledger;
}

export function upsertLocalArtistVerification(
  ledger: LocalArtistVerificationLedger,
  input: Omit<LocalArtistVerificationEntry, "normalizedName"> & {
    normalizedName?: string;
  }
): LocalArtistVerificationEntry {
  const normalizedName =
    input.normalizedName ?? normalizeVerifiedArtistName(input.name);
  if (!normalizedName) throw new Error("Artist verification requires a name");
  const entry: LocalArtistVerificationEntry = {
    name: input.name.trim(),
    normalizedName,
    status: input.status,
    verifiedAtEpochMs: input.verifiedAtEpochMs,
    method: input.method,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.sources ? { sources: input.sources } : {}),
    ...(input.lastSeenEditionId
      ? { lastSeenEditionId: input.lastSeenEditionId }
      : {}),
  };
  const index = ledger.entries.findIndex(
    (item) => item.normalizedName === normalizedName
  );
  if (index === -1) ledger.entries.push(entry);
  else ledger.entries[index] = entry;
  ledger.entries.sort((a, b) =>
    a.normalizedName.localeCompare(b.normalizedName)
  );
  return entry;
}

export function collectUnverifiedWeeklyArtists(
  events: Event[],
  artists: Artist[],
  weeklyEventIds: Iterable<number>,
  ledger: LocalArtistVerificationLedger
): WeeklyLocalArtistCandidate[] {
  const artistById = new Map(artists.map((artist) => [artist.id, artist]));
  const checked = new Set(
    ledger.entries.filter(isVerifiedOrigin).map((entry) => entry.normalizedName)
  );
  const wanted = new Set([...weeklyEventIds]);
  const candidates = new Map<string, WeeklyLocalArtistCandidate>();
  for (const event of events) {
    if (!wanted.has(Number(event.id))) continue;
    for (const artistId of event.artistIds) {
      const artist = artistById.get(artistId);
      if (!artist) continue;
      if (isNonPerformerArtistName(artist.name)) continue;
      const normalizedName = normalizeVerifiedArtistName(artist.name);
      if (!normalizedName || checked.has(normalizedName)) continue;
      const candidate = candidates.get(normalizedName) ?? {
        name: artist.name,
        normalizedName,
        eventIds: [],
      };
      if (!candidate.eventIds.includes(event.id))
        candidate.eventIds.push(event.id);
      candidates.set(normalizedName, candidate);
    }
  }
  return [...candidates.values()].sort((a, b) =>
    a.normalizedName.localeCompare(b.normalizedName)
  );
}

export function namesForVerificationStatus(
  ledger: LocalArtistVerificationLedger,
  status: LocalArtistVerificationStatus,
  artists: Pick<Artist, "name">[] = []
): string[] {
  const verified = ledger.entries.filter(
    (entry) => entry.status === status && isVerifiedOrigin(entry)
  );
  const keys = new Set(verified.map((entry) => entry.normalizedName));
  return [
    ...new Set([
      ...verified.map((entry) => entry.name),
      ...artists
        .filter((artist) => keys.has(normalizeVerifiedArtistName(artist.name)))
        .map((artist) => artist.name),
    ]),
  ].sort((a, b) => a.localeCompare(b));
}

/** Select performances by their local calendar date, independently of when imported. */
export function weeklyPerformanceEventIds(
  events: Pick<Event, "id" | "date" | "status">[],
  startDate: string,
  endDateExclusive: string
): EventId[] {
  const validDate = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  if (
    !validDate(startDate) ||
    !validDate(endDateExclusive) ||
    startDate >= endDateExclusive
  ) {
    throw new Error(
      "Artist review requires a valid, increasing calendar-date window"
    );
  }
  return events
    .filter(
      (event) =>
        event.date >= startDate &&
        event.date < endDateExclusive &&
        event.status !== "cancelled"
    )
    .map((event) => event.id);
}

/** An inherited label or an inconclusive search is not a verified origin. */
export function isVerifiedOrigin(entry: LocalArtistVerificationEntry): boolean {
  return (
    entry.status !== "unresolved" &&
    !entry.method.startsWith("legacy-") &&
    Boolean(entry.evidence?.trim()) &&
    (entry.method === "user-confirmed" ||
      Boolean(entry.sources?.length) ||
      /https?:\/\//u.test(entry.evidence ?? ""))
  );
}
