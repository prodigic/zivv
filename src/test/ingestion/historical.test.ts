import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  historicalContentHash,
  registerHistoricalSteveBatch,
} from "../../lib/ingestion/historical.js";
import { importSteveContent } from "../../lib/ingestion/imports.js";
import type { Artist, Event, Venue } from "../../../types/events.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir(), "zivv-historical-")))
      throw new Error("Unsafe test directory");
    rmSync(path, { recursive: true, force: true });
  }
});

const BASELINE_CREATED_AT = 1700000000000;
const BASELINE_EVENT_ID = 1001;
const BASELINE_ARTIST_ID = 2001;
const BASELINE_VENUE_ID = 3001;

function baselineSnapshot(): {
  events: Event[];
  artists: Artist[];
  venues: Venue[];
} {
  const artist: Artist = {
    id: BASELINE_ARTIST_ID as Artist["id"],
    name: "Fixture Band",
    slug: "fixture-band",
    normalizedName: "fixture band",
    aliases: [],
    upcomingEventCount: 0,
    totalEventCount: 1,
    upcomingEvents: [],
    createdAtEpochMs: BASELINE_CREATED_AT,
    updatedAtEpochMs: BASELINE_CREATED_AT,
  };
  const venue: Venue = {
    id: BASELINE_VENUE_ID as Venue["id"],
    name: "Fixture Venue",
    slug: "fixture-venue",
    normalizedName: "fixture venue",
    address: "1 Fixture Way",
    city: "San Francisco",
    ageRestriction: "unknown",
    upcomingEventCount: 0,
    totalEventCount: 1,
    upcomingEvents: [],
    createdAtEpochMs: BASELINE_CREATED_AT,
    updatedAtEpochMs: BASELINE_CREATED_AT,
    sourceLineNumber: 1,
  };
  const event: Event = {
    id: BASELINE_EVENT_ID as Event["id"],
    slug: "2026-08-21-fixture-band-fixture-venue",
    date: "2026-08-21",
    dateEpochMs: Date.parse("2026-08-21T00:00:00Z"),
    timezone: "America/Los_Angeles",
    headlinerArtistId: artist.id,
    artistIds: [artist.id],
    venueId: venue.id,
    isFree: false,
    ageRestriction: "unknown",
    status: "confirmed",
    tags: [],
    venueType: "club",
    createdAtEpochMs: BASELINE_CREATED_AT,
    updatedAtEpochMs: BASELINE_CREATED_AT,
    sourceLineNumber: 1,
  };
  return { events: [event], artists: [artist], venues: [venue] };
}

function identityHash(events: readonly Event[]): string {
  const identity = events
    .map((event) => [event.id, event.createdAtEpochMs ?? null])
    .sort((left, right) => Number(left[0]) - Number(right[0]));
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function writeHistoricalFixture(root: string, content: string): string {
  const snapshot = baselineSnapshot();
  const ledger = bootstrapLedger(snapshot, BASELINE_CREATED_AT);
  const ledgerPath = join(root, "data/ingestion/ledger.json");
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  writeFileSync(join(root, "data/latest.txt"), content);
  const datasetVersion = "historical";
  const migrationIdentitySha256 = identityHash(snapshot.events);
  writeFileSync(
    join(root, "data/ingestion/migration.json"),
    JSON.stringify({
      priorDatasetVersion: datasetVersion,
      events: snapshot.events.length,
      preservedIdentityAndAddedDateSha256: migrationIdentitySha256,
    })
  );
  writeFileSync(
    join(root, "data/ingestion/historical-batches.json"),
    JSON.stringify({
      schemaVersion: 1,
      batches: [
        {
          source: "steveslist",
          contentSha256: historicalContentHash(content),
          sourceCommit: "b".repeat(40),
          datasetVersion,
          processedAtEpochMs: 1787350000000,
          recordedAtEpochMs: Date.now(),
          migrationIdentitySha256,
        },
      ],
    })
  );
  return ledgerPath;
}

describe("historical batch recognition", () => {
  it("recognizes exact prior source content before stricter parsing, with no ledger writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "zivv-historical-"));
    directories.push(root);
    mkdirSync(join(root, "data/ingestion"), { recursive: true });
    const content =
      "aug 21 fri Historically malformed listing without a venue\n";
    const ledgerPath = writeHistoricalFixture(root, content);
    const before = readFileSync(ledgerPath, "utf8");
    const result = await importSteveContent(root, content);
    expect(result.report.replay).toBe(true);
    expect(result.report.historicalBatch?.datasetVersion).toBe("historical");
    expect(result.report.newEventIds).toEqual([]);
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
    await expect(
      importSteveContent(root, content.replace("Historically", "Changed"))
    ).rejects.toThrow("parse is incomplete");
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
    const migrationPath = join(root, "data/ingestion/migration.json");
    const migration = JSON.parse(readFileSync(migrationPath, "utf8")) as {
      priorDatasetVersion: string;
      preservedIdentityAndAddedDateSha256: string;
      events: number;
    };
    migration.priorDatasetVersion = "another";
    writeFileSync(migrationPath, JSON.stringify(migration));
    await expect(importSteveContent(root, content)).rejects.toThrow(
      "does not belong"
    );
  });

  it("rejects a receipt after a baseline event is mutated, deleted, or reattributed", async () => {
    const root = mkdtempSync(join(tmpdir(), "zivv-historical-"));
    directories.push(root);
    mkdirSync(join(root, "data/ingestion"), { recursive: true });
    const content =
      "aug 21 fri Historically malformed listing without a venue\n";
    const ledgerPath = writeHistoricalFixture(root, content);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      events: Array<Record<string, unknown>>;
    };

    ledger.events[0].createdAtEpochMs = BASELINE_CREATED_AT + 1;
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    await expect(importSteveContent(root, content)).rejects.toThrow(
      "IDs, dates, or origins"
    );

    writeHistoricalFixture(root, content);
    const deleted = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      events: Array<Record<string, unknown>>;
    };
    deleted.events.pop();
    writeFileSync(ledgerPath, JSON.stringify(deleted));
    await expect(importSteveContent(root, content)).rejects.toThrow(
      "IDs, dates, or origins"
    );

    writeHistoricalFixture(root, content);
    const reattributed = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      events: Array<Record<string, unknown>>;
    };
    reattributed.events[0].firstImportedBy = "zivv-venue-import";
    writeFileSync(ledgerPath, JSON.stringify(reattributed));
    await expect(importSteveContent(root, content)).rejects.toThrow(
      "IDs, dates, or origins"
    );
  });

  it("ignores later run events while validating the bootstrap baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "zivv-historical-"));
    directories.push(root);
    mkdirSync(join(root, "data/ingestion"), { recursive: true });
    const content =
      "aug 21 fri Historically malformed listing without a venue\n";
    const ledgerPath = writeHistoricalFixture(root, content);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      events: Array<Record<string, unknown>>;
    };
    const newRunEvent = { ...ledger.events[0] };
    newRunEvent.id = 1002;
    newRunEvent.slug = "2026-08-21-later-run-fixture";
    newRunEvent.firstImportRunId = "steveslist-v2-new-run";
    ledger.events.push(newRunEvent);
    writeFileSync(ledgerPath, JSON.stringify(ledger));

    const result = await importSteveContent(root, content);
    expect(result.report.replay).toBe(true);
    expect(result.report.newEventIds).toEqual([]);
    expect(readFileSync(ledgerPath, "utf8")).toContain(
      '"firstImportRunId":"steveslist-v2-new-run"'
    );
  });

  it("reuses an existing receipt without requiring git history or source chunks", async () => {
    const root = mkdtempSync(join(tmpdir(), "zivv-historical-"));
    directories.push(root);
    mkdirSync(join(root, "data/ingestion"), { recursive: true });
    const content =
      "aug 21 fri Historically malformed listing without a venue\n";
    writeHistoricalFixture(root, content);

    const receipt = await registerHistoricalSteveBatch(root, "b".repeat(40));
    expect(receipt.contentSha256).toBe(historicalContentHash(content));
    expect(receipt.datasetVersion).toBe("historical");
  });
});
