/**
 * Shared discovery rules for date-added and source-aware event views.
 *
 * All date boundaries are local calendar boundaries in Los Angeles. Stored
 * timestamps remain instants in UTC; the timezone is only used while turning
 * a local date into its UTC boundary.
 */

export const DISCOVERY_TIME_ZONE = "America/Los_Angeles";

export type DateWindowPreset = "today" | "last7days" | "custom";

export interface LocalDateWindow {
  /** Inclusive local date represented by the beginning of the window. */
  startDate: string;
  /** Inclusive local date represented by the final day of the window. */
  endDate: string;
  /** UTC instant at the start of startDate. */
  startEpochMs: number;
  /** UTC instant at the start of the day after endDate. */
  endEpochMs: number;
}

export interface LocalDateWindowOptions {
  preset?: DateWindowPreset;
  nowMs?: number;
  timeZone?: string;
  startDate?: string;
  endDate?: string;
}

export interface DiscoverySourceLinkLike {
  kind?: string | null;
  sourceId?: string | null;
}

/** The subset of an event needed by the pure discovery predicates. */
export interface DiscoveryEventLike {
  createdAtEpochMs?: number | null;
  addedDateProvenance?: string | null;
  firstImportedBy?: string | null;
  sources?: readonly DiscoverySourceLinkLike[] | null;
  date?: string | null;
  dateEpochMs?: number | null;
  startTimeEpochMs?: number | null;
  /** New records use instant; migrated parser output uses legacy-wall-clock. */
  timeBasis?: string | null;
}

export interface RecentAdditionLike {
  eventId?: number;
  createdAtEpochMs?: number | null;
  addedDateProvenance?: string | null;
  firstImportedBy?: string | null;
  sourceKinds?: readonly string[] | null;
}

export interface DiscoverySourceFilters {
  firstImportedBy?: string | null;
  listedBy?: string | null;
}

export interface WeeklyEditionLike {
  editionId?: string;
  startEpochMs?: number;
  endEpochMs?: number;
  eventIds?: readonly number[];
  datasetVersion?: string;
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(epochMs: number, timeZone: string): ZonedParts | null {
  if (!isKnownEpochMs(epochMs)) return null;

  try {
    const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
    const values = new Map(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)])
    );
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    const hour = values.get("hour");
    const minute = values.get("minute");
    const second = values.get("second");
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined ||
      second === undefined
    ) {
      return null;
    }
    return { year, month, day, hour, minute, second };
  } catch {
    // Invalid timezone identifiers should make a pure helper return no date,
    // rather than silently use the browser's timezone.
    return null;
  }
}

function dateKeyParts(
  dateKey: string
): { year: number; month: number; day: number } | null {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Date.UTC treats years 0-99 as 1900-1999, so set the full year after
  // constructing the date to validate every Gregorian date consistently.
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(year, month - 1, day);
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function formatDateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addCalendarDays(dateKey: string, amount: number): string | null {
  const parts = dateKeyParts(dateKey);
  if (!parts || !Number.isInteger(amount)) return null;

  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(parts.year, parts.month - 1, parts.day + amount);
  return formatDateKey(
    candidate.getUTCFullYear(),
    candidate.getUTCMonth() + 1,
    candidate.getUTCDate()
  );
}

/** Whether a value is a finite, representable epoch-millisecond instant. */
export function isKnownEpochMs(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return Number.isFinite(new Date(value).getTime());
}

/** Return the Gregorian local date for an instant in the requested timezone. */
export function localDateKey(
  epochMs: unknown,
  timeZone = DISCOVERY_TIME_ZONE
): string | null {
  if (!isKnownEpochMs(epochMs)) return null;
  const parts = zonedParts(epochMs, timeZone);
  return parts ? formatDateKey(parts.year, parts.month, parts.day) : null;
}

/** Alias used by callers that describe the value as a local show date. */
export const getLocalDateKey = localDateKey;
export const getLocalDate = localDateKey;

/**
 * Convert a local wall-clock date and time to the corresponding UTC instant.
 * This iterative offset calculation handles Los Angeles DST changes without a
 * separate timezone package.
 */
export function localWallClockToEpochMs(
  dateKey: string,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  timeZone = DISCOVERY_TIME_ZONE
): number | null {
  const parts = dateKeyParts(dateKey);
  if (
    !parts ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    !Number.isInteger(millisecond) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    millisecond < 0 ||
    millisecond > 999
  ) {
    return null;
  }

  // Date.UTC is safe here because the supported ISO event dates are normal
  // four-digit years (dateKeyParts has already rejected year 0).
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    minute,
    second,
    millisecond
  );
  if (!Number.isFinite(localAsUtc)) return null;

  // At the candidate instant, the displayed timezone parts tell us the
  // offset: displayed-as-UTC minus actual UTC. Recompute until stable.
  let guess = localAsUtc;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    // Intl parts intentionally stop at seconds. Preserve the caller's
    // millisecond remainder while calculating the offset.
    const wholeSecondGuess = Math.trunc(guess / 1000) * 1000;
    const displayed = zonedParts(wholeSecondGuess, timeZone);
    if (!displayed) return null;
    const displayedAsUtc = Date.UTC(
      displayed.year,
      displayed.month - 1,
      displayed.day,
      displayed.hour,
      displayed.minute,
      displayed.second
    );
    const next = localAsUtc - (displayedAsUtc - wholeSecondGuess);
    if (next === guess) break;
    guess = next;
  }

  return isKnownEpochMs(guess) ? guess : null;
}

export const localDateTimeToEpochMs = localWallClockToEpochMs;
export const localWallClockToInstant = localWallClockToEpochMs;

/**
 * Convert a legacy parser timestamp whose UTC fields represented an LA wall
 * clock to a real instant on the event's local show date.
 */
export function legacyWallClockToInstant(
  dateKey: string,
  wallClockEpochMs: unknown,
  timeZone = DISCOVERY_TIME_ZONE
): number | null {
  if (!isKnownEpochMs(wallClockEpochMs)) return null;
  const wallClock = new Date(wallClockEpochMs);
  return localWallClockToEpochMs(
    dateKey,
    wallClock.getUTCHours(),
    wallClock.getUTCMinutes(),
    wallClock.getUTCSeconds(),
    wallClock.getUTCMilliseconds(),
    timeZone
  );
}

// Keep a correctly-spelled alias available to ETL callers.
export const legacyWallClockTimestampToInstant = legacyWallClockToInstant;
export const convertLegacyWallClockTimestamp = legacyWallClockToInstant;

function validDateKey(value: unknown): value is string {
  return typeof value === "string" && dateKeyParts(value) !== null;
}

function eventLocalShowDate(
  event: DiscoveryEventLike,
  timeZone: string
): string | null {
  if (validDateKey(event.date)) return event.date;
  return localDateKey(event.dateEpochMs, timeZone);
}

export function getLocalShowDate(
  event: DiscoveryEventLike,
  timeZone = DISCOVERY_TIME_ZONE
): string | null {
  return eventLocalShowDate(event, timeZone);
}

/** UTC instant for an event's actual start, including legacy-time conversion. */
export function actualStartEpochMs(
  event: DiscoveryEventLike,
  timeZone = DISCOVERY_TIME_ZONE
): number | null {
  const storedStart = event.startTimeEpochMs;
  if (!isKnownEpochMs(storedStart)) return null;

  if (event.timeBasis !== "legacy-wall-clock") return storedStart;

  const showDate = eventLocalShowDate(event, timeZone);
  return showDate
    ? legacyWallClockToInstant(showDate, storedStart, timeZone)
    : null;
}

export const getActualStartEpochMs = actualStartEpochMs;

/**
 * Upcoming means actual start after now where available. For date-only rows,
 * the whole local show date remains upcoming, including after local midnight.
 */
export function isEventUpcoming(
  event: DiscoveryEventLike,
  nowMs = Date.now(),
  timeZone = DISCOVERY_TIME_ZONE
): boolean {
  if (!isKnownEpochMs(nowMs)) return false;

  const actualStart = actualStartEpochMs(event, timeZone);
  if (actualStart !== null) return actualStart > nowMs;

  const showDate = eventLocalShowDate(event, timeZone);
  const today = localDateKey(nowMs, timeZone);
  return showDate !== null && today !== null && showDate >= today;
}

export const isUpcoming = isEventUpcoming;
export const isUpcomingEvent = isEventUpcoming;

function windowFromDates(
  startDate: string,
  endDate: string,
  timeZone: string
): LocalDateWindow | null {
  if (
    !validDateKey(startDate) ||
    !validDateKey(endDate) ||
    startDate > endDate
  ) {
    return null;
  }

  const dayAfterEnd = addCalendarDays(endDate, 1);
  if (!dayAfterEnd) return null;
  const startEpochMs = localWallClockToEpochMs(startDate, 0, 0, 0, 0, timeZone);
  const endEpochMs = localWallClockToEpochMs(dayAfterEnd, 0, 0, 0, 0, timeZone);
  if (
    startEpochMs === null ||
    endEpochMs === null ||
    endEpochMs <= startEpochMs
  ) {
    return null;
  }
  return { startDate, endDate, startEpochMs, endEpochMs };
}

/** Inclusive custom local-date range. The end boundary is exclusive UTC. */
export function getInclusiveLocalDateWindow(
  startDate: string,
  endDate: string,
  timeZone = DISCOVERY_TIME_ZONE
): LocalDateWindow | null {
  return windowFromDates(startDate, endDate, timeZone);
}

export const getCustomLocalDateWindow = getInclusiveLocalDateWindow;

export function getTodayLocalDateWindow(
  nowMs = Date.now(),
  timeZone = DISCOVERY_TIME_ZONE
): LocalDateWindow | null {
  const today = localDateKey(nowMs, timeZone);
  return today ? windowFromDates(today, today, timeZone) : null;
}

export function getLast7LocalDateWindow(
  nowMs = Date.now(),
  timeZone = DISCOVERY_TIME_ZONE
): LocalDateWindow | null {
  const today = localDateKey(nowMs, timeZone);
  const start = today ? addCalendarDays(today, -6) : null;
  return today && start ? windowFromDates(start, today, timeZone) : null;
}

/** Build a date-added window from Today, Last 7 Days, or custom dates. */
export function getLocalDateWindow(
  presetOrOptions: DateWindowPreset | LocalDateWindowOptions = "last7days",
  options: LocalDateWindowOptions = {}
): LocalDateWindow | null {
  const preset =
    typeof presetOrOptions === "string"
      ? presetOrOptions
      : (presetOrOptions.preset ??
        (presetOrOptions.startDate || presetOrOptions.endDate
          ? "custom"
          : "last7days"));
  const resolvedOptions =
    typeof presetOrOptions === "string" ? options : presetOrOptions;
  const nowMs = resolvedOptions.nowMs ?? Date.now();
  const timeZone = resolvedOptions.timeZone ?? DISCOVERY_TIME_ZONE;

  if (preset === "today") return getTodayLocalDateWindow(nowMs, timeZone);
  if (preset === "last7days") return getLast7LocalDateWindow(nowMs, timeZone);
  if (!resolvedOptions.startDate || !resolvedOptions.endDate) return null;
  return getInclusiveLocalDateWindow(
    resolvedOptions.startDate,
    resolvedOptions.endDate,
    timeZone
  );
}

export const getDateAddedWindow = getLocalDateWindow;

/** Shared half-open timestamp predicate used by all latest/addition views. */
export function isAddedInWindow(
  eventOrTimestamp: DiscoveryEventLike | number | null | undefined,
  windowOrStart:
    | Pick<LocalDateWindow, "startEpochMs" | "endEpochMs">
    | number
    | null
    | undefined,
  endEpochMs?: number
): boolean {
  const startEpochMs =
    typeof windowOrStart === "number"
      ? windowOrStart
      : windowOrStart?.startEpochMs;
  const resolvedEndEpochMs =
    typeof windowOrStart === "number" ? endEpochMs : windowOrStart?.endEpochMs;
  if (!isKnownEpochMs(startEpochMs) || !isKnownEpochMs(resolvedEndEpochMs)) {
    return false;
  }

  const createdAtEpochMs =
    typeof eventOrTimestamp === "number"
      ? eventOrTimestamp
      : eventOrTimestamp?.createdAtEpochMs;
  if (!isKnownEpochMs(createdAtEpochMs)) return false;
  if (
    typeof eventOrTimestamp !== "number" &&
    eventOrTimestamp?.addedDateProvenance === "unknown"
  ) {
    return false;
  }
  return (
    startEpochMs <= createdAtEpochMs && createdAtEpochMs < resolvedEndEpochMs
  );
}

export const isDateAddedInWindow = isAddedInWindow;
export const eventAddedInWindow = isAddedInWindow;
export const addedInWindow = isAddedInWindow;
export const isInDateAddedWindow = isAddedInWindow;

export function isWithinLast7LocalDays(
  eventOrTimestamp: DiscoveryEventLike | number | null | undefined,
  nowMs = Date.now(),
  timeZone = DISCOVERY_TIME_ZONE
): boolean {
  return isAddedInWindow(
    eventOrTimestamp,
    getLast7LocalDateWindow(nowMs, timeZone)
  );
}

export function isFirstImportedBy(
  event: DiscoveryEventLike | null | undefined,
  importer: string | null | undefined,
  fallback?: RecentAdditionLike | null
): boolean {
  if (!importer || importer === "all") return true;
  return (event?.firstImportedBy ?? fallback?.firstImportedBy) === importer;
}

export function isListedBy(
  event: DiscoveryEventLike | null | undefined,
  sourceKind: string | null | undefined,
  fallback?: RecentAdditionLike | null
): boolean {
  if (!sourceKind || sourceKind === "all") return true;
  const eventKinds = (event?.sources ?? [])
    .map((source) => source.kind)
    .filter((kind): kind is string => typeof kind === "string");
  const fallbackKinds = fallback?.sourceKinds ?? [];
  return [...new Set([...eventKinds, ...fallbackKinds])].includes(sourceKind);
}

/** Apply both independent source dimensions, preserving multi-source events. */
export function matchesSourceFilters(
  event: DiscoveryEventLike | null | undefined,
  filters: DiscoverySourceFilters | null | undefined,
  fallback?: RecentAdditionLike | null
): boolean {
  if (!filters) return true;
  return (
    isFirstImportedBy(event, filters.firstImportedBy, fallback) &&
    isListedBy(event, filters.listedBy, fallback)
  );
}

export function sourceMatches(
  event: DiscoveryEventLike | null | undefined,
  source: string | null | undefined,
  dimension: "firstImportedBy" | "listedBy" = "listedBy",
  fallback?: RecentAdditionLike | null
): boolean {
  return dimension === "firstImportedBy"
    ? isFirstImportedBy(event, source, fallback)
    : isListedBy(event, source, fallback);
}

export function formatLocalDate(
  epochMs: unknown,
  options: Intl.DateTimeFormatOptions = {},
  timeZone = DISCOVERY_TIME_ZONE
): string | null {
  if (!isKnownEpochMs(epochMs)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      ...options,
    }).format(new Date(epochMs));
  } catch {
    return null;
  }
}

/** Human-readable date-added label, for example `Added Sep 8`. */
export function formatAddedDateLabel(
  createdAtEpochMs: unknown,
  timeZone = DISCOVERY_TIME_ZONE
): string | null {
  const date = formatLocalDate(
    createdAtEpochMs,
    { month: "short", day: "numeric" },
    timeZone
  );
  return date ? `Added ${date}` : null;
}

export const addedDateLabel = formatAddedDateLabel;
export const formatDateAddedLabel = formatAddedDateLabel;

/** Stable newest-first ordering with unknown dates at the end. */
export function sortNewestAddedFirst<T extends DiscoveryEventLike>(
  events: readonly T[]
): T[] {
  return [...events].sort((a, b) => {
    const aKnown = isKnownEpochMs(a.createdAtEpochMs);
    const bKnown = isKnownEpochMs(b.createdAtEpochMs);
    if (aKnown && bKnown)
      return (b.createdAtEpochMs as number) - (a.createdAtEpochMs as number);
    if (aKnown) return -1;
    if (bKnown) return 1;
    return 0;
  });
}
