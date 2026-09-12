import { describe, expect, it } from "vitest";
import {
  WeeklyEditionError,
  addedInWindow,
  createEmptyWeeklyEditionLedger,
  getInitialWeeklyEditionWindow,
  getLatestWeeklyEdition,
  getPublishedCutoffEpochMs,
  markWeeklyEditionPublished,
  parseWeeklyLedger,
  prepareWeeklyEdition,
  selectEventIdsForWindow,
  serializeWeeklyLedger,
} from "@/lib/ingestion/weekly.js";

const day = 24 * 60 * 60 * 1000;

function instant(iso: string): number {
  return Date.parse(iso);
}

describe("weekly edition snapshots", () => {
  it("uses seven Los Angeles calendar days for the first window, including DST rules", () => {
    const springCutoff = instant("2026-03-13T20:00:00-07:00");
    const spring = getInitialWeeklyEditionWindow(springCutoff);
    expect(spring.startEpochMs).toBe(instant("2026-03-06T08:00:00Z"));
    expect(spring.endEpochMs).toBe(springCutoff);

    const fallCutoff = instant("2026-11-08T20:00:00-08:00");
    const fall = getInitialWeeklyEditionWindow(fallCutoff);
    expect(fall.startEpochMs).toBe(instant("2026-11-01T07:00:00Z"));
    expect(fall.endEpochMs - fall.startEpochMs).toBe(
      7 * day + 21 * 60 * 60 * 1000
    );
  });

  it("selects known date-added events with a half-open range", () => {
    const start = instant("2026-09-04T07:00:00Z");
    const end = instant("2026-09-11T19:00:00Z");
    const events = [
      { id: 1, createdAtEpochMs: start },
      { id: 2, createdAtEpochMs: end - 1 },
      { id: 3, createdAtEpochMs: end },
      { id: 4, createdAtEpochMs: start - 1 },
      {
        id: 5,
        createdAtEpochMs: start + 1,
        addedDateProvenance: "unknown" as const,
      },
      { id: 6, createdAtEpochMs: null },
      // No show-date field is intentional: membership is based on date added.
      { id: 7, createdAtEpochMs: start + 2, showDate: "2026-08-01" },
    ];

    expect(selectEventIdsForWindow(events, start, end)).toEqual([1, 2, 7]);
    expect(addedInWindow(events[0], start, end)).toBe(true);
    expect(addedInWindow(events[2], start, end)).toBe(false);
  });

  it("freezes membership and window across same-ID retries", () => {
    const cutoff = instant("2026-09-11T19:00:00Z");
    const initial = prepareWeeklyEdition(
      createEmptyWeeklyEditionLedger(),
      [{ id: 11, createdAtEpochMs: cutoff - 1 }],
      { editionId: "week-1", cutoff, datasetVersion: "dataset-a" }
    );
    const replay = prepareWeeklyEdition(
      initial.ledger,
      [
        { id: 11, createdAtEpochMs: cutoff + 1 },
        { id: 12, createdAtEpochMs: cutoff - 1 },
      ],
      { editionId: "week-1", cutoff, datasetVersion: "dataset-b" }
    );

    expect(replay.reused).toBe(true);
    expect(replay.edition).toEqual(initial.edition);
    expect(replay.ledger).toEqual(initial.ledger);
  });

  it("rejects a retry that asks the same ID to use another cutoff", () => {
    const first = prepareWeeklyEdition(createEmptyWeeklyEditionLedger(), [], {
      editionId: "week-1",
      cutoff: instant("2026-09-11T19:00:00Z"),
      datasetVersion: "a",
    });
    expect(() =>
      prepareWeeklyEdition(first.ledger, [], {
        editionId: "week-1",
        cutoff: instant("2026-09-12T19:00:00Z"),
        datasetVersion: "a",
      })
    ).toThrowError(expect.objectContaining({ code: "EDITION_CONFLICT" }));
  });

  it("does not advance the cutoff until explicit publication and carries missed weeks", () => {
    const firstCutoff = instant("2026-09-11T19:00:00Z");
    const first = prepareWeeklyEdition(createEmptyWeeklyEditionLedger(), [], {
      editionId: "week-1",
      cutoff: firstCutoff,
      datasetVersion: "a",
    });
    expect(getPublishedCutoffEpochMs(first.ledger)).toBeNull();

    expect(() =>
      prepareWeeklyEdition(first.ledger, [], {
        editionId: "week-2",
        cutoff: firstCutoff + 7 * day,
        datasetVersion: "b",
      })
    ).toThrowError(expect.objectContaining({ code: "PENDING_EDITION" }));

    const published = markWeeklyEditionPublished(first.ledger, "week-1");
    expect(getPublishedCutoffEpochMs(published.ledger)).toBe(firstCutoff);

    const missedWeekCutoff = instant("2026-09-25T19:00:00Z");
    const second = prepareWeeklyEdition(
      published.ledger,
      [
        { id: 20, createdAtEpochMs: firstCutoff },
        { id: 21, createdAtEpochMs: missedWeekCutoff - 1 },
      ],
      { editionId: "week-3", cutoff: missedWeekCutoff, datasetVersion: "c" }
    );
    expect(second.edition.startEpochMs).toBe(firstCutoff);
    expect(second.edition.eventIds).toEqual([20, 21]);
    expect(second.edition.status).toBe("draft");
    expect(getPublishedCutoffEpochMs(second.ledger)).toBe(firstCutoff);
  });

  it("requires the earliest pending edition to publish first", () => {
    const firstCutoff = instant("2026-09-11T19:00:00Z");
    const first = prepareWeeklyEdition(createEmptyWeeklyEditionLedger(), [], {
      editionId: "week-1",
      cutoff: firstCutoff,
      datasetVersion: "a",
    });
    const secondDraft = {
      editionId: "week-2",
      startEpochMs: firstCutoff,
      endEpochMs: firstCutoff + 7 * day,
      eventIds: [],
      datasetVersion: "b",
      status: "draft" as const,
    };
    const ledgerWithTwoDrafts = parseWeeklyLedger({
      ...first.ledger,
      editions: [...first.ledger.editions, secondDraft],
    });

    expect(() =>
      markWeeklyEditionPublished(ledgerWithTwoDrafts, "week-2")
    ).toThrowError(expect.objectContaining({ code: "PUBLISH_ORDER" }));
    expect(
      markWeeklyEditionPublished(ledgerWithTwoDrafts, "week-1").edition.status
    ).toBe("published");
  });

  it("fails malformed state and invalid windows closed", () => {
    expect(() =>
      parseWeeklyLedger({
        schemaVersion: 1,
        publishedCutoffEpochMs: null,
        editions: [
          {
            editionId: "bad",
            startEpochMs: 10,
            endEpochMs: 10,
            eventIds: [],
            datasetVersion: "a",
            status: "draft",
          },
        ],
      })
    ).toThrowError(WeeklyEditionError);
    expect(() => getInitialWeeklyEditionWindow("not-an-iso-date")).toThrowError(
      expect.objectContaining({ code: "INVALID_CUTOFF" })
    );
    expect(() =>
      addedInWindow({ id: 1, createdAtEpochMs: 10 }, 20, 10)
    ).toThrowError(expect.objectContaining({ code: "INVALID_WINDOW" }));
  });

  it("round-trips a valid persisted ledger and exposes the latest snapshot", () => {
    const cutoff = instant("2026-09-11T19:00:00Z");
    const prepared = prepareWeeklyEdition(
      createEmptyWeeklyEditionLedger(),
      [{ id: 1, createdAtEpochMs: cutoff - 1 }],
      { editionId: "week-1", cutoff, datasetVersion: "a" }
    );
    const parsed = parseWeeklyLedger(
      JSON.parse(serializeWeeklyLedger(prepared.ledger))
    );
    expect(getLatestWeeklyEdition(parsed)).toEqual(prepared.edition);
  });
});
