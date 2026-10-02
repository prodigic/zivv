import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ledgerLocation } from "./store-location.js";
import {
  inheritStoreRevision,
  readSqliteLedger,
  writeSqliteLedger,
} from "./sqlite-store.js";
import type {
  Artist,
  ArtistId,
  Event,
  EventId,
  Venue,
  VenueId,
} from "../../types/events.js";
import {
  INGESTION_SCHEMA_VERSION,
  IngestionLedgerError,
} from "../../types/ingestion.js";
import { actualStartEpochMs } from "../discovery.js";
import type {
  AddedDateProvenance,
  EventRedirect,
  FirstImportedBy,
  IngestionBatch,
  IngestionCandidateEvent,
  IngestionCandidateMetadata,
  IngestionEventInput,
  IngestionEventProvenance,
  IngestionLedger,
  IngestionMigration,
  IngestionRun,
  IngestionSnapshot,
  LedgerEvent,
  MigrationBasis,
  ProvenanceConflict,
  ProvenanceValue,
  ReconciliationConflict,
  ReconciliationReport,
  ReconciliationResult,
  ReconciliationReview,
  SourceKind,
  SourceLink,
} from "../../types/ingestion.js";

/*
 * The ledger is deliberately implemented without a browser-side dependency.
 * It is a build-time/server-side persistence boundary, so the only filesystem
 * operations in this module delegate to the configured durable store.
 */

type JsonRecord = Record<string, unknown>;
type TimestampInput = number | Date;

interface CandidateParts {
  event: Event;
  externalEventId: string | null;
  canonicalUrl: string | null;
  session: string | null;
  sourceVenueId: VenueId | null;
  announcedAtEpochMs: number | null;
  evidence: string | null;
  suppliedContentHash: string | null;
  index: number;
}

interface EntityMaps {
  artists: Artist[];
  venues: Venue[];
  artistIds: Map<number, ArtistId>;
  venueIds: Map<number, VenueId>;
}

interface VenueConflictDetail {
  field: string;
  existingValue: ProvenanceValue;
  incomingValue: ProvenanceValue;
}

interface EntityMergeResult extends EntityMaps {
  venueConflicts: Map<number, VenueConflictDetail[]>;
}

interface EventMatch {
  event: LedgerEvent | null;
  sourceMatch: boolean;
  fingerprintMatch: boolean;
  ambiguousIds: EventId[];
  legacyTimeUncertainIds: EventId[];
  multipleShow?: boolean;
}

interface EventUpdateResult {
  event: LedgerEvent;
  changed: boolean;
  linkAdded: boolean;
  conflicts: ReconciliationConflict[];
}

const EVENT_STATUSES = new Set([
  "confirmed",
  "sold-out",
  "cancelled",
  "postponed",
  "rescheduled",
]);
const AGE_RESTRICTIONS = new Set([
  "unknown",
  "all-ages",
  "18+",
  "21+",
  "16+",
  "8+",
  "5+",
  "6+",
]);
const VENUE_TYPES = new Set([
  "major",
  "club",
  "diy",
  "outdoor",
  "festival",
  "unknown",
]);
const EVENT_TAGS = new Set([
  "sold-out",
  "free",
  "tribute",
  "hip-hop",
  "reggae",
  "festival",
  "outdoor",
  "all-ages",
  "matinee",
  "late-show",
  "multiple-show",
]);
const RUN_STATUSES = new Set([
  "reconciled",
  "committed",
  "published",
  "failed",
]);

const VOLATILE_EVENT_KEYS = new Set([
  "createdAtEpochMs",
  "updatedAtEpochMs",
  "sourceLineNumber",
]);
const VOLATILE_ENTITY_KEYS = new Set([
  "createdAtEpochMs",
  "updatedAtEpochMs",
  "upcomingEventCount",
  "totalEventCount",
  "upcomingEvents",
]);

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/**
 * Convert a timestamp input into a finite epoch millisecond value.
 */
function toEpochMs(value: TimestampInput, label: string): number {
  const epoch = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(epoch)) {
    throw new IngestionLedgerError(
      "invalid-input",
      `${label} must be a finite epoch timestamp`
    );
  }
  return epoch;
}

function fail(
  message: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): never {
  throw new IngestionLedgerError(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireRecord(
  value: unknown,
  label: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): JsonRecord {
  if (!isRecord(value)) fail(`${label} must be an object`, code);
  return value;
}

function requireString(
  value: unknown,
  label: string,
  options: {
    allowEmpty?: boolean;
    code?: "invalid-input" | "corrupt-ledger";
  } = {}
): string {
  if (typeof value !== "string")
    fail(`${label} must be a string`, options.code ?? "invalid-input");
  if (!options.allowEmpty && value.trim().length === 0) {
    fail(`${label} must not be empty`, options.code ?? "invalid-input");
  }
  return value;
}

function requireEpoch(
  value: unknown,
  label: string,
  nullable = false,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): number | null {
  if (nullable && value === null) return null;
  if (!isFiniteNumber(value))
    fail(`${label} must be a finite number${nullable ? " or null" : ""}`, code);
  return value;
}

function requireId(
  value: unknown,
  label: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): number {
  if (!isInteger(value) || value <= 0)
    fail(`${label} must be a positive integer`, code);
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/^(the|dj|a)\s+/u, "")
    .replace(/\s+(band|music|group)$/u, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0)
    return null;
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    // Fragments can carry the provider's durable performance/instance ID
    // (for example Salesforce `/ticket#/instances/123`). Preserve them.
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    // Relative provider URLs are still stable source keys; normalize only
    // surrounding whitespace when URL parsing is not possible.
    return trimmed.replace(/\/+$/u, "") || "/";
  }
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function stableHash(value: unknown): string {
  const input = canonicalize(value);
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function omitKeys(value: JsonRecord, keys: Set<string>): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keys.has(key)) result[key] = item;
  }
  return result;
}

function eventHashValue(event: Event): JsonRecord {
  return omitKeys(event as unknown as JsonRecord, VOLATILE_EVENT_KEYS);
}

function entityHashValue(entity: Artist | Venue): JsonRecord {
  return omitKeys(entity as unknown as JsonRecord, VOLATILE_ENTITY_KEYS);
}

function provenanceValue(value: unknown): ProvenanceValue {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => provenanceValue(item));
  if (isRecord(value)) {
    const result: { [key: string]: ProvenanceValue } = {};
    for (const [key, item] of Object.entries(value))
      result[key] = provenanceValue(item);
    return result;
  }
  return String(value);
}

function sourceKindFor(origin: FirstImportedBy): SourceKind {
  return origin === "steveslist" ? "steveslist" : "venue-calendar";
}

function isAbsoluteUrl(value: string | null): boolean {
  if (value === null) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function urlsMatch(
  link: SourceLink,
  candidate: CandidateParts,
  sourceKind: SourceKind,
  sourceId: string
): boolean {
  if (
    candidate.canonicalUrl === null ||
    normalizeUrl(link.canonicalUrl) !== candidate.canonicalUrl
  )
    return false;
  // Relative paths have no host namespace. Keep them scoped to the exact
  // source adapter so `/event/123` on two providers cannot cross-link.
  if (!isAbsoluteUrl(candidate.canonicalUrl))
    return link.kind === sourceKind && link.sourceId === sourceId;
  return true;
}

function urlBaseAndFragment(value: string): {
  base: string;
  fragment: string | null;
} {
  const hashIndex = value.indexOf("#");
  if (hashIndex < 0) return { base: value, fragment: null };
  return {
    base: value.slice(0, hashIndex),
    fragment: value.slice(hashIndex + 1) || null,
  };
}

function hasDistinctFragmentIdentity(first: string, second: string): boolean {
  const left = urlBaseAndFragment(first);
  const right = urlBaseAndFragment(second);
  return (
    left.base === right.base &&
    left.fragment !== null &&
    right.fragment !== null &&
    left.fragment !== right.fragment
  );
}

function conflictsWithExistingSourceIdentity(
  event: LedgerEvent,
  candidate: CandidateParts,
  sourceKind: SourceKind,
  sourceId: string
): boolean {
  const sourceLinks = event.sources.filter(
    (link) => link.kind === sourceKind && link.sourceId === sourceId
  );
  if (
    candidate.externalEventId !== null &&
    sourceLinks.some(
      (link) =>
        link.externalEventId !== null &&
        link.externalEventId !== candidate.externalEventId &&
        (candidate.session === null ||
          normalizeName(link.session ?? "") ===
            normalizeName(candidate.session))
    )
  )
    return true;
  if (
    candidate.canonicalUrl !== null &&
    sourceLinks.some((link) => {
      const existingUrl = normalizeUrl(link.canonicalUrl);
      return (
        existingUrl !== null &&
        hasDistinctFragmentIdentity(
          existingUrl,
          candidate.canonicalUrl as string
        )
      );
    })
  )
    return true;
  return false;
}

function sourceLabel(kind: SourceKind, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

function sourceLinkHasIdentity(
  link: SourceLink,
  candidate: CandidateParts,
  sourceKind: SourceKind,
  sourceId: string
): boolean {
  if (link.sourceId !== sourceId || link.kind !== sourceKind) return false;
  if (candidate.externalEventId !== null) {
    return (
      link.externalEventId === candidate.externalEventId &&
      (candidate.session === null ||
        normalizeName(link.session ?? "") === normalizeName(candidate.session))
    );
  }
  if (candidate.canonicalUrl !== null) {
    return (
      urlsMatch(link, candidate, sourceKind, sourceId) &&
      (candidate.session === null ||
        normalizeName(link.session ?? "") === normalizeName(candidate.session))
    );
  }
  return (
    link.externalEventId === null &&
    link.canonicalUrl === null &&
    (candidate.session === null ||
      normalizeName(link.session ?? "") === normalizeName(candidate.session))
  );
}

function sourceMatches(
  events: LedgerEvent[],
  candidate: CandidateParts,
  sourceKind: SourceKind,
  sourceId: string
): LedgerEvent[] {
  const matches: LedgerEvent[] = [];
  for (const event of events) {
    const byExternalId =
      candidate.externalEventId !== null &&
      event.sources.some(
        (link) =>
          link.kind === sourceKind &&
          link.sourceId === sourceId &&
          link.externalEventId === candidate.externalEventId &&
          (candidate.session === null ||
            normalizeName(link.session ?? "") ===
              normalizeName(candidate.session))
      );
    const byUrl =
      candidate.canonicalUrl !== null &&
      event.sources.some(
        (link) =>
          urlsMatch(link, candidate, sourceKind, sourceId) &&
          (candidate.session === null ||
            normalizeName(link.session ?? "") ===
              normalizeName(candidate.session))
      );
    if (byExternalId || byUrl) matches.push(event);
  }
  return matches;
}

function sourceSessions(
  event: LedgerEvent,
  sourceKind: SourceKind,
  sourceId: string
): string[] {
  return event.sources
    .filter(
      (link) =>
        link.kind === sourceKind &&
        link.sourceId === sourceId &&
        link.session !== null
    )
    .map((link) => normalizeName(link.session ?? ""));
}

function eventTimeKey(event: Event): string | null {
  // A migrated parser row stores the LA wall clock in a UTC-looking field.
  // discovery.ts converts that legacy value before matching it to an instant
  // from a new venue source, so early/late performances stay distinct while
  // a timezone representation change does not split one show.
  const actualStart = actualStartEpochMs(event);
  if (actualStart !== null) return `actual:${actualStart}`;
  if (event.startTime) {
    const isoTime = event.startTime.match(/T(\d{2}:\d{2})/u)?.[1];
    if (isoTime) return `local:${isoTime}`;
    const looseTime = event.startTime.match(/\b(\d{1,2}:\d{2})\b/u)?.[1];
    if (looseTime) return `local:${looseTime.padStart(5, "0")}`;
    return `text:${event.startTime.trim().toLowerCase()}`;
  }
  if (event.startTimeEpochMs !== undefined)
    return `epoch:${event.startTimeEpochMs}`;
  return null;
}

function artistNameById(artists: Artist[], id: number): string | null {
  const artist = artists.find((item) => item.id === id);
  return artist ? normalizeName(artist.normalizedName || artist.name) : null;
}

function lineupFingerprint(
  event: Event,
  artists: Artist[]
): { headliner: string | null; lineup: string[] } {
  const headliner = artistNameById(artists, event.headlinerArtistId);
  const lineup = event.artistIds
    .map((id) => artistNameById(artists, id))
    .filter((name): name is string => name !== null)
    .sort();
  return { headliner, lineup };
}

function sameFingerprint(
  existing: LedgerEvent,
  candidate: Event,
  artists: Artist[],
  sourceKind: SourceKind,
  sourceId: string,
  session: string | null
): boolean {
  if (
    existing.venueId !== candidate.venueId ||
    existing.date !== candidate.date
  )
    return false;

  const existingTime = eventTimeKey(existing);
  const candidateTime = eventTimeKey(candidate);
  if (existingTime !== candidateTime) return false;

  if (session !== null) {
    const existingSessions = sourceSessions(existing, sourceKind, sourceId);
    if (
      existingSessions.length === 0 ||
      !existingSessions.includes(normalizeName(session))
    )
      return false;
  }

  const oldLineup = lineupFingerprint(existing, artists);
  const newLineup = lineupFingerprint(candidate, artists);
  if (oldLineup.headliner === null || newLineup.headliner === null)
    return false;
  return (
    oldLineup.headliner === newLineup.headliner &&
    canonicalize(oldLineup.lineup) === canonicalize(newLineup.lineup)
  );
}

/**
 * A Steve's List lineup can gain or lose support acts between issues while
 * the show identity remains stable.  Once venue, date, start time, and
 * headliner agree, use that identity as a guarded fallback when the exact
 * lineup fingerprint no longer matches.
 */
function sameStableIdentity(
  existing: LedgerEvent,
  candidate: Event,
  artists: Artist[],
  sourceKind: SourceKind,
  sourceId: string,
  session: string | null
): boolean {
  if (
    existing.venueId !== candidate.venueId ||
    existing.date !== candidate.date
  )
    return false;

  const existingTime = eventTimeKey(existing);
  const candidateTime = eventTimeKey(candidate);
  if (
    existingTime === null ||
    candidateTime === null ||
    existingTime !== candidateTime
  )
    return false;

  if (session !== null) {
    const existingSessions = sourceSessions(existing, sourceKind, sourceId);
    if (
      existingSessions.length === 0 ||
      !existingSessions.includes(normalizeName(session))
    )
      return false;
  }

  const oldHeadliner = lineupFingerprint(existing, artists).headliner;
  const newHeadliner = lineupFingerprint(candidate, artists).headliner;
  return oldHeadliner !== null && oldHeadliner === newHeadliner;
}

function lineupArtistKey(name: string): string {
  // Parenthetical role/presentation markers should not block a near-duplicate
  // comparison (for example, "Kochina Rude (performance)").
  return normalizeName(name)
    .replace(/\s*\([^)]*\)\s*$/u, "")
    .trim();
}

function lineupSet(event: Event, artists: Artist[]): Set<string> {
  return new Set(
    event.artistIds
      .map((id) => artistNameById(artists, id))
      .filter((name): name is string => name !== null)
      .map(lineupArtistKey)
      .filter(Boolean)
  );
}

function lineupOverlap(
  existing: Event,
  candidate: Event,
  artists: Artist[]
): number {
  const oldLineup = lineupSet(existing, artists);
  const newLineup = lineupSet(candidate, artists);
  if (oldLineup.size < 3 || newLineup.size < 3) return 0;
  let intersection = 0;
  for (const artist of oldLineup) if (newLineup.has(artist)) intersection++;
  return intersection / Math.min(oldLineup.size, newLineup.size);
}

function isStrictLineupSubset(
  existing: Event,
  candidate: Event,
  artists: Artist[]
): boolean {
  const oldLineup = lineupSet(existing, artists);
  const newLineup = lineupSet(candidate, artists);
  if (
    oldLineup.size === newLineup.size ||
    Math.min(oldLineup.size, newLineup.size) < 2
  )
    return false;
  const smaller = oldLineup.size < newLineup.size ? oldLineup : newLineup;
  const larger = oldLineup.size < newLineup.size ? newLineup : oldLineup;
  return [...smaller].every((artist) => larger.has(artist));
}

function isNearbyLineupRevision(
  existing: Event,
  candidate: Event,
  artists: Artist[]
): boolean {
  if (!isStrictLineupSubset(existing, candidate, artists)) return false;
  const existingTime = actualStartEpochMs(existing);
  const candidateTime = actualStartEpochMs(candidate);
  return (
    existingTime !== null &&
    candidateTime !== null &&
    Math.abs(existingTime - candidateTime) <= 2 * 60 * 60 * 1000
  );
}

/**
 * A migrated Steve's List row can have an uncertain wall-clock time while a
 * later observation has an instant timestamp and a richer (or corrected)
 * lineup. A migrated row may contain only the headliner, or a couple of support
 * acts may have been corrected between listings. Require the same headliner
 * and at least two shared acts when both lineups have multiple acts. Explicitly
 * timed rows remain governed by the multiple-show guard below.
 */
function isLegacyLineupRevision(
  existing: Event,
  candidate: Event,
  artists: Artist[]
): boolean {
  const oldLineup = lineupSet(existing, artists);
  const newLineup = lineupSet(candidate, artists);
  const smallerSize = Math.min(oldLineup.size, newLineup.size);
  if (smallerSize < 1) return false;
  const intersection = [...oldLineup].filter((artist) =>
    newLineup.has(artist)
  ).length;
  const oldHeadliner = artistNameById(artists, existing.headlinerArtistId);
  const newHeadliner = artistNameById(artists, candidate.headlinerArtistId);
  if (oldHeadliner === null || oldHeadliner !== newHeadliner) return false;
  if (
    (smallerSize === 1 && intersection !== 1) ||
    (smallerSize > 1 && (intersection < 2 || intersection / smallerSize < 0.6))
  )
    return false;
  return (
    existing.timeBasis === "legacy-wall-clock" &&
    candidate.timeBasis === "instant"
  );
}

function matchEvent(
  events: LedgerEvent[],
  candidate: CandidateParts,
  artists: Artist[],
  sourceKind: SourceKind,
  sourceId: string
): EventMatch {
  const sourceCandidates = sourceMatches(
    events,
    candidate,
    sourceKind,
    sourceId
  );
  const sourceIds = [...new Set(sourceCandidates.map((event) => event.id))];

  if (candidate.externalEventId !== null && candidate.canonicalUrl !== null) {
    const externalMatches = events.filter((event) =>
      event.sources.some(
        (link) =>
          link.kind === sourceKind &&
          link.sourceId === sourceId &&
          link.externalEventId === candidate.externalEventId &&
          (candidate.session === null ||
            normalizeName(link.session ?? "") ===
              normalizeName(candidate.session))
      )
    );
    const urlMatches = events.filter((event) =>
      event.sources.some(
        (link) =>
          urlsMatch(link, candidate, sourceKind, sourceId) &&
          (candidate.session === null ||
            normalizeName(link.session ?? "") ===
              normalizeName(candidate.session))
      )
    );
    const combinedIds = [
      ...new Set([...externalMatches, ...urlMatches].map((event) => event.id)),
    ];
    if (combinedIds.length > 1) {
      return {
        event: null,
        sourceMatch: false,
        fingerprintMatch: false,
        ambiguousIds: combinedIds,
        legacyTimeUncertainIds: [],
      };
    }
  }

  if (sourceIds.length > 1) {
    return {
      event: null,
      sourceMatch: false,
      fingerprintMatch: false,
      ambiguousIds: sourceIds,
      legacyTimeUncertainIds: [],
    };
  }
  if (sourceIds.length === 1) {
    return {
      event: sourceCandidates[0] ?? null,
      sourceMatch: true,
      fingerprintMatch: false,
      ambiguousIds: [],
      legacyTimeUncertainIds: [],
    };
  }

  const unmatchedRelativeUrl =
    candidate.canonicalUrl !== null &&
    !isAbsoluteUrl(candidate.canonicalUrl) &&
    sourceCandidates.length === 0;
  const fingerprintCandidates = events.filter(
    (event) =>
      !unmatchedRelativeUrl &&
      !conflictsWithExistingSourceIdentity(
        event,
        candidate,
        sourceKind,
        sourceId
      ) &&
      sameFingerprint(
        event,
        candidate.event,
        artists,
        sourceKind,
        sourceId,
        candidate.session
      )
  );
  if (fingerprintCandidates.length > 1) {
    return {
      event: null,
      sourceMatch: false,
      fingerprintMatch: false,
      ambiguousIds: fingerprintCandidates.map((event) => event.id),
      legacyTimeUncertainIds: [],
    };
  }
  if (fingerprintCandidates.length === 1) {
    return {
      event: fingerprintCandidates[0] ?? null,
      sourceMatch: false,
      fingerprintMatch: true,
      ambiguousIds: [],
      legacyTimeUncertainIds: [],
    };
  }

  const stableIdentityCandidates = events.filter(
    (event) =>
      !unmatchedRelativeUrl &&
      !conflictsWithExistingSourceIdentity(
        event,
        candidate,
        sourceKind,
        sourceId
      ) &&
      sameStableIdentity(
        event,
        candidate.event,
        artists,
        sourceKind,
        sourceId,
        candidate.session
      )
  );
  if (stableIdentityCandidates.length > 1) {
    return {
      event: null,
      sourceMatch: false,
      fingerprintMatch: false,
      ambiguousIds: stableIdentityCandidates.map((event) => event.id),
      legacyTimeUncertainIds: [],
    };
  }
  if (stableIdentityCandidates.length === 1) {
    return {
      event: stableIdentityCandidates[0] ?? null,
      sourceMatch: false,
      // The stable identity fallback is still an identity-proven match; the
      // event update will preserve its canonical ID and original added date.
      fingerprintMatch: true,
      ambiguousIds: [],
      legacyTimeUncertainIds: [],
    };
  }

  // A same-day bill can be rewritten with a different headliner, reordered
  // acts, or role markers while remaining the same show. Compare the shared
  // lineup against all rows, including earlier candidates in this batch; a
  // plausible second performance is rolled into one grouped event below.
  const nearLineupCandidates = events.filter(
    (event) =>
      !unmatchedRelativeUrl &&
      !conflictsWithExistingSourceIdentity(
        event,
        candidate,
        sourceKind,
        sourceId
      ) &&
      event.venueId === candidate.event.venueId &&
      event.date === candidate.event.date &&
      (lineupOverlap(event, candidate.event, artists) >= 0.75 ||
        (sourceKind === "steveslist" &&
          isLegacyLineupRevision(event, candidate.event, artists)) ||
        isNearbyLineupRevision(event, candidate.event, artists))
  );
  if (nearLineupCandidates.length > 0) {
    const sameTime = nearLineupCandidates.filter(
      (event) => eventTimeKey(event) === eventTimeKey(candidate.event)
    );
    if (sameTime.length === 1) {
      return {
        event: sameTime[0] ?? null,
        sourceMatch: false,
        fingerprintMatch: true,
        ambiguousIds: [],
        legacyTimeUncertainIds: [],
      };
    }
    if (sameTime.length > 1) {
      return {
        event: null,
        sourceMatch: false,
        fingerprintMatch: false,
        ambiguousIds: sameTime.map((event) => event.id),
        legacyTimeUncertainIds: [],
      };
    }
    if (
      sourceKind === "steveslist" &&
      nearLineupCandidates.length === 1 &&
      isLegacyLineupRevision(
        nearLineupCandidates[0] as LedgerEvent,
        candidate.event,
        artists
      )
    ) {
      return {
        event: nearLineupCandidates[0] ?? null,
        sourceMatch: false,
        fingerprintMatch: true,
        ambiguousIds: [],
        legacyTimeUncertainIds: [],
      };
    }
    if (
      nearLineupCandidates.length === 1 &&
      isNearbyLineupRevision(
        nearLineupCandidates[0] as LedgerEvent,
        candidate.event,
        artists
      )
    ) {
      return {
        event: nearLineupCandidates[0] ?? null,
        sourceMatch: false,
        fingerprintMatch: true,
        ambiguousIds: [],
        legacyTimeUncertainIds: [],
      };
    }
    const ids = nearLineupCandidates.map((event) => event.id);
    if (
      nearLineupCandidates.some(
        (event) => event.timeBasis === "legacy-wall-clock"
      ) ||
      candidate.event.timeBasis === "legacy-wall-clock"
    ) {
      return {
        event: null,
        sourceMatch: false,
        fingerprintMatch: false,
        ambiguousIds: [],
        legacyTimeUncertainIds: ids,
      };
    }
    return {
      event:
        nearLineupCandidates.length === 1
          ? (nearLineupCandidates[0] ?? null)
          : null,
      sourceMatch: false,
      fingerprintMatch: false,
      ambiguousIds: [],
      legacyTimeUncertainIds: [],
      multipleShow: true,
    };
  }

  // Historical parser timestamps were occasionally extracted from prices or
  // age markers. A same-day, same-venue, same-lineup row whose only mismatch
  // is that legacy clock value is unsafe to auto-accept. Explicit provider
  // identity/session already established that it is a distinct listing, so it
  // is allowed through to normal new-event allocation.
  const hasExplicitIdentity =
    candidate.externalEventId !== null ||
    candidate.canonicalUrl !== null ||
    candidate.session !== null;
  const candidateLineup = lineupFingerprint(candidate.event, artists);
  const legacyNearMatches = hasExplicitIdentity
    ? []
    : events.filter((event) => {
        if (
          event.addedDateProvenance !== "legacy-batch" ||
          event.timeBasis !== "legacy-wall-clock"
        )
          return false;
        if (
          event.venueId !== candidate.event.venueId ||
          event.date !== candidate.event.date
        )
          return false;
        const existingLineup = lineupFingerprint(event, artists);
        return (
          existingLineup.headliner !== null &&
          existingLineup.headliner === candidateLineup.headliner &&
          canonicalize(existingLineup.lineup) ===
            canonicalize(candidateLineup.lineup) &&
          eventTimeKey(event) !== eventTimeKey(candidate.event)
        );
      });
  if (legacyNearMatches.length > 0) {
    return {
      event: null,
      sourceMatch: false,
      fingerprintMatch: false,
      ambiguousIds: [],
      legacyTimeUncertainIds: legacyNearMatches.map((event) => event.id),
    };
  }
  return {
    event: null,
    sourceMatch: false,
    fingerprintMatch: false,
    ambiguousIds: [],
    legacyTimeUncertainIds: [],
  };
}

function allocateId(preferred: number, used: Set<number>): number {
  let candidate = isInteger(preferred) && preferred > 0 ? preferred : 1;
  while (used.has(candidate)) {
    candidate += 1;
    if (!Number.isSafeInteger(candidate))
      fail("Unable to allocate a collision-checked identifier");
  }
  return candidate;
}

function artistKey(artist: Artist): string {
  return normalizeName(artist.normalizedName || artist.name);
}

function venueKey(venue: Venue): string {
  return `${normalizeName(venue.normalizedName || venue.name)}|${normalizeName(venue.city)}`;
}

function hasKnownVenueIdentity(venue: Venue): boolean {
  return (
    normalizeName(venue.normalizedName || venue.name).length > 0 &&
    normalizeName(venue.city).length > 0
  );
}

function validateEvent(
  value: unknown,
  label: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): asserts value is Event {
  const event = requireRecord(value, label, code);
  requireId(event.id, `${label}.id`, code);
  requireString(event.slug, `${label}.slug`, { code });
  const date = requireString(event.date, `${label}.date`, { code });
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
    fail(`${label}.date must be an ISO calendar date`, code);
  requireEpoch(event.dateEpochMs, `${label}.dateEpochMs`, false, code);
  requireString(event.timezone, `${label}.timezone`, { code });
  requireId(event.headlinerArtistId, `${label}.headlinerArtistId`, code);
  if (
    !Array.isArray(event.artistIds) ||
    event.artistIds.some((id) => !isInteger(id) || id <= 0)
  ) {
    fail(`${label}.artistIds must be an array of positive integer IDs`, code);
  }
  requireId(event.venueId, `${label}.venueId`, code);
  if (!isFiniteNumber(event.isFree)) {
    if (typeof event.isFree !== "boolean")
      fail(`${label}.isFree must be a boolean`, code);
  }
  if (
    typeof event.ageRestriction !== "string" ||
    !AGE_RESTRICTIONS.has(event.ageRestriction)
  ) {
    fail(`${label}.ageRestriction is invalid`, code);
  }
  if (typeof event.status !== "string" || !EVENT_STATUSES.has(event.status)) {
    fail(`${label}.status is invalid`, code);
  }
  if (
    !Array.isArray(event.tags) ||
    event.tags.some((tag) => typeof tag !== "string" || !EVENT_TAGS.has(tag))
  ) {
    fail(`${label}.tags must contain valid event tags`, code);
  }
  if (
    typeof event.venueType !== "string" ||
    !VENUE_TYPES.has(event.venueType)
  ) {
    fail(`${label}.venueType is invalid`, code);
  }
  requireEpoch(
    event.createdAtEpochMs,
    `${label}.createdAtEpochMs`,
    false,
    code
  );
  requireEpoch(
    event.updatedAtEpochMs,
    `${label}.updatedAtEpochMs`,
    false,
    code
  );
  if (!isInteger(event.sourceLineNumber) || event.sourceLineNumber < 0) {
    fail(`${label}.sourceLineNumber must be a non-negative integer`, code);
  }
  if (event.startTime !== undefined && typeof event.startTime !== "string")
    fail(`${label}.startTime must be a string`, code);
  if (event.startTimeEpochMs !== undefined)
    requireEpoch(
      event.startTimeEpochMs,
      `${label}.startTimeEpochMs`,
      false,
      code
    );
  if (
    event.multipleShowTimesEpochMs !== undefined &&
    (!Array.isArray(event.multipleShowTimesEpochMs) ||
      event.multipleShowTimesEpochMs.some((time) => !isFiniteNumber(time)))
  ) {
    fail(`${label}.multipleShowTimesEpochMs is invalid`, code);
  }
  if (
    event.timeBasis !== undefined &&
    event.timeBasis !== "legacy-wall-clock" &&
    event.timeBasis !== "instant"
  ) {
    fail(`${label}.timeBasis is invalid`, code);
  }
  const priceMin = event.priceMin;
  const priceMax = event.priceMax;
  for (const [optionalPrice, value] of [
    ["priceMin", priceMin],
    ["priceMax", priceMax],
  ] as const) {
    if (value !== undefined && (!isFiniteNumber(value) || value < 0)) {
      fail(`${label}.${optionalPrice} must be a non-negative number`, code);
    }
  }
  if (
    isFiniteNumber(priceMin) &&
    isFiniteNumber(priceMax) &&
    priceMin > priceMax
  ) {
    fail(`${label}.priceMin cannot exceed priceMax`, code);
  }
  for (const optionalString of ["description", "notes", "ticketUrl"] as const) {
    if (
      event[optionalString] !== undefined &&
      typeof event[optionalString] !== "string"
    ) {
      fail(`${label}.${optionalString} must be a string`, code);
    }
  }
}

function validateArtist(
  value: unknown,
  label: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): asserts value is Artist {
  const artist = requireRecord(value, label, code);
  requireId(artist.id, `${label}.id`, code);
  requireString(artist.name, `${label}.name`, { code });
  requireString(artist.slug, `${label}.slug`, { code });
  requireString(artist.normalizedName, `${label}.normalizedName`, { code });
  if (
    !Array.isArray(artist.aliases) ||
    artist.aliases.some((alias) => typeof alias !== "string")
  ) {
    fail(`${label}.aliases must be an array of strings`, code);
  }
  if (!isInteger(artist.upcomingEventCount) || artist.upcomingEventCount < 0)
    fail(`${label}.upcomingEventCount is invalid`, code);
  if (!isInteger(artist.totalEventCount) || artist.totalEventCount < 0)
    fail(`${label}.totalEventCount is invalid`, code);
  if (!Array.isArray(artist.upcomingEvents))
    fail(`${label}.upcomingEvents must be an array`, code);
  requireEpoch(
    artist.createdAtEpochMs,
    `${label}.createdAtEpochMs`,
    false,
    code
  );
  requireEpoch(
    artist.updatedAtEpochMs,
    `${label}.updatedAtEpochMs`,
    false,
    code
  );
}

function validateVenue(
  value: unknown,
  label: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): asserts value is Venue {
  const venue = requireRecord(value, label, code);
  requireId(venue.id, `${label}.id`, code);
  requireString(venue.name, `${label}.name`, { code });
  requireString(venue.slug, `${label}.slug`, { code });
  requireString(venue.normalizedName, `${label}.normalizedName`, { code });
  // Historical generated rows include legitimate venue stubs with unknown
  // address and/or city. Preserve those rows; name matching below is disabled
  // until enough location data is known.
  if (typeof venue.address !== "string")
    fail(`${label}.address must be a string`, code);
  if (typeof venue.city !== "string")
    fail(`${label}.city must be a string`, code);
  if (
    typeof venue.ageRestriction !== "string" ||
    !AGE_RESTRICTIONS.has(venue.ageRestriction)
  ) {
    fail(`${label}.ageRestriction is invalid`, code);
  }
  if (
    venue.neighborhood !== undefined &&
    typeof venue.neighborhood !== "string"
  )
    fail(`${label}.neighborhood must be a string`, code);
  if (venue.zipCode !== undefined && typeof venue.zipCode !== "string")
    fail(`${label}.zipCode must be a string`, code);
  if (venue.phone !== undefined && typeof venue.phone !== "string")
    fail(`${label}.phone must be a string`, code);
  if (venue.website !== undefined && typeof venue.website !== "string")
    fail(`${label}.website must be a string`, code);
  if (
    venue.capacity !== undefined &&
    (!isInteger(venue.capacity) || venue.capacity < 0)
  )
    fail(`${label}.capacity is invalid`, code);
  if (!isInteger(venue.upcomingEventCount) || venue.upcomingEventCount < 0)
    fail(`${label}.upcomingEventCount is invalid`, code);
  if (!isInteger(venue.totalEventCount) || venue.totalEventCount < 0)
    fail(`${label}.totalEventCount is invalid`, code);
  if (!Array.isArray(venue.upcomingEvents))
    fail(`${label}.upcomingEvents must be an array`, code);
  requireEpoch(
    venue.createdAtEpochMs,
    `${label}.createdAtEpochMs`,
    false,
    code
  );
  requireEpoch(
    venue.updatedAtEpochMs,
    `${label}.updatedAtEpochMs`,
    false,
    code
  );
  if (!isInteger(venue.sourceLineNumber) || venue.sourceLineNumber < 0)
    fail(`${label}.sourceLineNumber is invalid`, code);
}

function validateSourceLink(
  value: unknown,
  label: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): asserts value is SourceLink {
  const link = requireRecord(value, label, code);
  if (link.kind !== "steveslist" && link.kind !== "venue-calendar")
    fail(`${label}.kind is invalid`, code);
  requireString(link.sourceId, `${label}.sourceId`, { code });
  for (const nullableString of [
    "externalEventId",
    "canonicalUrl",
    "session",
    "firstSeenRunId",
    "lastSeenRunId",
    "evidence",
  ] as const) {
    if (
      link[nullableString] !== null &&
      typeof link[nullableString] !== "string"
    )
      fail(`${label}.${nullableString} must be a string or null`, code);
  }
  if (link.originalVenueId !== null)
    requireId(link.originalVenueId, `${label}.originalVenueId`, code);
  const firstSeenAt = requireEpoch(
    link.firstSeenAtEpochMs,
    `${label}.firstSeenAtEpochMs`,
    true,
    code
  );
  const lastSeenAt = requireEpoch(
    link.lastSeenAtEpochMs,
    `${label}.lastSeenAtEpochMs`,
    true,
    code
  );
  if (firstSeenAt !== null && lastSeenAt !== null && firstSeenAt > lastSeenAt) {
    fail(`${label} firstSeenAtEpochMs cannot be after lastSeenAtEpochMs`, code);
  }
  requireString(link.contentHash, `${label}.contentHash`, { code });
}

function validateProvenance(
  value: unknown,
  label: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): asserts value is IngestionEventProvenance {
  const provenance = requireRecord(value, label, code);
  if (
    provenance.firstImportedBy !== "steveslist" &&
    provenance.firstImportedBy !== "zivv-venue-import"
  )
    fail(`${label}.firstImportedBy is invalid`, code);
  if (
    provenance.addedDateProvenance !== "observed" &&
    provenance.addedDateProvenance !== "legacy-batch" &&
    provenance.addedDateProvenance !== "unknown"
  ) {
    fail(`${label}.addedDateProvenance is invalid`, code);
  }
  requireEpoch(
    provenance.firstObservedAtEpochMs,
    `${label}.firstObservedAtEpochMs`,
    true,
    code
  );
  requireEpoch(
    provenance.announcedAtEpochMs,
    `${label}.announcedAtEpochMs`,
    true,
    code
  );
  if (
    provenance.firstImportRunId !== null &&
    typeof provenance.firstImportRunId !== "string"
  )
    fail(`${label}.firstImportRunId must be a string or null`, code);
  if (!Array.isArray(provenance.sources))
    fail(`${label}.sources must be an array`, code);
  provenance.sources.forEach((source, index) =>
    validateSourceLink(source, `${label}.sources[${index}]`, code)
  );
  if (!Array.isArray(provenance.provenanceConflicts))
    fail(`${label}.provenanceConflicts must be an array`, code);
  provenance.provenanceConflicts.forEach((conflict, index) =>
    validateConflict(conflict, `${label}.provenanceConflicts[${index}]`, code)
  );
}

function validateConflict(
  value: unknown,
  label: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): void {
  const conflict = requireRecord(value, label, code);
  requireString(conflict.field, `${label}.field`, { code });
  requireString(conflict.incomingSource, `${label}.incomingSource`, { code });
  if (
    conflict.existingSource !== null &&
    typeof conflict.existingSource !== "string"
  )
    fail(`${label}.existingSource must be a string or null`, code);
  requireEpoch(
    conflict.detectedAtEpochMs,
    `${label}.detectedAtEpochMs`,
    false,
    code
  );
  if (
    conflict.reason !== "source-update" &&
    conflict.reason !== "source-linked-reschedule" &&
    conflict.reason !== "venue-authority" &&
    conflict.reason !== "ambiguous-match"
  ) {
    fail(`${label}.reason is invalid`, code);
  }
}

function validateRun(
  value: unknown,
  label: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): asserts value is IngestionRun {
  const run = requireRecord(value, label, code);
  requireString(run.runId, `${label}.runId`, { code });
  if (run.origin !== "steveslist" && run.origin !== "zivv-venue-import")
    fail(`${label}.origin is invalid`, code);
  requireString(run.sourceId, `${label}.sourceId`, { code });
  if (run.sourceUrl !== null && typeof run.sourceUrl !== "string")
    fail(`${label}.sourceUrl must be a string or null`, code);
  requireEpoch(
    run.observedAtEpochMs,
    `${label}.observedAtEpochMs`,
    false,
    code
  );
  requireString(run.contentHash, `${label}.contentHash`, { code });
  if (typeof run.status !== "string" || !RUN_STATUSES.has(run.status))
    fail(`${label}.status is invalid`, code);
  for (const ids of [
    "acceptedEventIds",
    "newEventIds",
    "updatedEventIds",
    "linkedEventIds",
  ] as const) {
    if (
      !Array.isArray(run[ids]) ||
      run[ids].some((id) => !isInteger(id) || id < 0)
    )
      fail(`${label}.${ids} must contain event IDs`, code);
  }
  if (!isInteger(run.reviewCount) || run.reviewCount < 0)
    fail(`${label}.reviewCount is invalid`, code);
  if (!isInteger(run.conflictCount) || run.conflictCount < 0)
    fail(`${label}.conflictCount is invalid`, code);
  requireEpoch(
    run.reconciledAtEpochMs,
    `${label}.reconciledAtEpochMs`,
    false,
    code
  );
  requireEpoch(
    run.committedAtEpochMs,
    `${label}.committedAtEpochMs`,
    true,
    code
  );
  requireEpoch(
    run.publishedAtEpochMs,
    `${label}.publishedAtEpochMs`,
    true,
    code
  );
}

function validateRedirect(
  value: unknown,
  label: string,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): asserts value is EventRedirect {
  const redirect = requireRecord(value, label, code);
  requireId(redirect.fromEventId, `${label}.fromEventId`, code);
  requireId(redirect.toEventId, `${label}.toEventId`, code);
  if (
    redirect.reason !== "duplicate-merge" &&
    redirect.reason !== "manual-merge"
  )
    fail(`${label}.reason is invalid`, code);
  requireEpoch(
    redirect.createdAtEpochMs,
    `${label}.createdAtEpochMs`,
    false,
    code
  );
}

export function validateLedger(
  ledger: unknown,
  code: "invalid-input" | "corrupt-ledger" = "invalid-input"
): asserts ledger is IngestionLedger {
  const value = requireRecord(ledger, "ledger", code);
  if (value.schemaVersion !== INGESTION_SCHEMA_VERSION)
    fail(
      `Unsupported ingestion ledger schema version: ${String(value.schemaVersion)}`,
      code
    );
  requireString(value.version, "ledger.version", { code });
  const migration = requireRecord(value.migration, "ledger.migration", code);
  if (migration.basis !== "all-prior-events-steveslist")
    fail("ledger.migration.basis is invalid", code);
  requireEpoch(
    migration.migratedAtEpochMs,
    "ledger.migration.migratedAtEpochMs",
    false,
    code
  );
  if (value.migrationBasis !== migration.basis)
    fail("ledger.migrationBasis does not match ledger.migration.basis", code);
  if (
    !Array.isArray(value.events) ||
    !Array.isArray(value.artists) ||
    !Array.isArray(value.venues) ||
    !Array.isArray(value.runs) ||
    !Array.isArray(value.redirects)
  ) {
    fail(
      "ledger events, artists, venues, runs, and redirects must be arrays",
      code
    );
  }

  const artistIds = new Set<number>();
  value.artists.forEach((artist, index) => {
    validateArtist(artist, `ledger.artists[${index}]`, code);
    if (artistIds.has(artist.id))
      fail(`Duplicate artist ID ${artist.id}`, code);
    artistIds.add(artist.id);
  });
  const venueIds = new Set<number>();
  value.venues.forEach((venue, index) => {
    validateVenue(venue, `ledger.venues[${index}]`, code);
    if (venueIds.has(venue.id)) fail(`Duplicate venue ID ${venue.id}`, code);
    venueIds.add(venue.id);
  });
  const eventIds = new Set<number>();
  value.events.forEach((event, index) => {
    validateEvent(event, `ledger.events[${index}]`, code);
    validateProvenance(event, `ledger.events[${index}]`, code);
    if (eventIds.has(event.id)) fail(`Duplicate event ID ${event.id}`, code);
    eventIds.add(event.id);
    if (
      !artistIds.has(event.headlinerArtistId) ||
      event.artistIds.some((id) => !artistIds.has(id))
    ) {
      fail(`ledger.events[${index}] references an unknown artist`, code);
    }
    if (!venueIds.has(event.venueId))
      fail(`ledger.events[${index}] references an unknown venue`, code);
  });
  const runIds = new Set<string>();
  value.runs.forEach((run, index) => {
    validateRun(run, `ledger.runs[${index}]`, code);
    if (runIds.has(run.runId))
      fail(`Duplicate ingestion run ID ${run.runId}`, code);
    runIds.add(run.runId);
  });
  value.redirects.forEach((redirect, index) =>
    validateRedirect(redirect, `ledger.redirects[${index}]`, code)
  );
}

function extractCandidate(
  input: IngestionEventInput,
  index: number
): CandidateParts {
  let event: Event;
  let wrapper: IngestionCandidateEvent | null = null;
  if (isRecord(input) && isRecord(input.event)) {
    wrapper = input as unknown as IngestionCandidateEvent;
    event = wrapper.event;
  } else if (
    isRecord(input) &&
    [
      "externalEventId",
      "sourceEventId",
      "canonicalUrl",
      "canonicalURL",
      "session",
      "sourceVenueId",
      "originalVenueId",
      "announcedAtEpochMs",
      "evidence",
      "contentHash",
    ].some((key) => Object.prototype.hasOwnProperty.call(input, key))
  ) {
    const metadata = input as unknown as IngestionCandidateMetadata;
    event = input as unknown as Event;
    wrapper = { event, ...metadata };
  } else {
    event = input as Event;
  }
  validateEvent(event, `batch.events[${index}].event`);
  const externalEventId = cleanOptionalString(
    wrapper?.externalEventId ?? wrapper?.sourceEventId
  );
  const canonicalUrl = normalizeUrl(
    wrapper?.canonicalUrl ?? wrapper?.canonicalURL
  );
  const session = cleanOptionalString(wrapper?.session);
  const suppliedVenue = wrapper?.sourceVenueId ?? wrapper?.originalVenueId;
  const sourceVenueId =
    suppliedVenue === undefined || suppliedVenue === null
      ? event.venueId
      : (requireId(
          suppliedVenue,
          `batch.events[${index}].sourceVenueId`
        ) as VenueId);
  const announcedAtEpochMs =
    wrapper?.announcedAtEpochMs === undefined ||
    wrapper.announcedAtEpochMs === null
      ? null
      : (requireEpoch(
          wrapper.announcedAtEpochMs,
          `batch.events[${index}].announcedAtEpochMs`,
          false
        ) as number);
  const evidence = cleanOptionalString(wrapper?.evidence);
  const suppliedContentHash =
    wrapper?.contentHash === undefined
      ? null
      : requireString(
          wrapper.contentHash,
          `batch.events[${index}].contentHash`
        );
  return {
    event,
    externalEventId,
    canonicalUrl,
    session,
    sourceVenueId,
    announcedAtEpochMs,
    evidence,
    suppliedContentHash,
    index,
  };
}

function cleanOptionalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, "source identity").trim() || null;
}

function candidateHash(candidate: CandidateParts, sourceId: string): string {
  if (candidate.suppliedContentHash !== null)
    return candidate.suppliedContentHash;
  return stableHash({
    sourceId,
    event: eventHashValue(candidate.event),
    externalEventId: candidate.externalEventId,
    canonicalUrl: candidate.canonicalUrl,
    session: candidate.session,
    sourceVenueId: candidate.sourceVenueId,
    announcedAtEpochMs: candidate.announcedAtEpochMs,
  });
}

function batchHash(
  batch: IngestionBatch,
  candidates: CandidateParts[]
): string {
  const suppliedContentHash =
    batch.contentHash === undefined
      ? null
      : requireString(batch.contentHash, "batch.contentHash");
  const events = candidates
    .map((candidate) => ({
      event: eventHashValue(candidate.event),
      externalEventId: candidate.externalEventId,
      canonicalUrl: candidate.canonicalUrl,
      session: candidate.session,
      sourceVenueId: candidate.sourceVenueId,
      announcedAtEpochMs: candidate.announcedAtEpochMs,
      contentHash: candidateHash(candidate, batch.sourceId),
    }))
    .sort((left, right) =>
      canonicalize(left).localeCompare(canonicalize(right))
    );
  // Importers commonly pass their complete current entity maps. Unrelated
  // artists/venues added by a later run must not make an otherwise identical
  // source replay look like changed content, so hash only entities referenced
  // by this batch's candidate events.
  const referencedArtistIds = new Set(
    candidates.flatMap((candidate) => [
      candidate.event.headlinerArtistId,
      ...candidate.event.artistIds,
    ])
  );
  const referencedVenueIds = new Set(
    candidates.map((candidate) => candidate.event.venueId)
  );
  const artists = batch.artists
    .filter((artist) => referencedArtistIds.has(artist.id))
    .map((artist) => entityHashValue(artist))
    .sort((left, right) =>
      canonicalize(left).localeCompare(canonicalize(right))
    );
  const venues = batch.venues
    .filter((venue) => referencedVenueIds.has(venue.id))
    .map((venue) => entityHashValue(venue))
    .sort((left, right) =>
      canonicalize(left).localeCompare(canonicalize(right))
    );
  // Keep an adapter's source hash as evidence, but always include the
  // normalized payload. A caller must not be able to reuse one hash while
  // silently changing the event body under the same run ID.
  return stableHash({
    origin: batch.origin,
    sourceId: batch.sourceId,
    suppliedContentHash,
    events,
    artists,
    venues,
  });
}

function validateSnapshot(snapshot: IngestionSnapshot): void {
  if (
    !isRecord(snapshot) ||
    !Array.isArray(snapshot.events) ||
    !Array.isArray(snapshot.artists) ||
    !Array.isArray(snapshot.venues)
  ) {
    fail("bootstrap snapshot must contain events, artists, and venues arrays");
  }
  snapshot.events.forEach((event, index) =>
    validateEvent(event, `snapshot.events[${index}]`)
  );
  snapshot.artists.forEach((artist, index) =>
    validateArtist(artist, `snapshot.artists[${index}]`)
  );
  snapshot.venues.forEach((venue, index) =>
    validateVenue(venue, `snapshot.venues[${index}]`)
  );
}

function buildBootstrapSource(event: Event): SourceLink {
  return {
    kind: "steveslist",
    sourceId: "steveslist",
    externalEventId: null,
    canonicalUrl: normalizeUrl(event.ticketUrl),
    originalVenueId: event.venueId,
    session: null,
    firstSeenAtEpochMs: null,
    lastSeenAtEpochMs: null,
    contentHash: stableHash({
      event: eventHashValue(event),
      sourceId: "steveslist",
    }),
    firstSeenRunId: null,
    lastSeenRunId: null,
    evidence: null,
  };
}

/**
 * Migrate the committed catalog once. Existing IDs and timestamps are kept
 * byte-for-byte; the legacy batch label prevents it from flooding "latest".
 */
export function bootstrapLedger(
  snapshot: IngestionSnapshot,
  timestamp: TimestampInput
): IngestionLedger {
  validateSnapshot(snapshot);
  const migratedAtEpochMs = toEpochMs(timestamp, "bootstrap timestamp");
  const eventIds = new Set<number>();
  const artistIds = new Set<number>();
  const venueIds = new Set<number>();
  for (const artist of snapshot.artists) {
    if (artistIds.has(artist.id))
      fail(`Duplicate artist ID ${artist.id} in bootstrap snapshot`);
    artistIds.add(artist.id);
  }
  for (const venue of snapshot.venues) {
    if (venueIds.has(venue.id))
      fail(`Duplicate venue ID ${venue.id} in bootstrap snapshot`);
    venueIds.add(venue.id);
  }
  for (const event of snapshot.events) {
    if (eventIds.has(event.id))
      fail(`Duplicate event ID ${event.id} in bootstrap snapshot`);
    eventIds.add(event.id);
    if (
      !artistIds.has(event.headlinerArtistId) ||
      event.artistIds.some((id) => !artistIds.has(id))
    )
      fail(`Bootstrap event ${event.id} references an unknown artist`);
    if (!venueIds.has(event.venueId))
      fail(`Bootstrap event ${event.id} references an unknown venue`);
  }

  const migration: IngestionMigration = {
    basis: "all-prior-events-steveslist",
    migratedAtEpochMs,
  };
  const events: LedgerEvent[] = snapshot.events.map((event) => {
    const copiedEvent = cloneJson(event);
    return {
      ...copiedEvent,
      firstImportedBy: "steveslist",
      addedDateProvenance: "legacy-batch",
      firstObservedAtEpochMs: null,
      announcedAtEpochMs: null,
      firstImportRunId: null,
      sources: [buildBootstrapSource(copiedEvent)],
      provenanceConflicts: [],
    };
  });
  const ledger: IngestionLedger = {
    schemaVersion: INGESTION_SCHEMA_VERSION,
    version: "1",
    migration,
    migrationBasis: migration.basis,
    events,
    artists: cloneJson(snapshot.artists),
    venues: cloneJson(snapshot.venues),
    runs: [],
    redirects: [],
  };
  validateLedger(ledger);
  return ledger;
}

function mergeArtists(
  existing: Artist[],
  incoming: Artist[]
): { artists: Artist[]; artistIds: Map<number, ArtistId> } {
  const artists = cloneJson(existing);
  const artistIds = new Map<number, ArtistId>();
  const used = new Set<number>(artists.map((artist) => artist.id));
  const byName = new Map<string, Artist>(
    artists.map((artist) => [artistKey(artist), artist])
  );
  incoming.forEach((incomingArtist) => {
    validateArtist(incomingArtist, "batch.artists[]");
    const sameId = artists.find((artist) => artist.id === incomingArtist.id);
    if (sameId) {
      if (artistKey(sameId) === artistKey(incomingArtist)) {
        artistIds.set(incomingArtist.id, sameId.id);
        return;
      }
      const byNameMatch = byName.get(artistKey(incomingArtist));
      if (byNameMatch) {
        artistIds.set(incomingArtist.id, byNameMatch.id);
        return;
      }
      const allocated = allocateId(incomingArtist.id, used) as ArtistId;
      const copied = { ...cloneJson(incomingArtist), id: allocated };
      artists.push(copied);
      used.add(allocated);
      byName.set(artistKey(copied), copied);
      artistIds.set(incomingArtist.id, allocated);
      return;
    }
    const sameName = byName.get(artistKey(incomingArtist));
    if (sameName) {
      artistIds.set(incomingArtist.id, sameName.id);
      return;
    }
    const allocated = allocateId(incomingArtist.id, used) as ArtistId;
    const copied = { ...cloneJson(incomingArtist), id: allocated };
    artists.push(copied);
    used.add(allocated);
    byName.set(artistKey(copied), copied);
    artistIds.set(incomingArtist.id, allocated);
  });
  for (const artist of artists) artistIds.set(artist.id, artist.id);
  return { artists, artistIds };
}

function mergeVenues(
  existing: Venue[],
  incoming: Venue[]
): {
  venues: Venue[];
  venueIds: Map<number, VenueId>;
  venueConflicts: Map<number, VenueConflictDetail[]>;
} {
  const venues = cloneJson(existing);
  const venueIds = new Map<number, VenueId>();
  const venueConflicts = new Map<number, VenueConflictDetail[]>();
  const used = new Set<number>(venues.map((venue) => venue.id));
  const byName = new Map<string, Venue>(
    venues
      .filter(hasKnownVenueIdentity)
      .map((venue) => [venueKey(venue), venue])
  );
  incoming.forEach((incomingVenue) => {
    validateVenue(incomingVenue, "batch.venues[]");
    const sameId = venues.find((venue) => venue.id === incomingVenue.id);
    const sameName = hasKnownVenueIdentity(incomingVenue)
      ? byName.get(venueKey(incomingVenue))
      : undefined;
    const canonical =
      sameId && sameName && sameId.id === sameName.id
        ? sameId
        : (sameId ?? sameName);
    if (canonical) {
      const existingValue = entityHashValue(canonical);
      const incomingValue = entityHashValue(incomingVenue);
      const differences = Object.keys(incomingValue)
        .filter(
          (key) =>
            canonicalize(existingValue[key]) !==
            canonicalize(incomingValue[key])
        )
        .map((field) => ({
          field,
          existingValue: provenanceValue(existingValue[field]),
          incomingValue: provenanceValue(incomingValue[field]),
        }));
      if (differences.length > 0) {
        const prior = venueConflicts.get(canonical.id) ?? [];
        const combined = [...prior];
        for (const difference of differences) {
          if (
            !combined.some(
              (item) =>
                item.field === difference.field &&
                canonicalize(item.existingValue) ===
                  canonicalize(difference.existingValue) &&
                canonicalize(item.incomingValue) ===
                  canonicalize(difference.incomingValue)
            )
          ) {
            combined.push(difference);
          }
        }
        venueConflicts.set(canonical.id, combined);
      }
      venueIds.set(incomingVenue.id, canonical.id);
      return;
    }
    const allocated = allocateId(incomingVenue.id, used) as VenueId;
    const copied = { ...cloneJson(incomingVenue), id: allocated };
    venues.push(copied);
    used.add(allocated);
    if (hasKnownVenueIdentity(copied)) byName.set(venueKey(copied), copied);
    venueIds.set(incomingVenue.id, allocated);
  });
  for (const venue of venues) venueIds.set(venue.id, venue.id);
  return { venues, venueIds, venueConflicts };
}

function buildEntityMaps(
  ledger: IngestionLedger,
  batch: IngestionBatch
): EntityMergeResult {
  const artists = mergeArtists(ledger.artists, batch.artists);
  const venues = mergeVenues(ledger.venues, batch.venues);
  return { ...artists, ...venues };
}

function remapCandidate(
  candidate: CandidateParts,
  maps: EntityMaps
): CandidateParts {
  const event = cloneJson(candidate.event);
  event.artistIds = event.artistIds.map(
    (id) => maps.artistIds.get(id) ?? (id as ArtistId)
  );
  event.headlinerArtistId =
    maps.artistIds.get(event.headlinerArtistId) ?? event.headlinerArtistId;
  event.venueId = maps.venueIds.get(event.venueId) ?? event.venueId;
  return { ...candidate, event };
}

/**
 * Source adapters are allowed to omit fields they do not observe. Preserve
 * those values from the canonical event; a present value (including an empty
 * string) is an explicit source update and is applied below.
 */
function mergeDefinedEventFields(existing: Event, incoming: Event): Event {
  const merged = cloneJson(existing) as Event;
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined)
      (merged as unknown as JsonRecord)[key] = cloneJson(value);
  }
  return merged;
}

function materialEventDifferences(existing: Event, incoming: Event): string[] {
  const oldValue = eventHashValue(existing);
  const newValue = eventHashValue(incoming);
  const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
  return [...keys]
    .filter(
      (key) => canonicalize(oldValue[key]) !== canonicalize(newValue[key])
    )
    .sort();
}

function sourceLinkIndex(
  event: LedgerEvent,
  candidate: CandidateParts,
  sourceKind: SourceKind,
  sourceId: string
): number {
  const exact = event.sources.findIndex((link) =>
    sourceLinkHasIdentity(link, candidate, sourceKind, sourceId)
  );
  if (exact >= 0) return exact;
  if (candidate.externalEventId === null && candidate.canonicalUrl === null) {
    return event.sources.findIndex(
      (link) =>
        link.kind === sourceKind &&
        link.sourceId === sourceId &&
        link.externalEventId === null &&
        link.canonicalUrl === null &&
        (candidate.session === null ||
          normalizeName(link.session ?? "") ===
            normalizeName(candidate.session))
    );
  }
  return -1;
}

function updateSourceLinks(
  event: LedgerEvent,
  candidate: CandidateParts,
  sourceKind: SourceKind,
  sourceId: string,
  observedAtEpochMs: number,
  runId: string,
  contentHash: string
): { sources: SourceLink[]; added: boolean } {
  const sources = cloneJson(event.sources);
  const index = sourceLinkIndex(event, candidate, sourceKind, sourceId);
  if (index < 0) {
    sources.push({
      kind: sourceKind,
      sourceId,
      externalEventId: candidate.externalEventId,
      canonicalUrl: candidate.canonicalUrl,
      originalVenueId: candidate.sourceVenueId,
      session: candidate.session,
      firstSeenAtEpochMs: observedAtEpochMs,
      lastSeenAtEpochMs: observedAtEpochMs,
      contentHash,
      firstSeenRunId: runId,
      lastSeenRunId: runId,
      evidence: candidate.evidence,
    });
    return { sources, added: true };
  }

  const old = sources[index];
  const firstSeenAt =
    old.firstSeenAtEpochMs === null
      ? observedAtEpochMs
      : Math.min(old.firstSeenAtEpochMs, observedAtEpochMs);
  const lastSeenAt =
    old.lastSeenAtEpochMs === null
      ? observedAtEpochMs
      : Math.max(old.lastSeenAtEpochMs, observedAtEpochMs);
  const seenEarlier =
    old.firstSeenAtEpochMs !== null &&
    old.firstSeenAtEpochMs <= observedAtEpochMs;
  const seenLater =
    old.lastSeenAtEpochMs !== null &&
    old.lastSeenAtEpochMs >= observedAtEpochMs;
  sources[index] = {
    ...old,
    externalEventId: old.externalEventId ?? candidate.externalEventId,
    canonicalUrl: old.canonicalUrl ?? candidate.canonicalUrl,
    originalVenueId: old.originalVenueId ?? candidate.sourceVenueId,
    session: old.session ?? candidate.session,
    firstSeenAtEpochMs: firstSeenAt,
    lastSeenAtEpochMs: lastSeenAt,
    contentHash,
    firstSeenRunId: old.firstSeenRunId ?? runId,
    lastSeenRunId: seenLater ? old.lastSeenRunId : runId,
    evidence: candidate.evidence ?? old.evidence,
  };
  if (!seenEarlier && old.firstSeenRunId === null)
    sources[index].firstSeenRunId = runId;
  return { sources, added: false };
}

function venueReportConflicts(
  details: VenueConflictDetail[],
  eventId: EventId,
  sourceKind: SourceKind,
  sourceId: string,
  detectedAtEpochMs: number
): ReconciliationConflict[] {
  return details.map((detail) => ({
    eventId,
    field: detail.field,
    existingValue: detail.existingValue,
    incomingValue: detail.incomingValue,
    existingSource: null,
    incomingSource: sourceLabel(sourceKind, sourceId),
    detectedAtEpochMs,
    reason: "venue-authority",
  }));
}

function eventUpdate(
  existing: LedgerEvent,
  candidate: CandidateParts,
  sourceKind: SourceKind,
  sourceId: string,
  observedAtEpochMs: number,
  runId: string,
  sourceContentHash: string,
  sourceMatched: boolean,
  fingerprintMatched: boolean,
  venueConflicts: ReconciliationConflict[] = []
): EventUpdateResult {
  // Candidate IDs and generated slugs are transient; matching preserves the
  // canonical identity and must not report those differences as content edits.
  const mergedContent = {
    ...mergeDefinedEventFields(existing, candidate.event),
    id: existing.id,
    slug: existing.slug,
  };
  const differences = materialEventDifferences(existing, mergedContent);
  const nextContent = {
    ...mergedContent,
    id: existing.id,
    slug: existing.slug,
    createdAtEpochMs: existing.createdAtEpochMs,
    updatedAtEpochMs:
      differences.length > 0
        ? Math.max(existing.updatedAtEpochMs, observedAtEpochMs)
        : existing.updatedAtEpochMs,
  };
  const linked = updateSourceLinks(
    existing,
    candidate,
    sourceKind,
    sourceId,
    observedAtEpochMs,
    runId,
    sourceContentHash
  );
  const firstObserved =
    existing.firstObservedAtEpochMs === null
      ? observedAtEpochMs
      : Math.min(existing.firstObservedAtEpochMs, observedAtEpochMs);
  const announced =
    existing.announcedAtEpochMs === null
      ? candidate.announcedAtEpochMs
      : candidate.announcedAtEpochMs === null
        ? existing.announcedAtEpochMs
        : Math.min(existing.announcedAtEpochMs, candidate.announcedAtEpochMs);
  const conflicts: ReconciliationConflict[] = differences.map((field) => {
    const reason =
      (field === "date" ||
        field === "dateEpochMs" ||
        field === "startTime" ||
        field === "startTimeEpochMs" ||
        field === "venueId") &&
      sourceMatched
        ? "source-linked-reschedule"
        : "source-update";
    const conflict: ReconciliationConflict = {
      eventId: existing.id,
      field,
      existingValue: provenanceValue(
        (existing as unknown as JsonRecord)[field]
      ),
      incomingValue: provenanceValue(
        (candidate.event as unknown as JsonRecord)[field]
      ),
      existingSource: existing.sources[0]
        ? sourceLabel(existing.sources[0].kind, existing.sources[0].sourceId)
        : null,
      incomingSource: sourceLabel(sourceKind, sourceId),
      detectedAtEpochMs: observedAtEpochMs,
      reason,
    };
    return conflict;
  });
  const allConflicts = [...conflicts, ...venueConflicts];
  const provenanceConflicts: ProvenanceConflict[] = [
    ...cloneJson(existing.provenanceConflicts),
    ...allConflicts.map(({ eventId: _eventId, ...conflict }) => conflict),
  ];
  const next: LedgerEvent = {
    ...nextContent,
    firstImportedBy: existing.firstImportedBy,
    addedDateProvenance: existing.addedDateProvenance,
    firstObservedAtEpochMs: firstObserved,
    announcedAtEpochMs: announced,
    firstImportRunId: existing.firstImportRunId,
    sources: linked.sources,
    provenanceConflicts,
  };
  // A fingerprint match proves cross-source identity; sourceMatched proves a
  // provider-linked update/reschedule. Both are deliberately retained as
  // separate report signals by the caller.
  void fingerprintMatched;
  return {
    event: next,
    changed: differences.length > 0,
    linkAdded: linked.added,
    conflicts: allConflicts,
  };
}

function multipleShowCandidate(
  existing: LedgerEvent,
  candidate: CandidateParts
): CandidateParts {
  const times = [
    ...(existing.multipleShowTimesEpochMs ??
      (existing.startTimeEpochMs === undefined
        ? []
        : [existing.startTimeEpochMs])),
    ...(candidate.event.multipleShowTimesEpochMs ??
      (candidate.event.startTimeEpochMs === undefined
        ? []
        : [candidate.event.startTimeEpochMs])),
  ].sort((a, b) => a - b);
  return {
    ...candidate,
    event: {
      ...candidate.event,
      headlinerArtistId: existing.headlinerArtistId,
      artistIds: [
        ...new Set([...existing.artistIds, ...candidate.event.artistIds]),
      ],
      startTime: existing.startTime ?? candidate.event.startTime,
      startTimeEpochMs:
        existing.startTimeEpochMs ?? candidate.event.startTimeEpochMs,
      multipleShowTimesEpochMs: times,
      tags: [
        ...new Set<Event["tags"][number]>([
          ...existing.tags,
          ...candidate.event.tags,
          "multiple-show",
        ]),
      ],
    },
  };
}

function newLedgerEvent(
  candidate: CandidateParts,
  origin: FirstImportedBy,
  sourceKind: SourceKind,
  sourceId: string,
  observedAtEpochMs: number,
  runId: string,
  allocatedId: EventId,
  sourceContentHash: string,
  venueConflicts: ReconciliationConflict[] = []
): LedgerEvent {
  const event = cloneJson(candidate.event);
  event.id = allocatedId;
  event.createdAtEpochMs = observedAtEpochMs;
  event.updatedAtEpochMs = observedAtEpochMs;
  const source: SourceLink = {
    kind: sourceKind,
    sourceId,
    externalEventId: candidate.externalEventId,
    canonicalUrl: candidate.canonicalUrl,
    originalVenueId: candidate.sourceVenueId,
    session: candidate.session,
    firstSeenAtEpochMs: observedAtEpochMs,
    lastSeenAtEpochMs: observedAtEpochMs,
    contentHash: sourceContentHash,
    firstSeenRunId: runId,
    lastSeenRunId: runId,
    evidence: candidate.evidence,
  };
  return {
    ...event,
    firstImportedBy: origin,
    addedDateProvenance: "observed",
    firstObservedAtEpochMs: observedAtEpochMs,
    announcedAtEpochMs: candidate.announcedAtEpochMs,
    firstImportRunId: runId,
    sources: [source],
    provenanceConflicts: venueConflicts.map(
      ({ eventId: _eventId, ...conflict }) => conflict
    ),
  };
}

function incrementVersion(version: string, priorRunCount: number): string {
  if (/^\d+$/u.test(version)) return String(Number(version) + 1);
  return `${version}.${priorRunCount + 1}`;
}

function replayReport(run: IngestionRun): ReconciliationReport {
  return {
    runId: run.runId,
    replay: true,
    acceptedEventIds: [...run.acceptedEventIds],
    newEventIds: [...run.newEventIds],
    updatedEventIds: [...run.updatedEventIds],
    linkedEventIds: [...run.linkedEventIds],
    review: [],
    conflicts: [],
  };
}

function validateBatch(batch: IngestionBatch): CandidateParts[] {
  if (!isRecord(batch)) fail("ingestion batch must be an object");
  requireString(batch.runId, "batch.runId");
  if (batch.origin !== "steveslist" && batch.origin !== "zivv-venue-import")
    fail("batch.origin is invalid");
  requireEpoch(batch.observedAtEpochMs, "batch.observedAtEpochMs", false);
  requireString(batch.sourceId, "batch.sourceId");
  if (batch.sourceUrl !== undefined && batch.sourceUrl !== null)
    requireString(batch.sourceUrl, "batch.sourceUrl");
  if (
    !Array.isArray(batch.events) ||
    !Array.isArray(batch.artists) ||
    !Array.isArray(batch.venues)
  )
    fail("batch events, artists, and venues must be arrays");
  batch.artists.forEach((artist, index) =>
    validateArtist(artist, `batch.artists[${index}]`)
  );
  batch.venues.forEach((venue, index) =>
    validateVenue(venue, `batch.venues[${index}]`)
  );
  const candidates = batch.events.map((event, index) =>
    extractCandidate(event, index)
  );
  const identities = new Map<string, string>();
  candidates.forEach((candidate) => {
    const identity =
      candidate.externalEventId !== null
        ? `id:${batch.sourceId}:${candidate.externalEventId}:${normalizeName(candidate.session ?? "")}`
        : candidate.canonicalUrl !== null
          ? `url:${candidate.canonicalUrl}:${normalizeName(candidate.session ?? "")}`
          : null;
    if (identity !== null) {
      const hash = candidateHash(candidate, batch.sourceId);
      const prior = identities.get(identity);
      if (prior !== undefined && prior !== hash)
        fail(
          `Batch contains conflicting records for source identity ${identity}`
        );
      identities.set(identity, hash);
    }
  });
  return candidates;
}

function buildReview(
  candidate: CandidateParts,
  ids: EventId[],
  reason: ReconciliationReview["reason"],
  message: string
): ReconciliationReview {
  return {
    candidateIndex: candidate.index,
    candidateEventId: candidate.event.id,
    reason,
    message,
    existingEventIds: ids,
  };
}

/**
 * Purely reconcile one batch against a ledger. Neither argument is mutated;
 * source observations which cannot be matched conservatively remain in the
 * report for review and never delete an existing event.
 */
export function reconcileCandidates(
  ledger: IngestionLedger,
  batch: IngestionBatch
): ReconciliationResult {
  validateLedger(ledger);
  const candidates = validateBatch(batch);
  const contentHash = batchHash(batch, candidates);
  const priorRun = ledger.runs.find((run) => run.runId === batch.runId);
  if (priorRun) {
    if (priorRun.contentHash !== contentHash) {
      throw new IngestionLedgerError(
        "replay-conflict",
        `Run ${batch.runId} was already recorded with different content`
      );
    }
    return {
      ledger: inheritStoreRevision(ledger, cloneJson(ledger)),
      report: replayReport(priorRun),
    };
  }

  const mergedEntities = buildEntityMaps(ledger, batch);
  const nextEvents = cloneJson(ledger.events);
  const nextLedger: IngestionLedger = {
    ...cloneJson(ledger),
    version: incrementVersion(ledger.version, ledger.runs.length),
    events: nextEvents,
    artists: mergedEntities.artists,
    venues: mergedEntities.venues,
    runs: cloneJson(ledger.runs),
    redirects: cloneJson(ledger.redirects),
  };
  const sourceKind = sourceKindFor(batch.origin);
  const acceptedEventIds: EventId[] = [];
  const newEventIds: EventId[] = [];
  const updatedEventIds: EventId[] = [];
  const linkedEventIds: EventId[] = [];
  const review: ReconciliationReview[] = [];
  const conflicts: ReconciliationConflict[] = [];
  const usedEventIds = new Set<number>(nextEvents.map((event) => event.id));

  for (const rawCandidate of candidates) {
    const candidate = remapCandidate(rawCandidate, mergedEntities);
    if (!mergedEntities.venueIds.has(candidate.event.venueId)) {
      fail(`Candidate event ${candidate.event.id} references an unknown venue`);
    }
    if (
      !mergedEntities.artistIds.has(candidate.event.headlinerArtistId) ||
      candidate.event.artistIds.some((id) => !mergedEntities.artistIds.has(id))
    ) {
      fail(
        `Candidate event ${candidate.event.id} references an unknown artist`
      );
    }
    const venueDetails =
      mergedEntities.venueConflicts.get(candidate.event.venueId) ?? [];
    const sourceContentHash = candidateHash(candidate, batch.sourceId);
    const match = matchEvent(
      nextEvents,
      candidate,
      mergedEntities.artists,
      sourceKind,
      batch.sourceId
    );
    if (match.ambiguousIds.length > 0) {
      conflicts.push(
        ...venueReportConflicts(
          venueDetails,
          candidate.event.id,
          sourceKind,
          batch.sourceId,
          batch.observedAtEpochMs
        )
      );
      review.push(
        buildReview(
          candidate,
          match.ambiguousIds,
          "ambiguous-match",
          `Candidate ${candidate.event.id} matched multiple canonical events; manual review required`
        )
      );
      continue;
    }
    if (match.legacyTimeUncertainIds.length > 0) {
      conflicts.push(
        ...venueReportConflicts(
          venueDetails,
          candidate.event.id,
          sourceKind,
          batch.sourceId,
          batch.observedAtEpochMs
        )
      );
      review.push(
        buildReview(
          candidate,
          match.legacyTimeUncertainIds,
          "legacy-time-uncertain",
          `Candidate ${candidate.event.id} is close to a migrated event but its legacy show time is uncertain; manual review required`
        )
      );
      continue;
    }
    if (!match.event) {
      const candidateForInsert = match.multipleShow
        ? {
            ...candidate,
            event: {
              ...candidate.event,
              tags: [
                ...new Set<Event["tags"][number]>([
                  ...candidate.event.tags,
                  "multiple-show",
                ]),
              ],
            },
          }
        : candidate;
      const allocatedId = allocateId(
        candidateForInsert.event.id,
        usedEventIds
      ) as EventId;
      const insertedVenueConflicts = venueReportConflicts(
        venueDetails,
        allocatedId,
        sourceKind,
        batch.sourceId,
        batch.observedAtEpochMs
      );
      const inserted = newLedgerEvent(
        candidateForInsert,
        batch.origin,
        sourceKind,
        batch.sourceId,
        batch.observedAtEpochMs,
        batch.runId,
        allocatedId,
        sourceContentHash,
        insertedVenueConflicts
      );
      nextEvents.push(inserted);
      usedEventIds.add(allocatedId);
      acceptedEventIds.push(allocatedId);
      newEventIds.push(allocatedId);
      conflicts.push(...insertedVenueConflicts);
      continue;
    }

    const index = nextEvents.findIndex((event) => event.id === match.event?.id);
    if (index < 0)
      fail(`Matched event ${match.event.id} disappeared during reconciliation`);
    const updated = eventUpdate(
      match.event,
      match.multipleShow
        ? multipleShowCandidate(match.event, candidate)
        : candidate,
      sourceKind,
      batch.sourceId,
      batch.observedAtEpochMs,
      batch.runId,
      sourceContentHash,
      match.sourceMatch,
      match.fingerprintMatch,
      venueReportConflicts(
        venueDetails,
        match.event.id,
        sourceKind,
        batch.sourceId,
        batch.observedAtEpochMs
      )
    );
    nextEvents[index] = updated.event;
    acceptedEventIds.push(updated.event.id);
    if (updated.changed) updatedEventIds.push(updated.event.id);
    if (updated.linkAdded) linkedEventIds.push(updated.event.id);
    conflicts.push(...updated.conflicts);
  }

  const run: IngestionRun = {
    runId: batch.runId,
    origin: batch.origin,
    sourceId: batch.sourceId,
    sourceUrl: batch.sourceUrl ?? null,
    observedAtEpochMs: batch.observedAtEpochMs,
    contentHash,
    status: "reconciled",
    acceptedEventIds: [...new Set(acceptedEventIds)],
    newEventIds: [...new Set(newEventIds)],
    updatedEventIds: [...new Set(updatedEventIds)],
    linkedEventIds: [...new Set(linkedEventIds)],
    reviewCount: review.length,
    conflictCount: conflicts.length,
    reconciledAtEpochMs: batch.observedAtEpochMs,
    committedAtEpochMs: null,
    publishedAtEpochMs: null,
  };
  nextLedger.runs.push(run);
  validateLedger(nextLedger);
  return {
    ledger: inheritStoreRevision(ledger, nextLedger),
    report: {
      runId: batch.runId,
      replay: false,
      acceptedEventIds: [...new Set(acceptedEventIds)],
      newEventIds: [...new Set(newEventIds)],
      updatedEventIds: [...new Set(updatedEventIds)],
      linkedEventIds: [...new Set(linkedEventIds)],
      review,
      conflicts,
    },
  };
}

function decodeLedger(value: unknown): IngestionLedger {
  if (!isRecord(value))
    fail("Ledger JSON root must be an object", "corrupt-ledger");
  const schemaVersion = value.schemaVersion;
  if (schemaVersion === INGESTION_SCHEMA_VERSION) {
    validateLedger(value, "corrupt-ledger");
    return cloneJson(value);
  }
  fail(
    `Unsupported ingestion ledger schema version: ${String(schemaVersion)}`,
    "corrupt-ledger"
  );
}

/**
 * Migrate a schema-less/legacy snapshot in memory. loadLedger uses this only
 * for an explicitly recognizable old snapshot; a missing file remains an
 * error so cold rebuilds cannot reset date-added history.
 */
export function migrateLedger(
  value: unknown,
  timestamp?: TimestampInput
): IngestionLedger {
  if (!isRecord(value)) fail("Legacy ledger must be an object");
  if (value.schemaVersion === INGESTION_SCHEMA_VERSION) {
    validateLedger(value);
    return cloneJson(value);
  }
  if (
    !Array.isArray(value.events) ||
    !Array.isArray(value.artists) ||
    !Array.isArray(value.venues)
  ) {
    fail("Legacy ledger must contain events, artists, and venues arrays");
  }
  const migrationValue = isRecord(value.migration)
    ? value.migration.migratedAtEpochMs
    : undefined;
  const fallbackTimestamp =
    migrationValue !== undefined && isFiniteNumber(migrationValue)
      ? migrationValue
      : Date.now();
  return bootstrapLedger(
    {
      events: value.events as Event[],
      artists: value.artists as Artist[],
      venues: value.venues as Venue[],
    },
    timestamp ?? fallbackTimestamp
  );
}

/** Load and validate the durable ledger. Missing and corrupt files fail closed. */
export async function loadLedger(path: string): Promise<IngestionLedger> {
  requireString(path, "ledger path");
  const location = ledgerLocation(path);
  if (location.backend === "sqlite") {
    const ledger = readSqliteLedger(location.path);
    validateLedger(ledger);
    return ledger;
  }
  let bytes: string;
  try {
    bytes = await readFile(path, "utf8");
  } catch (error) {
    const code =
      isRecord(error) && error.code === "ENOENT"
        ? "missing-ledger"
        : "corrupt-ledger";
    throw new IngestionLedgerError(
      code,
      code === "missing-ledger"
        ? `Ingestion ledger not found: ${path}`
        : `Unable to read ingestion ledger: ${path}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes) as unknown;
  } catch (_error) {
    throw new IngestionLedgerError(
      "corrupt-ledger",
      `Invalid JSON in ingestion ledger: ${path}`
    );
  }
  try {
    if (isRecord(parsed) && parsed.schemaVersion === undefined)
      return migrateLedger(parsed);
    return decodeLedger(parsed);
  } catch (error) {
    if (
      error instanceof IngestionLedgerError &&
      error.code === "corrupt-ledger"
    )
      throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new IngestionLedgerError(
      "corrupt-ledger",
      `Invalid ingestion ledger ${path}: ${message}`
    );
  }
}

/** Write a validated ledger using a same-directory temporary file and rename. */
export async function saveLedgerAtomic(
  path: string,
  ledger: IngestionLedger
): Promise<void> {
  requireString(path, "ledger path");
  validateLedger(ledger);
  const location = ledgerLocation(path);
  if (location.backend === "sqlite") {
    await writeSqliteLedger(location.path, ledger);
    return;
  }
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const bytes = `${JSON.stringify(ledger, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, bytes, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original write/rename error.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new IngestionLedgerError(
      "corrupt-ledger",
      `Unable to atomically save ingestion ledger: ${message}`
    );
  }
}

export type {
  AddedDateProvenance,
  FirstImportedBy,
  MigrationBasis,
  SourceKind,
};
