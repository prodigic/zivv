import { describe, expect, it } from "vitest";
import { fridayDeliveryTimes } from "../../lib/ingestion/weekly.js";

describe("Friday delivery boundaries in Pacific time", () => {
  it.each([
    [
      "2026-03-06",
      "2026-03-06T08:00:00Z",
      "2026-03-07T02:00:00Z",
      "2026-03-09T07:00:00Z",
    ],
    [
      "2026-03-13",
      "2026-03-13T07:00:00Z",
      "2026-03-14T01:00:00Z",
      "2026-03-16T07:00:00Z",
    ],
    [
      "2026-10-30",
      "2026-10-30T07:00:00Z",
      "2026-10-31T01:00:00Z",
      "2026-11-02T08:00:00Z",
    ],
    [
      "2026-11-06",
      "2026-11-06T08:00:00Z",
      "2026-11-07T02:00:00Z",
      "2026-11-09T08:00:00Z",
    ],
  ])(
    "calculates %s across calendar and DST boundaries",
    (edition, publication, alert, review) => {
      expect(fridayDeliveryTimes(edition)).toEqual({
        publicationNotBeforeEpochMs: Date.parse(publication),
        missingSourceAlertAtEpochMs: Date.parse(alert),
        newSourceReviewAtEpochMs: Date.parse(review),
      });
    }
  );

  it.each([
    "2026-10-08",
    "2026-02-30",
    "2026-3-06",
    "2026-03-06 ",
    "not-a-date",
    "",
  ])("rejects invalid or non-Friday edition %s", (edition) => {
    expect(() => fridayDeliveryTimes(edition)).toThrow();
  });
});
