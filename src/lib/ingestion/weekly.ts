/**
 * Durable weekly additions editions.
 *
 * This module deliberately contains no filesystem or network code.  It is the
 * small, deterministic state machine used by the weekly-edition CLI and by
 * the ETL publisher.  The CLI owns reading and atomically writing the JSON
 * ledger; keeping the policy here pure makes retries straightforward to test.
 */

export const WEEKLY_EDITION_SCHEMA_VERSION = 1 as const;
export const WEEKLY_EDITION_TIME_ZONE = "America/Los_Angeles" as const;

export type WeeklyEditionStatus = "draft" | "published";
export type WeeklyEditionEventId = string | number;
export type AddedDateProvenance = "observed" | "legacy-batch" | "unknown";

/** The subset of a canonical ledger event needed to build an edition. */
export interface WeeklyLedgerEvent {
  id: WeeklyEditionEventId;
  createdAtEpochMs?: number | null;
  addedDateProvenance?: AddedDateProvenance;
  [key: string]: unknown;
}

/** Alias retained for callers that use the ingestion ledger's shorter name. */
export type LedgerEvent = WeeklyLedgerEvent;

export interface WeeklyEditionSnapshot {
  editionId: string;
  startEpochMs: number;
  endEpochMs: number;
  eventIds: WeeklyEditionEventId[];
  datasetVersion: string;
  status: WeeklyEditionStatus;
}

export interface WeeklyEditionLedger {
  schemaVersion: typeof WEEKLY_EDITION_SCHEMA_VERSION;
  /** End of the last explicitly published edition, or null before one. */
  publishedCutoffEpochMs: number | null;
  editions: WeeklyEditionSnapshot[];
}

export interface PrepareWeeklyEditionOptions {
  editionId: string;
  /** An ISO instant, epoch milliseconds, or Date. */
  cutoff?: string | number | Date;
  /** Explicit aliases make the pure API convenient for callers using named fields. */
  cutoffIso?: string;
  cutoffEpochMs?: number;
  datasetVersion: string;
}

export interface PrepareWeeklyEditionInput extends PrepareWeeklyEditionOptions {
  ledger: WeeklyEditionLedger;
  events: readonly WeeklyLedgerEvent[];
}

export interface WeeklyEditionMutation {
  ledger: WeeklyEditionLedger;
  edition: WeeklyEditionSnapshot;
  /** True when the ID already existed and its frozen snapshot was reused. */
  reused: boolean;
  /** Convenience aliases for integrations that call the result a snapshot/state. */
  snapshot: WeeklyEditionSnapshot;
  state: WeeklyEditionLedger;
}

export interface MarkPublishedInput {
  ledger: WeeklyEditionLedger;
  editionId: string;
}

export type WeeklyEditionErrorCode =
  | "INVALID_LEDGER"
  | "INVALID_EVENT"
  | "INVALID_CUTOFF"
  | "INVALID_WINDOW"
  | "EDITION_CONFLICT"
  | "PENDING_EDITION"
  | "EDITION_NOT_FOUND"
  | "PUBLISH_ORDER";

export class WeeklyEditionError extends Error {
  readonly code: WeeklyEditionErrorCode;

  constructor(code: WeeklyEditionErrorCode, message: string) {
    super(message);
    this.name = "WeeklyEditionError";
    this.code = code;
  }
}

const localDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: WEEKLY_EDITION_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      `${label} must be an object`
    );
  }
  return value as Record<string, unknown>;
}

function isSafeEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function assertEpoch(
  value: unknown,
  label: string,
  code: WeeklyEditionErrorCode = "INVALID_WINDOW"
): number {
  if (!isSafeEpoch(value)) {
    throw new WeeklyEditionError(
      code,
      `${label} must be a safe integer epoch millisecond value`
    );
  }
  return value;
}

function eventIdKey(id: WeeklyEditionEventId): string {
  return `${typeof id}:${String(id)}`;
}

function assertEventId(value: unknown, label: string): WeeklyEditionEventId {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new WeeklyEditionError(
        "INVALID_EVENT",
        `${label} must be a safe integer or non-empty string`
      );
    }
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new WeeklyEditionError(
    "INVALID_EVENT",
    `${label} must be a safe integer or non-empty string`
  );
}

function assertEditionId(value: unknown, label = "editionId"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      `${label} must be a non-empty string`
    );
  }
  return value.trim();
}

function assertDatasetVersion(
  value: unknown,
  label = "datasetVersion"
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      `${label} must be a non-empty string`
    );
  }
  return value;
}

function assertWindow(
  startEpochMs: unknown,
  endEpochMs: unknown
): { startEpochMs: number; endEpochMs: number } {
  const start = assertEpoch(startEpochMs, "startEpochMs");
  const end = assertEpoch(endEpochMs, "endEpochMs");
  if (start >= end) {
    throw new WeeklyEditionError(
      "INVALID_WINDOW",
      "Weekly edition window must satisfy startEpochMs < endEpochMs"
    );
  }
  return { startEpochMs: start, endEpochMs: end };
}

function parseEventIds(value: unknown, label: string): WeeklyEditionEventId[] {
  if (!Array.isArray(value)) {
    throw new WeeklyEditionError("INVALID_LEDGER", `${label} must be an array`);
  }
  const ids: WeeklyEditionEventId[] = [];
  const seen = new Set<string>();
  value.forEach((candidate, index) => {
    const id = assertEventId(candidate, `${label}[${index}]`);
    const key = eventIdKey(id);
    if (seen.has(key)) {
      throw new WeeklyEditionError(
        "INVALID_LEDGER",
        `${label} contains duplicate event ID ${String(id)}`
      );
    }
    seen.add(key);
    ids.push(id);
  });
  return ids;
}

function parseEdition(value: unknown, index: number): WeeklyEditionSnapshot {
  const raw = asRecord(value, `editions[${index}]`);
  const editionId = assertEditionId(
    raw.editionId,
    `editions[${index}].editionId`
  );
  const window = assertWindow(raw.startEpochMs, raw.endEpochMs);
  const eventIds = parseEventIds(raw.eventIds, `editions[${index}].eventIds`);
  const datasetVersion = assertDatasetVersion(
    raw.datasetVersion,
    `editions[${index}].datasetVersion`
  );
  if (raw.status !== "draft" && raw.status !== "published") {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      `editions[${index}].status must be draft or published`
    );
  }
  return {
    editionId,
    startEpochMs: window.startEpochMs,
    endEpochMs: window.endEpochMs,
    eventIds,
    datasetVersion,
    status: raw.status,
  };
}

function latestPublishedCutoff(
  editions: readonly WeeklyEditionSnapshot[]
): number | null {
  let latest: number | null = null;
  for (const edition of editions) {
    if (edition.status !== "published") continue;
    if (latest === null || edition.endEpochMs > latest)
      latest = edition.endEpochMs;
  }
  return latest;
}

function validateLedgerInvariants(
  ledger: WeeklyEditionLedger
): WeeklyEditionLedger {
  const seenEditionIds = new Set<string>();
  const seenWindowEnds = new Set<number>();
  const editions = ledger.editions.map((edition, index) => {
    const parsed = parseEdition(edition, index);
    if (seenEditionIds.has(parsed.editionId)) {
      throw new WeeklyEditionError(
        "INVALID_LEDGER",
        `Duplicate weekly edition ID ${parsed.editionId}`
      );
    }
    seenEditionIds.add(parsed.editionId);
    if (seenWindowEnds.has(parsed.endEpochMs)) {
      throw new WeeklyEditionError(
        "INVALID_LEDGER",
        `Duplicate weekly edition cutoff ${parsed.endEpochMs}`
      );
    }
    seenWindowEnds.add(parsed.endEpochMs);
    return parsed;
  });

  const derivedCutoff = latestPublishedCutoff(editions);
  if (ledger.publishedCutoffEpochMs !== derivedCutoff) {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      "publishedCutoffEpochMs must equal the end of the latest published edition"
    );
  }

  // A pending edition can only follow the last successful cutoff.  This also
  // prevents a corrupted state from silently moving the cutoff backwards.
  if (derivedCutoff !== null) {
    for (const edition of editions) {
      if (edition.status === "draft" && edition.endEpochMs <= derivedCutoff) {
        throw new WeeklyEditionError(
          "INVALID_LEDGER",
          `Draft edition ${edition.editionId} ends at or before the published cutoff`
        );
      }
    }
  }

  return {
    schemaVersion: WEEKLY_EDITION_SCHEMA_VERSION,
    publishedCutoffEpochMs: derivedCutoff,
    editions,
  };
}

export function createEmptyWeeklyEditionLedger(): WeeklyEditionLedger {
  return {
    schemaVersion: WEEKLY_EDITION_SCHEMA_VERSION,
    publishedCutoffEpochMs: null,
    editions: [],
  };
}

/** Short alias for integrations that call the persisted state a ledger. */
export const createEmptyLedger = createEmptyWeeklyEditionLedger;

/**
 * Parse and validate the persisted state.  A missing file is handled by the
 * CLI; passing malformed state here always fails so a cold rebuild cannot
 * overwrite history accidentally.
 */
export function parseWeeklyEditionLedger(value: unknown): WeeklyEditionLedger {
  const raw = asRecord(value, "weekly edition ledger");
  const schemaVersion =
    raw.schemaVersion === undefined
      ? WEEKLY_EDITION_SCHEMA_VERSION
      : raw.schemaVersion;
  if (schemaVersion !== WEEKLY_EDITION_SCHEMA_VERSION) {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      `Unsupported weekly edition ledger schema version ${String(schemaVersion)}`
    );
  }
  if (!Array.isArray(raw.editions)) {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      "weekly edition ledger editions must be an array"
    );
  }

  const editions = raw.editions.map((edition, index) =>
    parseEdition(edition, index)
  );
  const derivedCutoff = latestPublishedCutoff(editions);
  if (
    raw.publishedCutoffEpochMs !== undefined &&
    raw.lastPublishedCutoffEpochMs !== undefined &&
    raw.publishedCutoffEpochMs !== raw.lastPublishedCutoffEpochMs
  ) {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      "publishedCutoffEpochMs and lastPublishedCutoffEpochMs disagree"
    );
  }
  const explicitCutoff =
    raw.publishedCutoffEpochMs ??
    raw.lastPublishedCutoffEpochMs ??
    derivedCutoff;
  if (explicitCutoff !== null && !isSafeEpoch(explicitCutoff)) {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      "publishedCutoffEpochMs must be null or a safe integer epoch millisecond value"
    );
  }
  if (explicitCutoff !== derivedCutoff) {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      "publishedCutoffEpochMs must equal the end of the latest published edition"
    );
  }

  return validateLedgerInvariants({
    schemaVersion: WEEKLY_EDITION_SCHEMA_VERSION,
    publishedCutoffEpochMs: derivedCutoff,
    editions,
  });
}

/** Exact export requested by the ingestion coordinator. */
export const parseWeeklyLedger = parseWeeklyEditionLedger;

export function serializeWeeklyEditionLedger(
  value: WeeklyEditionLedger
): string {
  const ledger = parseWeeklyEditionLedger(value);
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

export const serializeWeeklyLedger = serializeWeeklyEditionLedger;

export function parseCutoffEpochMs(value: string | number | Date): number {
  let epochMs: number;
  if (value instanceof Date) {
    epochMs = value.getTime();
  } else if (typeof value === "number") {
    epochMs = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    epochMs = Date.parse(value);
  } else {
    epochMs = Number.NaN;
  }
  if (!Number.isSafeInteger(epochMs)) {
    throw new WeeklyEditionError(
      "INVALID_CUTOFF",
      `Invalid cutoff ISO instant: ${String(value)}`
    );
  }
  return epochMs;
}

function localDateTimeParts(epochMs: number): LocalDateTimeParts {
  const parts = localDateTimeFormatter.formatToParts(new Date(epochMs));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const required = ["year", "month", "day", "hour", "minute", "second"];
  if (required.some((name) => !Number.isInteger(values[name]))) {
    throw new WeeklyEditionError(
      "INVALID_CUTOFF",
      `Could not convert ${epochMs} to Los Angeles local time`
    );
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    // Some runtimes can render midnight as 24; midnight arithmetic is easier
    // and equivalent when represented as hour zero.
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function utcEpochForParts(parts: LocalDateTimeParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}

function offsetAtEpoch(epochMs: number): number {
  const parts = localDateTimeParts(epochMs);
  return utcEpochForParts(parts) - epochMs;
}

function parseLocalDate(date: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new WeeklyEditionError(
      "INVALID_WINDOW",
      `Invalid Los Angeles local date ${date}`
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  check.setUTCHours(0, 0, 0, 0);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new WeeklyEditionError(
      "INVALID_WINDOW",
      `Invalid Los Angeles local date ${date}`
    );
  }
  return { year, month, day };
}

function addLocalCalendarDays(date: string, days: number): string {
  const parsed = parseLocalDate(date);
  const shifted = new Date(0);
  shifted.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day + days);
  shifted.setUTCHours(0, 0, 0, 0);
  return [
    String(shifted.getUTCFullYear()).padStart(4, "0"),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Convert a Los Angeles local midnight to an epoch, accounting for DST. */
export function localDateStartEpochMs(date: string): number {
  const parsed = parseLocalDate(date);
  const localMidnight: LocalDateTimeParts = {
    ...parsed,
    hour: 0,
    minute: 0,
    second: 0,
  };
  const naiveEpoch = utcEpochForParts(localMidnight);
  let candidate = naiveEpoch;
  // Offset iteration converges for the normal one-hour DST transitions and
  // avoids relying on the machine's process timezone.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const corrected = naiveEpoch - offsetAtEpoch(candidate);
    if (corrected === candidate) return candidate;
    candidate = corrected;
  }
  return candidate;
}

export const localMidnightEpochMs = localDateStartEpochMs;

export function formatLosAngelesDate(epochMs: number): string {
  const safeEpoch = assertEpoch(epochMs, "epochMs", "INVALID_CUTOFF");
  const parts = localDateTimeParts(safeEpoch);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

export const localDateForEpochMs = formatLosAngelesDate;

export interface WeeklyEditionWindow {
  startEpochMs: number;
  endEpochMs: number;
}

/** First-run range: seven preceding Los Angeles calendar days through cutoff. */
export function initialWeeklyEditionWindow(
  cutoff: string | number | Date
): WeeklyEditionWindow {
  const endEpochMs = parseCutoffEpochMs(cutoff);
  const cutoffLocalDate = formatLosAngelesDate(endEpochMs);
  const startLocalDate = addLocalCalendarDays(cutoffLocalDate, -7);
  const startEpochMs = localDateStartEpochMs(startLocalDate);
  return assertWindow(startEpochMs, endEpochMs);
}

export const getInitialWeeklyEditionWindow = initialWeeklyEditionWindow;

function isKnownAddedDate(event: WeeklyLedgerEvent): boolean {
  return (
    isSafeEpoch(event.createdAtEpochMs) &&
    event.addedDateProvenance !== "unknown"
  );
}

/**
 * Shared half-open date-added predicate.  Unknown or absent added dates are
 * deliberately excluded, while already-happened shows remain eligible.
 */
export function addedInWindow(
  event: WeeklyLedgerEvent,
  startEpochMs: number,
  endEpochMs: number
): boolean {
  const window = assertWindow(startEpochMs, endEpochMs);
  if (
    event.addedDateProvenance !== undefined &&
    event.addedDateProvenance !== "observed" &&
    event.addedDateProvenance !== "legacy-batch" &&
    event.addedDateProvenance !== "unknown"
  ) {
    throw new WeeklyEditionError(
      "INVALID_EVENT",
      `Unknown added-date provenance for event ${String(event.id)}`
    );
  }
  return (
    isKnownAddedDate(event) &&
    window.startEpochMs <= event.createdAtEpochMs! &&
    event.createdAtEpochMs! < window.endEpochMs
  );
}

export const eventAddedInWindow = addedInWindow;

export function selectEventIdsForWindow(
  events: readonly WeeklyLedgerEvent[],
  startEpochMs: number,
  endEpochMs: number
): WeeklyEditionEventId[] {
  if (!Array.isArray(events)) {
    throw new WeeklyEditionError("INVALID_EVENT", "events must be an array");
  }
  const selected: WeeklyEditionEventId[] = [];
  const seen = new Set<string>();
  events.forEach((event, index) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      throw new WeeklyEditionError(
        "INVALID_EVENT",
        `events[${index}] must be an object`
      );
    }
    const id = assertEventId(event.id, `events[${index}].id`);
    if (addedInWindow(event, startEpochMs, endEpochMs)) {
      const key = eventIdKey(id);
      if (!seen.has(key)) {
        seen.add(key);
        selected.push(id);
      }
    }
  });
  return selected;
}

export const selectWeeklyEditionEventIds = selectEventIdsForWindow;

function cloneEdition(edition: WeeklyEditionSnapshot): WeeklyEditionSnapshot {
  return { ...edition, eventIds: [...edition.eventIds] };
}

function cloneLedger(ledger: WeeklyEditionLedger): WeeklyEditionLedger {
  return {
    schemaVersion: WEEKLY_EDITION_SCHEMA_VERSION,
    publishedCutoffEpochMs: ledger.publishedCutoffEpochMs,
    editions: ledger.editions.map(cloneEdition),
  };
}

function mutation(
  ledger: WeeklyEditionLedger,
  edition: WeeklyEditionSnapshot,
  reused: boolean
): WeeklyEditionMutation {
  const clonedLedger = cloneLedger(ledger);
  const clonedEdition = cloneEdition(edition);
  return {
    ledger: clonedLedger,
    edition: clonedEdition,
    reused,
    snapshot: cloneEdition(clonedEdition),
    state: cloneLedger(clonedLedger),
  };
}

function normalizePrepareOptions(options: PrepareWeeklyEditionOptions): {
  editionId: string;
  cutoffEpochMs: number;
  datasetVersion: string;
} {
  const editionId = assertEditionId(options.editionId);
  const cutoffInputs = [
    options.cutoff,
    options.cutoffIso,
    options.cutoffEpochMs,
  ].filter((value): value is string | number | Date => value !== undefined);
  if (cutoffInputs.length === 0) {
    throw new WeeklyEditionError(
      "INVALID_CUTOFF",
      "A cutoff ISO instant is required"
    );
  }
  const parsedCutoffs = cutoffInputs.map(parseCutoffEpochMs);
  if (parsedCutoffs.some((value) => value !== parsedCutoffs[0])) {
    throw new WeeklyEditionError(
      "EDITION_CONFLICT",
      "Multiple cutoff options disagree"
    );
  }
  const cutoffInput = cutoffInputs[0];
  if (cutoffInput === undefined) {
    throw new WeeklyEditionError(
      "INVALID_CUTOFF",
      "A cutoff ISO instant is required"
    );
  }
  const cutoffEpochMs = parseCutoffEpochMs(cutoffInput);
  const datasetVersion = assertDatasetVersion(options.datasetVersion);
  return { editionId, cutoffEpochMs, datasetVersion };
}

function pendingEditions(ledger: WeeklyEditionLedger): WeeklyEditionSnapshot[] {
  return ledger.editions
    .filter((edition) => edition.status === "draft")
    .sort((a, b) => a.endEpochMs - b.endEpochMs);
}

export function prepareWeeklyEdition(
  ledger: WeeklyEditionLedger,
  events: readonly WeeklyLedgerEvent[],
  options: PrepareWeeklyEditionOptions
): WeeklyEditionMutation;
export function prepareWeeklyEdition(
  input: PrepareWeeklyEditionInput
): WeeklyEditionMutation;
export function prepareWeeklyEdition(
  ledgerOrInput: WeeklyEditionLedger | PrepareWeeklyEditionInput,
  eventsArgument?: readonly WeeklyLedgerEvent[],
  optionsArgument?: PrepareWeeklyEditionOptions
): WeeklyEditionMutation {
  const ledger =
    "ledger" in ledgerOrInput && "events" in ledgerOrInput
      ? ledgerOrInput.ledger
      : ledgerOrInput;
  const events =
    "ledger" in ledgerOrInput && "events" in ledgerOrInput
      ? ledgerOrInput.events
      : eventsArgument;
  const options =
    "ledger" in ledgerOrInput && "events" in ledgerOrInput
      ? ledgerOrInput
      : optionsArgument;
  if (!events || !options) {
    throw new WeeklyEditionError(
      "INVALID_LEDGER",
      "ledger, events, and prepare options are required"
    );
  }
  const parsedLedger = parseWeeklyEditionLedger(ledger);
  const normalizedOptions = normalizePrepareOptions(options);
  const existing = parsedLedger.editions.find(
    (edition) => edition.editionId === normalizedOptions.editionId
  );

  // Replay is intentionally resolved before reading the event collection: a
  // changed canonical ledger cannot change a frozen edition's membership.
  if (existing) {
    if (existing.endEpochMs !== normalizedOptions.cutoffEpochMs) {
      throw new WeeklyEditionError(
        "EDITION_CONFLICT",
        `Edition ${normalizedOptions.editionId} already uses cutoff ${existing.endEpochMs}; requested ${normalizedOptions.cutoffEpochMs}`
      );
    }
    return mutation(parsedLedger, existing, true);
  }

  const pending = pendingEditions(parsedLedger);
  if (pending.length > 0) {
    throw new WeeklyEditionError(
      "PENDING_EDITION",
      `Cannot prepare ${normalizedOptions.editionId} while earlier draft edition ${pending[0].editionId} is pending publication`
    );
  }

  const startEpochMs =
    parsedLedger.publishedCutoffEpochMs === null
      ? initialWeeklyEditionWindow(normalizedOptions.cutoffEpochMs).startEpochMs
      : parsedLedger.publishedCutoffEpochMs;
  const window = assertWindow(startEpochMs, normalizedOptions.cutoffEpochMs);
  if (
    parsedLedger.publishedCutoffEpochMs !== null &&
    normalizedOptions.cutoffEpochMs <= parsedLedger.publishedCutoffEpochMs
  ) {
    throw new WeeklyEditionError(
      "INVALID_WINDOW",
      `Requested cutoff ${normalizedOptions.cutoffEpochMs} must advance past published cutoff ${parsedLedger.publishedCutoffEpochMs}`
    );
  }

  const edition: WeeklyEditionSnapshot = {
    editionId: normalizedOptions.editionId,
    startEpochMs: window.startEpochMs,
    endEpochMs: window.endEpochMs,
    eventIds: selectEventIdsForWindow(
      events,
      window.startEpochMs,
      window.endEpochMs
    ),
    datasetVersion: normalizedOptions.datasetVersion,
    status: "draft",
  };
  const nextLedger: WeeklyEditionLedger = {
    schemaVersion: WEEKLY_EDITION_SCHEMA_VERSION,
    publishedCutoffEpochMs: parsedLedger.publishedCutoffEpochMs,
    editions: [...parsedLedger.editions.map(cloneEdition), edition],
  };
  return mutation(nextLedger, edition, false);
}

export const prepareEdition = prepareWeeklyEdition;

export function markWeeklyEditionPublished(
  ledger: WeeklyEditionLedger,
  editionId: string
): WeeklyEditionMutation;
export function markWeeklyEditionPublished(
  input: MarkPublishedInput
): WeeklyEditionMutation;
export function markWeeklyEditionPublished(
  ledgerOrInput: WeeklyEditionLedger | MarkPublishedInput,
  editionIdArgument?: string
): WeeklyEditionMutation {
  const ledgerInput =
    "ledger" in ledgerOrInput
      ? ledgerOrInput
      : { ledger: ledgerOrInput, editionId: editionIdArgument };
  if (!ledgerInput.editionId) {
    throw new WeeklyEditionError(
      "EDITION_NOT_FOUND",
      "An edition ID is required to mark publication"
    );
  }
  const ledger = parseWeeklyEditionLedger(ledgerInput.ledger);
  const editionId = assertEditionId(ledgerInput.editionId);
  const existing = ledger.editions.find(
    (edition) => edition.editionId === editionId
  );
  if (!existing) {
    throw new WeeklyEditionError(
      "EDITION_NOT_FOUND",
      `Weekly edition ${editionId} does not exist`
    );
  }
  if (existing.status === "published") {
    return mutation(ledger, existing, true);
  }

  const pending = pendingEditions(ledger);
  if (pending[0].editionId !== editionId) {
    throw new WeeklyEditionError(
      "PUBLISH_ORDER",
      `Cannot publish ${editionId} before earlier draft edition ${pending[0].editionId}`
    );
  }
  if (
    ledger.publishedCutoffEpochMs !== null &&
    existing.startEpochMs !== ledger.publishedCutoffEpochMs
  ) {
    throw new WeeklyEditionError(
      "PUBLISH_ORDER",
      `Edition ${editionId} does not start at the last published cutoff`
    );
  }

  const publishedEdition = { ...existing, status: "published" as const };
  const nextLedger: WeeklyEditionLedger = {
    schemaVersion: WEEKLY_EDITION_SCHEMA_VERSION,
    publishedCutoffEpochMs: publishedEdition.endEpochMs,
    editions: ledger.editions.map((edition) =>
      edition.editionId === editionId ? publishedEdition : cloneEdition(edition)
    ),
  };
  return mutation(nextLedger, publishedEdition, false);
}

export const markPublished = markWeeklyEditionPublished;

export function getPublishedCutoffEpochMs(
  ledger: WeeklyEditionLedger
): number | null {
  return parseWeeklyEditionLedger(ledger).publishedCutoffEpochMs;
}

export function getLatestPublishedWeeklyEdition(
  ledger: WeeklyEditionLedger
): WeeklyEditionSnapshot | null {
  const parsed = parseWeeklyEditionLedger(ledger);
  const published = parsed.editions.filter(
    (edition) => edition.status === "published"
  );
  if (published.length === 0) return null;
  return cloneEdition(
    published.reduce((latest, edition) =>
      edition.endEpochMs > latest.endEpochMs ? edition : latest
    )
  );
}

export function getLatestWeeklyEdition(
  ledger: WeeklyEditionLedger
): WeeklyEditionSnapshot | null {
  const parsed = parseWeeklyEditionLedger(ledger);
  if (parsed.editions.length === 0) return null;
  return cloneEdition(
    parsed.editions.reduce((latest, edition) =>
      edition.endEpochMs > latest.endEpochMs ? edition : latest
    )
  );
}
