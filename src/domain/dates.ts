export type DateOnly = string & { readonly __brand: "DateOnly" };

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function dateOnly(value: string): DateOnly {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid date-only value: ${value}`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const utcValue = Date.UTC(year, month - 1, day);
  const date = new Date(utcValue);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }

  return value as DateOnly;
}

export function compareDateOnly(left: DateOnly, right: DateOnly): number {
  return left.localeCompare(right);
}

export function isDateOnlyInRange(
  value: DateOnly,
  range: { readonly start?: DateOnly; readonly end?: DateOnly },
): boolean {
  return (
    (range.start === undefined || compareDateOnly(value, range.start) >= 0) &&
    (range.end === undefined || compareDateOnly(value, range.end) <= 0)
  );
}

/**
 * Event dates are calendar dates in the event's timezone. They are not UTC
 * midnights, which would move an event across a date boundary for many users.
 */
export function eventDateFromInstant(epochMs: number, timezone: string): DateOnly {
  if (!Number.isFinite(epochMs)) {
    throw new Error("Event instant must be finite");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    calendar: "iso8601",
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(epochMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return dateOnly(`${values.get("year")}-${values.get("month")}-${values.get("day")}`);
}

export function hasKnownStartTime(startTime: string | undefined): boolean {
  return startTime !== undefined && startTime.trim().length > 0;
}

export function eventDateSortValue(date: DateOnly, startTime?: string): string {
  return `${date}|${hasKnownStartTime(startTime) ? startTime : "~"}`;
}
