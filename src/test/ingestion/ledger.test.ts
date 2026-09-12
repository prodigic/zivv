import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type {
  Artist,
  ArtistId,
  Event,
  EventId,
  Venue,
  VenueId,
} from "../../types/events.js";
import {
  bootstrapLedger,
  loadLedger,
  migrateLedger,
  reconcileCandidates,
  saveLedgerAtomic,
} from "../../lib/ingestion/ledger.js";
import type { IngestionBatch } from "../../types/ingestion.js";

function makeArtist(id: number, name: string): Artist {
  return {
    id: id as ArtistId,
    name,
    slug: name.toLowerCase().replace(/\s+/gu, "-"),
    normalizedName: name.toLowerCase(),
    aliases: [],
    upcomingEventCount: 0,
    totalEventCount: 0,
    upcomingEvents: [],
    createdAtEpochMs: 10,
    updatedAtEpochMs: 10,
  };
}

function makeVenue(id: number, name: string, city = "San Francisco"): Venue {
  return {
    id: id as VenueId,
    name,
    slug: name.toLowerCase().replace(/\s+/gu, "-"),
    normalizedName: name.toLowerCase(),
    address: "1 Test Street",
    city,
    ageRestriction: "all-ages",
    upcomingEventCount: 0,
    totalEventCount: 0,
    upcomingEvents: [],
    createdAtEpochMs: 10,
    updatedAtEpochMs: 10,
    sourceLineNumber: 1,
  };
}

function makeEvent(
  id: number,
  artistId: number,
  venueId: number,
  date: string,
  startTimeEpochMs?: number,
  overrides: Partial<Event> = {}
): Event {
  return {
    id: id as EventId,
    slug: `event-${id}`,
    date,
    dateEpochMs: Date.parse(`${date}T12:00:00.000Z`),
    startTime:
      startTimeEpochMs === undefined
        ? undefined
        : new Date(startTimeEpochMs).toISOString(),
    startTimeEpochMs,
    timezone: "America/Los_Angeles",
    headlinerArtistId: artistId as ArtistId,
    artistIds: [artistId as ArtistId],
    venueId: venueId as VenueId,
    isFree: false,
    priceMin: 20,
    priceMax: 20,
    ageRestriction: "all-ages",
    status: "confirmed",
    tags: [],
    venueType: "club",
    createdAtEpochMs: 111,
    updatedAtEpochMs: 111,
    sourceLineNumber: 1,
    ...overrides,
  };
}

function emptyLedger() {
  return bootstrapLedger({ events: [], artists: [], venues: [] }, 1000);
}

function batch(
  runId: string,
  origin: IngestionBatch["origin"],
  sourceId: string,
  observedAtEpochMs: number,
  event: Event,
  artists: Artist[],
  venues: Venue[],
  metadata: {
    externalEventId?: string;
    canonicalUrl?: string;
    session?: string;
  } = {}
): IngestionBatch {
  return {
    runId,
    origin,
    sourceId,
    observedAtEpochMs,
    events: [{ event, ...metadata }],
    artists,
    venues,
  };
}

describe("durable ingestion ledger", () => {
  it("bootstraps all historical events as Steve's List without changing identity or date added", () => {
    const artist = makeArtist(1, "The Example");
    const venue = makeVenue(2, "The Test Room");
    const event = makeEvent(3, artist.id, venue.id, "2026-09-20", undefined, {
      createdAtEpochMs: 1234,
      updatedAtEpochMs: 2345,
    });

    const ledger = bootstrapLedger(
      { events: [event], artists: [artist], venues: [venue] },
      9999
    );

    expect(ledger.events[0]).toMatchObject({
      id: event.id,
      createdAtEpochMs: 1234,
      updatedAtEpochMs: 2345,
      firstImportedBy: "steveslist",
      addedDateProvenance: "legacy-batch",
      firstObservedAtEpochMs: null,
      firstImportRunId: null,
    });
    expect(ledger.events[0]?.sources[0]).toMatchObject({
      kind: "steveslist",
      sourceId: "steveslist",
      firstSeenAtEpochMs: null,
      lastSeenAtEpochMs: null,
      firstSeenRunId: null,
      lastSeenRunId: null,
    });
    expect(ledger.migration.basis).toBe("all-prior-events-steveslist");
    expect(ledger.events).toHaveLength(1);
  });

  it("migrates a recognizable legacy snapshot and rejects a missing or corrupt cold ledger", async () => {
    const artist = makeArtist(1, "Example");
    const venue = makeVenue(2, "Room");
    venue.address = "";
    venue.city = "";
    const event = makeEvent(3, artist.id, venue.id, "2026-09-20");
    const migrated = migrateLedger(
      { events: [event], artists: [artist], venues: [venue] },
      5555
    );
    expect(migrated.migration.migratedAtEpochMs).toBe(5555);

    const directory = await mkdtemp(join(tmpdir(), "zivv-ledger-test-"));
    const missingPath = join(directory, "missing.json");
    await expect(loadLedger(missingPath)).rejects.toMatchObject({
      code: "missing-ledger",
    });

    const corruptPath = join(directory, "corrupt.json");
    await writeFile(corruptPath, "{not-json", "utf8");
    await expect(loadLedger(corruptPath)).rejects.toMatchObject({
      code: "corrupt-ledger",
    });
  });

  it("round-trips a ledger through the atomic persistence boundary", async () => {
    const ledger = emptyLedger();
    const directory = await mkdtemp(join(tmpdir(), "zivv-ledger-test-"));
    const path = join(directory, "nested", "ledger.json");
    await saveLedgerAtomic(path, ledger);
    await expect(loadLedger(path)).resolves.toEqual(ledger);
  });

  it("joins daily venue and later weekly Steve's List observations into one event", () => {
    const dailyArtist = makeArtist(10, "The Shared Lineup");
    const dailyVenue = makeVenue(20, "The Shared Room");
    const first = makeEvent(
      30,
      dailyArtist.id,
      dailyVenue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const daily = reconcileCandidates(
      emptyLedger(),
      batch(
        "daily-1",
        "zivv-venue-import",
        "venue-shared",
        2000,
        first,
        [dailyArtist],
        [dailyVenue],
        { externalEventId: "provider-30" }
      )
    );
    const weeklyArtist = makeArtist(110, "The Shared Lineup");
    const weeklyVenue = makeVenue(120, "The Shared Room");
    const second = makeEvent(
      130,
      weeklyArtist.id,
      weeklyVenue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const weekly = reconcileCandidates(
      daily.ledger,
      batch(
        "weekly-1",
        "steveslist",
        "steveslist",
        3000,
        second,
        [weeklyArtist],
        [weeklyVenue]
      )
    );

    expect(weekly.ledger.events).toHaveLength(1);
    expect(weekly.report.newEventIds).toEqual([]);
    expect(weekly.report.linkedEventIds).toEqual([daily.report.newEventIds[0]]);
    expect(weekly.ledger.events[0]?.firstImportedBy).toBe("zivv-venue-import");
    expect(weekly.ledger.events[0]?.createdAtEpochMs).toBe(2000);
    expect(
      weekly.ledger.events[0]?.sources.map((source) => source.kind)
    ).toEqual(["venue-calendar", "steveslist"]);
  });

  it("keeps early and late performances separate even when legacy IDs collide", () => {
    const artist = makeArtist(1, "One Lineup");
    const venue = makeVenue(2, "One Room");
    const early = makeEvent(
      99,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T02:00:00.000Z")
    );
    const late = makeEvent(
      99,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T05:00:00.000Z")
    );
    const result = reconcileCandidates(emptyLedger(), {
      runId: "two-shows",
      origin: "steveslist",
      sourceId: "steveslist",
      observedAtEpochMs: 2000,
      events: [early, late],
      artists: [artist],
      venues: [venue],
    });

    expect(result.ledger.events).toHaveLength(2);
    expect(new Set(result.ledger.events.map((event) => event.id)).size).toBe(2);
    expect(result.report.newEventIds).toHaveLength(2);
  });

  it("reviews a possible legacy-time mismatch instead of guessing a new show", () => {
    const artist = makeArtist(1, "Legacy Time Artist");
    const venue = makeVenue(2, "Legacy Time Room");
    const historical = makeEvent(
      3,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T02:00:00.000Z"),
      {
        timeBasis: "legacy-wall-clock",
      }
    );
    const ledger = bootstrapLedger(
      { events: [historical], artists: [artist], venues: [venue] },
      1000
    );
    const candidate = makeEvent(
      4,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T05:00:00.000Z")
    );
    const result = reconcileCandidates(
      ledger,
      batch(
        "legacy-near",
        "steveslist",
        "steveslist",
        2000,
        candidate,
        [artist],
        [venue]
      )
    );

    expect(result.ledger.events).toHaveLength(1);
    expect(result.report.review).toMatchObject([
      { reason: "legacy-time-uncertain", existingEventIds: [3] },
    ]);
    expect(result.report.newEventIds).toEqual([]);
  });

  it("updates a provider-linked reschedule in place and retains date added", () => {
    const artist = makeArtist(1, "Rescheduled Artist");
    const venue = makeVenue(2, "Reschedule Room");
    const original = makeEvent(
      3,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const first = reconcileCandidates(
      emptyLedger(),
      batch(
        "provider-1",
        "zivv-venue-import",
        "venue-reschedule",
        2000,
        original,
        [artist],
        [venue],
        { externalEventId: "same-provider-id", session: "main" }
      )
    );
    const moved = makeEvent(
      300,
      artist.id,
      venue.id,
      "2026-09-22",
      Date.parse("2026-09-23T04:00:00.000Z"),
      { status: "rescheduled" }
    );
    const second = reconcileCandidates(
      first.ledger,
      batch(
        "provider-2",
        "zivv-venue-import",
        "venue-reschedule",
        4000,
        moved,
        [artist],
        [venue],
        { externalEventId: "same-provider-id", session: "main" }
      )
    );

    expect(second.ledger.events).toHaveLength(1);
    expect(second.ledger.events[0]).toMatchObject({
      id: 3,
      date: "2026-09-22",
      createdAtEpochMs: 2000,
      updatedAtEpochMs: 4000,
    });
    expect(second.report.updatedEventIds).toEqual([3]);
    expect(second.report.newEventIds).toEqual([]);
    expect(
      second.report.conflicts.some(
        (conflict) => conflict.reason === "source-linked-reschedule"
      )
    ).toBe(true);
  });

  it("preserves omitted optional event fields while applying explicit values", () => {
    const artist = makeArtist(1, "Optional Fields Artist");
    const venue = makeVenue(2, "Optional Fields Room");
    const original = makeEvent(
      3,
      artist.id,
      venue.id,
      "2026-09-20",
      undefined,
      {
        description: "Canonical description",
        notes: "Canonical notes",
        ticketUrl: "https://tickets.example/canonical",
        priceMin: 12,
        priceMax: 30,
      }
    );
    const first = reconcileCandidates(
      emptyLedger(),
      batch(
        "optional-1",
        "steveslist",
        "steveslist",
        2000,
        original,
        [artist],
        [venue]
      )
    );

    const omitted = { ...original, id: 30 as EventId };
    delete omitted.description;
    delete omitted.notes;
    delete omitted.ticketUrl;
    delete omitted.priceMin;
    delete omitted.priceMax;
    const preserved = reconcileCandidates(
      first.ledger,
      batch(
        "optional-2",
        "steveslist",
        "steveslist",
        3000,
        omitted,
        [artist],
        [venue]
      )
    );
    expect(preserved.ledger.events[0]).toMatchObject({
      description: "Canonical description",
      notes: "Canonical notes",
      ticketUrl: "https://tickets.example/canonical",
      priceMin: 12,
      priceMax: 30,
    });

    const explicit = {
      ...omitted,
      id: 31 as EventId,
      description: "",
      notes: "",
      ticketUrl: "",
      priceMin: 0,
      priceMax: 0,
    };
    const cleared = reconcileCandidates(
      preserved.ledger,
      batch(
        "optional-3",
        "steveslist",
        "steveslist",
        4000,
        explicit,
        [artist],
        [venue]
      )
    );
    expect(cleared.ledger.events[0]).toMatchObject({
      description: "",
      notes: "",
      ticketUrl: "",
      priceMin: 0,
      priceMax: 0,
    });
  });

  it("retains authoritative venue data and reports incoming venue conflicts", () => {
    const artist = makeArtist(1, "Venue Conflict Artist");
    const venue = makeVenue(2, "Venue Conflict Room");
    venue.address = "1 Canonical Street";
    const event = makeEvent(3, artist.id, venue.id, "2026-09-20");
    const ledger = bootstrapLedger(
      { events: [event], artists: [artist], venues: [venue] },
      1000
    );
    const incomingVenue = { ...venue, address: "2 Stale Source Street" };
    const result = reconcileCandidates(
      ledger,
      batch(
        "venue-conflict-1",
        "steveslist",
        "steveslist",
        2000,
        { ...event, id: 30 as EventId },
        [artist],
        [incomingVenue]
      )
    );

    expect(result.ledger.venues[0]?.address).toBe("1 Canonical Street");
    expect(result.report.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: 3,
          field: "address",
          existingValue: "1 Canonical Street",
          incomingValue: "2 Stale Source Street",
          reason: "venue-authority",
        }),
      ])
    );
    expect(result.ledger.events[0]?.provenanceConflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "address",
          incomingValue: "2 Stale Source Street",
          reason: "venue-authority",
        }),
      ])
    );
  });

  it("routes an ambiguous fingerprint to review without auto-merging", () => {
    const artist = makeArtist(1, "Ambiguous Artist");
    const venue = makeVenue(2, "Ambiguous Room");
    const first = makeEvent(
      10,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const second = makeEvent(
      11,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const ledger = bootstrapLedger(
      { events: [first, second], artists: [artist], venues: [venue] },
      1000
    );
    const candidate = makeEvent(
      12,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const result = reconcileCandidates(
      ledger,
      batch(
        "ambiguous-1",
        "steveslist",
        "steveslist",
        2000,
        candidate,
        [artist],
        [venue]
      )
    );

    expect(result.ledger.events).toHaveLength(2);
    expect(result.report.review).toMatchObject([
      { reason: "ambiguous-match", existingEventIds: [10, 11] },
    ]);
    expect(result.report.acceptedEventIds).toEqual([]);
  });

  it("allocates a new ID when a candidate collides with a different canonical event", () => {
    const artist = makeArtist(1, "Collision Artist");
    const venue = makeVenue(2, "Collision Room");
    const existing = makeEvent(
      42,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const ledger = bootstrapLedger(
      { events: [existing], artists: [artist], venues: [venue] },
      1000
    );
    const candidate = makeEvent(
      42,
      artist.id,
      venue.id,
      "2026-09-21",
      Date.parse("2026-09-22T03:00:00.000Z")
    );
    const result = reconcileCandidates(
      ledger,
      batch(
        "collision-1",
        "steveslist",
        "steveslist",
        2000,
        candidate,
        [artist],
        [venue]
      )
    );

    expect(result.ledger.events).toHaveLength(2);
    expect(result.report.newEventIds).toEqual([43]);
    expect(result.ledger.events.map((event) => event.id)).toEqual([42, 43]);
  });

  it("uses source ID plus session so provider sessions with one ID remain separate", () => {
    const artist = makeArtist(1, "Session Artist");
    const venue = makeVenue(2, "Session Room");
    const first = makeEvent(
      50,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const second = makeEvent(
      50,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const result = reconcileCandidates(emptyLedger(), {
      runId: "sessions-1",
      origin: "zivv-venue-import",
      sourceId: "session-provider",
      observedAtEpochMs: 2000,
      events: [
        {
          event: first,
          externalEventId: "shared-provider-id",
          session: "early",
        },
        {
          event: second,
          externalEventId: "shared-provider-id",
          session: "late",
        },
      ],
      artists: [artist],
      venues: [venue],
    });

    expect(result.ledger.events).toHaveLength(2);
    expect(
      result.ledger.events.map((event) => event.sources[0]?.session)
    ).toEqual(["early", "late"]);
  });

  it("preserves Salesforce instance fragments as distinct canonical URLs", () => {
    const artist = makeArtist(1, "Salesforce Artist");
    const venue = makeVenue(2, "Salesforce Room");
    const first = makeEvent(
      50,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const second = makeEvent(
      50,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const result = reconcileCandidates(emptyLedger(), {
      runId: "salesforce-fragments",
      origin: "zivv-venue-import",
      sourceId: "salesforce-room",
      observedAtEpochMs: 2000,
      events: [
        {
          event: first,
          canonicalURL: "https://tickets.example.test/ticket#/instances/early",
        },
        {
          event: second,
          canonicalURL: "https://tickets.example.test/ticket#/instances/late",
        },
      ],
      artists: [artist],
      venues: [venue],
    });

    expect(result.ledger.events).toHaveLength(2);
    expect(
      result.ledger.events.map((event) => event.sources[0]?.canonicalUrl)
    ).toEqual([
      "https://tickets.example.test/ticket#/instances/early",
      "https://tickets.example.test/ticket#/instances/late",
    ]);
  });

  it("keeps relative provider URLs scoped to their source namespace", () => {
    const artist = makeArtist(1, "Relative URL Artist");
    const venue = makeVenue(2, "Relative URL Room");
    const first = makeEvent(
      60,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const second = makeEvent(
      60,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const result = reconcileCandidates(emptyLedger(), {
      runId: "relative-urls",
      origin: "zivv-venue-import",
      sourceId: "relative-a",
      observedAtEpochMs: 2000,
      events: [{ event: first, canonicalUrl: "/event/123" }],
      artists: [artist],
      venues: [venue],
    });
    const secondResult = reconcileCandidates(result.ledger, {
      runId: "relative-urls-b",
      origin: "zivv-venue-import",
      sourceId: "relative-b",
      observedAtEpochMs: 3000,
      events: [{ event: second, canonicalUrl: "/event/123" }],
      artists: [artist],
      venues: [venue],
    });

    expect(secondResult.ledger.events).toHaveLength(2);
    expect(secondResult.report.newEventIds).toEqual([61]);
  });

  it("replays a run idempotently, ignores parser timestamps, and rejects changed replay content", () => {
    const artist = makeArtist(1, "Replay Artist");
    const venue = makeVenue(2, "Replay Room");
    const original = makeEvent(
      3,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z")
    );
    const first = reconcileCandidates(
      emptyLedger(),
      batch(
        "replay-1",
        "steveslist",
        "steveslist",
        2000,
        original,
        [artist],
        [venue]
      )
    );
    const parserTimestampOnly = makeEvent(
      3,
      artist.id,
      venue.id,
      "2026-09-20",
      Date.parse("2026-09-21T03:00:00.000Z"),
      {
        createdAtEpochMs: 8888,
        updatedAtEpochMs: 9999,
        sourceLineNumber: 99,
      }
    );
    const replay = reconcileCandidates(
      first.ledger,
      batch(
        "replay-1",
        "steveslist",
        "steveslist",
        7000,
        parserTimestampOnly,
        [artist],
        [venue]
      )
    );
    expect(replay.report.replay).toBe(true);
    expect(replay.ledger).toEqual(first.ledger);
    expect(() =>
      reconcileCandidates(
        first.ledger,
        batch(
          "replay-1",
          "steveslist",
          "steveslist",
          7000,
          { ...parserTimestampOnly, date: "2026-09-21" },
          [artist],
          [venue]
        )
      )
    ).toThrow(/different content/u);
  });

  it("never trusts a reused adapter hash without comparing the normalized payload", () => {
    const artist = makeArtist(1, "Hash Artist");
    const venue = makeVenue(2, "Hash Room");
    const firstEvent = makeEvent(3, artist.id, venue.id, "2026-09-20");
    const firstBatch = {
      ...batch(
        "hash-replay",
        "steveslist",
        "steveslist",
        2000,
        firstEvent,
        [artist],
        [venue]
      ),
      contentHash: "adapter-hash",
    };
    const first = reconcileCandidates(emptyLedger(), firstBatch);
    const changedEvent = makeEvent(3, artist.id, venue.id, "2026-09-21");
    const changedBatch = {
      ...batch(
        "hash-replay",
        "steveslist",
        "steveslist",
        2000,
        changedEvent,
        [artist],
        [venue]
      ),
      contentHash: "adapter-hash",
    };

    expect(() => reconcileCandidates(first.ledger, changedBatch)).toThrow(
      /different content/u
    );
  });
});
