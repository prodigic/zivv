import { describe, expect, it } from "vitest";
import {
  fridayDeliveryTimes,
  planFridayMailboxWake,
} from "../../lib/ingestion/weekly.js";

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

describe("recurring Friday mailbox wake selection", () => {
  it.each([
    [
      "2026-11-19T07:59:59.999Z",
      1,
      "2026-11-20",
      "not-open",
      "2026-11-19T08:00:00Z",
    ],
    [
      "2026-11-19T08:00:00.000Z",
      1,
      "2026-11-20",
      "poll-window-open",
      "2026-11-19T08:00:00Z",
    ],
    [
      "2026-11-20T07:59:59.999Z",
      0,
      "2026-11-20",
      "not-open",
      "2026-11-20T08:00:00Z",
    ],
    [
      "2026-11-20T08:00:00.000Z",
      0,
      "2026-11-20",
      "poll-window-open",
      "2026-11-20T08:00:00Z",
    ],
    [
      "2026-03-09T06:59:59.999Z",
      1,
      "2026-03-06",
      "poll-window-open",
      "2026-03-05T08:00:00Z",
    ],
    [
      "2026-03-09T07:00:00.000Z",
      1,
      "2026-03-13",
      "not-open",
      "2026-03-12T07:00:00Z",
    ],
    [
      "2026-11-01T08:30:00.000Z",
      1,
      "2026-10-30",
      "poll-window-open",
      "2026-10-29T07:00:00Z",
    ],
    [
      "2026-11-01T09:30:00.000Z",
      1,
      "2026-10-30",
      "poll-window-open",
      "2026-10-29T07:00:00Z",
    ],
    [
      "2026-11-02T07:59:59.999Z",
      4,
      "2026-10-30",
      "poll-window-open",
      "2026-10-26T07:00:00Z",
    ],
    [
      "2026-11-02T08:00:00.000Z",
      4,
      "2026-11-06",
      "poll-window-open",
      "2026-11-02T08:00:00Z",
    ],
    [
      "2027-01-01T08:00:00.000Z",
      1,
      "2027-01-01",
      "poll-window-open",
      "2026-12-31T08:00:00Z",
    ],
  ] as const)(
    "routes wake %s with %i early days",
    (now, lead, editionId, status, start) => {
      const epoch = Date.parse(now);
      const boundaries = fridayDeliveryTimes(editionId);
      expect(planFridayMailboxWake(epoch, lead)).toEqual({
        editionId,
        status,
        scanStartsAtEpochMs: Date.parse(start),
        ...boundaries,
      });
      expect(epoch).toBeLessThan(boundaries.newSourceReviewAtEpochMs);
    }
  );

  it.each([-1, 5, 0.5, NaN, Infinity])(
    "refuses invalid configured scan lead %s",
    (lead) => {
      expect(() =>
        planFridayMailboxWake(Date.parse("2026-11-20T18:00:00Z"), lead)
      ).toThrow("Invalid Friday scan lead");
    }
  );

  it("refuses invalid wake clocks", () => {
    expect(() => planFridayMailboxWake(NaN, 1)).toThrow();
    expect(() => planFridayMailboxWake(9e15, 1)).toThrow();
  });
});
