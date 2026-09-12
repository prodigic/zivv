import { localDateKey, localWallClockToEpochMs } from "../../discovery.js";
import { htmlDocument, nodeText, type DomNode } from "../venue-html.js";
import type { AgeRestriction, EventStatus } from "../../../types/events.js";
import type {
  VenueAdapterResult,
  VenueFetchContext,
  VenueInventory,
  VenueListing,
  VenueSource,
} from "../venue-types.js";

/** Bump when the selectors, identity rules, or inclusion policy change. */
export const RICKSHAW_ADAPTER_VERSION = "rickshaw-stop-v1";
/** Safety bound for an unexpectedly expanded public pagination control. */
export const RICKSHAW_MAX_LIST_PAGES = 20;

const DEFAULT_CALENDAR_URL = "https://rickshawstop.com/calendar/";
const DEFAULT_TICKET_HOSTS = [
  "wl.seetickets.us",
  "wl.eventim.us",
  "www.ticketmaster.com",
  "www.axs.com",
];
// The current official calendar links the JT listing directly to AXS even
// though the venue registry predates that provider. Keep this narrowly scoped
// source-linked host in the adapter allowlist rather than trusting all hosts.
const VERIFIED_SOURCE_LINKED_HOSTS = ["www.axs.com"];
const MONTH_NAMES = [
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
] as const;
const MONTH_PATTERN =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const STATUS_WORDS: Array<[EventStatus, RegExp]> = [
  ["cancelled", /\bcancel(?:led|l?e?d)?\b|canceled/i],
  ["postponed", /\bpostponed\b/i],
  ["rescheduled", /\brescheduled\b/i],
  ["sold-out", /\bsold[ -]?out\b|button-soldout/i],
];
const TRACKING_QUERY_KEYS = new Set([
  "afflky",
  "camefrom",
  "brand",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
]);
const SOCIAL_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "twitter.com",
  "x.com",
  "www.x.com",
]);

/** The one See Tickets -> Eventim redirect observed in source investigation. */
export const RICKSHAW_VERIFIED_TICKET_ALIASES: Readonly<
  Record<string, string>
> = {
  "seetickets:696618": "see-eventim:696618",
  "eventim:696618": "see-eventim:696618",
};

export interface RickshawTicketLink {
  originalUrl: string;
  canonicalUrl: string | null;
  host: string | null;
  provider: "seetickets" | "eventim" | "ticketmaster" | "axs" | "unknown";
  eventId?: string;
  identity: string;
  trusted: boolean;
  reason?: string;
}

export interface RickshawCalendarRecord {
  source: "calendar";
  title: string;
  date?: string;
  monthLabel?: string;
  showTime?: string;
  doorsTime?: string;
  supportingTalent: string[];
  status: EventStatus;
  statusSignal?: string;
  ticket?: RickshawTicketLink;
  originalUrl?: string;
  canonicalUrl?: string;
  ticketIdentity: string;
  evidence: string;
}

export interface RickshawListRecord {
  source: "list";
  page: number;
  title: string;
  dateLabel?: string;
  date?: string;
  headliners: string[];
  supportingTalent: string[];
  showTime?: string;
  doorsTime?: string;
  ageRestriction?: AgeRestriction;
  priceMin?: number;
  priceMax?: number;
  isFree?: boolean;
  genre?: string;
  presentation?: string;
  status: EventStatus;
  statusSignal?: string;
  ticket?: RickshawTicketLink;
  originalUrl?: string;
  canonicalUrl?: string;
  ticketIdentity: string;
  evidence: string;
}

export interface RickshawPaginationLink {
  page: number;
  url?: string;
}

export interface RickshawPagination {
  pages: number[];
  links: RickshawPaginationLink[];
}

/** Public settings emitted by See Tickets for the visible list controls. */
export interface RickshawAjaxSettings {
  ajaxUrl: string;
  nonce: string;
  listType: string;
  currentList?: string;
}

interface RickshawParserOptions {
  baseUrl?: string;
  ticketHosts?: string[];
  page?: number;
  timezone?: string;
}

interface RickshawNormalizedLink {
  href: string;
  ticket: RickshawTicketLink;
}

interface RickshawAggregate {
  calendar?: RickshawCalendarRecord;
  list?: RickshawListRecord;
  unresolvedList?: RickshawListRecord;
  key: string;
}

interface RickshawClassification {
  kind: VenueListing["kind"];
  reason?: string;
}

function asNodes(nodes: ArrayLike<DomNode> | null | undefined): DomNode[] {
  return nodes ? Array.from(nodes) : [];
}

function hasClass(
  node: DomNode | null | undefined,
  className: string
): boolean {
  return (node?.getAttribute("class") ?? "")
    .split(/\s+/u)
    .some((name) => name === className);
}

function attribute(node: DomNode | null | undefined, name: string): string {
  return node?.getAttribute(name)?.trim() ?? "";
}

function compact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function lower(value: string): string {
  return compact(value).toLowerCase();
}

function slug(value: string): string {
  return lower(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
}

function allowedHosts(sourceHosts?: string[]): Set<string> {
  const configured =
    sourceHosts && sourceHosts.length > 0 ? sourceHosts : DEFAULT_TICKET_HOSTS;
  const sourceLinked =
    sourceHosts && sourceHosts.length > 0 ? VERIFIED_SOURCE_LINKED_HOSTS : [];
  return new Set(
    [...configured, ...sourceLinked].map((host) =>
      host.toLowerCase().replace(/\.$/u, "")
    )
  );
}

function stripTracking(url: URL): string {
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_QUERY_KEYS.has(key.toLowerCase()))
      url.searchParams.delete(key);
  }
  // Provider event identity comes from the verified path ID. Any remaining
  // query parameters are presentation or campaign state and must not split
  // one source event into multiple candidates.
  url.search = "";
  url.hash = "";
  return url.toString();
}

function decodeUrlDefense(raw: string): string | null {
  let value = compact(raw).replace(/&amp;/giu, "&");
  if (!/urldefense\.com/i.test(value)) return value;

  // The public calendar currently uses the documented v3 marker form:
  // `/v3/__https://provider.example/event/ID__;<integrity-token>`.  Keep
  // extraction bounded to the marker and decode its destination only; the
  // trailing integrity token is not a ticket URL and must not become part of
  // the provider identity.  Some saved source captures percent-encode the
  // inner URL, so decode after extracting both forms.
  const marker = value.match(/\/v\d+\/__(.*?)(?:__|$)/iu);
  const fallbackMarker = value.match(
    /__((?:https?|ftp)(?::|%3a).*?)(?:__|$)/iu
  );
  const destination = marker?.[1] ?? fallbackMarker?.[1];
  if (!destination) return null;
  value = destination;
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the already-readable URL if only a query value is encoded.
  }
  return /^https?:\/\//iu.test(value) ? value : null;
}

function providerForHost(host: string | null): RickshawTicketLink["provider"] {
  if (host === "wl.seetickets.us") return "seetickets";
  if (host === "wl.eventim.us") return "eventim";
  if (host === "www.ticketmaster.com") return "ticketmaster";
  if (host === "www.axs.com") return "axs";
  return "unknown";
}

function eventIdForUrl(
  url: URL,
  provider: RickshawTicketLink["provider"]
): string | undefined {
  if (provider === "unknown") return undefined;
  const path = url.pathname.split("/").filter(Boolean);
  const eventSegment = provider === "axs" ? "events" : "event";
  const eventIndex = path.findIndex(
    (segment) => segment.toLowerCase() === eventSegment
  );
  if (eventIndex < 0) return undefined;

  if (provider === "axs") {
    const id = path[eventIndex + 1];
    return id && /^\d+$/u.test(id) ? id : undefined;
  }

  if (provider === "ticketmaster") {
    const id = path[eventIndex + 1];
    return id && /^[a-z0-9]+$/iu.test(id) ? id.toUpperCase() : undefined;
  }

  const id = path
    .slice(eventIndex + 1)
    .find((segment) => /^\d+$/u.test(segment));
  return id;
}

function verifiedIdentity(
  provider: RickshawTicketLink["provider"],
  eventId: string | undefined
): string {
  if (!eventId || provider === "unknown") return `${provider}:unknown`;
  const direct = `${provider}:${eventId}`;
  return RICKSHAW_VERIFIED_TICKET_ALIASES[direct] ?? direct;
}

function normalizeTicketLink(
  rawHref: string,
  baseUrl: string,
  ticketHosts?: string[]
): RickshawNormalizedLink | null {
  const originalUrl = compact(rawHref);
  if (
    !originalUrl ||
    /(?:sharer\.php|intent\/tweet|facebook\.com\/sharer)/iu.test(originalUrl)
  ) {
    return null;
  }

  const decoded = decodeUrlDefense(originalUrl);
  if (!decoded) {
    return {
      href: originalUrl,
      ticket: {
        originalUrl,
        canonicalUrl: null,
        host: "urldefense.com",
        provider: "unknown",
        identity: "unknown:urldefense",
        trusted: false,
        reason: "URL Defense wrapper did not expose a readable destination",
      },
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(decoded, baseUrl);
  } catch {
    return {
      href: originalUrl,
      ticket: {
        originalUrl,
        canonicalUrl: null,
        host: null,
        provider: "unknown",
        identity: "unknown:invalid-url",
        trusted: false,
        reason: "ticket link is not an absolute or source-relative URL",
      },
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (SOCIAL_HOSTS.has(host)) return null;
  const hosts = allowedHosts(ticketHosts);
  const provider = providerForHost(host);
  const eventId = eventIdForUrl(parsed, provider);
  const trusted = hosts.has(host) && eventId !== undefined;
  const canonicalUrl = stripTracking(parsed);
  const identity = trusted
    ? verifiedIdentity(provider, eventId)
    : `unknown:${host}:${parsed.pathname}`;

  return {
    href: originalUrl,
    ticket: {
      originalUrl,
      canonicalUrl,
      host,
      provider,
      ...(eventId ? { eventId } : {}),
      identity,
      trusted,
      ...(trusted
        ? {}
        : {
            reason: hosts.has(host)
              ? "ticket URL has no recognized provider event ID"
              : `ticket host ${host} is not in the verified source allowlist`,
          }),
    },
  };
}

/** Return a canonical trusted provider URL while retaining the source URL in callers. */
export function canonicalizeRickshawTicketUrl(
  rawHref: string,
  baseUrl = DEFAULT_CALENDAR_URL,
  ticketHosts = DEFAULT_TICKET_HOSTS
): string | null {
  const normalized = normalizeTicketLink(rawHref, baseUrl, ticketHosts);
  return normalized?.ticket.trusted ? normalized.ticket.canonicalUrl : null;
}

/** Parse and validate a Rickshaw ticket link, including the known URL Defense form. */
export function parseRickshawTicketUrl(
  rawHref: string,
  baseUrl = DEFAULT_CALENDAR_URL,
  ticketHosts = DEFAULT_TICKET_HOSTS
): RickshawTicketLink | null {
  return normalizeTicketLink(rawHref, baseUrl, ticketHosts)?.ticket ?? null;
}

function firstTicketLink(
  node: DomNode,
  options: RickshawParserOptions
): RickshawNormalizedLink | null {
  const baseUrl = options.baseUrl ?? DEFAULT_CALENDAR_URL;
  const hosts = options.ticketHosts ?? DEFAULT_TICKET_HOSTS;
  for (const anchor of asNodes(node.querySelectorAll("a[href]"))) {
    const href = attribute(anchor, "href");
    const normalized = normalizeTicketLink(href, baseUrl, hosts);
    if (normalized) return normalized;
  }
  return null;
}

function parseClock(value: string): string | undefined {
  const text = compact(value).toUpperCase();
  const meridiemMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/u);
  const match = meridiemMatch ?? text.match(/\b(\d{1,2}):(\d{2})\b/u);
  if (!match) return undefined;
  const hourValue = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = meridiemMatch?.[3];
  if (
    !Number.isInteger(hourValue) ||
    !Number.isInteger(minute) ||
    minute > 59
  ) {
    return undefined;
  }
  let hour = hourValue;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === "AM") hour = hour === 12 ? 0 : hour;
    if (meridiem === "PM" && hour !== 12) hour += 12;
  } else if (hour > 23) {
    return undefined;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Normalize a source clock such as `8:00PM` or `20:00` to 24-hour `HH:MM`. */
export function parseRickshawTime(value: string): string | undefined {
  return parseClock(value);
}

function labelledTime(
  value: string,
  label: "show" | "doors"
): string | undefined {
  const expression =
    label === "show"
      ? /show\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/iu
      : /doors\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/iu;
  const match = compact(value).match(expression);
  return parseClock(match?.[1] ?? value);
}

function parseMonthHeader(
  value: string
): { month: number; year: number } | undefined {
  const match = compact(value).match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/iu
  );
  if (!match) return undefined;
  const month = MONTH_NAMES.indexOf(
    match[1].toLowerCase() as (typeof MONTH_NAMES)[number]
  );
  const year = Number(match[2]);
  return month >= 0 && year >= 1 ? { month: month + 1, year } : undefined;
}

function monthNumber(value: string): number | undefined {
  const normalized = value.toLowerCase();
  const month = MONTH_NAMES.findIndex(
    (name) => name === normalized || name.startsWith(normalized.slice(0, 3))
  );
  return month >= 0 ? month + 1 : undefined;
}

function validCalendarDate(
  year: number,
  month: number,
  day: number
): string | undefined {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  )
    return undefined;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dayFromCalendarEvent(event: DomNode): number | undefined {
  const cell = event.closest("td");
  const dayText = nodeText(cell?.querySelector(".date-number"));
  const day = Number(dayText);
  return /^\d{1,2}$/u.test(dayText) && day >= 1 && day <= 31 ? day : undefined;
}

function cleanTalent(value: string, label: RegExp): string {
  return compact(value.replace(label, ""));
}

function splitTalent(value: string): string[] {
  const text = compact(value)
    .replace(/^(?:supporting\s+talent|headliners?)\s*:\s*/iu, "")
    .replace(/\b(?:support\s+)?tba\b/giu, "")
    .trim();
  if (!text) return [];
  return text
    .split(/\s*[,;]\s*|\s+and\s+/iu)
    .map((item) => compact(item))
    .filter((item) => item && !/^(?:support|tba|none)$/iu.test(item));
}

function parseSupport(node: DomNode | null): string[] {
  return splitTalent(cleanTalent(nodeText(node), /^Supporting\s+Talent:\s*/iu));
}

function parseAge(value: string): AgeRestriction | undefined {
  const text = lower(value);
  if (/all\s*ages|a\/a/u.test(text)) return "all-ages";
  const match = text.match(/\b(5|6|8|16|18|21)\s*\+/u);
  if (!match) return undefined;
  return `${match[1]}+` as AgeRestriction;
}

function parsePrice(value: string): {
  priceMin?: number;
  priceMax?: number;
  isFree?: boolean;
} {
  const text = compact(value);
  if (/\bfree\b|no\s+cover/iu.test(text)) return { isFree: true };
  const values = [...text.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/gu)].map((match) =>
    Number(match[1])
  );
  if (!values.length) return {};
  const priceMin = Math.min(...values);
  const priceMax = Math.max(...values);
  return {
    priceMin,
    ...(priceMax !== priceMin ? { priceMax } : {}),
  };
}

/** Map source status markup and action text to the canonical event status. */
export function parseRickshawStatus(node: DomNode): {
  status: EventStatus;
  signal: string;
} {
  const button =
    node.querySelector(".button-soldout") ??
    node.querySelector(".button-cancelled") ??
    node.querySelector(".button-postponed") ??
    node.querySelector(".button-rescheduled") ??
    node.querySelector(".seetickets-buy-btn");
  const signal = lower(
    `${attribute(node, "class")} ${attribute(button, "class")} ${nodeText(button)}`
  );
  for (const [status, pattern] of STATUS_WORDS) {
    if (pattern.test(signal)) return { status, signal };
  }
  return { status: "confirmed", signal };
}

function parseCalendarEvent(
  event: DomNode,
  month: { month: number; year: number } | undefined,
  options: RickshawParserOptions
): RickshawCalendarRecord {
  const titleNode = event.querySelector(".seetickets-calendar-event-title");
  const title = nodeText(titleNode?.querySelector("a") ?? titleNode);
  const sourceDate =
    month && dayFromCalendarEvent(event)
      ? validCalendarDate(
          month.year,
          month.month,
          dayFromCalendarEvent(event) as number
        )
      : undefined;
  const supportNode = event.querySelector(".supporting-talent");
  const timeText = nodeText(
    event.querySelector(".seetickets-calendar-event-date")
  );
  const normalizedLink = firstTicketLink(event, options);
  const parsedStatus = parseRickshawStatus(event);
  const ticket = normalizedLink?.ticket;
  return {
    source: "calendar",
    title,
    ...(sourceDate ? { date: sourceDate } : {}),
    ...(month
      ? { monthLabel: `${MONTH_NAMES[month.month - 1]} ${month.year}` }
      : {}),
    ...(labelledTime(timeText, "show")
      ? { showTime: labelledTime(timeText, "show") }
      : {}),
    ...(labelledTime(timeText, "doors")
      ? { doorsTime: labelledTime(timeText, "doors") }
      : {}),
    supportingTalent: parseSupport(supportNode),
    status: parsedStatus.status,
    statusSignal: parsedStatus.signal,
    ...(ticket ? { ticket } : {}),
    ...(ticket?.originalUrl ? { originalUrl: ticket.originalUrl } : {}),
    ...(ticket?.canonicalUrl ? { canonicalUrl: ticket.canonicalUrl } : {}),
    ticketIdentity: ticket?.identity ?? `title:${slug(title)}`,
    evidence: "calendar:.seetickets-calendar-event-container",
  };
}

/** Parse all calendar month grids, including empty month grids between events. */
export function parseRickshawCalendar(
  text: string,
  options: RickshawParserOptions = {}
): RickshawCalendarRecord[] {
  const document = htmlDocument(text, options.baseUrl ?? DEFAULT_CALENDAR_URL);
  let month: { month: number; year: number } | undefined;
  const records: RickshawCalendarRecord[] = [];
  const sequence = asNodes(
    document.querySelectorAll(
      ".seetickets-calendar-year-month-container, .seetickets-calendar-event-container"
    )
  );
  for (const node of sequence) {
    if (hasClass(node, "seetickets-calendar-year-month-container")) {
      month = parseMonthHeader(nodeText(node));
      continue;
    }
    records.push(parseCalendarEvent(node, month, options));
  }
  return records;
}

function listDateWithYear(
  dateLabel: string | undefined,
  yearHint: number | undefined
): string | undefined {
  if (!dateLabel) return undefined;
  const text = compact(dateLabel);
  const withYear = text.match(
    new RegExp(
      `(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\\s*(${MONTH_PATTERN})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`,
      "iu"
    )
  );
  if (!withYear) return undefined;
  const month = monthNumber(withYear[1]);
  const day = Number(withYear[2]);
  const year = withYear[3] ? Number(withYear[3]) : yearHint;
  return year && month ? validCalendarDate(year, month, day) : undefined;
}

function listDateLabel(node: DomNode): string | undefined {
  const text = nodeText(node.querySelector(".date"));
  return text || undefined;
}

function listLink(
  node: DomNode,
  options: RickshawParserOptions
): RickshawNormalizedLink | null {
  const titleAnchor = node.querySelector(".title a");
  if (titleAnchor) {
    const normalized = normalizeTicketLink(
      attribute(titleAnchor, "href"),
      options.baseUrl ?? DEFAULT_CALENDAR_URL,
      options.ticketHosts ?? DEFAULT_TICKET_HOSTS
    );
    if (normalized) return normalized;
  }
  return firstTicketLink(node, options);
}

/** Parse one public list page into enriched source facts. */
export function parseRickshawListPage(
  text: string,
  options: RickshawParserOptions = {}
): RickshawListRecord[] {
  const page = options.page ?? 1;
  const document = htmlDocument(text, options.baseUrl ?? DEFAULT_CALENDAR_URL);
  return asNodes(
    document.querySelectorAll(".seetickets-list-event-container")
  ).map((card): RickshawListRecord => {
    const titleNode = card.querySelector(".title");
    const title = nodeText(titleNode?.querySelector("a") ?? titleNode);
    const dateLabel = listDateLabel(card);
    const headliners = splitTalent(nodeText(card.querySelector(".headliners")));
    const supportingTalent = parseSupport(
      card.querySelector(".supporting-talent")
    );
    const timeText = nodeText(card.querySelector(".doortime-showtime"));
    const price = parsePrice(nodeText(card.querySelector(".price")));
    const normalizedLink = listLink(card, options);
    const ticket = normalizedLink?.ticket;
    const parsedStatus = parseRickshawStatus(card);
    return {
      source: "list",
      page,
      title,
      ...(dateLabel ? { dateLabel } : {}),
      ...(listDateWithYear(dateLabel, undefined)
        ? { date: listDateWithYear(dateLabel, undefined) }
        : {}),
      headliners,
      supportingTalent,
      ...(parseClock(nodeText(card.querySelector(".see-showtime")))
        ? {
            showTime: parseClock(nodeText(card.querySelector(".see-showtime"))),
          }
        : labelledTime(timeText, "show")
          ? { showTime: labelledTime(timeText, "show") }
          : {}),
      ...(parseClock(nodeText(card.querySelector(".see-doortime")))
        ? {
            doorsTime: parseClock(
              nodeText(card.querySelector(".see-doortime"))
            ),
          }
        : labelledTime(timeText, "doors")
          ? { doorsTime: labelledTime(timeText, "doors") }
          : {}),
      ...(parseAge(nodeText(card.querySelector(".ages")))
        ? { ageRestriction: parseAge(nodeText(card.querySelector(".ages"))) }
        : {}),
      ...(price.priceMin !== undefined ? { priceMin: price.priceMin } : {}),
      ...(price.priceMax !== undefined ? { priceMax: price.priceMax } : {}),
      ...(price.isFree !== undefined ? { isFree: price.isFree } : {}),
      ...(nodeText(card.querySelector(".genre"))
        ? { genre: nodeText(card.querySelector(".genre")) }
        : {}),
      ...(nodeText(card.querySelector(".header"))
        ? { presentation: nodeText(card.querySelector(".header")) }
        : {}),
      status: parsedStatus.status,
      statusSignal: parsedStatus.signal,
      ...(ticket ? { ticket } : {}),
      ...(ticket?.originalUrl ? { originalUrl: ticket.originalUrl } : {}),
      ...(ticket?.canonicalUrl ? { canonicalUrl: ticket.canonicalUrl } : {}),
      ticketIdentity: ticket?.identity ?? `title:${slug(title)}`,
      evidence: `list:.seetickets-list-event-container(page=${page})`,
    };
  });
}

export const parseRickshawList = parseRickshawListPage;

/** Return every month heading in source order, including headings with no events. */
export function parseRickshawCalendarMonths(
  text: string,
  options: Pick<RickshawParserOptions, "baseUrl"> = {}
): string[] {
  const document = htmlDocument(text, options.baseUrl ?? DEFAULT_CALENDAR_URL);
  return asNodes(
    document.querySelectorAll(".seetickets-calendar-year-month-container")
  )
    .map((node) => nodeText(node))
    .filter((value) => parseMonthHeader(value) !== undefined);
}

function publicPageUrl(
  href: string | undefined,
  baseUrl: string,
  sourceUrl: string
): string | undefined {
  if (!href) return undefined;
  try {
    const source = new URL(sourceUrl);
    const url = new URL(href, baseUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== source.hostname.toLowerCase()
    ) {
      return undefined;
    }
    if (
      url.pathname.includes("/wp-admin/") ||
      /admin-ajax\.php$/iu.test(url.pathname)
    ) {
      return undefined;
    }
    if (!url.pathname.startsWith("/calendar")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function controlHref(control: DomNode): string | undefined {
  const direct = attribute(control, "href");
  if (direct) return direct;
  for (const name of [
    "data-href",
    "data-url",
    "data-page-url",
    "data-see-url",
  ]) {
    const value = attribute(control, name);
    if (value) return value;
  }
  const anchor = control.querySelector("a[href]");
  if (anchor) return attribute(anchor, "href");
  let parent = control.parentElement;
  while (parent) {
    const parentAnchor = parent.querySelector("a[href]");
    if (parentAnchor) return attribute(parentAnchor, "href");
    parent = parent.parentElement;
  }
  return undefined;
}

/** Read the source's advertised list-page controls without deriving private AJAX URLs. */
export function parseRickshawPagination(
  text: string,
  options: RickshawParserOptions = {}
): RickshawPagination {
  const baseUrl = options.baseUrl ?? DEFAULT_CALENDAR_URL;
  const document = htmlDocument(text, baseUrl);
  const controls = asNodes(document.querySelectorAll("[data-see-ajax-page]"));
  const links = controls
    .map((control): RickshawPaginationLink | undefined => {
      const page = Number(attribute(control, "data-see-ajax-page"));
      if (!Number.isInteger(page) || page < 1) return undefined;
      const href = publicPageUrl(
        controlHref(control),
        baseUrl,
        options.baseUrl ?? DEFAULT_CALENDAR_URL
      );
      return href ? { page, url: href } : { page };
    })
    .filter((link): link is RickshawPaginationLink => link !== undefined);
  const pages = [1, ...links.map((link) => link.page)]
    .filter((page, index, all) => all.indexOf(page) === index)
    .sort((a, b) => a - b);
  return {
    pages,
    links: pages.map(
      (page) => links.find((link) => link.page === page) ?? { page }
    ),
  };
}

function stringField(value: unknown, name: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const candidate = (value as Record<string, unknown>)[name];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

/**
 * Read the public settings that the loaded See Tickets script uses for list
 * pagination.  A nonce or endpoint is accepted only from the source page's
 * `seetickets_ajax_obj`; no endpoint is inferred when that object is absent.
 */
export function parseRickshawAjaxSettings(
  text: string,
  options: Pick<RickshawParserOptions, "baseUrl"> = {}
): RickshawAjaxSettings | undefined {
  const baseUrl = options.baseUrl ?? DEFAULT_CALENDAR_URL;
  const document = htmlDocument(text, baseUrl);
  for (const script of asNodes(document.querySelectorAll("script"))) {
    const source = nodeText(script);
    const assignment = source.match(
      /seetickets_ajax_obj\s*=\s*(\{[\s\S]*?\})\s*;?/iu
    );
    if (!assignment) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(assignment[1]);
    } catch {
      continue;
    }
    const rawUrl = stringField(parsed, "ajax_url");
    const nonce = stringField(parsed, "nonce");
    if (!rawUrl || !nonce) continue;
    let ajaxUrl: URL;
    let sourceUrl: URL;
    try {
      ajaxUrl = new URL(rawUrl.replaceAll("\\/", "/"), baseUrl);
      sourceUrl = new URL(baseUrl);
    } catch {
      continue;
    }
    if (
      ajaxUrl.protocol !== "https:" ||
      ajaxUrl.hostname.toLowerCase() !== sourceUrl.hostname.toLowerCase() ||
      ajaxUrl.pathname !== "/wp-admin/admin-ajax.php"
    ) {
      continue;
    }
    ajaxUrl.search = "";
    ajaxUrl.hash = "";
    const pagination = document.querySelector(
      ".seetickets-list-view-pagination"
    );
    const listType = attribute(pagination, "data-list-type") || "list";
    const currentList = attribute(pagination, "data-nth-list-element") || "1";
    return {
      ajaxUrl: ajaxUrl.toString(),
      nonce,
      listType,
      currentList,
    };
  }
  return undefined;
}

/** Build the exact GET URL used by the public See Tickets pagination handler. */
export function rickshawPaginationRequestUrl(
  settings: RickshawAjaxSettings,
  page: number
): string | undefined {
  if (!Number.isInteger(page) || page < 1) return undefined;
  const url = new URL(settings.ajaxUrl);
  url.search = new URLSearchParams([
    ["action", "get_seetickets_events"],
    ["nonce", settings.nonce],
    ["listType", settings.listType],
    ["seeAjaxPage", String(page)],
    ...(settings.currentList
      ? [["currentList", settings.currentList] as [string, string]]
      : []),
  ]).toString();
  return url.toString();
}

function ticketDateKey(record: {
  ticketIdentity: string;
  date?: string;
  showTime?: string;
}): string {
  return `${record.ticketIdentity}|${record.date ?? "unknown-date"}|${record.showTime ?? "unspecified"}`;
}

function titleDateKey(record: {
  title: string;
  date?: string;
  showTime?: string;
}): string {
  return `${slug(record.title)}|${record.date ?? "unknown-date"}|${record.showTime ?? "unspecified"}`;
}

function sourceKey(
  sourceId: string,
  ticketIdentity: string,
  date: string | undefined,
  showTime: string | undefined
): string {
  return `${sourceId}:${ticketIdentity}:${date ?? "unknown-date"}:${showTime ?? "unspecified"}`;
}

function resolveListDate(
  list: RickshawListRecord,
  calendars: RickshawCalendarRecord[]
): string | undefined {
  const sameTicket = calendars.filter(
    (calendar) => calendar.ticketIdentity === list.ticketIdentity
  );
  const bySession = sameTicket.filter(
    (calendar) =>
      !list.showTime ||
      !calendar.showTime ||
      calendar.showTime === list.showTime
  );
  const labelMatch = list.dateLabel?.match(
    new RegExp(
      `(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\\s*(${MONTH_PATTERN})\\s+(\\d{1,2})`,
      "iu"
    )
  );
  if (labelMatch) {
    const month = String(monthNumber(labelMatch[1]) ?? 0).padStart(2, "0");
    const day = String(Number(labelMatch[2])).padStart(2, "0");
    const byMonthDay = bySession.filter((calendar) =>
      calendar.date?.endsWith(`-${month}-${day}`)
    );
    if (byMonthDay.length === 1) return byMonthDay[0].date;
  }
  if (bySession.length === 1) return bySession[0].date;
  if (list.date) return list.date;
  return undefined;
}

function dateHintForList(
  list: RickshawListRecord,
  calendars: RickshawCalendarRecord[]
): RickshawListRecord {
  const date = resolveListDate(list, calendars);
  return date ? { ...list, date } : list;
}

function mergeStatus(
  calendar: RickshawCalendarRecord | undefined,
  list: RickshawListRecord | undefined
): EventStatus {
  const values = [calendar?.status, list?.status].filter(
    (status): status is EventStatus => status !== undefined
  );
  if (values.includes("cancelled")) return "cancelled";
  if (values.includes("postponed")) return "postponed";
  if (values.includes("rescheduled")) return "rescheduled";
  if (values.includes("sold-out")) return "sold-out";
  return "confirmed";
}

function classificationText(
  calendar: RickshawCalendarRecord | undefined,
  list: RickshawListRecord | undefined
): string {
  return lower(
    [
      calendar?.title,
      list?.title,
      list?.genre,
      list?.presentation,
      ...(list?.headliners ?? []),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ")
  );
}

/** Classify themed dance and non-music programming without inventing performers. */
export function classifyRickshawListing(
  calendar: RickshawCalendarRecord | undefined,
  list: RickshawListRecord | undefined
): RickshawClassification {
  const text = classificationText(calendar, list);
  if (
    /\bnerd\s+nite\b|\blecture\b|\bspoken\s+word\b|\bpanel\b|\bcomedy\b/iu.test(
      text
    )
  ) {
    return {
      kind: "non-music",
      reason: "non-music programming is retained for coverage review",
    };
  }
  if (
    /dj\s*\/\s*dance|\bdance\b|\brave\b|\bemo\s+nite\b|\bhaus\s+party\b/iu.test(
      text
    )
  ) {
    return {
      kind: "review",
      reason:
        "dance or themed programming has no verified performing-artist roster",
    };
  }
  if (!list?.headliners?.length) {
    return {
      kind: "review",
      reason: "listing has no verified list-page performer roster",
    };
  }
  return { kind: "live" };
}

function fallbackHeadliners(
  list: RickshawListRecord | undefined,
  classification: RickshawClassification
): string[] {
  if (classification.kind !== "live") return [];
  const fromList = list?.headliners ?? [];
  return fromList;
}

function mergeArtists(
  calendar: RickshawCalendarRecord | undefined,
  list: RickshawListRecord | undefined,
  classification: RickshawClassification
): string[] {
  if (classification.kind !== "live") return [];
  return [
    ...new Set([
      ...fallbackHeadliners(list, classification),
      ...(list?.supportingTalent ?? []),
      ...(calendar?.supportingTalent ?? []),
    ]),
  ];
}

function mergedEvidence(
  calendar: RickshawCalendarRecord | undefined,
  list: RickshawListRecord | undefined
): string {
  return [calendar?.evidence, list?.evidence].filter(Boolean).join("; ");
}

function toVenueListing(
  source: VenueSource,
  aggregate: RickshawAggregate
): VenueListing {
  const calendar = aggregate.calendar;
  const list = aggregate.list ?? aggregate.unresolvedList;
  const classification = classifyRickshawListing(calendar, list);
  const date = calendar?.date ?? list?.date ?? "unknown";
  const showTime = list?.showTime ?? calendar?.showTime;
  const doorsTime = list?.doorsTime ?? calendar?.doorsTime;
  const timezone = source.timezone || "America/Los_Angeles";
  const startParts = showTime?.split(":").map(Number);
  const doorsParts = doorsTime?.split(":").map(Number);
  const startTimeEpochMs =
    startParts?.length === 2 && date !== "unknown"
      ? (localWallClockToEpochMs(
          date,
          startParts[0],
          startParts[1],
          0,
          0,
          timezone
        ) ?? undefined)
      : undefined;
  const doorsTimeEpochMs =
    doorsParts?.length === 2 && date !== "unknown"
      ? (localWallClockToEpochMs(
          date,
          doorsParts[0],
          doorsParts[1],
          0,
          0,
          timezone
        ) ?? undefined)
      : undefined;
  const status = mergeStatus(calendar, list);
  const ticket = calendar?.ticket ?? list?.ticket;
  const title = list?.title || calendar?.title || "Untitled Rickshaw listing";
  const notes = [
    list?.genre ? `Genre: ${list.genre}` : undefined,
    list?.presentation ? `Presentation: ${list.presentation}` : undefined,
    status === "sold-out" && /more\s+info/iu.test(calendar?.statusSignal ?? "")
      ? "Source marks button-soldout while rendering More Info"
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("; ");
  const reason =
    aggregate.unresolvedList && !calendar
      ? "list-page record has no matching full-calendar occurrence; date/year remains unresolved"
      : !ticket?.trusted && ticket?.reason
        ? ticket.reason
        : classification.reason;
  return {
    key: aggregate.key,
    url: ticket?.canonicalUrl ?? ticket?.originalUrl ?? source.calendarUrl,
    title,
    date,
    artists: mergeArtists(calendar, list, classification),
    ...(startTimeEpochMs !== undefined ? { startTimeEpochMs } : {}),
    ...(doorsTimeEpochMs !== undefined ? { doorsTimeEpochMs } : {}),
    ...(list?.ageRestriction ? { ageRestriction: list.ageRestriction } : {}),
    status,
    ...(list?.priceMin !== undefined ? { priceMin: list.priceMin } : {}),
    ...(list?.priceMax !== undefined ? { priceMax: list.priceMax } : {}),
    ...(list?.isFree !== undefined ? { isFree: list.isFree } : {}),
    ...(ticket?.originalUrl ? { ticketUrl: ticket.originalUrl } : {}),
    ...(showTime ? { session: showTime } : {}),
    ...(notes ? { notes } : {}),
    kind: classification.kind,
    ...(reason ? { reason } : {}),
    evidence: mergedEvidence(calendar, list),
  };
}

function aggregateRecords(
  source: VenueSource,
  calendars: RickshawCalendarRecord[],
  lists: RickshawListRecord[]
): { aggregates: RickshawAggregate[]; unmatchedLists: RickshawListRecord[] } {
  const aggregates: RickshawAggregate[] = [];
  const byTicket = new Map<string, RickshawAggregate[]>();
  const byTitle = new Map<string, RickshawAggregate>();

  const addAggregate = (
    record: RickshawCalendarRecord,
    key: string
  ): RickshawAggregate => {
    const aggregate: RickshawAggregate = { calendar: record, key };
    aggregates.push(aggregate);
    const ticketKey = ticketDateKey(record);
    const ticketPrefix = `${record.ticketIdentity}|${record.date ?? "unknown-date"}|`;
    byTicket.set(ticketKey, [...(byTicket.get(ticketKey) ?? []), aggregate]);
    byTicket.set(ticketPrefix, [
      ...(byTicket.get(ticketPrefix) ?? []),
      aggregate,
    ]);
    byTitle.set(titleDateKey(record), aggregate);
    return aggregate;
  };

  for (const calendar of calendars) {
    const key = sourceKey(
      source.sourceId,
      calendar.ticketIdentity,
      calendar.date,
      calendar.showTime
    );
    const duplicate = byTicket
      .get(ticketDateKey(calendar))
      ?.find((item) => item.calendar);
    if (!duplicate) addAggregate(calendar, key);
  }

  const unmatchedLists: RickshawListRecord[] = [];
  for (const rawList of lists) {
    const list = dateHintForList(rawList, calendars);
    const exact = byTicket.get(ticketDateKey(list))?.find((item) => !item.list);
    const dateOnly = byTicket
      .get(`${list.ticketIdentity}|${list.date ?? "unknown-date"}|`)
      ?.filter((item) => !item.list);
    const titleMatch = byTitle.get(titleDateKey(list));
    const target =
      exact ?? (dateOnly?.length === 1 ? dateOnly[0] : undefined) ?? titleMatch;
    if (target) {
      target.list = list;
      continue;
    }

    const key = sourceKey(
      source.sourceId,
      list.ticketIdentity,
      list.date,
      list.showTime
    );
    const duplicate = aggregates.find(
      (item) =>
        item.key === key ||
        item.unresolvedList?.ticketIdentity === list.ticketIdentity
    );
    if (duplicate) {
      duplicate.unresolvedList = list;
    } else {
      const aggregate: RickshawAggregate = { unresolvedList: list, key };
      aggregates.push(aggregate);
      unmatchedLists.push(list);
    }
  }
  return { aggregates, unmatchedLists };
}

function initialResult(sourceId: string): VenueAdapterResult {
  return {
    sourceId,
    adapterVersion: RICKSHAW_ADAPTER_VERSION,
    listings: [],
    inventories: [],
    complete: false,
    warnings: [],
  };
}

function fetchFailedResult(
  source: VenueSource,
  reason: string
): VenueAdapterResult {
  const result = initialResult(source.sourceId);
  result.inventories = [
    { name: "calendar", keys: [], complete: false, reason },
    { name: "list-pages", keys: [], complete: false, reason },
  ];
  result.warnings.push(reason);
  return result;
}

function statusOkay(status: number, body: string): boolean {
  return (
    (status >= 200 && status < 300) ||
    (status === 304 && body.trim().length > 0)
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Fetch and deterministically parse Rickshaw's full calendar plus public list pages. */
export async function fetchRickshawStop(
  context: VenueFetchContext
): Promise<VenueAdapterResult> {
  const source = context.source;
  const calendarUrl = source.calendarUrl || DEFAULT_CALENDAR_URL;
  const result = initialResult(source.sourceId);
  let calendarResponse;
  try {
    calendarResponse = await context.fetchText(calendarUrl);
  } catch (error) {
    return fetchFailedResult(
      source,
      `Rickshaw calendar fetch failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
  if (
    !statusOkay(calendarResponse.status, calendarResponse.text) ||
    !calendarResponse.text.trim()
  ) {
    return fetchFailedResult(
      source,
      `Rickshaw calendar response was unusable (status ${calendarResponse.status}, ${calendarResponse.text.length} body characters)`
    );
  }

  const parserOptions: RickshawParserOptions = {
    baseUrl: calendarUrl,
    ticketHosts: source.ticketHosts,
    timezone: source.timezone,
  };
  const calendars = parseRickshawCalendar(calendarResponse.text, parserOptions);
  const pagination = parseRickshawPagination(
    calendarResponse.text,
    parserOptions
  );
  const ajaxSettings = parseRickshawAjaxSettings(
    calendarResponse.text,
    parserOptions
  );
  const listRecords = parseRickshawListPage(calendarResponse.text, {
    ...parserOptions,
    page: 1,
  });
  const fetchedPages = new Set([1]);
  const listWarnings: string[] = [];
  const expectedPages = pagination.pages.filter(
    (page) => page <= RICKSHAW_MAX_LIST_PAGES
  );
  const advertisedBeyondBound = pagination.pages.filter(
    (page) => page > RICKSHAW_MAX_LIST_PAGES
  );
  if (advertisedBeyondBound.length) {
    listWarnings.push(
      `Rickshaw list pagination advertises pages beyond the bounded limit: ${advertisedBeyondBound.join(", ")}`
    );
  }

  for (const page of expectedPages.filter((value) => value > 1)) {
    const publicLink = pagination.links.find((link) => link.page === page)?.url;
    const pageLink =
      publicLink ??
      (ajaxSettings
        ? rickshawPaginationRequestUrl(ajaxSettings, page)
        : undefined);
    if (!pageLink) {
      listWarnings.push(
        `Rickshaw list page ${page} is advertised by data-see-ajax-page but exposes neither a public href nor the source page's public See Tickets pagination settings`
      );
      continue;
    }
    try {
      const pageResponse = await context.fetchText(pageLink);
      if (
        !statusOkay(pageResponse.status, pageResponse.text) ||
        !pageResponse.text.trim()
      ) {
        listWarnings.push(
          `Rickshaw list page ${page} was unavailable (status ${pageResponse.status})`
        );
        continue;
      }
      const pageRecords = parseRickshawListPage(pageResponse.text, {
        ...parserOptions,
        baseUrl: publicLink ?? calendarUrl,
        page,
      });
      if (!pageRecords.length) {
        listWarnings.push(`Rickshaw list page ${page} returned no list cards`);
        continue;
      }
      fetchedPages.add(page);
      listRecords.push(...pageRecords);
    } catch (error) {
      listWarnings.push(
        `Rickshaw list page ${page} fetch failed: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  const { aggregates, unmatchedLists } = aggregateRecords(
    source,
    calendars,
    listRecords
  );
  const listings = aggregates.map((aggregate) =>
    toVenueListing(source, aggregate)
  );
  const calendarKeys = unique(
    calendars.map((calendar) =>
      sourceKey(
        source.sourceId,
        calendar.ticketIdentity,
        calendar.date,
        calendar.showTime
      )
    )
  );
  // Use the aggregate key after date hints and provider aliases have been
  // applied.  This keeps list inventory keys in the same namespace as the
  // returned listings, including cards whose short date was resolved from a
  // matching calendar occurrence.
  const listKeys = unique(
    aggregates
      .filter(
        (aggregate) =>
          aggregate.list !== undefined || aggregate.unresolvedList !== undefined
      )
      .map((aggregate) => aggregate.key)
  );
  const monthLabels = parseRickshawCalendarMonths(
    calendarResponse.text,
    parserOptions
  );
  const calendarComplete =
    monthLabels.length >= 12 &&
    calendars.every((record) => Boolean(record.date));
  const listComplete =
    pagination.pages.length <= RICKSHAW_MAX_LIST_PAGES &&
    expectedPages.every((page) => fetchedPages.has(page)) &&
    unmatchedLists.length === 0;
  const dates = calendars
    .map((record) => record.date)
    .filter((value): value is string => Boolean(value))
    .sort();
  const calendarInventory: VenueInventory = {
    name: "calendar",
    keys: calendarKeys,
    complete: calendarComplete,
    ...(calendarComplete
      ? {}
      : { reason: "calendar did not expose a complete month/date context" }),
  };
  const listInventory: VenueInventory = {
    name: "list-pages",
    keys: listKeys,
    complete: listComplete,
    ...(listComplete
      ? {}
      : {
          reason:
            listWarnings.join("; ") ||
            "list-page enrichment did not account for every advertised page or card",
        }),
  };
  result.listings = listings;
  result.inventories = [calendarInventory, listInventory];
  result.complete = calendarComplete && listComplete;
  if (dates.length) {
    result.coverageStart =
      localDateKey(context.nowEpochMs, source.timezone) ?? dates[0];
    result.coverageEnd = dates[dates.length - 1];
  }
  result.warnings.push(
    `Rickshaw calendar parsed ${calendars.length} occurrences across ${monthLabels.length} month grids`
  );
  if (listWarnings.length) result.warnings.push(...listWarnings);
  if (unmatchedLists.length) {
    result.warnings.push(
      `Rickshaw list enrichment found ${unmatchedLists.length} card(s) without a matching calendar occurrence; they remain review records`
    );
  }
  if (calendarResponse.fromCache)
    result.warnings.push(
      "Rickshaw calendar body was served from conditional cache"
    );
  return result;
}

/** Build the deterministic source key used by calendar/list inventories and listings. */
export function rickshawListingKey(
  sourceId: string,
  record: Pick<
    RickshawCalendarRecord | RickshawListRecord,
    "ticketIdentity" | "date" | "showTime"
  >
): string {
  return sourceKey(
    sourceId,
    record.ticketIdentity,
    record.date,
    record.showTime
  );
}
