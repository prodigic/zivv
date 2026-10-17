import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import { importSteveContent } from "../../lib/ingestion/imports.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { runWeeklyImport } from "../../lib/ingestion/weekly-import-runner.js";
import type { WeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";
import {
  createEmptyWeeklyEditionLedger,
  markWeeklyEditionPublished,
  parseWeeklyLedger,
  prepareWeeklyEdition,
} from "../../lib/ingestion/weekly.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 15_000 });
const observedAt = Date.parse("2026-10-09T20:00:00Z");
const cutoff = Date.parse("2026-10-09T21:00:00Z");
function makeSource(
  name: string,
  options: {
    editionId?: string;
    observedAt?: number;
    deliveryId?: string;
    extraRows?: string[];
  } = {}
) {
  const editionId = options.editionId ?? "2026-10-09";
  const issueDate = new Date(editionId + "T12:00:00Z").toLocaleDateString(
    "en-US",
    { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }
  );
  return {
    editionId,
    deliveryId: options.deliveryId ?? name,
    importObservedAtEpochMs: options.observedAt ?? observedAt,
    raw: Buffer.from(
      [
        "THE LIST",
        `funk-punk-thrash-ska Upcoming shows of Interest ${issueDate}`,
        `oct 23 fri ${name} at Test Room, Oakland a/a $20 8pm`,
        ...(options.extraRows ?? []),
        "Please feel free to forward The List on to your friends.",
        "",
      ].join("\n")
    ),
  };
}

describe("weekly edition freeze recovery", () => {
  let directory: string;
  let root: string;
  let home: string;
  let sqlitePath: string;
  let weeklyPath: string;
  const source = makeSource("Initial Band");
  function catalogDigest(): string {
    return ledgerDigest(readSqliteLedger(sqlitePath));
  }
  function weekly() {
    return parseWeeklyLedger(JSON.parse(readFileSync(weeklyPath, "utf8")));
  }
  function journalStates(): WeeklyRunState[] {
    const db = new DatabaseSync(join(home, "weekly-runs.sqlite"), {
      readOnly: true,
    });
    try {
      return db
        .prepare("SELECT payload FROM run_state")
        .all()
        .map((row) => JSON.parse(String(row.payload)) as WeeklyRunState);
    } finally {
      db.close();
    }
  }
  function stage(state: WeeklyRunState, name: "load" | "freeze") {
    const value = state.stages.find((item) => item.stage === name);
    if (!value) throw new Error("Missing fixture stage");
    return value;
  }
  function currentState(runId?: string): WeeklyRunState {
    const state = journalStates().find(
      (value) => !runId || value.runId === runId
    );
    if (!state) throw new Error("Missing fixture run");
    return state;
  }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "zivv-weekly-freeze-"));
    root = join(directory, "checkout");
    home = join(directory, "operator");
    sqlitePath = join(home, "ledger.sqlite");
    weeklyPath = join(root, "data/ingestion/weekly-editions.json");
    vi.stubEnv("ZIVV_LEDGER_HOME", home);
    mkdirSync(join(root, "data/ingestion"), { recursive: true });
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
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
    // SQLite/filesystem work completes synchronously through promise microtasks.
    // Yield between cases so Vitest can receive its worker-report RPC replies.
    await setImmediate();
  });

  it("freezes the fifth stage and reuses its exact membership and cutoff on resume", async () => {
    const frozen = await runWeeklyImport({
      root,
      source,
      stopAfter: "freeze",
      freezeCutoffEpochMs: cutoff,
    });
    expect(frozen.stages.slice(0, 5).map((item) => item.status)).toEqual(
      Array(5).fill("succeeded")
    );
    expect(
      frozen.stages.slice(5).every((item) => item.status === "pending")
    ).toBe(true);
    const edition = weekly().editions[0];
    expect(edition).toMatchObject({
      editionId: source.editionId,
      endEpochMs: cutoff,
      status: "draft",
      eventIds: [readSqliteLedger(sqlitePath).events[0].id],
    });
    expect(stage(frozen, "freeze").evidence).toMatchObject({
      mode: "initial",
      editionId: source.editionId,
      cutoffEpochMs: cutoff,
      preCutoffPendingCount: 0,
      ledgerRevision: catalogDigest(),
    });
    const bytes = readFileSync(weeklyPath);
    const digest = catalogDigest();
    expect(
      await runWeeklyImport({ root, runId: frozen.runId, stopAfter: "freeze" })
    ).toEqual(frozen);
    expect(readFileSync(weeklyPath)).toEqual(bytes);
    expect(catalogDigest()).toBe(digest);
  });

  it("blocks on a pending earlier production batch and retries after that batch loads", async () => {
    const earlier = await runWeeklyImport({
      root,
      source: makeSource("Earlier Band", {
        observedAt: observedAt - 3_600_000,
      }),
      stopAfter: "acquire",
    });
    await expect(
      runWeeklyImport({
        root,
        source,
        stopAfter: "freeze",
        freezeCutoffEpochMs: cutoff,
      })
    ).rejects.toThrow("PENDING_PRE_CUTOFF_IMPORTS");
    const blocked = journalStates().find(
      (state) => state.runId !== earlier.runId
    )!;
    expect(stage(blocked, "load").status).toBe("succeeded");
    expect(stage(blocked, "freeze").errorCode).toBe(
      "PENDING_PRE_CUTOFF_IMPORTS"
    );
    expect(existsSync(weeklyPath)).toBe(false);
    await runWeeklyImport({ root, runId: earlier.runId });
    const frozen = await runWeeklyImport({
      root,
      runId: blocked.runId,
      stopAfter: "freeze",
      freezeCutoffEpochMs: cutoff,
    });
    expect(stage(frozen, "freeze")).toMatchObject({
      status: "succeeded",
      attempt: 2,
    });
    expect(weekly().editions[0].eventIds).toHaveLength(2);
  });

  it("refuses a future cutoff and accepts a subsequent valid cutoff", async () => {
    const loaded = await runWeeklyImport({ root, source });
    await expect(
      runWeeklyImport({
        root,
        runId: loaded.runId,
        stopAfter: "freeze",
        freezeCutoffEpochMs: Date.now() + 60_000,
      })
    ).rejects.toThrow("INVALID_RUN_INPUT");
    expect(existsSync(weeklyPath)).toBe(false);
    const frozen = await runWeeklyImport({
      root,
      runId: loaded.runId,
      stopAfter: "freeze",
      freezeCutoffEpochMs: cutoff,
    });
    expect(stage(frozen, "freeze").status).toBe("succeeded");
    expect(weekly().editions[0].endEpochMs).toBe(cutoff);
  });

  it("requires a cutoff for the first freeze intent but permits saved-intent recovery", async () => {
    const loaded = await runWeeklyImport({ root, source });
    await expect(
      runWeeklyImport({ root, runId: loaded.runId, stopAfter: "freeze" })
    ).rejects.toThrow("FREEZE_CUTOFF_REQUIRED");
    expect(existsSync(weeklyPath)).toBe(false);
    const frozen = await runWeeklyImport({
      root,
      runId: loaded.runId,
      stopAfter: "freeze",
      freezeCutoffEpochMs: cutoff,
    });
    expect(stage(frozen, "freeze").status).toBe("succeeded");
  });

  it.each(["artifact-saved", "effect-committed"] as const)(
    "recovers an interrupted freeze at %s with the original saved cutoff",
    async (phase: "artifact-saved" | "effect-committed") => {
      const interruption = new Error("fixture freeze interruption");
      await expect(
        runWeeklyImport({
          root,
          source,
          stopAfter: "freeze",
          freezeCutoffEpochMs: cutoff,
          onProgress: async (event) => {
            if (event.stage === "freeze" && event.phase === phase)
              throw interruption;
          },
        })
      ).rejects.toBe(interruption);
      const interrupted = currentState();
      expect(stage(interrupted, "freeze")).toMatchObject({
        status: "running",
        attempt: 1,
      });
      expect(existsSync(weeklyPath)).toBe(phase === "effect-committed");
      const digest = catalogDigest();
      const frozen = await runWeeklyImport({
        root,
        runId: interrupted.runId,
        stopAfter: "freeze",
      });
      expect(stage(frozen, "freeze")).toMatchObject({
        status: "succeeded",
        attempt: 1,
      });
      expect(weekly().editions[0]).toMatchObject({
        endEpochMs: cutoff,
        eventIds: [readSqliteLedger(sqlitePath).events[0].id],
      });
      expect(catalogDigest()).toBe(digest);
    }
  );

  it("refuses a changed cutoff on a frozen run without changing its file or journal", async () => {
    const frozen = await runWeeklyImport({
      root,
      source,
      stopAfter: "freeze",
      freezeCutoffEpochMs: cutoff,
    });
    const bytes = readFileSync(weeklyPath);
    await expect(
      runWeeklyImport({
        root,
        runId: frozen.runId,
        stopAfter: "freeze",
        freezeCutoffEpochMs: cutoff + 60_000,
      })
    ).rejects.toThrow("FREEZE_CUTOFF_CHANGED");
    expect(readFileSync(weeklyPath)).toEqual(bytes);
    expect(currentState(frozen.runId)).toEqual(frozen);
  });

  it("does not overwrite changed weekly bytes in the intent-to-write recovery gap", async () => {
    const interruption = new Error("fixture freeze intent interruption");
    await expect(
      runWeeklyImport({
        root,
        source,
        stopAfter: "freeze",
        freezeCutoffEpochMs: cutoff,
        onProgress: async (event) => {
          if (event.stage === "freeze" && event.phase === "artifact-saved")
            throw interruption;
        },
      })
    ).rejects.toBe(interruption);
    const interrupted = currentState();
    const other = prepareWeeklyEdition(createEmptyWeeklyEditionLedger(), [], {
      editionId: "external-edition",
      cutoffEpochMs: cutoff + 60_000,
      datasetVersion: "external",
    });
    writeFileSync(weeklyPath, canonicalJson(other.ledger));
    const bytes = readFileSync(weeklyPath);
    await expect(
      runWeeklyImport({ root, runId: interrupted.runId, stopAfter: "freeze" })
    ).rejects.toThrow("WEEKLY_STATE_CHANGED");
    expect(readFileSync(weeklyPath)).toEqual(bytes);
    expect(stage(currentState(interrupted.runId), "freeze").status).not.toBe(
      "succeeded"
    );
  });

  it("records the current capture revision after a post-load catalog advance", async () => {
    const loaded = await runWeeklyImport({ root, source });
    const loadedRevision = stage(loaded, "load").evidence?.ledgerRevision;
    await importSteveContent(
      root,
      "oct 24 2026 Later Band at Other Room, Oakland a/a 8pm\n",
      { observedAtEpochMs: cutoff + 60_000 }
    );
    const capturedRevision = catalogDigest();
    expect(capturedRevision).not.toBe(loadedRevision);
    const frozen = await runWeeklyImport({
      root,
      runId: loaded.runId,
      stopAfter: "freeze",
      freezeCutoffEpochMs: cutoff,
    });
    expect(stage(frozen, "freeze").evidence?.ledgerRevision).toBe(
      capturedRevision
    );
    expect(weekly().editions[0].eventIds).toHaveLength(1);
    expect(catalogDigest()).toBe(capturedRevision);
  });

  it("explicitly reuses correction membership and places later additions in the following edition", async () => {
    await runWeeklyImport({
      root,
      source,
      stopAfter: "freeze",
      freezeCutoffEpochMs: cutoff,
    });
    const published = markWeeklyEditionPublished(
      weekly(),
      source.editionId
    ).ledger;
    writeFileSync(weeklyPath, canonicalJson(published));
    const originalEdition = published.editions[0];
    const correction = makeSource("Initial Band", {
      deliveryId: "correction",
      observedAt: cutoff + 120_000,
      extraRows: ["oct 24 sat Correction Band at Other Room, Oakland a/a 8pm"],
    });
    const corrected = await runWeeklyImport({
      root,
      source: correction,
      stopAfter: "freeze",
      reuseFrozen: true,
    });
    expect(stage(corrected, "freeze").evidence).toMatchObject({
      mode: "correction",
      cutoffEpochMs: cutoff,
    });
    expect(weekly().editions[0]).toEqual(originalEdition);
    await importSteveContent(
      root,
      "oct 25 2026 Later Band at Other Room, Oakland a/a 8pm\n",
      { observedAtEpochMs: cutoff + 3_600_000 }
    );
    const nextCutoff = Date.parse("2026-10-13T21:00:00Z");
    const next = makeSource("Next Band", {
      editionId: "2026-10-13",
      observedAt: nextCutoff - 3_600_000,
    });
    await runWeeklyImport({
      root,
      source: next,
      stopAfter: "freeze",
      freezeCutoffEpochMs: nextCutoff,
    });
    const editions = weekly().editions;
    expect(editions[0]).toEqual(originalEdition);
    expect(editions[1]).toMatchObject({
      startEpochMs: cutoff,
      endEpochMs: nextCutoff,
      status: "draft",
    });
    expect(editions[1].eventIds).toHaveLength(3);
    expect(editions[1].eventIds).not.toContain(originalEdition.eventIds[0]);
    expect(new Set(editions[1].eventIds)).toEqual(
      new Set(
        readSqliteLedger(sqlitePath)
          .events.filter((event) => event.createdAtEpochMs >= cutoff)
          .map((event) => event.id)
      )
    );
  });

  it("refuses a saved freeze intent after clock rollback makes its cutoff future", async () => {
    const interruption = new Error("fixture saved freeze intent");
    await expect(
      runWeeklyImport({
        root,
        source,
        stopAfter: "freeze",
        freezeCutoffEpochMs: cutoff,
        onProgress: async (event) => {
          if (event.stage === "freeze" && event.phase === "artifact-saved")
            throw interruption;
        },
      })
    ).rejects.toBe(interruption);
    const interrupted = currentState();
    const digest = catalogDigest();
    const clock = vi.spyOn(Date, "now").mockReturnValue(cutoff - 60_000);
    try {
      await expect(
        runWeeklyImport({ root, runId: interrupted.runId, stopAfter: "freeze" })
      ).rejects.toThrow("INVALID_FREEZE_CUTOFF");
    } finally {
      clock.mockRestore();
    }
    expect(existsSync(weeklyPath)).toBe(false);
    expect(catalogDigest()).toBe(digest);
    expect(stage(currentState(interrupted.runId), "freeze").status).not.toBe(
      "succeeded"
    );
  });

  it("runs the actual CLI with a qualified freeze cutoff and explicit frozen correction reuse", () => {
    const script = join(process.cwd(), "scripts/run-weekly-import.js");
    const file = join(directory, "private-cli-source.txt");
    const run = (
      chosen: ReturnType<typeof makeSource>,
      extraArgs: string[]
    ) => {
      writeFileSync(file, chosen.raw);
      return spawnSync(
        process.execPath,
        [
          script,
          "--root",
          root,
          "--file",
          file,
          "--edition-id",
          chosen.editionId,
          "--delivery-id",
          chosen.deliveryId,
          "--observed-at",
          new Date(chosen.importObservedAtEpochMs).toISOString(),
          "--through",
          "freeze",
          ...extraArgs,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, ZIVV_LEDGER_HOME: home },
          encoding: "utf8",
          windowsHide: true,
          timeout: 25_000,
        }
      );
    };
    const initial = run(source, [
      "--freeze-cutoff",
      new Date(cutoff).toISOString(),
    ]);
    expect(initial.status, initial.stderr).toBe(0);
    const first: { runId: string } = JSON.parse(initial.stdout.trim());
    expect(stage(currentState(first.runId), "freeze").evidence).toMatchObject({
      mode: "initial",
      cutoffEpochMs: cutoff,
    });
    const published = markWeeklyEditionPublished(
      weekly(),
      source.editionId
    ).ledger;
    writeFileSync(weeklyPath, canonicalJson(published));
    const frozenEdition = published.editions[0];
    const correction = makeSource("Initial Band", {
      deliveryId: "cli-correction",
      observedAt: cutoff + 120_000,
      extraRows: [
        "oct 24 sat CLI Correction Band at Other Room, Oakland a/a 8pm",
      ],
    });
    const corrected = run(correction, ["--reuse-frozen", "true"]);
    expect(corrected.status, corrected.stderr).toBe(0);
    const second: { runId: string } = JSON.parse(corrected.stdout.trim());
    expect(stage(currentState(second.runId), "freeze").evidence).toMatchObject({
      mode: "correction",
      cutoffEpochMs: cutoff,
    });
    expect(weekly().editions[0]).toEqual(frozenEdition);
    expect(readSqliteLedger(sqlitePath).events).toHaveLength(2);
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(2);
    expect(
      initial.stdout + initial.stderr + corrected.stdout + corrected.stderr
    ).not.toContain("THE LIST");
    expect(initial.stdout + corrected.stdout).not.toContain(
      "Initial Band at Test Room"
    );
  });
});
