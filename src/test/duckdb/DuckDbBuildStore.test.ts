import { describe, expect, it } from "vitest";
import type { Event, Artist, Venue } from "@/types/events.js";
import { buildTemporalProjections } from "@/lib/etl/derivations/projections.js";
import {
  DeterministicMemoryBuildStore,
  DUCKDB_SCHEMA_STATEMENTS,
  DUCKDB_SCHEMA_VERSION,
  exportFingerprint,
  exportStaticJson,
  stageSnapshot,
  type SnapshotDescriptor,
  type StagedSnapshot,
} from "@/lib/store/duckdb/index.js";

const event = {
  id: 1 as Event["id"],
  slug: "the-test-show",
  date: "2026-08-15",
  dateEpochMs: Date.UTC(2026, 7, 15),
  timezone: "America/Los_Angeles",
  headlinerArtistId: 1 as Artist["id"],
  artistIds: [1 as Artist["id"], 2 as Artist["id"]],
  venueId: 1 as Venue["id"],
  isFree: false,
  priceMin: 15,
  priceMax: 20,
  ageRestriction: "all-ages" as const,
  status: "confirmed" as const,
  tags: ["all-ages"],
  venueType: "club" as const,
  createdAtEpochMs: 100,
  updatedAtEpochMs: 100,
  sourceLineNumber: 1,
} satisfies Event;

const artist = (id: number, name: string): Artist => ({
  id: id as Artist["id"],
  name,
  slug: name.toLowerCase().replaceAll(" ", "-"),
  normalizedName: name.toLowerCase(),
  aliases: [],
  upcomingEventCount: 0,
  totalEventCount: 1,
  upcomingEvents: [],
  createdAtEpochMs: 100,
  updatedAtEpochMs: 100,
});

const venue: Venue = {
  id: 1 as Venue["id"],
  name: "Test Hall",
  slug: "test-hall",
  normalizedName: "test hall",
  address: "1 Test Way",
  city: "Oakland",
  ageRestriction: "all-ages",
  upcomingEventCount: 0,
  totalEventCount: 1,
  upcomingEvents: [],
  createdAtEpochMs: 100,
  updatedAtEpochMs: 100,
  sourceLineNumber: 1,
};

const descriptor: SnapshotDescriptor = {
  snapshotId: "week-260807",
  sequence: 1,
  sourceDate: "2026-08-07",
  sourceChecksum: "source-checksum",
  processedAtEpochMs: 200,
  asOfEpochMs: Date.UTC(2026, 7, 1),
  schemaVersion: DUCKDB_SCHEMA_VERSION,
  datasetVersion: "2026-08-07T00:00:00.000Z",
};

function makeSnapshot(): StagedSnapshot {
  const model = {
    events: [event],
    artists: [artist(1, "The Testers"), artist(2, "Support Act")].map((value) => ({
      ...value,
      provenance: { sourceFile: "week-260807.txt", sourceLineNumber: 1, firstSeenEpochMs: 100, lastSeenEpochMs: 100 },
    })),
    venues: [{ ...venue, provenance: { sourceFile: "venues.txt", sourceLineNumber: 1, firstSeenEpochMs: 100, lastSeenEpochMs: 100 } }],
    provenance: { events: new Map(), artists: new Map(), venues: new Map() },
  };
  return stageSnapshot({
    descriptor,
    model,
    projections: buildTemporalProjections(model.events, [artist(1, "The Testers"), artist(2, "Support Act")], [venue], descriptor.asOfEpochMs),
  });
}

describe("build-time DuckDB boundary", () => {
  it("has explicit relational schema statements without a client runtime dependency", () => {
    expect(DUCKDB_SCHEMA_STATEMENTS).toEqual(expect.arrayContaining([
      expect.stringContaining("CREATE TABLE IF NOT EXISTS ingestion_runs"),
      expect.stringContaining("CREATE TABLE IF NOT EXISTS events"),
      expect.stringContaining("CREATE TABLE IF NOT EXISTS search_documents"),
    ]));
  });

  it("is idempotent when the same snapshot is applied twice", async () => {
    const store = new DeterministicMemoryBuildStore();
    const snapshot = makeSnapshot();
    await store.initialize();
    const first = await store.applySnapshot(snapshot);
    const firstState = await store.readState();
    const second = await store.applySnapshot(snapshot);
    const secondState = await store.readState();

    expect(first.replayed).toBe(false);
    expect(first.inserted).toBeGreaterThan(0);
    expect(second).toEqual({ inserted: 0, updated: 0, replayed: true });
    expect(secondState).toEqual(firstState);
    await store.close();
  });

  it("exports deterministic exact-byte metadata from canonical projections", () => {
    const snapshot = makeSnapshot();
    const first = exportStaticJson(snapshot);
    const second = exportStaticJson(snapshot);
    expect(exportFingerprint(first, descriptor)).toBe(exportFingerprint(second, descriptor));
    for (const item of first.artifacts) {
      expect(item.metadata.size).toBe(item.bytes.byteLength);
      expect(item.metadata.checksum).toMatch(/^sha256-[a-f0-9]{64}$/);
      expect(item.text.endsWith("\n")).toBe(true);
    }
    expect(first.manifest.chunks.events[0].size).toBe(first.artifacts[0].bytes.byteLength);
    expect(first.manifest.chunks.events[0].checksum).toBe(first.artifacts[0].metadata.checksum);
  });
});
