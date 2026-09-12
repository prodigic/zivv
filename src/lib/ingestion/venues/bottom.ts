import { localDateKey, localWallClockToEpochMs } from "../../discovery.js";
import { htmlDocument, nodeText, type DomNode } from "../venue-html.js";
import type {
  VenueAdapterResult,
  VenueFetchContext,
  VenueListing,
} from "../venue-types.js";

const DEFAULT_TIME_ZONE = "America/Los_Angeles";
export const BOTTOM_CALENDAR_URL =
  "https://www.bottomofthehill.com/calendar.html";
export const BOTTOM_RSS_URL = "https://www.bottomofthehill.com/RSS.xml";
export const BOTTOM_ADAPTER_VERSION = "bottom-of-the-hill-v1";

const DEFAULT_CALENDAR_URL = BOTTOM_CALENDAR_URL;
const DEFAULT_RSS_URL = BOTTOM_RSS_URL;
const ADAPTER_VERSION = BOTTOM_ADAPTER_VERSION;

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const DETAIL_PATH = /(?:^|\/)20\d{6}\.html(?:[?#].*)?$/iu;
const DETAIL_DATE = /(?:^|\/)(20\d{2})(\d{2})(\d{2})\.html(?:[?#].*)?$/iu;
const FEED_EVENT_PATH = /(?:^|\/)20\d{6}[A-Za-z0-9-]*\.html(?:[?#].*)?$/iu;
const MONEY = /\$\s*(\d+(?:\.\d{1,2})?)/gu;
const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/giu;
const CLOCK_TEST = /\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)\b/iu;

export interface BottomCalendarParseOptions {
  baseUrl?: string;
  timezone?: string;
}

export interface BottomCalendarParseResult {
  listings: VenueListing[];
  complete: boolean;
  warnings: string[];
  coverageStart?: string;
  coverageEnd?: string;
}

export interface BottomRssRevision {
  url: string;
  guid: string;
  title: string;
  date: string;
  artists: string[];
  startTimeEpochMs?: number;
  doorsTimeEpochMs?: number;
  ageRestriction?: VenueListing["ageRestriction"];
  priceMin?: number;
  priceMax?: number;
  notes?: string;
  publishedAtEpochMs?: number;
  evidence: string;
}

export interface BottomRssParseResult {
  revisions: BottomRssRevision[];
  complete: boolean;
  warnings: string[];
}

interface PriceFacts {
  baseText: string;
  feeText: string;
  baseValues: number[];
  feeValues: number[];
  faceValue?: number;
  doorValue?: number;
  feeInclusiveValue?: number;
}

interface TimeFacts {
  rawText: string;
  tokens: string[];
  startTimeEpochMs?: number;
  doorsTimeEpochMs?: number;
  session?: string;
}

interface CalendarCandidate {
  listing: VenueListing;
  baseUrl: string;
}

/** Parse the complete current calendar into source listings and diagnostics. */
export function parseBottomCalendar(
  text: string,
  options: BottomCalendarParseOptions = {}
): BottomCalendarParseResult {
  const warnings: string[] = [];
  const baseUrl = options.baseUrl ?? DEFAULT_CALENDAR_URL;
  const timezone = options.timezone ?? DEFAULT_TIME_ZONE;
  if (!text.trim()) {
    return {
      listings: [],
      complete: false,
      warnings: ["Bottom of the Hill calendar was empty"],
    };
  }

  const document = htmlDocument(text, baseUrl);
  const rows = eventRows(document);
  const markupComplete = hasBalancedCalendarMarkup(text);
  if (!markupComplete)
    warnings.push("Bottom of the Hill calendar appears truncated");
  if (rows.length === 0) {
    warnings.push("Bottom of the Hill calendar contained no event rows");
    return { listings: [], complete: false, warnings };
  }

  const candidates: CalendarCandidate[] = [];
  rows.forEach((row, index) => {
    const candidate = parseCalendarRow(row, baseUrl, timezone, index, warnings);
    if (candidate) candidates.push(candidate);
  });

  const listings = giveDuplicateRowsDistinctKeys(candidates).map(
    (candidate) => candidate.listing
  );
  if (listings.length === 0)
    warnings.push("Bottom of the Hill calendar had no valid event rows");
  const dates = listings.map((listing) => listing.date).sort();
  const complete =
    markupComplete && rows.length === candidates.length && listings.length > 0;
  return {
    listings,
    complete,
    warnings,
    coverageStart: dates[0],
    coverageEnd: dates[dates.length - 1],
  };
}

/** Parse the RSS update history and retain only the newest revision per URL. */
export function parseBottomRss(
  text: string,
  options: BottomCalendarParseOptions = {}
): BottomRssParseResult {
  const warnings: string[] = [];
  const baseUrl = options.baseUrl ?? DEFAULT_RSS_URL;
  const timezone = options.timezone ?? DEFAULT_TIME_ZONE;
  if (!text.trim()) {
    return {
      revisions: [],
      complete: false,
      warnings: ["Bottom of the Hill RSS feed was empty"],
    };
  }

  const structurallyComplete = hasBalancedRssMarkup(text);
  if (!structurallyComplete)
    warnings.push("Bottom of the Hill RSS feed appears truncated or malformed");
  const document = htmlDocument(normalizeRssMarkup(text), baseUrl);
  const items = toNodes(document.querySelectorAll("item"));
  if (items.length === 0) {
    warnings.push("Bottom of the Hill RSS feed contained no items");
    return { revisions: [], complete: false, warnings };
  }

  const byUrl = new Map<string, BottomRssRevision>();
  let validItems = 0;
  items.forEach((item, index) => {
    const revision = parseRssItem(item, baseUrl, timezone, index, warnings);
    if (!revision) return;
    validItems += 1;
    const prior = byUrl.get(revision.url);
    if (!prior || isLaterRevision(revision, prior))
      byUrl.set(revision.url, revision);
  });
  const revisions = [...byUrl.values()].sort((left, right) =>
    left.url.localeCompare(right.url)
  );
  const complete =
    structurallyComplete && validItems === items.length && revisions.length > 0;
  return { revisions, complete, warnings };
}

/** Convenience form for callers which only need calendar listings. */
export function parseBottomCalendarListings(
  text: string,
  options: BottomCalendarParseOptions = {}
): VenueListing[] {
  return parseBottomCalendar(text, options).listings;
}

export const parseBottomOfTheHillCalendar = parseBottomCalendar;

/** Convenience form for callers which only need deduplicated RSS revisions. */
export function parseBottomRssRevisions(
  text: string,
  options: BottomCalendarParseOptions = {}
): BottomRssRevision[] {
  return parseBottomRss(text, options).revisions;
}

export const parseBottomOfTheHillRss = parseBottomRss;

/**
 * Fetch and reconcile Bottom of the Hill's calendar baseline with RSS
 * revisions. The calendar owns coverage; RSS is an update and provenance
 * signal and therefore cannot remove a calendar listing.
 */
export async function fetchBottomOfTheHill(
  context: VenueFetchContext
): Promise<VenueAdapterResult> {
  const source = context.source;
  const timezone = source.timezone || DEFAULT_TIME_ZONE;
  const calendarUrl = source.calendarUrl || DEFAULT_CALENDAR_URL;
  const rssUrl = source.feedUrls?.[0] ?? DEFAULT_RSS_URL;
  const warnings: string[] = [];

  const [calendarFetch, rssFetch] = await Promise.allSettled([
    context.fetchText(calendarUrl),
    context.fetchText(rssUrl),
  ]);

  let calendarParsed: BottomCalendarParseResult = {
    listings: [],
    complete: false,
    warnings: [],
  };
  if (calendarFetch.status === "fulfilled") {
    if (!usableResponse(calendarFetch.value)) {
      warnings.push(
        `Bottom of the Hill calendar response was unusable (status ${calendarFetch.value.status}, ${calendarFetch.value.text.length} body characters)`
      );
    } else {
      calendarParsed = parseBottomCalendar(calendarFetch.value.text, {
        baseUrl: calendarFetch.value.url || calendarUrl,
        timezone,
      });
      warnings.push(...calendarParsed.warnings);
    }
  } else {
    warnings.push(
      `Bottom of the Hill calendar fetch failed: ${errorMessage(calendarFetch.reason)}`
    );
  }

  let rssParsed: BottomRssParseResult = {
    revisions: [],
    complete: false,
    warnings: [],
  };
  if (rssFetch.status === "fulfilled") {
    if (!usableResponse(rssFetch.value)) {
      warnings.push(
        `Bottom of the Hill RSS response was unusable (status ${rssFetch.value.status}, ${rssFetch.value.text.length} body characters)`
      );
    } else {
      rssParsed = parseBottomRss(rssFetch.value.text, {
        baseUrl: rssFetch.value.url || rssUrl,
        timezone,
      });
      warnings.push(...rssParsed.warnings);
    }
  } else {
    warnings.push(
      `Bottom of the Hill RSS fetch failed: ${errorMessage(rssFetch.reason)}`
    );
  }

  const currentDate = localDateKey(context.nowEpochMs, timezone);
  const observedListings = currentDate
    ? calendarParsed.listings.filter((listing) => listing.date >= currentDate)
    : calendarParsed.listings;
  if (!currentDate)
    warnings.push(
      "Bottom of the Hill current date could not be derived from nowEpochMs"
    );

  const revisionsByUrl = new Map(
    rssParsed.revisions.map((revision) => [revision.url, revision])
  );
  const listings = observedListings.map((listing) => {
    const revision = revisionsByUrl.get(listing.url);
    return revision ? mergeRssRevision(listing, revision) : listing;
  });

  const observedRevisions = rssParsed.revisions.filter(
    (revision) => !currentDate || revision.date >= currentDate
  );
  const rssUrls = new Set(observedRevisions.map((revision) => revision.url));
  const feedGaps = observedListings.filter(
    (listing) => !rssUrls.has(listing.url)
  );
  if (feedGaps.length > 0) {
    warnings.push(
      `RSS feed gap: ${feedGaps.length} calendar listing(s) have no matching current RSS URL (${feedGaps
        .map((listing) => listing.url)
        .join(", ")})`
    );
  }
  const calendarOnlyUrls = new Set(
    observedListings.map((listing) => listing.url)
  );
  const feedOnly = observedRevisions.filter(
    (revision) => !calendarOnlyUrls.has(revision.url)
  );
  if (feedOnly.length > 0) {
    warnings.push(
      `RSS contains ${feedOnly.length} current item(s) outside the calendar baseline: ${feedOnly
        .map((revision) => revision.url)
        .join(", ")}`
    );
  }

  const dates = listings.map((listing) => listing.date).sort();
  const rssReason = [
    feedGaps.length > 0
      ? `RSS intentionally omits ${feedGaps.length} calendar listing(s); calendar remains authoritative`
      : undefined,
    feedOnly.length > 0
      ? `RSS has ${feedOnly.length} current listing(s) outside the calendar baseline; review before coverage is complete`
      : undefined,
    !rssParsed.complete ? "RSS parsing or retrieval was incomplete" : undefined,
  ]
    .filter((reason): reason is string => Boolean(reason))
    .join("; ");
  const inventories = [
    {
      name: "discovered-calendar",
      keys: listings.map((listing) => listing.key),
      complete: calendarParsed.complete,
      reason: calendarParsed.complete
        ? undefined
        : "Calendar parsing or retrieval was incomplete",
    },
    {
      name: "rss-revisions",
      keys: observedRevisions.map((revision) => revision.url),
      complete: rssParsed.complete && feedOnly.length === 0,
      reason: rssReason || undefined,
    },
  ];
  return {
    sourceId: source.sourceId,
    adapterVersion: ADAPTER_VERSION,
    listings,
    inventories,
    complete:
      calendarParsed.complete && rssParsed.complete && feedOnly.length === 0,
    coverageStart: currentDate ?? dates[0],
    coverageEnd: dates[dates.length - 1],
    warnings,
  };
}

function eventRows(document: DomNode): DomNode[] {
  const rows: DomNode[] = [];
  const seen = new Set<DomNode>();
  for (const link of toNodes(document.querySelectorAll("a[href]"))) {
    const href = link.getAttribute("href") ?? "";
    if (!DETAIL_PATH.test(href)) continue;
    const row =
      link.closest("tr") ?? link.closest("article") ?? link.parentElement;
    if (!row || seen.has(row)) continue;
    if (
      !row.querySelector(".date") &&
      !row.querySelector(".time") &&
      !row.querySelector(".band") &&
      !row.querySelector(".cover")
    ) {
      continue;
    }
    seen.add(row);
    rows.push(row);
  }
  return rows;
}

function parseCalendarRow(
  row: DomNode,
  baseUrl: string,
  timezone: string,
  index: number,
  warnings: string[]
): CalendarCandidate | null {
  const detailLink = toNodes(row.querySelectorAll("a[href]"))
    .map((link) => link.getAttribute("href"))
    .find((href): href is string => href !== null && DETAIL_PATH.test(href));
  const url = detailLink ? canonicalBottomUrl(detailLink, baseUrl) : null;
  if (!url) {
    warnings.push(`Calendar row ${index + 1} had no canonical event URL`);
    return null;
  }
  const date = parseCalendarDate(row, url);
  const hasDateMarkup =
    Boolean(row.querySelector(".date")) ||
    toNodes(row.querySelectorAll("a[name]"))
      .map((anchor) => anchor.getAttribute("name"))
      .some((name) => Boolean(name && /^20\d{6}$/u.test(name)));
  const time = parseTimeFacts(
    toNodes(row.querySelectorAll(".time"))
      .map((node) => nodeText(node))
      .join(" "),
    date,
    timezone
  );
  time.session = explicitSession(row) ?? time.session;
  const bands = toNodes(row.querySelectorAll(".band"))
    .map((node) => cleanArtist(nodeText(node)))
    .filter((artist) => artist.length > 0);
  const genres = toNodes(row.querySelectorAll(".genre")).map((node) =>
    collapse(nodeText(node))
  );
  const performers = bands.filter((band, bandIndex) => {
    const genre = genres[bandIndex] ?? "";
    return !isSpinner(band, genre);
  });
  const spinnerNotes = bands.filter((band, bandIndex) => {
    const genre = genres[bandIndex] ?? "";
    return isSpinner(band, genre);
  });
  const price = parsePriceFacts(row);
  const ageRestriction = parseAgeRestriction(
    toNodes(row.querySelectorAll(".age"))
      .map((node) => nodeText(node))
      .join(" ")
  );
  const status = hasSoldOutImage(row) ? ("sold-out" as const) : undefined;
  const title =
    performers.join(" ~ ") ||
    bands.join(" ~ ") ||
    `Bottom of the Hill show ${date ?? ""}`.trim();
  const sourceText = collapse(row.textContent);
  const kindInfo = classifyListing(sourceText, bands, performers, genres);
  const listingArtists =
    kindInfo.kind === "non-music" ||
    (kindInfo.kind === "review" && performers.every(isPlaceholderArtist))
      ? []
      : performers;
  const notes = buildNotes(price, spinnerNotes, sourceText, kindInfo.reason);
  const hasEventSignal =
    date !== undefined &&
    hasDateMarkup &&
    (toNodes(row.querySelectorAll(".time")).length > 0 ||
      bands.length > 0 ||
      toNodes(row.querySelectorAll(".cover")).length > 0);
  if (!hasEventSignal) {
    warnings.push(
      `Calendar row ${index + 1} was missing date, timing, price, or performer data`
    );
    return null;
  }
  if (!date || !hasDateMarkup) {
    warnings.push(
      `Calendar row ${index + 1} had an invalid or missing event date`
    );
    return null;
  }
  if (bands.length === 0) {
    warnings.push(
      `Calendar row ${index + 1} had no performer bands; retained for review`
    );
  }

  const listing: VenueListing = {
    key: url,
    url,
    title,
    date,
    artists: listingArtists,
    startTimeEpochMs: time.startTimeEpochMs,
    doorsTimeEpochMs: time.doorsTimeEpochMs,
    ageRestriction,
    status,
    priceMin: price.faceValue,
    priceMax: price.doorValue ?? price.faceValue,
    isFree:
      price.baseText && /free|no cover|donation/iu.test(price.baseText)
        ? true
        : undefined,
    ticketUrl: parseTicketUrl(row, baseUrl),
    session: time.session,
    notes,
    kind: kindInfo.kind,
    reason: kindInfo.reason,
    evidence: `calendar:${url}`,
  };
  return { listing, baseUrl };
}

function parseRssItem(
  item: DomNode,
  baseUrl: string,
  timezone: string,
  index: number,
  warnings: string[]
): BottomRssRevision | null {
  const title = collapse(item.querySelector("title")?.textContent);
  const link = collapse(
    item.querySelector("rss-link")?.textContent ??
      item.querySelector("link")?.textContent
  );
  const url = canonicalFeedUrl(link, baseUrl);
  const guid = collapse(
    item.querySelector("rss-guid")?.textContent ??
      item.querySelector("guid")?.textContent
  );
  const published = collapse(
    item.querySelector("rss-pubdate")?.textContent ??
      item.querySelector("pubdate")?.textContent
  );
  const descriptionNode = item.querySelector("description");
  if (!title || !url || !guid || !descriptionNode) {
    warnings.push(
      `RSS item ${index + 1} was missing title, link, GUID, or description`
    );
    return null;
  }
  const description = decodeDescriptionMarkup(descriptionNode, baseUrl);
  if (!description.trim()) {
    warnings.push(`RSS item ${index + 1} had an empty description`);
    return null;
  }
  const lines = markupLines(description, baseUrl);
  const date = parseRssDate(title, url);
  if (!date) {
    warnings.push(`RSS item ${index + 1} had no valid event date`);
    return null;
  }
  const timeLine = lines.find((line) =>
    CLOCK_TEST.test(normalizeTimeText(line))
  );
  const time = parseTimeFacts(timeLine ?? "", date, timezone);
  const priceLines = lines.filter((line) => /\$\s*\d/iu.test(line));
  const feeLines = priceLines.filter((line) =>
    /face\s+value|service\s+fee/iu.test(line)
  );
  const baseLines = priceLines.filter((line) => !feeLines.includes(line));
  const price = parsePriceFactsFromText(
    `${baseLines.join(" ")} || ${feeLines.join(" ")}`,
    baseLines.join(" "),
    feeLines.join(" ")
  );
  const age = lines.find((line) =>
    /all ages|\d+\s*(?:and\s*over|\+)/iu.test(line)
  );
  const artists = parseRssArtists(lines, timeLine, priceLines, age);
  const summaryTitle = title
    .replace(/^\s*20\d{2}\s+\d{1,2}\/\d{1,2}\s*:\s*/iu, "")
    .trim();
  const noteParts = [
    price.baseText ? `Prices: ${price.baseText}` : "",
    price.feeText ? `Fee-inclusive: ${price.feeText}` : "",
  ].filter((part) => part.length > 0);
  const publishedAtEpochMs = Date.parse(published);
  return {
    url,
    guid,
    title: summaryTitle || artists.join(" ~ ") || title,
    date,
    artists,
    startTimeEpochMs: time.startTimeEpochMs,
    doorsTimeEpochMs: time.doorsTimeEpochMs,
    ageRestriction: parseAgeRestriction(age ?? ""),
    priceMin: price.faceValue,
    priceMax: price.doorValue ?? price.faceValue,
    notes: noteParts.length > 0 ? noteParts.join("; ") : undefined,
    publishedAtEpochMs: Number.isFinite(publishedAtEpochMs)
      ? publishedAtEpochMs
      : undefined,
    evidence: `rss:${guid}`,
  };
}

function parseRssArtists(
  lines: string[],
  timeLine: string | undefined,
  priceLines: string[],
  ageLine: string | undefined
): string[] {
  const stopAt = timeLine ? lines.indexOf(timeLine) : lines.length;
  const metadataLines = new Set([...priceLines, ...(ageLine ? [ageLine] : [])]);
  return lines
    .slice(0, stopAt < 0 ? lines.length : stopAt)
    .map((line) => cleanArtist(line))
    .filter((line) => {
      if (!line || metadataLines.has(line)) return false;
      if (/^\[.*\]$/u.test(line)) return false;
      if (
        /presents?\.\.\.|benefit show|all proceeds|doors?|music at/iu.test(line)
      )
        return false;
      return true;
    })
    .filter((line, index, values) => values.indexOf(line) === index)
    .filter((line) => !isSpinner(line, ""));
}

function mergeRssRevision(
  listing: VenueListing,
  revision: BottomRssRevision
): VenueListing {
  const artists =
    listing.kind === "non-music"
      ? listing.artists
      : mergeUnannouncedArtists(listing.artists, revision.artists);
  const notes = [
    listing.notes,
    revision.notes,
    `RSS latest revision ${revision.guid}${
      revision.publishedAtEpochMs !== undefined
        ? ` at ${new Date(revision.publishedAtEpochMs).toISOString()}`
        : ""
    }`,
  ].filter((note): note is string => Boolean(note && note.trim()));
  return {
    ...listing,
    title:
      listing.title.startsWith("Bottom of the Hill show") && revision.title
        ? revision.title
        : artists.length > 0 && listing.artists.some(isPlaceholderArtist)
          ? artists.join(" ~ ")
          : listing.title,
    artists,
    startTimeEpochMs: listing.startTimeEpochMs ?? revision.startTimeEpochMs,
    doorsTimeEpochMs: listing.doorsTimeEpochMs ?? revision.doorsTimeEpochMs,
    ageRestriction: listing.ageRestriction ?? revision.ageRestriction,
    priceMin: listing.priceMin ?? revision.priceMin,
    priceMax: listing.priceMax ?? revision.priceMax,
    notes: notes.join("; ") || undefined,
    evidence: `${listing.evidence ?? `calendar:${listing.url}`};${revision.evidence}`,
  };
}

function mergeUnannouncedArtists(
  calendarArtists: string[],
  rssArtists: string[]
): string[] {
  if (calendarArtists.length === 0) return rssArtists;
  if (rssArtists.length === 0) return calendarArtists;
  const merged = calendarArtists.map((artist, index) =>
    isPlaceholderArtist(artist) && rssArtists[index]
      ? rssArtists[index]
      : artist
  );
  if (merged.every(isPlaceholderArtist) && rssArtists.length > 0)
    return rssArtists;
  return merged;
}

function giveDuplicateRowsDistinctKeys(
  candidates: CalendarCandidate[]
): CalendarCandidate[] {
  const seen = new Map<string, number>();
  return candidates.map((candidate) => {
    const base = candidate.listing.url;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    if (occurrence === 1) return candidate;
    const session = candidate.listing.session ?? `performance-${occurrence}`;
    return {
      ...candidate,
      listing: {
        ...candidate.listing,
        key: `${base}#session=${slug(session)}`,
        session,
      },
    };
  });
}

function parseCalendarDate(row: DomNode, url: string): string | undefined {
  const dateText = collapse(row.querySelector(".date")?.textContent);
  const match = dateText.match(
    new RegExp(`\\b(?:${MONTHS})\\s+(\\d{1,2})\\s+(\\d{4})\\b`, "iu")
  );
  if (match) {
    const monthName = dateText
      .slice(match.index ?? 0)
      .match(new RegExp(`^(?:${MONTHS})`, "iu"))?.[0];
    const month = monthName ? monthNumber(monthName) : undefined;
    const date =
      month && match[1] && match[2]
        ? isoDate(Number(match[2]), month, Number(match[1]))
        : undefined;
    if (date) return date;
  }
  return parseDateFromDetailUrl(url);
}

function parseRssDate(title: string, url: string): string | undefined {
  const match = title.match(/\b(20\d{2})\s+(\d{1,2})\/(\d{1,2})\b/iu);
  if (match?.[1] && match[2] && match[3]) {
    const fromTitle = isoDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    );
    if (fromTitle) return fromTitle;
  }
  return parseDateFromDetailUrl(url);
}

function parseDateFromDetailUrl(url: string): string | undefined {
  const match = url.match(DETAIL_DATE);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function isoDate(year: number, month: number, day: number): string | undefined {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  )
    return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const check = new Date(`${value}T00:00:00Z`);
  return check.getUTCFullYear() === year &&
    check.getUTCMonth() + 1 === month &&
    check.getUTCDate() === day
    ? value
    : undefined;
}

function monthNumber(month: string): number | undefined {
  const value = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].indexOf(month.toLowerCase());
  return value < 0 ? undefined : value + 1;
}

function parseTimeFacts(
  text: string,
  date: string | undefined,
  timezone: string
): TimeFacts {
  const rawText = normalizeTimeText(text);
  const tokens: string[] = [];
  CLOCK.lastIndex = 0;
  for (const match of rawText.matchAll(CLOCK)) {
    const hour = Number(match[1]);
    const minute = Number(match[2] ?? "0");
    const meridiem = match[3]?.toUpperCase();
    if (hour < 1 || hour > 12 || minute > 59 || !meridiem) continue;
    tokens.push(`${hour}:${String(minute).padStart(2, "0")}${meridiem}`);
  }
  const epochs = tokens
    .map((token) => parseClockToken(token, date, timezone))
    .filter((value): value is number => value !== undefined);
  const range = /\bto\b|\s[-–]\s/iu.test(rawText) && epochs.length >= 2;
  let startTimeEpochMs: number | undefined;
  let doorsTimeEpochMs: number | undefined;
  if (epochs.length > 0) {
    if (range || !/doors?/iu.test(rawText)) {
      startTimeEpochMs = epochs[0];
    } else {
      doorsTimeEpochMs = epochs[0];
      startTimeEpochMs = epochs[1] ?? epochs[0];
    }
  }
  const session = range ? rawText : undefined;
  return { rawText, tokens, startTimeEpochMs, doorsTimeEpochMs, session };
}

function parseClockToken(
  token: string,
  date: string | undefined,
  timezone: string
): number | undefined {
  if (!date) return undefined;
  const match = token.match(/^(\d{1,2}):(\d{2})(AM|PM)$/iu);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  let hour = Number(match[1]);
  if (match[3].toUpperCase() === "AM" && hour === 12) hour = 0;
  if (match[3].toUpperCase() === "PM" && hour !== 12) hour += 12;
  return (
    localWallClockToEpochMs(date, hour, Number(match[2]), 0, 0, timezone) ??
    undefined
  );
}

function parsePriceFacts(row: DomNode): PriceFacts {
  const baseText = toNodes(row.querySelectorAll(".cover"))
    .map((node) => collapse(node.textContent))
    .filter((value) => /\$|\d/iu.test(value))
    .join(" ");
  const feeText = toNodes(row.querySelectorAll(".note"))
    .map((node) => collapse(node.textContent))
    .filter((value) => /\$|face\s+value|service\s+fee/iu.test(value))
    .join(" ");
  return parsePriceFactsFromText(
    `${baseText} || ${feeText}`,
    baseText,
    feeText
  );
}

function parsePriceFactsFromText(
  text: string,
  explicitBase?: string,
  explicitFee?: string
): PriceFacts {
  const baseText = collapse(explicitBase ?? text.split("||")[0]);
  const feeText = collapse(explicitFee ?? text.split("||")[1] ?? "");
  const baseValues = moneyValues(baseText);
  const feeValues = moneyValues(feeText);
  const hasDoor = /at\s+the\s+door|after\s+that/iu.test(baseText);
  const faceValue = baseValues[0];
  const doorValue = hasDoor
    ? baseValues[baseValues.length - 1]
    : baseValues.length > 1
      ? baseValues[baseValues.length - 1]
      : undefined;
  const feeInclusiveValue = feeValues[0];
  return {
    baseText,
    feeText,
    baseValues,
    feeValues,
    faceValue,
    doorValue,
    feeInclusiveValue,
  };
}

function moneyValues(text: string): number[] {
  const values: number[] = [];
  MONEY.lastIndex = 0;
  for (const match of text.matchAll(MONEY)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function parseAgeRestriction(text: string): VenueListing["ageRestriction"] {
  const value = collapse(text).toLowerCase();
  if (/all\s+ages/iu.test(value)) return "all-ages";
  const match = value.match(/(\d+)\s*(?:and\s+over|\+)/iu);
  if (!match?.[1]) return undefined;
  const age = Number(match[1]);
  if (
    age === 21 ||
    age === 18 ||
    age === 16 ||
    age === 8 ||
    age === 6 ||
    age === 5
  )
    return `${age}+` as VenueListing["ageRestriction"];
  return undefined;
}

function parseTicketUrl(row: DomNode, baseUrl: string): string | undefined {
  const href = toNodes(row.querySelectorAll("a[href]"))
    .map((link) => link.getAttribute("href"))
    .find(
      (value): value is string =>
        value !== null &&
        /\/(?:stubmatic|dice)\/event20\d{6}\.html(?:[?#].*)?$/iu.test(value)
    );
  return href ? canonicalExternalUrl(href, baseUrl) : undefined;
}

function canonicalBottomUrl(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    if (!DETAIL_PATH.test(url.pathname)) return null;
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function canonicalFeedUrl(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    if (!FEED_EVENT_PATH.test(url.pathname)) return null;
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function canonicalExternalUrl(
  href: string,
  baseUrl: string
): string | undefined {
  try {
    const url = new URL(href, baseUrl);
    url.protocol = "https:";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function classifyListing(
  sourceText: string,
  rawBands: string[],
  performers: string[],
  genres: string[]
): { kind: VenueListing["kind"]; reason?: string } {
  const text =
    `${sourceText} ${rawBands.join(" ")} ${genres.join(" ")}`.toLowerCase();
  if (/\b(package|multi[- ]show|show\s+pass|festival\s+pass)\b/iu.test(text)) {
    return {
      kind: "package",
      reason: "Source labels this listing as a package or pass",
    };
  }
  if (
    /\b(karaoke|trivia|comedy|film screening|movie|lecture|workshop|podcast|open mic|burlesque|drag show)\b/iu.test(
      text
    )
  ) {
    return {
      kind: "non-music",
      reason: "Source describes non-band programming",
    };
  }
  if (/\b(?:dance\s+party|dance[- ]night|themed\s+dance)\b/iu.test(text)) {
    return {
      kind: "review",
      reason:
        "Themed dance programming is retained for review without promoting theme names to artists",
    };
  }
  if (rawBands.length > 0 && performers.length === 0) {
    return {
      kind: "non-music",
      reason: "Listing contains only DJ, spinning, or dance programming",
    };
  }
  if (
    rawBands.length === 0 ||
    performers.length === 0 ||
    performers.every(isPlaceholderArtist)
  ) {
    return { kind: "review", reason: "Lineup is unavailable or ambiguous" };
  }
  if (
    genres.some((genre) =>
      /spinning|dance floor|playing .*records/iu.test(genre)
    )
  ) {
    return { kind: "live" };
  }
  return { kind: "live" };
}

function buildNotes(
  price: PriceFacts,
  spinnerNotes: string[],
  sourceText: string,
  reason: string | undefined
): string | undefined {
  const notes = [
    price.baseText ? `Prices: ${price.baseText}` : "",
    price.feeText ? `Fee-inclusive: ${price.feeText}` : "",
    spinnerNotes.length > 0 ? `DJ/spinning: ${spinnerNotes.join("; ")}` : "",
    reason ?? "",
  ].filter((note) => note.length > 0);
  if (
    notes.length === 0 &&
    /present|featuring|benefit|tribute/iu.test(sourceText)
  ) {
    return "Source includes presenter, feature, benefit, or tribute context";
  }
  return notes.length > 0 ? notes.join("; ") : undefined;
}

function isSpinner(band: string, genre: string): boolean {
  return (
    /^\s*\/\s*/u.test(band) ||
    /spinning|dance floor|playing .*records/iu.test(genre)
  );
}

function explicitSession(row: DomNode): string | undefined {
  const classSession = collapse(row.querySelector(".session")?.textContent);
  if (classSession) return classSession;
  const dataSession = collapse(row.getAttribute("data-session"));
  return dataSession || undefined;
}

function cleanArtist(value: string): string {
  return collapse(value)
    .replace(/^\s*[•·]+\s*/u, "")
    .replace(/\s*\[[^\]]*\]\s*/gu, " ")
    .trim();
}

function isPlaceholderArtist(value: string): boolean {
  return /^tba$|^tbd$|^to be announced$|^special guests?$/iu.test(
    collapse(value)
  );
}

function normalizeTimeText(value: string): string {
  return collapse(value).replace(/\s*:\s*/gu, ":");
}

function collapse(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeDescriptionMarkup(node: DomNode, baseUrl: string): string {
  const raw = node.innerHTML || node.textContent || "";
  const first = htmlDocument(`<div>${raw}</div>`, baseUrl).querySelector("div");
  if (!first) return raw;
  if (/&lt;|&#(?:60|x3c);/iu.test(raw)) return first.textContent ?? raw;
  return first.innerHTML;
}

function markupLines(markup: string, baseUrl: string): string[] {
  const withBreaks = markup
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/\r\n?/gu, "\n");
  const root = htmlDocument(`<div>${withBreaks}</div>`, baseUrl).querySelector(
    "div"
  );
  const text = root?.textContent ?? withBreaks;
  return text
    .split("\n")
    .map((line) => collapse(line))
    .filter((line) => line.length > 0);
}

function normalizeRssMarkup(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, "$1")
    .replace(
      /<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/giu,
      "<rss-link>$1</rss-link>"
    )
    .replace(
      /<guid(?:\s[^>]*)?>([\s\S]*?)<\/guid>/giu,
      "<rss-guid>$1</rss-guid>"
    )
    .replace(
      /<pubdate(?:\s[^>]*)?>([\s\S]*?)<\/pubdate>/giu,
      "<rss-pubdate>$1</rss-pubdate>"
    );
}

function isLaterRevision(
  candidate: BottomRssRevision,
  prior: BottomRssRevision
): boolean {
  if (
    candidate.publishedAtEpochMs !== undefined &&
    prior.publishedAtEpochMs !== undefined
  ) {
    return candidate.publishedAtEpochMs >= prior.publishedAtEpochMs;
  }
  return true;
}

function hasSoldOutImage(row: DomNode): boolean {
  return toNodes(row.querySelectorAll("img")).some((image) =>
    /sold\s*out/iu.test(
      `${image.getAttribute("alt") ?? ""} ${image.getAttribute("src") ?? ""}`
    )
  );
}

function hasBalancedCalendarMarkup(text: string): boolean {
  if (!hasBalancedTag(text, "table") || !hasBalancedTag(text, "tr"))
    return false;
  if (/<html\b/iu.test(text) && !/<\/html\s*>/iu.test(text)) return false;
  return true;
}

function hasBalancedRssMarkup(text: string): boolean {
  return (
    /<rss\b/iu.test(text) &&
    /<\/rss\s*>/iu.test(text) &&
    /<channel\b/iu.test(text) &&
    /<\/channel\s*>/iu.test(text) &&
    hasBalancedTag(text, "item")
  );
}

function hasBalancedTag(text: string, tag: string): boolean {
  const open = [...text.matchAll(new RegExp(`<${tag}\\b`, "giu"))].length;
  const close = [...text.matchAll(new RegExp(`</${tag}\\s*>`, "giu"))].length;
  return open > 0 && open === close;
}

function toNodes(nodes: ArrayLike<DomNode>): DomNode[] {
  return Array.from(nodes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usableResponse(response: {
  status: number;
  text: string;
  fromCache: boolean;
}): boolean {
  const successfulStatus = response.status >= 200 && response.status < 300;
  const cachedStatus = response.status === 0 && response.fromCache;
  return (
    (successfulStatus || response.status === 304 || cachedStatus) &&
    response.text.trim().length > 0
  );
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "session"
  );
}
