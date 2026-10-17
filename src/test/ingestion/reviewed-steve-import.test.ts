import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  importSteveContent,
  loadReviewedSteveImport,
  prepareSteveBatch,
  reviewSteveImport,
  recoverReviewedSteveImport,
  type SteveImportReview,
} from "../../lib/ingestion/imports.js";
import {
  bootstrapLedger,
  loadLedger,
  saveLedgerAtomic,
} from "../../lib/ingestion/ledger.js";
import { historicalContentHash } from "../../lib/ingestion/historical.js";
import {
  canonicalJson,
  readSqliteLedger,
  withStoreTransaction,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { normalizeLatestContent } from "../../lib/etl/latest-content.js";
import {
  parseSteveImportReview,
  parseImportObservation,
} from "../../lib/ingestion/steve-import-review.js";
import type { Event } from "../../types/events.js";

const observedAt = Date.parse("2026-10-09T20:00:00Z");
vi.setConfig({ testTimeout: 30_000, hookTimeout: 15_000 });
const content = "oct 16 2026 Reviewed Band at Test Room, Oakland a/a $20 8pm\n";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function reseal(
  receipt: SteveImportReview,
  changes: Partial<SteveImportReview>
): SteveImportReview {
  const { reviewId: _reviewId, ...value } = { ...receipt, ...changes };
  return { ...value, reviewId: hash(canonicalJson(value)) };
}

describe("reviewed Steve import", () => {
  let root: string;
  let ledgerPath: string;
  let sqlitePath: string;
  const assertOwnership = () => undefined;
  const reportsDirectory = () => join(root, "data/ingestion/reports");
  const reportPath = (runId: string) =>
    join(reportsDirectory(), `${hash(runId)}.json`);
  const ledgerBytes = () =>
    Buffer.from(canonicalJson(readSqliteLedger(sqlitePath)));

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "zivv-reviewed-steve-"));
    mkdirSync(join(root, "data/ingestion"), { recursive: true });
    ledgerPath = join(root, "data/ingestion/ledger.json");
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

  it("reviews without writing catalog or report and binds the exact receipt fields", async () => {
    const before = ledgerBytes();
    const result = await reviewSteveImport(root, content, observedAt);
    expect(ledgerBytes()).toEqual(before);
    expect(existsSync(reportsDirectory())).toBe(false);
    expect(result.report.review).toEqual([]);
    expect(result.report.conflicts).toEqual([]);
    expect(result.report.newEventIds).toHaveLength(1);
    expect(Object.keys(result.receipt).sort()).toEqual(
      [
        "schemaVersion",
        "importer",
        "inputSha256",
        "configurationSha256",
        "ledgerRevision",
        "reportSha256",
        "importRunId",
        "observedAtEpochMs",
        "reviewId",
      ].sort()
    );
    expect(result.receipt).toMatchObject({
      schemaVersion: 1,
      importer: "steveslist-v5",
      inputSha256: hash(content),
      observedAtEpochMs: observedAt,
      importRunId: result.report.runId,
      reportSha256: hash(canonicalJson(result.report)),
    });
    const { reviewId, ...identity } = result.receipt;
    expect(reviewId).toBe(hash(canonicalJson(identity)));
  });

  const legacyRunId = () =>
    `steveslist-v4-${hash(
      JSON.stringify({
        importer: "steveslist-v4",
        schema: 1,
        content: normalizeLatestContent(content),
        aliases: [],
      })
    )}`;

  it("retains historical v4 receipt hashes but refuses to load an uncommitted legacy review", async () => {
    const { receipt, report } = await reviewSteveImport(
      root,
      content,
      observedAt
    );
    const legacy = reseal(receipt, {
      importer: "steveslist-v4",
      importRunId: legacyRunId(),
      reportSha256: hash(canonicalJson({ ...report, runId: legacyRunId() })),
    });
    expect(parseSteveImportReview(legacy)).toEqual(legacy);
    const before = ledgerBytes();
    await expect(
      loadReviewedSteveImport(root, content, legacy, assertOwnership)
    ).rejects.toMatchObject({ code: "NO_COMMITTED_IMPORT" });
    expect(ledgerBytes()).toEqual(before);
    expect(existsSync(reportsDirectory())).toBe(false);
  });

  it("recovers an exact committed v4 run without creating v5 work or changing first-added history", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    await loadReviewedSteveImport(root, content, receipt, assertOwnership);
    const saved = JSON.parse(
      readFileSync(reportPath(receipt.importRunId), "utf8")
    );
    const historicalReport = { ...saved, runId: legacyRunId() };
    const ledger = await loadLedger(ledgerPath);
    // Simulate the pre-v5 durable identity on a semantically unchanged source.
    // Full ledger validation still runs on save, including provenance references.
    const historicalLedger = JSON.parse(
      JSON.stringify(ledger).replaceAll(receipt.importRunId, legacyRunId())
    );
    Object.assign(ledger, historicalLedger);
    await saveLedgerAtomic(ledgerPath, ledger);
    writeFileSync(reportPath(legacyRunId()), canonicalJson(historicalReport));
    const legacy = reseal(receipt, {
      importer: "steveslist-v4",
      importRunId: legacyRunId(),
      reportSha256: hash(canonicalJson(historicalReport)),
    });
    const before = ledgerBytes();
    const replay = await recoverReviewedSteveImport(
      root,
      content,
      legacy,
      assertOwnership
    );
    expect(replay.report.replay).toBe(true);
    expect(replay.report.runId).toBe(legacyRunId());
    expect(ledgerBytes()).toEqual(before);
    expect(replay.ledger.runs).toHaveLength(1);
    expect(replay.ledger.events[0].createdAtEpochMs).toBe(observedAt);
    expect(replay.ledger.events[0].firstImportRunId).toBe(legacyRunId());
  });

  it("rejects mixed importer/run versions even when the receipt is resealed", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    for (const mixed of [
      reseal(receipt, { importer: "steveslist-v4" }),
      reseal(receipt, { importRunId: legacyRunId() }),
    ])
      expect(() => parseSteveImportReview(mixed)).toThrow(
        "INVALID_IMPORT_REVIEW"
      );
  });

  it("reviews and loads v5 whole-show cancellations with the matching receipt identity", async () => {
    const cancelled = content.trimEnd() + " (cancelled)\n";
    const { receipt } = await reviewSteveImport(root, cancelled, observedAt);
    expect(receipt.importer).toBe("steveslist-v5");
    expect(receipt.importRunId).toMatch(/^steveslist-v5-/);
    const loaded = await loadReviewedSteveImport(
      root,
      cancelled,
      receipt,
      assertOwnership
    );
    expect(loaded.ledger.events[0].status).toBe("cancelled");
    expect(loaded.ledger.events[0].createdAtEpochMs).toBe(observedAt);
  });

  it("loads a clean review and replays despite a later ledger revision without resetting first-added dates", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    const ownership = vi.fn(assertOwnership);
    const imported = await loadReviewedSteveImport(
      root,
      content,
      receipt,
      ownership
    );
    expect(ownership.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(imported.report.replay).toBe(false);
    expect(imported.ledger.events).toHaveLength(1);
    expect(imported.ledger.events[0]).toMatchObject({
      createdAtEpochMs: observedAt,
      firstObservedAtEpochMs: observedAt,
      firstImportRunId: receipt.importRunId,
    });
    expect(imported.ledger.runs[0]).toMatchObject({
      status: "committed",
      observedAtEpochMs: observedAt,
    });
    const savedReport = readFileSync(reportPath(receipt.importRunId));
    await importSteveContent(
      root,
      "oct 17 2026 Later Band at Test Room, Oakland a/a 7pm\n",
      { observedAtEpochMs: observedAt + 86_400_000 }
    );
    const beforeReplay = ledgerBytes();
    const replay = await loadReviewedSteveImport(
      root,
      content,
      receipt,
      assertOwnership
    );
    expect(replay.report.replay).toBe(true);
    expect(replay.ledger.events).toHaveLength(2);
    expect(
      replay.ledger.events.find(
        (event) => event.firstImportRunId === receipt.importRunId
      )?.createdAtEpochMs
    ).toBe(observedAt);
    expect(ledgerBytes()).toEqual(beforeReplay);
    expect(readFileSync(reportPath(receipt.importRunId))).toEqual(savedReport);
  });

  it("rejects changed raw input without writing", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    const before = ledgerBytes();
    await expect(
      loadReviewedSteveImport(root, content + "\n", receipt, assertOwnership)
    ).rejects.toMatchObject({ code: "IMPORT_INPUT_CHANGED" });
    expect(ledgerBytes()).toEqual(before);
    expect(existsSync(reportsDirectory())).toBe(false);
  });

  it("rejects changed importer configuration without writing", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    writeFileSync(
      join(root, "data/venue-aliases.json"),
      JSON.stringify({ "test room": "Different Room" })
    );
    const before = ledgerBytes();
    await expect(
      loadReviewedSteveImport(root, content, receipt, assertOwnership)
    ).rejects.toMatchObject({ code: "IMPORT_CONFIGURATION_CHANGED" });
    expect(ledgerBytes()).toEqual(before);
  });

  it("rejects an intervening ledger import before the reviewed run commits", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    await importSteveContent(
      root,
      "oct 17 2026 Other Band at Other Room, Oakland a/a 8pm\n",
      { observedAtEpochMs: observedAt + 1 }
    );
    const before = ledgerBytes();
    await expect(
      loadReviewedSteveImport(root, content, receipt, assertOwnership)
    ).rejects.toMatchObject({ code: "IMPORT_LEDGER_CHANGED" });
    expect(ledgerBytes()).toEqual(before);
    expect(existsSync(reportPath(receipt.importRunId))).toBe(false);
  });

  it("rejects a changed report digest even with an internally consistent review identity", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    const changed = reseal(receipt, { reportSha256: "f".repeat(64) });
    const before = ledgerBytes();
    await expect(
      loadReviewedSteveImport(root, content, changed, assertOwnership)
    ).rejects.toMatchObject({ code: "IMPORT_REPORT_CHANGED" });
    expect(ledgerBytes()).toEqual(before);
  });

  it("rejects receipt field tampering and extra fields", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    const before = ledgerBytes();
    for (const changed of [
      { ...receipt, reviewId: "f".repeat(64) },
      { ...receipt, observedAtEpochMs: observedAt + 1 },
      { ...receipt, unexpected: true },
    ]) {
      await expect(
        loadReviewedSteveImport(root, content, changed, assertOwnership)
      ).rejects.toMatchObject({ code: "INVALID_IMPORT_REVIEW" });
    }
    expect(ledgerBytes()).toEqual(before);
  });

  it("rejects a replay receipt with a different original observation", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    await loadReviewedSteveImport(root, content, receipt, assertOwnership);
    const before = ledgerBytes();
    await expect(
      loadReviewedSteveImport(
        root,
        content,
        reseal(receipt, { observedAtEpochMs: observedAt + 1 }),
        assertOwnership
      )
    ).rejects.toMatchObject({ code: "IMPORT_OBSERVATION_CHANGED" });
    expect(ledgerBytes()).toEqual(before);
  });

  it("refuses replay evidence for a run that has not durably committed", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    await loadReviewedSteveImport(root, content, receipt, assertOwnership);
    const ledger = await loadLedger(ledgerPath);
    ledger.runs[0].status = "reconciled";
    ledger.runs[0].committedAtEpochMs = null;
    await saveLedgerAtomic(ledgerPath, ledger);
    const before = ledgerBytes();
    await expect(
      loadReviewedSteveImport(root, content, receipt, assertOwnership)
    ).rejects.toMatchObject({ code: "IMPORT_REPORT_CHANGED" });
    expect(ledgerBytes()).toEqual(before);
  });

  it("rechecks importer configuration before the durable write", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    const before = ledgerBytes();
    await expect(
      loadReviewedSteveImport(root, content, receipt, () => {
        writeFileSync(join(root, "data/line-corrections.json"), "[]\n");
      })
    ).rejects.toMatchObject({ code: "IMPORT_CONFIGURATION_CHANGED" });
    expect(ledgerBytes()).toEqual(before);
    expect(existsSync(reportsDirectory())).toBe(false);
  });

  it("rolls back configuration mutation in the third ownership callback after the save", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    const before = ledgerBytes();
    let calls = 0;
    await expect(
      loadReviewedSteveImport(root, content, receipt, () => {
        calls += 1;
        if (calls === 3)
          writeFileSync(
            join(root, "data/venue-aliases.json"),
            JSON.stringify({ "test room": "Changed Room" })
          );
      })
    ).rejects.toMatchObject({ code: "IMPORT_CONFIGURATION_CHANGED" });
    expect(calls).toBe(3);
    expect(ledgerBytes()).toEqual(before);
    expect(readSqliteLedger(sqlitePath).runs).toEqual([]);
  });

  it("accepts a formatting heuristic for the exact known canonical U2 artist", async () => {
    const source = "oct 16 2026 U2 at Test Room, Oakland a/a $20 8pm\n";
    const batch = prepareSteveBatch(
      await loadLedger(ledgerPath),
      source,
      observedAt
    );
    await withStoreTransaction(sqlitePath, async () =>
      saveLedgerAtomic(
        ledgerPath,
        bootstrapLedger(
          { events: [], artists: batch.artists, venues: batch.venues },
          1_000
        )
      )
    );
    const { receipt, report } = await reviewSteveImport(
      root,
      source,
      observedAt
    );
    expect(report.review).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.newEventIds).toHaveLength(1);
    const loaded = await loadReviewedSteveImport(
      root,
      source,
      receipt,
      assertOwnership
    );
    expect(loaded.ledger.events).toHaveLength(1);
    expect(
      loaded.ledger.artists.filter((artist) => artist.name === "U2")
    ).toHaveLength(1);
    expect(loaded.ledger.events[0].headlinerArtistId).toBe(batch.artists[0].id);
  });

  it("requires core reconciliation for an unknown U2 formatting heuristic", async () => {
    const before = ledgerBytes();
    await expect(
      reviewSteveImport(
        root,
        "oct 16 2026 U2 at Test Room, Oakland a/a $20 8pm\n",
        observedAt
      )
    ).rejects.toMatchObject({ code: "CORE_RECONCILIATION_REQUIRED" });
    expect(ledgerBytes()).toEqual(before);
    expect(existsSync(reportsDirectory())).toBe(false);
  });

  it("replays a reviewed U2 import after the catalog renames the canonical artist", async () => {
    const source = "oct 16 2026 U2 at Test Room, Oakland a/a $20 8pm\n";
    const batch = prepareSteveBatch(
      await loadLedger(ledgerPath),
      source,
      observedAt
    );
    await withStoreTransaction(sqlitePath, async () =>
      saveLedgerAtomic(
        ledgerPath,
        bootstrapLedger(
          { events: [], artists: batch.artists, venues: batch.venues },
          1_000
        )
      )
    );
    const { receipt } = await reviewSteveImport(root, source, observedAt);
    await loadReviewedSteveImport(root, source, receipt, assertOwnership);
    const advanced = await loadLedger(ledgerPath);
    const artistId = advanced.artists[0].id;
    advanced.artists[0].name = "Renamed Artist";
    advanced.artists[0].normalizedName = "renamed artist";
    advanced.artists[0].slug = "renamed-artist";
    await saveLedgerAtomic(ledgerPath, advanced);
    const before = ledgerBytes();
    await expect(
      reviewSteveImport(root, source, observedAt)
    ).rejects.toMatchObject({ code: "CORE_RECONCILIATION_REQUIRED" });
    const replay = await loadReviewedSteveImport(
      root,
      source,
      receipt,
      assertOwnership
    );
    expect(replay.report.replay).toBe(true);
    expect(replay.ledger.events).toHaveLength(1);
    expect(replay.ledger.events[0]).toMatchObject({
      headlinerArtistId: artistId,
      createdAtEpochMs: observedAt,
      firstObservedAtEpochMs: observedAt,
    });
    expect(replay.ledger.artists[0]).toMatchObject({
      id: artistId,
      name: "Renamed Artist",
      normalizedName: "renamed artist",
      slug: "renamed-artist",
    });
    expect(ledgerBytes()).toEqual(before);
  });

  it.each(["missing", "tampered"])(
    "rejects a committed replay with %s saved report evidence",
    async (mode: string) => {
      const { receipt } = await reviewSteveImport(root, content, observedAt);
      await loadReviewedSteveImport(root, content, receipt, assertOwnership);
      const path = reportPath(receipt.importRunId);
      if (mode === "missing") rmSync(path);
      else {
        const report: Record<string, unknown> = JSON.parse(
          readFileSync(path, "utf8")
        );
        writeFileSync(
          path,
          JSON.stringify({ ...report, newEventIds: [999999] })
        );
      }
      const before = ledgerBytes();
      await expect(
        loadReviewedSteveImport(root, content, receipt, assertOwnership)
      ).rejects.toMatchObject({ code: "IMPORT_REPORT_CHANGED" });
      expect(ledgerBytes()).toEqual(before);
    }
  );

  it("refuses an entire mixed accepted/review batch without mutating catalog or reports", async () => {
    const empty = await loadLedger(ledgerPath);
    const batch = prepareSteveBatch(
      empty,
      "oct 16 2026 Ambiguous Band at Test Room, Oakland a/a 6pm\n",
      observedAt - 1_000
    );
    const event = batch.events[0];
    const first = "event" in event ? event.event : event;
    const lateTime = Date.parse("2026-10-17T04:00:00Z");
    const second: Event = {
      ...first,
      id: (Number(first.id) + 1) as Event["id"],
      slug: first.slug + "-late",
      startTimeEpochMs: lateTime,
      startTime: new Date(lateTime).toISOString(),
    };
    await withStoreTransaction(sqlitePath, async () =>
      saveLedgerAtomic(
        ledgerPath,
        bootstrapLedger(
          {
            events: [first, second],
            artists: batch.artists,
            venues: batch.venues,
          },
          observedAt - 1_000
        )
      )
    );
    const mixed =
      "oct 16 2026 Ambiguous Band at Test Room, Oakland a/a\noct 17 2026 Fresh Band at Other Room, Oakland a/a 8pm\n";
    const manual = await importSteveContent(root, mixed, {
      observedAtEpochMs: observedAt,
      dryRun: true,
    });
    expect(manual.report.newEventIds).toHaveLength(1);
    expect(manual.report.review).toMatchObject([{ reason: "ambiguous-match" }]);
    const before = ledgerBytes();
    await expect(
      reviewSteveImport(root, mixed, observedAt)
    ).rejects.toMatchObject({ code: "CORE_RECONCILIATION_REQUIRED" });
    expect(ledgerBytes()).toEqual(before);
    expect(existsSync(reportsDirectory())).toBe(false);
  });

  it("refuses a historical batch without importing it as a fresh weekly source", async () => {
    const migrationIdentitySha256 = hash(JSON.stringify([]));
    writeFileSync(
      join(root, "data/ingestion/migration.json"),
      JSON.stringify({
        priorDatasetVersion: "historical",
        preservedIdentityAndAddedDateSha256: migrationIdentitySha256,
        events: 0,
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
            datasetVersion: "historical",
            processedAtEpochMs: observedAt - 1_000,
            migrationIdentitySha256,
            recordedAtEpochMs: observedAt,
          },
        ],
      })
    );
    const before = ledgerBytes();
    await expect(
      reviewSteveImport(root, content, observedAt)
    ).rejects.toMatchObject({ code: "HISTORICAL_IMPORT_NOT_ALLOWED" });
    expect(ledgerBytes()).toEqual(before);
  });

  it("rejects normalization that drops one source bill at the same date and time", async () => {
    const mixed =
      "oct 16 2026 Foo at Test Room, Oakland a/a 8pm\noct 16 2026 Foo, Bar at Test Room, Oakland a/a 8pm\n";
    const before = ledgerBytes();
    await expect(
      reviewSteveImport(root, mixed, observedAt)
    ).rejects.toMatchObject({ code: "CORE_RECONCILIATION_REQUIRED" });
    expect(ledgerBytes()).toEqual(before);
    expect(existsSync(reportsDirectory())).toBe(false);
  });

  it("propagates lease failure before writing the report or catalog", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    const before = ledgerBytes();
    const failure = new Error("lease lost before import");
    await expect(
      loadReviewedSteveImport(root, content, receipt, () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(ledgerBytes()).toEqual(before);
    expect(existsSync(reportsDirectory())).toBe(false);
  });

  it("checks lease ownership after the durable ledger save before returning", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    const before = ledgerBytes();
    const failure = new Error("lease lost after durable save");
    let checkedAfterSave = false;
    await expect(
      loadReviewedSteveImport(root, content, receipt, () => {
        const ledger: { runs: { runId: string; status: string }[] } =
          JSON.parse(ledgerBytes().toString());
        if (
          ledger.runs.some(
            (run) =>
              run.runId === receipt.importRunId && run.status === "committed"
          )
        ) {
          checkedAfterSave = true;
          throw failure;
        }
      })
    ).rejects.toBe(failure);
    expect(checkedAfterSave).toBe(true);
    expect(ledgerBytes()).toEqual(before);
    expect(readSqliteLedger(sqlitePath).runs).toEqual([]);
  });

  it("requires SQLite for reviewed operations while preserving legacy manual import", async () => {
    const { receipt } = await reviewSteveImport(root, content, observedAt);
    rmSync(join(root, "data/ingestion/store.json"));
    await saveLedgerAtomic(
      ledgerPath,
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1_000)
    );
    const before = readFileSync(ledgerPath);
    await expect(
      reviewSteveImport(root, content, observedAt)
    ).rejects.toMatchObject({ code: "SHARED_SQLITE_REQUIRED" });
    await expect(
      loadReviewedSteveImport(root, content, receipt, assertOwnership)
    ).rejects.toMatchObject({ code: "SHARED_SQLITE_REQUIRED" });
    expect(readFileSync(ledgerPath)).toEqual(before);
    const manual = await importSteveContent(root, content, {
      observedAtEpochMs: observedAt,
    });
    expect(manual.report.newEventIds).toHaveLength(1);
    expect(manual.ledger.runs[0].status).toBe("committed");
    expect(readSqliteLedger(sqlitePath).runs).toEqual([]);
  });

  it("runs the actual CLI review, load and replay lifecycle and refuses artifact or edition tampering", () => {
    const raw = [
      "THE LIST",
      "funk-punk-thrash-ska Upcoming shows of Interest October 9, 2026",
      "oct 16 fri Reviewed Band at Test Room, Oakland a/a $20 8pm",
      "oct 16 fri Reviewed Band at Test Room, Oakland a/a $20 8pm",
      "oct 10 sat Volunteer Orientation at Test Room, Oakland a/a 8pm",
      "Please feel free to forward The List on to your friends.",
      "",
    ].join("\n");
    const rawPath = join(root, "source.txt");
    writeFileSync(rawPath, raw);
    const outputDirectory = join(root, "operator", "reviews");
    const script = join(process.cwd(), "scripts/review-weekly-import.js");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: process.cwd(),
        env: { ...process.env, ZIVV_LEDGER_HOME: join(root, "operator") },
        windowsHide: true,
        encoding: "utf8",
        timeout: 25_000,
      });
    const reviewArgs = (editionId: string) => [
      "review",
      "--root",
      root,
      "--file",
      rawPath,
      "--output-dir",
      outputDirectory,
      "--edition-id",
      editionId,
      "--delivery-id",
      "fixture",
      "--observed-at",
      "2026-10-09T20:00:00Z",
    ];
    const before = ledgerBytes();
    const reviewed = run(reviewArgs("2026-10-09"));
    expect(reviewed.status, reviewed.stderr).toBe(0);
    const review: {
      reviewId: string;
      directory: string;
      importRunId: string;
      counts: {
        rows: number;
        accepted: number;
        programming: number;
        duplicates: number;
        invalid: number;
      };
    } = JSON.parse(reviewed.stdout.trim());
    expect(review.counts).toEqual({
      rows: 3,
      accepted: 1,
      programming: 1,
      duplicates: 1,
      invalid: 0,
    });
    expect(ledgerBytes()).toEqual(before);
    expect(readFileSync(join(review.directory, "raw.txt"), "utf8")).toBe(raw);
    const loadArgs = [
      "load",
      "--root",
      root,
      "--directory",
      review.directory,
      "--review-id",
      review.reviewId,
    ];
    const loaded = run(loadArgs);
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(JSON.parse(loaded.stdout.trim())).toMatchObject({
      reviewId: review.reviewId,
      replay: false,
      importRunId: review.importRunId,
      accepted: 1,
    });
    const committed = ledgerBytes();
    expect(readSqliteLedger(sqlitePath).events[0].createdAtEpochMs).toBe(
      observedAt
    );
    const replay = run(loadArgs);
    expect(replay.status, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout.trim())).toMatchObject({
      replay: true,
      importRunId: review.importRunId,
      accepted: 1,
    });
    expect(ledgerBytes()).toEqual(committed);
    writeFileSync(
      join(review.directory, "prepared.txt"),
      "tampered prepared content\n"
    );
    const tampered = run(loadArgs);
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain("Review artifact changed");
    expect(ledgerBytes()).toEqual(committed);
    const mismatchedEdition = run(reviewArgs("2026-10-16"));
    expect(mismatchedEdition.status).not.toBe(0);
    expect(mismatchedEdition.stderr).toContain(
      "Source issue does not match requested edition"
    );
    expect(ledgerBytes()).toEqual(committed);
  });
});

describe("reviewed import observation parsing", () => {
  it.each([
    { value: "2026-02-30T19:00:00Z", valid: false },
    { value: "2026-10-09", valid: false },
    { value: "2026-10-09T20:00:00", valid: false },
    { value: "2026-10-09T20:00:00Z", valid: true },
    { value: "2026-10-09T13:00:00-07:00", valid: true },
  ])(
    "validates explicit timezone and calendar for $value",
    ({ value, valid }: { value: string; valid: boolean }) => {
      if (valid) expect(parseImportObservation(value)).toBe(observedAt);
      else
        expect(() => parseImportObservation(value)).toThrow(
          "INVALID_IMPORT_OBSERVATION"
        );
    }
  );
});
