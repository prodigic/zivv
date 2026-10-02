import { describe, expect, it } from "vitest";
import {
  bootstrapLedger,
  reconcileCandidates,
} from "../../lib/ingestion/ledger.js";
import { assessVenueCoverage } from "../../lib/ingestion/venue-coverage.js";
import type { Artist, Event, Venue } from "../../types/events.js";
import type {
  VenueAdapterResult,
  VenueListing,
  VenueSource,
} from "../../lib/ingestion/venue-types.js";

const observed = Date.parse("2026-09-08T19:00:00Z");
const created = observed - 86400000;
const venue = {
  id: 301,
  name: "Test Hall",
  normalizedName: "test hall",
  slug: "test-hall",
  address: "123 Test Street",
  city: "San Francisco",
  ageRestriction: "all-ages",
  upcomingEventCount: 0,
  totalEventCount: 1,
  upcomingEvents: [],
  createdAtEpochMs: created,
  updatedAtEpochMs: created,
  sourceLineNumber: 1,
} as Venue;
const artist = {
  id: 201,
  name: "Example",
  normalizedName: "example",
  slug: "example",
  aliases: [],
  upcomingEventCount: 0,
  totalEventCount: 1,
  upcomingEvents: [],
  createdAtEpochMs: created,
  updatedAtEpochMs: created,
} as Artist;
const event = {
  id: 101,
  slug: "stable-original-link",
  date: "2026-10-10",
  dateEpochMs: Date.parse("2026-10-10T12:00:00Z"),
  startTimeEpochMs: Date.parse("2026-10-11T03:00:00Z"),
  timeBasis: "instant",
  timezone: "America/Los_Angeles",
  headlinerArtistId: 201,
  artistIds: [201],
  venueId: 301,
  isFree: false,
  ageRestriction: "all-ages",
  status: "confirmed",
  tags: [],
  venueType: "club",
  createdAtEpochMs: created,
  updatedAtEpochMs: created,
  sourceLineNumber: 1,
} as Event;
const source: VenueSource = {
  sourceId: "test",
  venueId: 301,
  venueName: "Test Hall",
  website: "https://venue.example/",
  calendarUrl: "https://venue.example/calendar",
  timezone: "America/Los_Angeles",
  enabled: false,
};
const listing: VenueListing = {
  key: "one",
  url: "https://venue.example/one",
  title: "Example",
  date: "2026-10-10",
  startTimeEpochMs: event.startTimeEpochMs,
  artists: ["Example"],
  ageRestriction: "all-ages",
  kind: "live",
};
const ledger = () =>
  bootstrapLedger(
    { events: [event], artists: [artist], venues: [venue] },
    observed
  );
function result(listings: VenueListing[]): VenueAdapterResult {
  return {
    sourceId: "test",
    adapterVersion: "test-v1",
    complete: true,
    listings,
    inventories: [
      {
        name: "calendar",
        keys: listings.map((item) => item.key),
        complete: true,
      },
    ],
    coverageStart: "2026-09-08",
    coverageEnd: "2026-12-31",
    warnings: [],
  };
}

describe("venue completeness and DB accounting", () => {
  it("distinguishes real matches, absent shows and packages, preserving existing IDs and slugs", () => {
    const original = ledger();
    const snapshot = JSON.stringify(original);
    const input = result([
      listing,
      {
        ...listing,
        key: "new",
        url: "https://venue.example/new",
        date: "2026-11-10",
        startTimeEpochMs: undefined,
      },
      { ...listing, key: "pass", kind: "package", reason: "Multi-show pass" },
    ]);
    const assessment = assessVenueCoverage(original, source, input, observed);
    expect(assessment.report.counts).toMatchObject({
      discovered: 3,
      matched: 1,
      "missing-from-db": 1,
      excluded: 1,
      review: 0,
    });
    expect(assessment.report.sourceStatus).toBe("complete");
    expect(assessment.report.items[0].eventIds).toEqual([101]);
    expect(assessment.report.items[1].eventIds).toEqual([]);
    expect(assessment.report.importEligible).toBe(true);
    const accepted = reconcileCandidates(original, assessment.batch);
    expect(accepted.ledger.events.find((e) => e.id === 101)?.slug).toBe(
      "stable-original-link"
    );
    const repeat = assessVenueCoverage(
      accepted.ledger,
      source,
      input,
      observed + 86400000
    );
    expect(repeat.reconciliation.updatedEventIds).toEqual([]);
    expect(repeat.reconciliation.conflicts).toEqual([]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("matches Fillmore title hints to an exact existing act, date, and venue", () => {
    const input = result([
      {
        ...listing,
        key: "fillmore-title-hint",
        url: "https://venue.example/fillmore-title-hint",
        title: "Example - A Headline Tour",
        artists: [],
        kind: "review",
        reason: "listing is missing explicit performer markup",
      },
    ]);
    input.sourceId = "fillmore-sf";
    const assessment = assessVenueCoverage(
      ledger(),
      { ...source, sourceId: "fillmore-sf" },
      input,
      observed
    );

    expect(assessment.report.items[0]).toMatchObject({
      outcome: "matched",
      eventIds: [101],
      reason: expect.stringContaining("parsed title act"),
    });
    expect(assessment.batch.events).toHaveLength(0);
  });

  it("keeps unmatched title hints and package listings in review", () => {
    const input = result([
      {
        ...listing,
        key: "unmatched-fillmore-title-hint",
        url: "https://venue.example/unmatched-fillmore-title-hint",
        title: "Unlisted Act - Tour",
        artists: [],
        kind: "review",
        reason: "listing is missing explicit performer markup",
      },
      {
        ...listing,
        key: "fillmore-pass",
        url: "https://venue.example/fillmore-pass",
        title: "Example - Seven Show Ticket",
        artists: [],
        kind: "review",
        reason: "package/pass listing is missing explicit performer markup",
      },
    ]);
    input.sourceId = "fillmore-sf";
    const assessment = assessVenueCoverage(
      ledger(),
      { ...source, sourceId: "fillmore-sf" },
      input,
      observed
    );

    expect(assessment.report.items.map((item) => item.outcome)).toEqual([
      "review",
      "review",
    ]);
    expect(assessment.batch.events).toHaveLength(0);
  });

  it("leaves multiple same-day Fillmore matches for performance review", () => {
    const original = bootstrapLedger(
      {
        events: [
          event,
          {
            ...event,
            id: 102 as Event["id"],
            slug: "second-example-performance",
          },
        ],
        artists: [artist],
        venues: [venue],
      },
      observed
    );
    const input = result([
      {
        ...listing,
        key: "ambiguous-fillmore-title-hint",
        url: "https://venue.example/ambiguous-fillmore-title-hint",
        title: "Example - A Headline Tour",
        artists: [],
        kind: "review",
        reason: "listing is missing explicit performer markup",
      },
    ]);
    input.sourceId = "fillmore-sf";
    const assessment = assessVenueCoverage(
      original,
      { ...source, sourceId: "fillmore-sf" },
      input,
      observed
    );

    expect(assessment.report.items[0]).toMatchObject({
      outcome: "review",
      eventIds: [101, 102],
      reason: expect.stringContaining("multiple same-day"),
    });
    expect(assessment.batch.events).toHaveLength(0);
  });

  it("never reports a truncated or unaccounted calendar as complete", () => {
    const input = result([listing]);
    input.inventories[0].keys.push("missing-card");
    const assessment = assessVenueCoverage(ledger(), source, input, observed);
    expect(assessment.report.sourceStatus).toBe("partial");
    expect(assessment.report.databaseStatus).toBe("not-verified");
    expect(assessment.report.importEligible).toBe(false);
    expect(assessment.report.issues.join(" ")).toContain(
      "no parsed/classified listing"
    );
  });

  it("retains calendar discoveries absent from an auxiliary feed", () => {
    const input = result([listing]);
    input.inventories.push({ name: "RSS", keys: [], complete: true });
    const assessment = assessVenueCoverage(ledger(), source, input, observed);
    expect(assessment.report.items).toHaveLength(1);
    expect(
      assessment.report.inventoryDifferences[0].missingFromInventory
    ).toEqual(["one"]);
  });

  it("does not promote vendor markers into performer identities", () => {
    const input = result([
      {
        ...listing,
        key: "vendor-marker",
        url: "https://venue.example/vendor-marker",
        date: "2026-11-10",
        startTimeEpochMs: undefined,
        artists: ["Example", "vendors"],
      },
    ]);
    const assessment = assessVenueCoverage(ledger(), source, input, observed);

    expect(assessment.batch.events).toHaveLength(1);
    expect(assessment.batch.events[0].event.artistIds).toHaveLength(1);
    expect(
      assessment.batch.artists.map((artist) => artist.normalizedName)
    ).toEqual(["example"]);
  });

  it("requires a valid horizon before claiming the DB is verified", () => {
    const input = result([listing]);
    input.coverageEnd = undefined;
    const assessment = assessVenueCoverage(ledger(), source, input, observed);
    expect(assessment.report.sourceStatus).toBe("partial");
    expect(assessment.report.databaseStatus).toBe("not-verified");
    expect(assessment.report.importEligible).toBe(false);
    expect(assessment.report.issues).toContain(
      "No valid source coverage horizon established"
    );
  });

  it("allows an explicitly auxiliary partial audit only when primary discovery is complete", () => {
    const input = result([listing]);
    input.inventories.push({
      name: "initial HTML",
      keys: [],
      complete: false,
      requiredForCoverage: false,
    });
    expect(
      assessVenueCoverage(ledger(), source, input, observed).report.sourceStatus
    ).toBe("complete");
    input.inventories[0].complete = false;
    input.inventories[0].requiredForCoverage = false;
    expect(
      assessVenueCoverage(ledger(), source, input, observed).report.sourceStatus
    ).toBe("partial");
  });

  it("flags uncertain historical times instead of inventing a duplicate show", () => {
    const original = ledger();
    original.events[0].timeBasis = "legacy-wall-clock";
    original.events[0].startTimeEpochMs = Date.parse("2026-10-10T02:00:00Z");
    const assessment = assessVenueCoverage(
      original,
      source,
      result([listing]),
      observed
    );
    expect(assessment.report.counts.review).toBe(1);
    expect(assessment.report.counts["missing-from-db"]).toBe(0);
    expect(assessment.batch.events).toHaveLength(0);
    expect(assessment.report.importEligible).toBe(false);
  });

  it("keeps two differently timed performances separate and flags disappeared DB rows without deleting", () => {
    const input = result([
      {
        ...listing,
        key: "later",
        startTimeEpochMs: Date.parse("2026-10-11T05:00:00Z"),
      },
    ]);
    const assessment = assessVenueCoverage(ledger(), source, input, observed);
    expect(assessment.report.counts["missing-from-db"]).toBe(1);
    expect(
      assessment.report.databaseEventsNotOnSource.map((e) => e.eventId)
    ).toEqual([101]);
    expect(assessment.report.databaseStatus).toBe("review-required");
    expect(assessment.report.importEligible).toBe(false);
  });
});
