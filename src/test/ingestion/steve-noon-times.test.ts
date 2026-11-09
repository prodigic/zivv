import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadReviewedSteveImport,
  prepareSteveBatch,
  reviewSteveImport,
  recoverReviewedSteveImport,
} from "../../lib/ingestion/imports.js";
import {
  bootstrapLedger,
  reconcileCandidates,
} from "../../lib/ingestion/ledger.js";
import {
  readSqliteLedger,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import {
  CURRENT_STEVE_IMPORTER,
  type SteveImportReview,
} from "../../lib/ingestion/steve-import-review.js";

const observedAt = Date.parse("2026-11-12T20:00:00Z");
const header =
  "funk-punk-thrash-ska Upcoming shows of Interest November 12, 2026";

function emptyLedger() {
  return bootstrapLedger({ events: [], artists: [], venues: [] }, observedAt);
}

describe("Steve's List noon hour parsing", () => {
  it("parses noon as the show start in single times, door/show pairs and ranges", () => {
    const content = [
      header,
      // 12:00 Pacific on 2026-11-13 (PST, UTC-8 after the November 1 DST end).
      "nov 13 fri Midday Bands at Porch House, S.F. a/a free noon (Porchfest)",
      "nov 13 fri Blueprint at Union Tavern, Oakland a/a $8 noon til 1:15pm",
      "nov 13 fri Little School Acts at Music Hall, S.F. a/a $25 11am/noon",
      "nov 13 fri Table Manners at Parker Lot, Oakland a/a free noon/2pm til 5pm",
      // Ordinary controls (non-noon range and door/show forms).
      "nov 13 fri Open Close at Creek Room, Walnut Creek a/a $15 6pm til 9pm",
      "nov 13 fri Nightlife at the Theater, Berkeley 21+ $30 7pm/8pm til 11pm #",
    ].join("\n");
    const batch = prepareSteveBatch(emptyLedger(), content, observedAt);

    expect(batch.events.map((e) => e.date)).toEqual(
      Array(6).fill("2026-11-13")
    );
    expect(
      batch.events.map((e) => new Date(e.startTimeEpochMs ?? 0).toISOString())
    ).toEqual([
      "2026-11-13T20:00:00.000Z",
      "2026-11-13T20:00:00.000Z",
      "2026-11-13T20:00:00.000Z",
      "2026-11-13T22:00:00.000Z",
      "2026-11-14T02:00:00.000Z",
      "2026-11-14T04:00:00.000Z",
    ]);
  });

  it("keeps a til range from replacing the start time that precedes it", () => {
    const content = [
      header,
      "nov 13 fri Medium Sprint at Jax Room, S.F. 21+ free 5:30pm til 8pm",
      "nov 13 fri Late Wrap at Dive Club, Oakland a/a $5 9pm til 2am",
    ].join("\n");
    const batch = prepareSteveBatch(emptyLedger(), content, observedAt);

    expect(
      batch.events.map((e) => new Date(e.startTimeEpochMs ?? 0).toISOString())
    ).toEqual(["2026-11-14T01:30:00.000Z", "2026-11-14T05:00:00.000Z"]);
  });

  it("does not duplicate a noon show when a later issue widens the window", () => {
    const first = reconcileCandidates(
      emptyLedger(),
      prepareSteveBatch(
        emptyLedger(),
        `${header}\nnov 13 fri Midday Bands at Union Tavern, Oakland a/a $8 noon\n`,
        observedAt
      )
    );

    const second = reconcileCandidates(
      first.ledger,
      prepareSteveBatch(
        first.ledger,
        `${header}\nnov 13 fri Midday Bands at Union Tavern, Oakland a/a $8 noon til 1:15pm\n`,
        observedAt + 7 * 86_400_000
      )
    );

    expect(second.ledger.events).toHaveLength(1);
    expect(second.report.newEventIds).toEqual([]);
    expect(second.report.acceptedEventIds).toEqual([first.ledger.events[0].id]);
    expect(second.ledger.events[0].id).toBe(first.ledger.events[0].id);
    expect(second.ledger.events[0].createdAtEpochMs).toBe(observedAt);
    expect(second.ledger.events[0].startTimeEpochMs).toBe(
      first.ledger.events[0].startTimeEpochMs
    );
  });

  it("adds a noon listing to a previously untimed bill without a new show", () => {
    const first = reconcileCandidates(
      emptyLedger(),
      prepareSteveBatch(
        emptyLedger(),
        `${header}\nnov 13 fri Porch Bands at Extra Room, S.F. a/a $8\n`,
        observedAt
      )
    );

    const second = reconcileCandidates(
      first.ledger,
      prepareSteveBatch(
        first.ledger,
        `${header}\nnov 13 fri Porch Bands at Extra Room, S.F. a/a $8 noon (Porchfest)\n`,
        observedAt + 44 * 86_400_000
      )
    );

    expect(second.ledger.events).toHaveLength(1);
    expect(second.report.newEventIds).toEqual([]);
    expect(second.report.updatedEventIds).toEqual([first.ledger.events[0].id]);
    expect(
      new Date(second.ledger.events[0].startTimeEpochMs ?? 0).toISOString()
    ).toBe("2026-11-13T20:00:00.000Z");
    expect(second.ledger.events[0].createdAtEpochMs).toBe(observedAt);
  });
});

describe("reviewed Steve import with a noon window", () => {
  let root: string;
  let sqlitePath: string;
  const assertOwnership = () => undefined;
  const content1 = `${header}\nnov 13 fri Midday Bands at Union Tavern, Oakland a/a $8 noon\n`;
  const content2 = `${header}\nnov 13 fri Midday Bands at Union Tavern, Oakland a/a $8 noon til 1:15pm\n`;
  const lateObservedAt = observedAt + 7 * 86_400_000;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "zivv-steve-noon-"));
    mkdirSync(join(root, "data/ingestion"), { recursive: true });
    const home = join(root, "operator");
    vi.stubEnv("ZIVV_LEDGER_HOME", home);
    sqlitePath = join(home, "ledger.sqlite");
    writeFileSync(
      join(root, "data/ingestion/store.json"),
      JSON.stringify({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    loadBackupKey(home, true);
    await writeSqliteLedger(
      sqlitePath,
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1_000),
      true
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("imports, replays and re-observes a noon window with a stable identity", async () => {
    const { receipt: receipt1 } = await reviewSteveImport(
      root,
      content1,
      observedAt
    );
    // A current-version receipt owns the current importer and its run prefix.
    expect(receipt1.importer).toBe(CURRENT_STEVE_IMPORTER);
    expect(receipt1.importRunId).toMatch(
      new RegExp(`^${CURRENT_STEVE_IMPORTER}-`)
    );
    const first = await loadReviewedSteveImport(
      root,
      content1,
      receipt1,
      assertOwnership
    );
    expect(first.report.replay).toBe(false);
    expect(first.ledger.events).toHaveLength(1);
    const keeper = first.ledger.events[0];
    expect(keeper).toMatchObject({
      createdAtEpochMs: observedAt,
      firstObservedAtEpochMs: observedAt,
      firstImportedBy: "steveslist",
      firstImportRunId: receipt1.importRunId,
    });
    expect(new Date(keeper.startTimeEpochMs ?? 0).toISOString()).toBe(
      "2026-11-13T20:00:00.000Z"
    );

    // A later issue widens the window instead of adding a 1:15 p.m. show.
    const { receipt: receipt2 } = await reviewSteveImport(
      root,
      content2,
      lateObservedAt
    );
    const second = await loadReviewedSteveImport(
      root,
      content2,
      receipt2,
      assertOwnership
    );
    expect(second.report.newEventIds).toEqual([]);
    expect(second.ledger.events).toHaveLength(1);
    const updated = second.ledger.events[0];
    expect(updated.id).toBe(keeper.id);
    expect(updated.createdAtEpochMs).toBe(observedAt);
    expect(updated.firstImportRunId).toBe(receipt1.importRunId);
    expect(updated.firstImportedBy).toBe("steveslist");
    expect(new Date(updated.startTimeEpochMs ?? 0).toISOString()).toBe(
      "2026-11-13T20:00:00.000Z"
    );

    // Replay of the first reviewed import stays exact and non-rewriting.
    const beforeReplay = JSON.stringify(readSqliteLedger(sqlitePath));
    const replay = await recoverReviewedSteveImport(
      root,
      content1,
      receipt1,
      assertOwnership
    );
    expect(replay.report.replay).toBe(true);
    expect(JSON.stringify(readSqliteLedger(sqlitePath))).toBe(beforeReplay);
  });

  it("rejects a tampered noon replay receipt", async () => {
    const receipt = {} as SteveImportReview;
    await expect(
      recoverReviewedSteveImport(root, content1, receipt, assertOwnership)
    ).rejects.toThrow("INVALID_IMPORT_REVIEW");
  });
});
