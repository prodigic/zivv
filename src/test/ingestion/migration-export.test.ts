import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { migrateExistingCatalog } from "../../lib/ingestion/migrate.js";
import { ETLProcessor } from "../../lib/etl/processor.js";
import {
  importSteveContent,
  importVenueBatch,
} from "../../lib/ingestion/imports.js";
import { loadLedger } from "../../lib/ingestion/ledger.js";
import type { Artist, Event, Venue } from "../../types/events.js";

const directories: string[] = [];
const created = Date.parse("2026-08-21T19:00:00Z");
function setup() {
  const root = mkdtempSync(join(tmpdir(), "zivv-ingestion-"));
  directories.push(root);
  const event = {
    id: 101,
    slug: "2026-12-01-test-band-test-hall",
    date: "2026-12-01",
    dateEpochMs: Date.parse("2026-12-01T12:00:00Z"),
    startTimeEpochMs: Date.parse("2026-12-01T20:00:00Z"),
    timezone: "America/Los_Angeles",
    headlinerArtistId: 201,
    artistIds: [201],
    venueId: 301,
    isFree: false,
    priceMin: 20,
    ageRestriction: "21+",
    status: "confirmed",
    tags: [],
    venueType: "club",
    createdAtEpochMs: created,
    updatedAtEpochMs: created,
    sourceLineNumber: 1,
  } as Event;
  const artist = {
    id: 201,
    name: "Test Band",
    normalizedName: "test",
    slug: "test-band",
    aliases: [],
    upcomingEventCount: 1,
    totalEventCount: 1,
    upcomingEvents: [],
    createdAtEpochMs: created,
    updatedAtEpochMs: created,
  } as Artist;
  const venue = {
    id: 301,
    name: "Test Hall",
    normalizedName: "test hall",
    slug: "test-hall",
    city: "S.f",
    address: "1 Mission Street",
    ageRestriction: "21+",
    upcomingEventCount: 1,
    totalEventCount: 1,
    upcomingEvents: [],
    createdAtEpochMs: created,
    updatedAtEpochMs: created,
    sourceLineNumber: 1,
  } as Venue;
  mkdirSync(join(root, "public/data"), { recursive: true });
  mkdirSync(join(root, "data"));
  const write = (file: string, value: unknown) =>
    writeFileSync(join(root, file), JSON.stringify(value));
  write("public/data/events-2026-12.json", {
    chunkId: "2026-12",
    events: [event],
  });
  write("public/data/artists.json", [artist]);
  write("public/data/venues.json", [venue]);
  write("public/data/manifest.json", {
    datasetVersion: "old",
    schemaVersion: "1.0.0",
    totalEvents: 1,
    totalArtists: 1,
    totalVenues: 1,
  });
  write("data/venue-sources.json", {
    sources: [{ sourceId: "test-hall", venueId: 301, enabled: false }],
  });
  writeFileSync(
    join(root, "data/events.txt"),
    "dec 1 2026 Test Band at Test Hall, S.F. 21+ $20 8pm\n"
  );
  writeFileSync(
    join(root, "data/venues.txt"),
    "Test Hall, 1 Mission Street, S.F. 21+\n"
  );
  return { root, event, artist, venue };
}
afterEach(() => {
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir(), "zivv-ingestion-")))
      throw new Error("Unsafe test cleanup path");
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migration and ledger export", () => {
  it("backfills the exact prior catalog and does not repeat the migration", async () => {
    const { root, event } = setup();
    await migrateExistingCatalog(root, Date.parse("2026-09-07T12:00:00Z"));
    const path = join(root, "data/ingestion/ledger.json");
    const before = readFileSync(path, "utf8");
    const ledger = await loadLedger(path);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]).toMatchObject({
      id: event.id,
      createdAtEpochMs: created,
      firstImportedBy: "steveslist",
      addedDateProvenance: "legacy-batch",
      timeBasis: "legacy-wall-clock",
    });
    expect(ledger.events[0].sources.some((s) => s.kind === "steveslist")).toBe(
      true
    );
    expect((await migrateExistingCatalog(root)).migrated).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("exports valid checksums and preserves history after a cold rebuild", async () => {
    const { root } = setup();
    await migrateExistingCatalog(root);
    const first = await new ETLProcessor(root).processData();
    expect(first.success).toBe(true);
    for (const file of [
      ...first.manifest.chunks.events,
      first.manifest.chunks.artists,
      first.manifest.chunks.venues,
      first.manifest.chunks.indexes,
      first.manifest.chunks.recentAdditions!,
    ]) {
      const bytes = readFileSync(join(root, "public/data", file.filename));
      expect(file.size).toBe(bytes.length);
      expect(file.checksum).toBe(
        `sha256-${createHash("sha256").update(bytes).digest("hex")}`
      );
    }
    rmSync(join(root, "public/data"), { recursive: true });
    const rebuilt = await new ETLProcessor(root).processData();
    expect(rebuilt.success).toBe(true);
    const events = JSON.parse(
      readFileSync(join(root, "public/data/events-2026-12.json"), "utf8")
    ).events;
    expect(events[0]).toMatchObject({
      id: 101,
      createdAtEpochMs: created,
      firstImportedBy: "steveslist",
    });
  });

  it("fails without ledger and leaves existing output unchanged", async () => {
    const { root } = setup();
    const path = join(root, "public/data/manifest.json");
    const before = readFileSync(path, "utf8");
    expect((await new ETLProcessor(root).processData()).success).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    await migrateExistingCatalog(root);
    writeFileSync(join(root, "data/ingestion/ledger.json"), "broken");
    expect((await new ETLProcessor(root).processData()).success).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("routes daily and weekly observations through one identity without resetting newness", async () => {
    const { root, event, artist, venue } = setup();
    await migrateExistingCatalog(root);
    const observed = Date.parse("2026-09-08T19:00:00Z");
    const newShow = {
      ...event,
      id: 102 as Event["id"],
      date: "2026-12-02",
      dateEpochMs: Date.parse("2026-12-02T12:00:00Z"),
      startTimeEpochMs: Date.parse("2026-12-03T04:00:00Z"),
      timeBasis: "instant" as const,
      slug: "new-show",
    };
    const batch = {
      runId: "daily-1",
      origin: "zivv-venue-import" as const,
      sourceId: "test-hall",
      observedAtEpochMs: observed,
      events: [{ event: newShow, externalEventId: "provider-123" }],
      artists: [artist],
      venues: [venue],
    };
    const daily = await importVenueBatch(root, batch);
    expect(daily.report.newEventIds).toHaveLength(1);
    expect(daily.ledger.runs[0].status).toBe("committed");
    expect(daily.ledger.runs[0].committedAtEpochMs).toEqual(expect.any(Number));
    const weekly = await importSteveContent(
      root,
      "dec 2 2026 Test Band at Test Hall, S.F. 21+ $20 8pm\n",
      { observedAtEpochMs: observed + 3 * 86400000 }
    );
    expect(weekly.report.newEventIds).toHaveLength(0);
    expect(weekly.report.review).toHaveLength(0);
    const matched = weekly.ledger.events.find(
      (e) => e.id === daily.report.newEventIds[0]
    )!;
    expect(matched.firstImportedBy).toBe("zivv-venue-import");
    expect(matched.createdAtEpochMs).toBe(observed);
    expect(new Set(matched.sources.map((s) => s.kind))).toEqual(
      new Set(["venue-calendar", "steveslist"])
    );
    const path = join(root, "data/ingestion/ledger.json");
    const saved = readFileSync(path, "utf8");
    expect((await importVenueBatch(root, batch)).report.replay).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(saved);
  });

  it("rejects corrupted replay evidence without changing canonical history", async () => {
    const { root } = setup();
    await migrateExistingCatalog(root);
    const content = "dec 2 2026 Test Band at Test Hall, S.F. 21+ $20 8pm\n";
    const result = await importSteveContent(root, content);
    const ledgerPath = join(root, "data/ingestion/ledger.json");
    const saved = readFileSync(ledgerPath, "utf8");
    const name = createHash("sha256").update(result.report.runId).digest("hex");
    writeFileSync(
      join(root, "data/ingestion/reports", `${name}.json`),
      JSON.stringify({ ...result.report, newEventIds: [999999] })
    );
    await expect(importSteveContent(root, content)).rejects.toThrow(
      "disagrees with durable run"
    );
    expect(readFileSync(ledgerPath, "utf8")).toBe(saved);
  });
});
