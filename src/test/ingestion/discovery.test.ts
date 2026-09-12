import { describe, expect, it } from "vitest";
import {
  getInclusiveLocalDateWindow,
  getLast7LocalDateWindow,
  isAddedInWindow,
  isEventUpcoming,
  isListedBy,
  isFirstImportedBy,
  legacyWallClockToInstant,
  localDateKey,
  localWallClockToEpochMs,
  matchesSourceFilters,
} from "@/lib/discovery.js";

const TZ = "America/Los_Angeles";

describe("discovery date windows", () => {
  it("uses seven local calendar dates and a half-open end boundary", () => {
    const now = localWallClockToEpochMs("2026-09-08", 12, 0, 0, 0, TZ);
    expect(now).not.toBeNull();
    const window = getLast7LocalDateWindow(now as number, TZ);
    expect(window).toMatchObject({
      startDate: "2026-09-02",
      endDate: "2026-09-08",
    });

    const start = localWallClockToEpochMs("2026-09-02", 0, 0, 0, 0, TZ);
    const end = localWallClockToEpochMs("2026-09-09", 0, 0, 0, 0, TZ);
    const before = (start as number) - 1;
    expect(isAddedInWindow(start, window)).toBe(true);
    expect(isAddedInWindow(end, window)).toBe(false);
    expect(isAddedInWindow(before, window)).toBe(false);
  });

  it("keeps DST transition boundaries at local midnight", () => {
    const window = getInclusiveLocalDateWindow("2026-11-01", "2026-11-01", TZ);
    expect(window).not.toBeNull();
    expect(
      (window as NonNullable<typeof window>).endEpochMs -
        (window as NonNullable<typeof window>).startEpochMs
    ).toBe(25 * 60 * 60 * 1000);
    expect(
      localDateKey((window as NonNullable<typeof window>).startEpochMs, TZ)
    ).toBe("2026-11-01");
  });

  it("rejects invalid custom dates and unknown added timestamps", () => {
    expect(
      getInclusiveLocalDateWindow("2026-02-30", "2026-03-01", TZ)
    ).toBeNull();
    expect(
      getInclusiveLocalDateWindow("2026-03-02", "2026-03-01", TZ)
    ).toBeNull();
    const window = getInclusiveLocalDateWindow("2026-03-01", "2026-03-01", TZ);
    expect(isAddedInWindow({ createdAtEpochMs: Number.NaN }, window)).toBe(
      false
    );
    expect(isAddedInWindow({ createdAtEpochMs: null }, window)).toBe(false);
    expect(
      isAddedInWindow(
        {
          createdAtEpochMs: window?.startEpochMs,
          addedDateProvenance: "unknown",
        },
        window
      )
    ).toBe(false);
  });
});

describe("discovery source predicates", () => {
  const event = {
    firstImportedBy: "zivv-venue-import",
    sources: [
      { kind: "venue-calendar", sourceId: "chapel" },
      { kind: "steveslist", sourceId: "2026-09-08" },
    ],
  };

  it("supports independent first-importer and listed-by filters", () => {
    expect(isFirstImportedBy(event, "zivv-venue-import")).toBe(true);
    expect(isFirstImportedBy(event, "steveslist")).toBe(false);
    expect(isListedBy(event, "venue-calendar")).toBe(true);
    expect(isListedBy(event, "steveslist")).toBe(true);
    expect(
      matchesSourceFilters(event, {
        firstImportedBy: "zivv-venue-import",
        listedBy: "steveslist",
      })
    ).toBe(true);
    expect(
      matchesSourceFilters(event, {
        firstImportedBy: "steveslist",
        listedBy: "venue-calendar",
      })
    ).toBe(false);
  });

  it("uses the recent-additions index when event sources are not embedded yet", () => {
    const indexEntry = {
      firstImportedBy: "steveslist",
      sourceKinds: ["venue-calendar"],
    };
    expect(isFirstImportedBy({}, "steveslist", indexEntry)).toBe(true);
    expect(isListedBy({}, "venue-calendar", indexEntry)).toBe(true);
  });
});

describe("upcoming event interpretation", () => {
  it("uses an actual instant and keeps a late-night show upcoming", () => {
    const start = localWallClockToEpochMs("2026-09-08", 0, 30, 0, 0, TZ);
    const before = localWallClockToEpochMs("2026-09-08", 0, 5, 0, 0, TZ);
    const after = localWallClockToEpochMs("2026-09-08", 1, 0, 0, 0, TZ);
    const event = {
      date: "2026-09-08",
      dateEpochMs: localWallClockToEpochMs("2026-09-08", 0, 0, 0, 0, TZ),
      startTimeEpochMs: start,
      timeBasis: "instant",
    };
    expect(isEventUpcoming(event, before as number, TZ)).toBe(true);
    expect(isEventUpcoming(event, after as number, TZ)).toBe(false);
  });

  it("converts legacy wall-clock hours using the event date and LA DST", () => {
    const wallClock = Date.UTC(2026, 10, 1, 1, 30, 0);
    const expected = localWallClockToEpochMs("2026-11-01", 1, 30, 0, 0, TZ);
    expect(legacyWallClockToInstant("2026-11-01", wallClock, TZ)).toBe(
      expected
    );
  });

  it("uses the local show date when no actual start is known", () => {
    const showDate = localWallClockToEpochMs("2026-09-08", 0, 0, 0, 0, TZ);
    const afterMidnight = localWallClockToEpochMs(
      "2026-09-08",
      23,
      55,
      0,
      0,
      TZ
    );
    expect(
      isEventUpcoming(
        { date: "2026-09-08", dateEpochMs: showDate },
        afterMidnight as number,
        TZ
      )
    ).toBe(true);
  });
});
