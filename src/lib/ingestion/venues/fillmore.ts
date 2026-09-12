import { localDateKey, localWallClockToEpochMs } from "../../discovery.js";
import { htmlDocument, nodeText } from "../venue-html.js";
import type {
  FetchedText,
  VenueAdapterResult,
  VenueFetchContext,
  VenueListing,
  VenueSource,
} from "../venue-types.js";
import type { EventStatus } from "../../../types/events.js";

/** The provider identity verified from The Fillmore's official Live Nation link. */
export const FILLMORE_TICKETMASTER_VENUE_ID = "KovZpZAE6eeA";
export const FILLMORE_DISCOVERY_VENUE_ID = FILLMORE_TICKETMASTER_VENUE_ID;
export const FILLMORE_CALENDAR_URL = "https://www.thefillmore.com/shows";
export const TICKETMASTER_DISCOVERY_EVENTS_URL =
  "https://app.ticketmaster.com/discovery/v2/events.json";

export const FILLMORE_ADAPTER_VERSION = "fillmore-ticketmaster-v1";
const ADAPTER_VERSION = FILLMORE_ADAPTER_VERSION;
const API_PAGE_SIZE = 200;
const MAX_API_PAGES = 5;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EVENT_ID_FROM_URL = /\/event\/([A-Za-z0-9]+)(?:[/?#]|$)/i;
const PACKAGE_TITLE =
  /\b(?:package|pass|multi[- ]?day)\b|\(\s*\d+\s*\)\s*show\s*ticket|\b\d+\s+show\s+ticket\b/i;

type JsonRecord = Record<string, unknown>;

export interface FillmoreHtmlAudit {
  listings: VenueListing[];
  keys: string[];
  initialJsonLdCount: number;
  venueMatched: boolean;
  complete: false;
  warnings: string[];
}

export interface DiscoveryPageParse {
  listings: VenueListing[];
  keys: string[];
  pageNumber: number | null;
  totalElements: number | null;
  totalPages: number | null;
  hasEventsArray: boolean;
}

interface ApiInventory {
  attempted: boolean;
  listings: VenueListing[];
  keys: string[];
  complete: boolean;
  reason: string;
  warnings: string[];
}

interface HtmlInventory {
  fetched: boolean;
  audit: FillmoreHtmlAudit | null;
  warnings: string[];
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const identity = trimmed.toLocaleLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(trimmed);
  }
  return result;
}

function validDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  return (
    candidate.getUTCFullYear() === Number(match[1]) &&
    candidate.getUTCMonth() === Number(match[2]) - 1 &&
    candidate.getUTCDate() === Number(match[3])
  );
}

function dateKeyFromValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match && validDateKey(match[1]) ? match[1] : "";
}

function absoluteUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    return new URL(value, fallback).href;
  } catch {
    return fallback;
  }
}

function eventKeyFromUrl(url: string): string {
  const eventId = EVENT_ID_FROM_URL.exec(url)?.[1];
  return eventId ?? url;
}

function fallbackKey(date: string, title: string): string {
  const normalized = title
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `fillmore:${date || "unknown"}:${normalized || "review"}`;
}

function eventStatus(value: unknown): EventStatus | undefined {
  const record = asRecord(value);
  const raw =
    stringValue(record?.code) ??
    stringValue(record?.name) ??
    stringValue(value);
  if (!raw) return undefined;
  const status = raw.toLocaleLowerCase();
  if (status.includes("cancel")) return "cancelled";
  if (status.includes("postpon")) return "postponed";
  if (status.includes("reschedul")) return "rescheduled";
  if (status.includes("sold.out") || status === "soldout") return "sold-out";
  if (status.includes("schedul")) return "confirmed";
  return undefined;
}

function namesFromValues(values: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      if (value.trim()) names.push(value);
      continue;
    }
    const record = asRecord(value);
    const name = stringValue(record?.name);
    if (name) names.push(name);
  }
  return uniqueStrings(names);
}

function jsonLdArtists(record: JsonRecord): string[] {
  const performer = Array.isArray(record.performer)
    ? record.performer
    : record.performer === undefined
      ? []
      : [record.performer];
  return namesFromValues([...performer, ...arrayValue(record.performers)]);
}

function ticketmasterArtists(record: JsonRecord): string[] {
  const embedded = asRecord(record._embedded);
  return namesFromValues(arrayValue(embedded?.attractions));
}

function locationValues(record: JsonRecord): JsonRecord[] {
  const location = record.location;
  if (Array.isArray(location)) {
    return location
      .map(asRecord)
      .filter((value): value is JsonRecord => value !== null);
  }
  const one = asRecord(location);
  return one ? [one] : [];
}

function isFillmoreLocation(record: JsonRecord): boolean | null {
  const locations = locationValues(record);
  if (locations.length === 0) return null;
  for (const location of locations) {
    const name = stringValue(location.name)?.toLocaleLowerCase() ?? "";
    const sameAs = stringValue(location.sameAs)?.toLocaleLowerCase() ?? "";
    const address = asRecord(location.address);
    const addressText = [
      stringValue(address?.streetAddress),
      stringValue(address?.addressLocality),
      stringValue(address?.addressRegion),
      stringValue(address?.postalCode),
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ")
      .toLocaleLowerCase();
    if (
      name.includes("fillmore") ||
      sameAs.includes(FILLMORE_TICKETMASTER_VENUE_ID.toLocaleLowerCase()) ||
      addressText.includes("1805 geary")
    ) {
      return true;
    }
  }
  return false;
}

function ticketmasterVenueMatches(
  record: JsonRecord,
  expectedVenueId: string
): boolean {
  const embedded = asRecord(record._embedded);
  const venues = arrayValue(embedded?.venues)
    .map(asRecord)
    .filter((value): value is JsonRecord => value !== null);
  if (venues.length === 0) return false;
  return venues.some((venue) => stringValue(venue.id) === expectedVenueId);
}

function classificationSegment(record: JsonRecord): string | undefined {
  const classifications = arrayValue(record.classifications)
    .map(asRecord)
    .filter((value): value is JsonRecord => value !== null);
  const primary =
    classifications.find((value) => value.primary === true) ??
    classifications[0];
  return stringValue(asRecord(primary?.segment)?.name);
}

function isNonMusic(record: JsonRecord): boolean {
  const segment = classificationSegment(record);
  return Boolean(segment && segment.toLocaleLowerCase() !== "music");
}

function isPackageRecord(record: JsonRecord, title: string): boolean {
  if (PACKAGE_TITLE.test(title)) return true;
  const productType =
    stringValue(record.productType) ?? stringValue(record.type);
  if (productType && /package|pass|multi/i.test(productType)) return true;

  const dates = asRecord(record.dates);
  if (dates?.spanMultipleDays === true) return true;
  const endDate = dateKeyFromValue(
    asRecord(dates?.end)?.localDate ?? record.endDate
  );
  const startDate = dateKeyFromValue(
    asRecord(dates?.start)?.localDate ?? record.startDate
  );
  return Boolean(startDate && endDate && startDate !== endDate);
}

function packageSession(
  startDate: string,
  endDate: string
): string | undefined {
  if (!startDate || !endDate || startDate === endDate) return undefined;
  return `${startDate}/${endDate}`;
}

function parseLocalTime(
  value: unknown
): { hour: number; minute: number; second: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  return hour <= 23 && minute <= 59 && second <= 59
    ? { hour, minute, second }
    : null;
}

function parsePriceRange(value: unknown): {
  min?: number;
  max?: number;
  free?: boolean;
} {
  const ranges = arrayValue(value)
    .map(asRecord)
    .filter((range): range is JsonRecord => range !== null);
  const range = ranges[0];
  if (!range) return {};
  const min = finiteNumber(range.min);
  const max = finiteNumber(range.max);
  return {
    min: min ?? undefined,
    max: max ?? undefined,
    free: min === 0 && max === 0,
  };
}

function sourceTimezone(source?: VenueSource): string {
  return source?.timezone || "America/Los_Angeles";
}

function listingKind(
  artists: string[],
  packageRecord: boolean,
  nonMusic: boolean
): { kind: VenueListing["kind"]; reason?: string } {
  if (packageRecord) {
    if (artists.length === 0) {
      return {
        kind: "review",
        reason: "package/pass listing is missing explicit performer markup",
      };
    }
    return { kind: "package" };
  }
  if (nonMusic)
    return {
      kind: "non-music",
      reason: "Ticketmaster classification is not Music",
    };
  if (artists.length === 0) {
    return {
      kind: "review",
      reason: "listing is missing explicit performer markup",
    };
  }
  return { kind: "live" };
}

function withReason(base: string | undefined, extra: string): string {
  return base ? `${base}; ${extra}` : extra;
}

function jsonLdRecords(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdRecords);
  const record = asRecord(value);
  if (!record) return [];
  const graph = record["@graph"];
  if (Array.isArray(graph)) return graph.flatMap(jsonLdRecords);
  return [record];
}

function jsonLdType(record: JsonRecord): string[] {
  return Array.isArray(record["@type"])
    ? record["@type"].filter(
        (value): value is string => typeof value === "string"
      )
    : stringValue(record["@type"])
      ? [stringValue(record["@type"]) as string]
      : [];
}

function isEventJsonLd(record: JsonRecord): boolean {
  return jsonLdType(record).some((value) => /musicevent|event/i.test(value));
}

function parseJsonLdListing(
  record: JsonRecord,
  sourceUrl: string,
  source?: VenueSource
): VenueListing {
  const title = stringValue(record.name) ?? "Untitled Fillmore listing";
  const date = dateKeyFromValue(record.startDate);
  const sourceEventUrl = stringValue(record.url);
  const url = absoluteUrl(sourceEventUrl, sourceUrl);
  const artists = jsonLdArtists(record);
  const packageRecord = isPackageRecord(record, title);
  const kind = listingKind(artists, packageRecord, false);
  const startTimeEpochMs =
    typeof record.startDate === "string" &&
    Number.isFinite(Date.parse(record.startDate))
      ? Date.parse(record.startDate)
      : undefined;
  const endDate = dateKeyFromValue(record.endDate);
  const result: VenueListing = {
    key: sourceEventUrl
      ? eventKeyFromUrl(url) || fallbackKey(date, title)
      : fallbackKey(date, title),
    url,
    title,
    date,
    artists,
    kind: kind.kind,
    reason: kind.reason,
    startTimeEpochMs,
    status: eventStatus(record.eventStatus),
    ticketUrl: url,
    session: packageSession(date, endDate),
    evidence: `JSON-LD from ${source?.calendarUrl ?? sourceUrl}`,
  };
  if (!date)
    result.reason = withReason(
      result.reason,
      "listing has no valid local show date"
    );
  return result;
}

function parseTicketmasterListing(
  record: JsonRecord,
  expectedVenueId: string,
  source?: VenueSource
): VenueListing | null {
  if (!ticketmasterVenueMatches(record, expectedVenueId)) return null;

  const title = stringValue(record.name) ?? "Untitled Fillmore listing";
  const providerEventId = stringValue(record.id);
  const sourceEventUrl = stringValue(record.url);
  const url = absoluteUrl(
    sourceEventUrl,
    `https://www.ticketmaster.com/event/${providerEventId ?? "unknown"}`
  );
  const dates = asRecord(record.dates);
  const start = asRecord(dates?.start);
  const end = asRecord(dates?.end);
  const date = dateKeyFromValue(start?.localDate);
  const endDate = dateKeyFromValue(end?.localDate);
  const artists = ticketmasterArtists(record);
  const packageRecord = isPackageRecord(record, title);
  const kind = listingKind(artists, packageRecord, isNonMusic(record));
  const status = eventStatus(start?.status ?? dates?.status);
  const dateTime = stringValue(start?.dateTime);
  let startTimeEpochMs: number | undefined;
  if (dateTime && Number.isFinite(Date.parse(dateTime))) {
    startTimeEpochMs = Date.parse(dateTime);
  } else {
    const localTime = parseLocalTime(start?.localTime);
    if (date && localTime) {
      startTimeEpochMs =
        localWallClockToEpochMs(
          date,
          localTime.hour,
          localTime.minute,
          localTime.second,
          0,
          sourceTimezone(source)
        ) ?? undefined;
    }
  }
  const prices = parsePriceRange(record.priceRanges);
  const result: VenueListing = {
    key:
      providerEventId ??
      (sourceEventUrl
        ? eventKeyFromUrl(url) || fallbackKey(date, title)
        : fallbackKey(date, title)),
    url,
    title,
    date,
    artists,
    kind: kind.kind,
    reason: kind.reason,
    startTimeEpochMs,
    status,
    priceMin: prices.min,
    priceMax: prices.max,
    isFree: prices.free,
    ticketUrl: url,
    session: packageSession(date, endDate),
    notes: packageRecord
      ? "Ticketmaster package/pass; retained as one ticket product and not expanded into performances"
      : undefined,
    evidence: `Ticketmaster Discovery API venue ${expectedVenueId}`,
  };
  if (!date)
    result.reason = withReason(
      result.reason,
      "listing has no valid local show date"
    );
  if (!providerEventId) {
    result.kind = "review";
    result.reason = withReason(
      result.reason,
      "listing has no Ticketmaster event ID"
    );
  }
  return result;
}

function dedupeListings(listings: readonly VenueListing[]): VenueListing[] {
  const byKey = new Map<string, VenueListing>();
  for (const listing of listings) {
    if (!byKey.has(listing.key)) byKey.set(listing.key, listing);
  }
  return [...byKey.values()];
}

function parseJsonLdScripts(text: string): {
  records: JsonRecord[];
  warnings: string[];
} {
  const document = htmlDocument(text, FILLMORE_CALENDAR_URL);
  const scripts = document.querySelectorAll(
    'script[type="application/ld+json"]'
  );
  const records: JsonRecord[] = [];
  const warnings: string[] = [];
  for (let index = 0; index < scripts.length; index += 1) {
    const script = scripts[index];
    if (!script) continue;
    const raw = nodeText(script);
    if (!raw) continue;
    try {
      records.push(...jsonLdRecords(JSON.parse(raw) as unknown));
    } catch {
      warnings.push(`official HTML JSON-LD block ${index + 1} is invalid`);
    }
  }
  return { records, warnings };
}

function parseJsonLdInput(text: string): {
  records: JsonRecord[];
  warnings: string[];
} {
  if (/<script\b/i.test(text)) return parseJsonLdScripts(text);
  try {
    return {
      records: jsonLdRecords(JSON.parse(text) as unknown),
      warnings: [],
    };
  } catch {
    return { records: [], warnings: ["Fillmore JSON-LD input is invalid"] };
  }
}

/** Parse event records from the initial official page JSON-LD response. */
export function parseFillmoreJsonLd(
  text: string,
  sourceUrl = FILLMORE_CALENDAR_URL,
  source?: VenueSource
): VenueListing[] {
  return parseJsonLdInput(text)
    .records.filter(isEventJsonLd)
    .filter((record) => isFillmoreLocation(record) !== false)
    .map((record) => parseJsonLdListing(record, sourceUrl, source));
}

/** Audit only the structured markup returned by the official Fillmore page. */
export function auditOfficialFillmoreHtml(
  text: string,
  sourceUrl = FILLMORE_CALENDAR_URL,
  source?: VenueSource
): FillmoreHtmlAudit {
  const parsed = parseJsonLdInput(text);
  const eventRecords = parsed.records.filter(isEventJsonLd);
  const matchedRecords = eventRecords.filter(
    (record) => isFillmoreLocation(record) === true
  );
  const unknownVenueRecords = eventRecords.filter(
    (record) => isFillmoreLocation(record) === null
  );
  const mismatchedRecords =
    eventRecords.length - matchedRecords.length - unknownVenueRecords.length;
  const listings = dedupeListings(
    eventRecords
      .filter((record) => isFillmoreLocation(record) !== false)
      .map((record) => parseJsonLdListing(record, sourceUrl, source))
  );
  const warnings = [...parsed.warnings];
  if (eventRecords.length === 0) {
    warnings.push(
      "official Fillmore HTML contained no parseable MusicEvent JSON-LD records"
    );
  }
  if (mismatchedRecords > 0) {
    warnings.push(
      `official HTML audit skipped ${mismatchedRecords} listing(s) with a different venue`
    );
  }
  if (unknownVenueRecords.length > 0) {
    warnings.push(
      "official HTML audit accepted listing(s) without explicit venue identity for review"
    );
  }
  warnings.push(
    "official HTML audit covers initial JSON-LD only; rendered Fillmore inventory is known to be larger"
  );
  return {
    listings,
    keys: listings.map((listing) => listing.key),
    initialJsonLdCount: eventRecords.length,
    venueMatched: matchedRecords.length > 0 && mismatchedRecords === 0,
    complete: false,
    warnings,
  };
}

export const auditFillmoreHtml = auditOfficialFillmoreHtml;
export const parseFillmoreOfficialHtml = parseFillmoreJsonLd;
export const parseFillmoreHtml = parseFillmoreJsonLd;

function providerVenueId(source: VenueSource): string | undefined {
  return source.providerVenueIds?.ticketmasterDiscovery;
}

function pageRecord(payload: unknown): JsonRecord | null {
  const root = asRecord(payload);
  return asRecord(root?.page);
}

/** Parse one documented Ticketmaster Discovery API page without fetching. */
export function parseTicketmasterDiscoveryPage(
  payload: unknown,
  sourceOrVenueId?: VenueSource | string,
  requestedPage = 0
): DiscoveryPageParse {
  void requestedPage;
  const expectedVenueId =
    typeof sourceOrVenueId === "string"
      ? sourceOrVenueId
      : (providerVenueId(
          sourceOrVenueId ?? {
            sourceId: "fillmore-sf",
            venueId: 1136597428,
            venueName: "Fillmore",
            website: "https://www.thefillmore.com/",
            calendarUrl: FILLMORE_CALENDAR_URL,
            timezone: "America/Los_Angeles",
            providerVenueIds: {
              ticketmasterDiscovery: FILLMORE_TICKETMASTER_VENUE_ID,
            },
            enabled: false,
          }
        ) ?? FILLMORE_TICKETMASTER_VENUE_ID);
  const root = asRecord(payload);
  const embedded = asRecord(root?._embedded);
  const hasEventsArray = Array.isArray(embedded?.events);
  const events = arrayValue(embedded?.events)
    .map(asRecord)
    .filter((value): value is JsonRecord => value !== null);
  const page = pageRecord(payload);
  const listings = dedupeListings(
    events
      .map((event) =>
        parseTicketmasterListing(
          event,
          expectedVenueId,
          typeof sourceOrVenueId === "object" ? sourceOrVenueId : undefined
        )
      )
      .filter((listing): listing is VenueListing => listing !== null)
  );
  return {
    listings,
    keys: listings.map((listing) => listing.key),
    pageNumber: nonNegativeInteger(page?.number),
    totalElements: nonNegativeInteger(page?.totalElements),
    totalPages: nonNegativeInteger(page?.totalPages),
    hasEventsArray,
  };
}

export const parseDiscoveryPage = parseTicketmasterDiscoveryPage;

/** Parse one Discovery API event after checking its exact provider venue ID. */
export function parseTicketmasterEvent(
  raw: unknown,
  sourceOrVenueId?: VenueSource | string
): VenueListing | null {
  const expectedVenueId =
    typeof sourceOrVenueId === "string"
      ? sourceOrVenueId
      : sourceOrVenueId
        ? (providerVenueId(sourceOrVenueId) ?? FILLMORE_TICKETMASTER_VENUE_ID)
        : FILLMORE_TICKETMASTER_VENUE_ID;
  const record = asRecord(raw);
  return record
    ? parseTicketmasterListing(
        record,
        expectedVenueId,
        typeof sourceOrVenueId === "object" ? sourceOrVenueId : undefined
      )
    : null;
}

export const parseDiscoveryEvent = parseTicketmasterEvent;

function successful(response: FetchedText): boolean {
  return (
    (response.status >= 200 && response.status < 300) ||
    (response.status === 0 && response.fromCache) ||
    (response.status === 304 &&
      response.fromCache &&
      response.text.trim().length > 0)
  );
}

function apiUrl(
  venueId: string,
  page: number,
  key: string,
  startDateTime?: string
): string {
  const url = new URL(TICKETMASTER_DISCOVERY_EVENTS_URL);
  url.searchParams.set("venueId", venueId);
  url.searchParams.set("countryCode", "US");
  url.searchParams.set("locale", "en-us");
  url.searchParams.set("size", String(API_PAGE_SIZE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", "date,asc");
  if (startDateTime) url.searchParams.set("startDateTime", startDateTime);
  url.searchParams.set("apikey", key);
  return url.href;
}

function queryStart(
  nowEpochMs: number,
  source: VenueSource
): { date: string | null; instant: string | undefined } {
  const date = localDateKey(nowEpochMs, sourceTimezone(source));
  if (!date) return { date: null, instant: undefined };
  const epochMs = localWallClockToEpochMs(
    date,
    0,
    0,
    0,
    0,
    sourceTimezone(source)
  );
  return {
    date,
    instant: epochMs === null ? undefined : new Date(epochMs).toISOString(),
  };
}

async function fetchApiInventory(
  context: VenueFetchContext,
  expectedVenueId: string,
  startDateTime?: string
): Promise<ApiInventory> {
  const key = context.ticketmasterApiKey?.trim();
  if (!key) {
    return {
      attempted: false,
      listings: [],
      keys: [],
      complete: false,
      reason: "Ticketmaster Discovery API key is unavailable",
      warnings: [
        "Ticketmaster Discovery API key is unavailable; official HTML fallback is partial",
      ],
    };
  }

  const listings: VenueListing[] = [];
  const keys = new Set<string>();
  const pageFingerprints = new Set<string>();
  const seenPageNumbers = new Set<number>();
  const warnings: string[] = [];
  let expectedTotal: number | null = null;
  let expectedPages: number | null = null;
  let complete = false;
  let reason =
    "API pagination did not reach an explicit, verified exhaustion point";

  for (let pageIndex = 0; pageIndex < MAX_API_PAGES; pageIndex += 1) {
    let fetched: FetchedText;
    try {
      fetched = await context.fetchText(
        apiUrl(expectedVenueId, pageIndex, key, startDateTime)
      );
    } catch {
      warnings.push("Ticketmaster Discovery API request failed");
      reason = "Ticketmaster Discovery API request failed";
      break;
    }
    if (!successful(fetched)) {
      warnings.push(
        "Ticketmaster Discovery API returned an unsuccessful response"
      );
      reason = "Ticketmaster Discovery API returned an unsuccessful response";
      break;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(fetched.text) as unknown;
    } catch {
      warnings.push("Ticketmaster Discovery API response was not valid JSON");
      reason = "Ticketmaster Discovery API response was not valid JSON";
      break;
    }

    const parsed = parseTicketmasterDiscoveryPage(
      payload,
      context.source,
      pageIndex
    );
    if (
      parsed.pageNumber === null ||
      parsed.totalElements === null ||
      parsed.totalPages === null
    ) {
      warnings.push("Ticketmaster Discovery API page metadata is incomplete");
      reason = "Ticketmaster Discovery API page metadata is incomplete";
      break;
    }
    if (parsed.pageNumber !== pageIndex) {
      warnings.push(
        "Ticketmaster Discovery API returned an unexpected page number"
      );
      reason = "Ticketmaster Discovery API returned an unexpected page number";
      break;
    }
    if (expectedTotal === null) expectedTotal = parsed.totalElements;
    if (expectedPages === null) expectedPages = parsed.totalPages;
    if (
      parsed.totalElements !== expectedTotal ||
      parsed.totalPages !== expectedPages
    ) {
      warnings.push(
        "Ticketmaster Discovery API page totals changed during pagination"
      );
      reason =
        "Ticketmaster Discovery API page totals changed during pagination";
      break;
    }
    if (seenPageNumbers.has(parsed.pageNumber)) {
      warnings.push("Ticketmaster Discovery API repeated a page number");
      reason = "Ticketmaster Discovery API repeated a page number";
      break;
    }
    seenPageNumbers.add(parsed.pageNumber);
    const fingerprint = parsed.keys.slice().sort().join("\u001f");
    if (pageFingerprints.has(fingerprint)) {
      warnings.push("Ticketmaster Discovery API repeated page contents");
      reason = "Ticketmaster Discovery API repeated page contents";
      break;
    }
    pageFingerprints.add(fingerprint);
    for (const listing of parsed.listings) {
      if (keys.has(listing.key)) continue;
      keys.add(listing.key);
      listings.push(listing);
    }

    if (expectedTotal === 0) {
      complete = true;
      reason = "API reported zero matching events and page 0 was read";
      break;
    }
    if (expectedPages === 0 || expectedPages > MAX_API_PAGES) {
      warnings.push(
        `Ticketmaster Discovery API requires ${expectedPages} page(s), beyond the bounded ${MAX_API_PAGES}-page request limit`
      );
      reason =
        "Ticketmaster Discovery API result exceeds the bounded page limit";
      break;
    }
    if (pageIndex + 1 >= expectedPages) {
      if (listings.length === expectedTotal) {
        complete = true;
        reason =
          "API page totals and unique provider event IDs reached exhaustion";
      } else {
        warnings.push(
          `Ticketmaster Discovery API exhausted pages with ${listings.length} of ${expectedTotal} verified venue events`
        );
        reason =
          "Ticketmaster Discovery API pages ended before all total events were verified";
      }
      break;
    }
  }

  if (
    !complete &&
    expectedPages !== null &&
    expectedPages <= MAX_API_PAGES &&
    expectedPages > 0 &&
    seenPageNumbers.size >= expectedPages &&
    expectedTotal !== null &&
    listings.length !== expectedTotal
  ) {
    reason =
      "Ticketmaster Discovery API returned duplicate or unverified events";
  }

  return {
    attempted: true,
    listings,
    keys: [...keys],
    complete,
    reason,
    warnings,
  };
}

async function fetchHtmlInventory(
  context: VenueFetchContext
): Promise<HtmlInventory> {
  let fetched: FetchedText;
  try {
    fetched = await context.fetchText(context.source.calendarUrl);
  } catch {
    return {
      fetched: false,
      audit: null,
      warnings: ["official Fillmore HTML audit request failed"],
    };
  }
  if (!successful(fetched)) {
    return {
      fetched: false,
      audit: null,
      warnings: [
        "official Fillmore HTML audit returned an unsuccessful response",
      ],
    };
  }
  const audit = auditOfficialFillmoreHtml(
    fetched.text,
    context.source.calendarUrl,
    context.source
  );
  return { fetched: true, audit, warnings: audit.warnings };
}

function mergePrimaryListings(
  primary: readonly VenueListing[],
  supplemental: readonly VenueListing[]
): VenueListing[] {
  const result = [...primary];
  const keys = new Set(result.map((listing) => listing.key));
  for (const listing of supplemental) {
    if (keys.has(listing.key)) continue;
    keys.add(listing.key);
    result.push(listing);
  }
  return result;
}

function coverage(listings: readonly VenueListing[]): {
  start?: string;
  end?: string;
} {
  const dates = listings
    .map((listing) => listing.date)
    .filter(validDateKey)
    .sort();
  return dates.length > 0
    ? { start: dates[0], end: dates[dates.length - 1] }
    : {};
}

function uniqueWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings.filter((warning) => warning.trim().length > 0))];
}

/**
 * Discover Fillmore listings through the documented Ticketmaster API and
 * reconcile the result against the official page's initial JSON-LD audit.
 */
export async function fetchFillmore(
  context: VenueFetchContext
): Promise<VenueAdapterResult> {
  const warnings: string[] = [];
  const start = queryStart(context.nowEpochMs, context.source);
  const configuredVenueId = providerVenueId(context.source);
  const providerVerified = configuredVenueId === FILLMORE_TICKETMASTER_VENUE_ID;
  if (!providerVerified) {
    warnings.push(
      `Fillmore source is not configured with verified Ticketmaster venue ID ${FILLMORE_TICKETMASTER_VENUE_ID}`
    );
  }

  const api = providerVerified
    ? await fetchApiInventory(
        context,
        FILLMORE_TICKETMASTER_VENUE_ID,
        start.instant
      )
    : ({
        attempted: false,
        listings: [],
        keys: [],
        complete: false,
        reason: "verified Ticketmaster venue ID is unavailable",
        warnings: [
          "Ticketmaster Discovery API was not queried without the verified venue ID",
        ],
      } satisfies ApiInventory);
  warnings.push(...api.warnings);

  const html = await fetchHtmlInventory(context);
  warnings.push(...html.warnings);

  const htmlListings = html.audit?.listings ?? [];
  const primaryListings = mergePrimaryListings(
    api.attempted && api.listings.length > 0 ? api.listings : htmlListings,
    api.attempted && api.listings.length > 0 ? htmlListings : []
  );
  const primaryKeys = primaryListings.map((listing) => listing.key);
  const htmlKeys = new Set(html.audit?.keys ?? []);
  const apiKeys = new Set(api.keys);
  if (
    api.complete &&
    html.audit &&
    [...htmlKeys].some((key) => !apiKeys.has(key))
  ) {
    warnings.push(
      "official HTML audit found a listing key missing from the complete API result"
    );
  }
  const complete =
    providerVerified &&
    api.complete &&
    (!html.audit || ![...htmlKeys].some((key) => !apiKeys.has(key)));
  const inventories = [
    {
      name: "primary-discovery",
      keys: primaryKeys,
      complete,
      requiredForCoverage: true,
      reason: complete
        ? "Primary listings reached verified Ticketmaster API exhaustion"
        : api.reason,
    },
    {
      name: "ticketmaster-discovery-api",
      keys: api.keys,
      complete: api.complete,
      requiredForCoverage: true,
      reason: api.reason,
    },
    {
      name: "official-html-jsonld-audit",
      keys: html.audit?.keys ?? [],
      complete: html.audit?.complete ?? false,
      requiredForCoverage: !api.attempted,
      reason: html.audit
        ? "Initial official JSON-LD is an audit only; rendered Fillmore inventory is known to be larger"
        : "Official HTML audit was unavailable",
    },
  ];
  const dates = coverage(primaryListings);
  const coverageStart = start.date ?? dates.start;
  return {
    sourceId: context.source.sourceId,
    adapterVersion: ADAPTER_VERSION,
    listings: primaryListings,
    inventories,
    complete,
    coverageStart,
    coverageEnd: dates.end,
    warnings: uniqueWarnings(warnings),
  };
}
