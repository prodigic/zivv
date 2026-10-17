import { describe, expect, it } from "vitest";
import { assertWeeklyPublicationTime } from "../../lib/ingestion/weekly-publication.js";

describe("Friday publication boundary in Pacific time", () => {
  it.each([
    ["2026-03-06", "2026-03-06T08:00:00Z"],
    ["2026-03-13", "2026-03-13T07:00:00Z"],
    ["2026-10-30", "2026-10-30T07:00:00Z"],
    ["2026-11-06", "2026-11-06T08:00:00Z"],
  ])("holds %s until local midnight across DST changes", (edition, instant) => {
    const start = Date.parse(instant);
    expect(() => assertWeeklyPublicationTime(edition, start - 1)).toThrow(
      "wait until Friday Pacific midnight"
    );
    expect(() => assertWeeklyPublicationTime(edition, start)).not.toThrow();
    expect(() =>
      assertWeeklyPublicationTime(edition, start + 3 * 86_400_000)
    ).not.toThrow();
  });
  it.each(["2026-10-08", "2026-02-30", "not-a-date"])(
    "rejects invalid edition %s",
    (edition) => {
      expect(() =>
        assertWeeklyPublicationTime(edition, Date.parse("2026-10-17T12:00:00Z"))
      ).toThrow();
    }
  );
  it.each([NaN, Infinity, 1.5])("rejects invalid clock %s", (now) => {
    expect(() => assertWeeklyPublicationTime("2026-10-09", now)).toThrow();
  });
});
