import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import {
  bootstrapLedger,
  loadLedger,
  saveLedgerAtomic,
} from "../../lib/ingestion/ledger.js";
import { prepareSteveBatch } from "../../lib/ingestion/imports.js";
import {
  canonicalJson,
  readSqliteLedger,
  writeSqliteLedger,
  withStoreTransaction,
} from "../../lib/ingestion/sqlite-store.js";
import { runWeeklyImport } from "../../lib/ingestion/weekly-import-runner.js";
import type { WeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";
import {
  createEmptyWeeklyEditionLedger,
  markWeeklyEditionPublished,
  prepareWeeklyEdition,
} from "../../lib/ingestion/weekly.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 15_000 });
const importObservedAtEpochMs = Date.parse("2026-10-09T20:00:00Z");
const source = {
  editionId: "2026-10-09",
  deliveryId: "runner-fixture",
  importObservedAtEpochMs,
  raw: Buffer.from(
    [
      "THE LIST",
      "funk-punk-thrash-ska Upcoming shows of Interest October 9, 2026",
      "oct 16 fri Fixture Band at Test Room, Oakland a/a $20 8pm",
      "oct 16 fri Fixture Band at Test Room, Oakland a/a $20 8pm",
      "oct 10 sat Volunteer Orientation at Test Room, Oakland a/a 8pm",
      "Please feel free to forward The List on to your friends.",
      "",
    ].join("\n")
  ),
};

describe("weekly import runner recovery", () => {
  let directory: string;
  let root: string;
  let home: string;
  let sqlitePath: string;
  function catalogDigest(): string {
    return createHash("sha256")
      .update(canonicalJson(readSqliteLedger(sqlitePath)))
      .digest("hex");
  }
  function journalState(): WeeklyRunState {
    const db = new DatabaseSync(join(home, "weekly-runs.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db.prepare("SELECT payload FROM run_state").get();
      if (!row) throw new Error("Fixture run was not persisted");
      return JSON.parse(String(row.payload)) as WeeklyRunState;
    } finally {
      db.close();
    }
  }
  function artifact(
    runId: string,
    name: string,
    attempt: number
  ): Buffer | null {
    const db = new DatabaseSync(join(home, "weekly-runs.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare(
          "SELECT bytes FROM stage_artifact WHERE run_id=? AND stage=? AND attempt=?"
        )
        .get(runId, name, attempt);
      return row ? Buffer.from(row.bytes as Uint8Array) : null;
    } finally {
      db.close();
    }
  }
  function stage(
    state: WeeklyRunState,
    name: "acquire" | "prepare" | "reconcile" | "load"
  ) {
    const value = state.stages.find((item) => item.stage === name);
    if (!value) throw new Error("Missing fixture stage");
    return value;
  }
  function freezeWeeklyCutoff(status: "draft" | "published"): void {
    const frozen = prepareWeeklyEdition(
      createEmptyWeeklyEditionLedger(),
      readSqliteLedger(sqlitePath).events.map((event) => ({
        id: event.id,
        createdAtEpochMs: event.createdAtEpochMs,
        addedDateProvenance: event.addedDateProvenance,
      })),
      {
        editionId: "2026-10-09",
        cutoffEpochMs: importObservedAtEpochMs + 3_600_000,
        datasetVersion: "fixture-frozen",
      }
    );
    const ledger =
      status === "published"
        ? markWeeklyEditionPublished(frozen.ledger, frozen.edition.editionId)
            .ledger
        : frozen.ledger;
    writeFileSync(
      join(root, "data/ingestion/weekly-editions.json"),
      canonicalJson(ledger)
    );
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "zivv-weekly-runner-"));
    root = join(directory, "checkout");
    home = join(directory, "operator");
    sqlitePath = join(home, "ledger.sqlite");
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
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("executes only the four import stages and retains the original observation", async () => {
    const state = await runWeeklyImport({ root, source });
    expect(state.stages.slice(0, 4).map((item) => item.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(
      state.stages.slice(4).every((item) => item.status === "pending")
    ).toBe(true);
    const catalog = readSqliteLedger(sqlitePath);
    expect(catalog.events).toHaveLength(1);
    expect(catalog.runs).toHaveLength(1);
    expect(catalog.runs[0]).toMatchObject({
      status: "committed",
      observedAtEpochMs: importObservedAtEpochMs,
    });
    expect(catalog.events[0]).toMatchObject({
      createdAtEpochMs: importObservedAtEpochMs,
      firstObservedAtEpochMs: importObservedAtEpochMs,
    });
    expect(journalState()).toEqual(state);
    const beforeReplay = catalogDigest();
    expect(await runWeeklyImport({ root, runId: state.runId })).toEqual(state);
    expect(catalogDigest()).toBe(beforeReplay);
  });

  it("stops after reconciliation without importing and resumes using persisted source bytes", async () => {
    const before = catalogDigest();
    const reviewed = await runWeeklyImport({
      root,
      source,
      stopAfter: "reconcile",
    });
    expect(reviewed.stages.slice(0, 3).map((item) => item.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(stage(reviewed, "load").status).toBe("pending");
    expect(catalogDigest()).toBe(before);
    const complete = await runWeeklyImport({ root, runId: reviewed.runId });
    expect(stage(complete, "load").status).toBe("succeeded");
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
  });

  it.each(["acquire", "prepare"] as const)(
    "recovers an interrupted %s stage from its saved artifact without another attempt",
    async (name: "acquire" | "prepare") => {
      const before = catalogDigest();
      const interruption = new Error(
        "fixture interruption after saved artifact"
      );
      await expect(
        runWeeklyImport({
          root,
          source,
          onProgress: async (event) => {
            if (event.stage === name && event.phase === "artifact-saved")
              throw interruption;
          },
        })
      ).rejects.toBe(interruption);
      const interrupted = journalState();
      expect(stage(interrupted, name)).toMatchObject({
        status: "running",
        attempt: 1,
      });
      const savedArtifact = artifact(interrupted.runId, name, 1);
      expect(savedArtifact).not.toBeNull();
      expect(artifact(interrupted.runId, "acquire", 0)).toEqual(source.raw);
      expect(catalogDigest()).toBe(before);
      const resumed = await runWeeklyImport({
        root,
        runId: interrupted.runId,
        stopAfter: "reconcile",
      });
      expect(stage(resumed, name)).toMatchObject({
        status: "succeeded",
        attempt: 1,
      });
      expect(artifact(resumed.runId, name, 1)).toEqual(savedArtifact);
      expect(catalogDigest()).toBe(before);
    }
  );

  it("recovers a committed catalog load before the journal artifact was saved without duplicating events", async () => {
    const interruption = new Error("fixture interruption after catalog commit");
    await expect(
      runWeeklyImport({
        root,
        source,
        onProgress: async (event) => {
          if (event.stage === "load" && event.phase === "effect-committed")
            throw interruption;
        },
      })
    ).rejects.toBe(interruption);
    const interrupted = journalState();
    expect(stage(interrupted, "load")).toMatchObject({
      status: "running",
      attempt: 1,
    });
    expect(artifact(interrupted.runId, "load", 1)).toBeNull();
    const committed = readSqliteLedger(sqlitePath);
    expect(committed.runs).toHaveLength(1);
    expect(committed.runs[0].status).toBe("committed");
    const before = catalogDigest();
    const resumed = await runWeeklyImport({ root, runId: interrupted.runId });
    expect(stage(resumed, "load")).toMatchObject({
      status: "succeeded",
      attempt: 1,
    });
    expect(artifact(resumed.runId, "load", 1)).not.toBeNull();
    expect(catalogDigest()).toBe(before);
    expect(readSqliteLedger(sqlitePath).events).toHaveLength(1);
    expect(readSqliteLedger(sqlitePath).events[0].createdAtEpochMs).toBe(
      importObservedAtEpochMs
    );
  });

  it("marks an interrupted uncommitted load failed before a later explicit retry", async () => {
    const before = catalogDigest();
    const interruption = new Error("fixture interruption before catalog load");
    await expect(
      runWeeklyImport({
        root,
        source,
        onProgress: async (event) => {
          if (event.stage === "load" && event.phase === "started")
            throw interruption;
        },
      })
    ).rejects.toBe(interruption);
    const interrupted = journalState();
    expect(stage(interrupted, "load")).toMatchObject({
      status: "running",
      attempt: 1,
    });
    await expect(
      runWeeklyImport({ root, runId: interrupted.runId })
    ).rejects.toThrow("NO_COMMITTED_IMPORT");
    expect(stage(journalState(), "load")).toMatchObject({
      status: "failed",
      attempt: 1,
      errorCode: "NO_COMMITTED_IMPORT",
    });
    expect(catalogDigest()).toBe(before);
    const retried = await runWeeklyImport({ root, runId: interrupted.runId });
    expect(stage(retried, "load")).toMatchObject({
      status: "succeeded",
      attempt: 2,
    });
    expect(readSqliteLedger(sqlitePath).events).toHaveLength(1);
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
  });

  it("rejects changed import configuration before resuming a reviewed load", async () => {
    const reviewed = await runWeeklyImport({
      root,
      source,
      stopAfter: "reconcile",
    });
    const before = catalogDigest();
    writeFileSync(
      join(root, "data/venue-aliases.json"),
      JSON.stringify({ "test room": "Changed Room" })
    );
    await expect(
      runWeeklyImport({ root, runId: reviewed.runId })
    ).rejects.toThrow("RUN_CONTEXT_CHANGED");
    expect(catalogDigest()).toBe(before);
    expect(stage(journalState(), "load").status).toBe("pending");
  });

  it.each([
    { change: "raw", error: "SOURCE_DELIVERY_CHANGED" },
    { change: "observation", error: "IMPORT_OBSERVATION_CHANGED" },
  ])(
    "rejects changed original $change for an existing delivery",
    async ({ change, error }: { change: string; error: string }) => {
      const initial = await runWeeklyImport({
        root,
        source,
        stopAfter: "acquire",
      });
      const before = catalogDigest();
      const changed =
        change === "raw"
          ? {
              ...source,
              raw: Buffer.concat([source.raw, Buffer.from("changed source\n")]),
            }
          : { ...source, importObservedAtEpochMs: importObservedAtEpochMs + 1 };
      await expect(runWeeklyImport({ root, source: changed })).rejects.toThrow(
        error
      );
      expect(catalogDigest()).toBe(before);
      expect(journalState()).toEqual(initial);
    }
  );

  it("refuses changed persisted acquisition bytes before another stage executes", async () => {
    const initial = await runWeeklyImport({
      root,
      source,
      stopAfter: "acquire",
    });
    const before = catalogDigest();
    const db = new DatabaseSync(join(home, "weekly-runs.sqlite"));
    try {
      db.prepare(
        "UPDATE stage_artifact SET bytes=? WHERE run_id=? AND stage='acquire' AND attempt=0"
      ).run(Buffer.from("tampered source"), initial.runId);
    } finally {
      db.close();
    }
    await expect(
      runWeeklyImport({ root, runId: initial.runId })
    ).rejects.toThrow("Changed stage artifact");
    expect(catalogDigest()).toBe(before);
    expect(stage(journalState(), "prepare").status).toBe("pending");
  });

  it("refuses a modified reconciliation receipt even if its artifact digest is refreshed", async () => {
    const reviewed = await runWeeklyImport({
      root,
      source,
      stopAfter: "reconcile",
    });
    const before = catalogDigest();
    const value: { receipt: { reportSha256: string } } = JSON.parse(
      artifact(reviewed.runId, "reconcile", 1)!.toString()
    );
    value.receipt.reportSha256 = "f".repeat(64);
    const bytes = Buffer.from(canonicalJson(value) + "\n");
    const identity = createHash("sha256").update(bytes).digest("hex");
    const db = new DatabaseSync(join(home, "weekly-runs.sqlite"));
    try {
      db.prepare(
        "UPDATE stage_artifact SET identity=?,bytes=? WHERE run_id=? AND stage='reconcile' AND attempt=1"
      ).run(identity, bytes, reviewed.runId);
    } finally {
      db.close();
    }
    await expect(
      runWeeklyImport({ root, runId: reviewed.runId })
    ).rejects.toThrow("INVALID_IMPORT_REVIEW");
    expect(catalogDigest()).toBe(before);
    expect(stage(journalState(), "load").status).not.toBe("succeeded");
  });

  it("refuses to recover a committed load when its saved reconciliation report is missing", async () => {
    const interruption = new Error(
      "fixture interruption before journal completion"
    );
    await expect(
      runWeeklyImport({
        root,
        source,
        onProgress: async (event) => {
          if (event.stage === "load" && event.phase === "effect-committed")
            throw interruption;
        },
      })
    ).rejects.toBe(interruption);
    const interrupted = journalState();
    const committed = readSqliteLedger(sqlitePath);
    const reportName = createHash("sha256")
      .update(committed.runs[0].runId)
      .digest("hex");
    rmSync(join(root, "data/ingestion/reports", `${reportName}.json`));
    const before = catalogDigest();
    await expect(
      runWeeklyImport({ root, runId: interrupted.runId })
    ).rejects.toThrow("IMPORT_REPORT_CHANGED");
    expect(catalogDigest()).toBe(before);
    expect(stage(journalState(), "load").status).not.toBe("succeeded");
  });

  it.each(["importRunId", "ledgerRevision"] as const)(
    "refuses a forged load artifact %s after the catalog committed",
    async (field: "importRunId" | "ledgerRevision") => {
      const interruption = new Error(
        "fixture interruption after load artifact"
      );
      await expect(
        runWeeklyImport({
          root,
          source,
          onProgress: async (event) => {
            if (event.stage === "load" && event.phase === "artifact-saved")
              throw interruption;
          },
        })
      ).rejects.toBe(interruption);
      const interrupted = journalState();
      const value: {
        evidence: { importRunId: string; ledgerRevision: string };
      } = JSON.parse(artifact(interrupted.runId, "load", 1)!.toString());
      value.evidence[field] =
        field === "importRunId"
          ? `steveslist-v4-${"f".repeat(64)}`
          : "f".repeat(64);
      const bytes = Buffer.from(canonicalJson(value) + "\n");
      const db = new DatabaseSync(join(home, "weekly-runs.sqlite"));
      try {
        db.prepare(
          "UPDATE stage_artifact SET identity=?,bytes=? WHERE run_id=? AND stage='load' AND attempt=1"
        ).run(
          createHash("sha256").update(bytes).digest("hex"),
          bytes,
          interrupted.runId
        );
      } finally {
        db.close();
      }
      const before = catalogDigest();
      await expect(
        runWeeklyImport({ root, runId: interrupted.runId })
      ).rejects.toThrow("INVALID_STAGE_ARTIFACT");
      expect(catalogDigest()).toBe(before);
      expect(readSqliteLedger(sqlitePath).events).toHaveLength(1);
      expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
      expect(stage(journalState(), "load").status).not.toBe("succeeded");
    }
  );

  it("runs the actual CLI without the source file and retains captured preflight after a canonical rename", async () => {
    const knownSource = {
      ...source,
      raw: Buffer.from(source.raw.toString().replaceAll("Fixture Band", "U2")),
    };
    const ledgerPath = join(root, "data/ingestion/ledger.json");
    const batch = prepareSteveBatch(
      await loadLedger(ledgerPath),
      "oct 16 2026 U2 at Test Room, Oakland a/a $20 8pm\n",
      importObservedAtEpochMs
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
    const file = join(directory, "private-source.txt");
    writeFileSync(file, knownSource.raw);
    const script = join(process.cwd(), "scripts/run-weekly-import.js");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [script, "--root", root, ...args], {
        cwd: process.cwd(),
        env: { ...process.env, ZIVV_LEDGER_HOME: home },
        encoding: "utf8",
        windowsHide: true,
        timeout: 25_000,
      });
    const initialDigest = catalogDigest();
    const reviewed = run([
      "--file",
      file,
      "--edition-id",
      source.editionId,
      "--delivery-id",
      source.deliveryId,
      "--observed-at",
      "2026-10-09T20:00:00Z",
      "--through",
      "reconcile",
    ]);
    expect(reviewed.status, reviewed.stderr).toBe(0);
    const state = journalState();
    expect(JSON.parse(reviewed.stdout.trim())).toMatchObject({
      runId: state.runId,
    });
    expect(stage(state, "load").status).toBe("pending");
    expect(catalogDigest()).toBe(initialDigest);
    const originalPreflight = artifact(state.runId, "prepare", 1);
    rmSync(file);
    const loaded = run(["--run-id", state.runId]);
    expect(loaded.status, loaded.stderr).toBe(0);
    const advanced = await loadLedger(ledgerPath);
    const artistId = advanced.artists[0].id;
    advanced.artists[0].name = "Renamed Artist";
    advanced.artists[0].normalizedName = "renamed artist";
    advanced.artists[0].slug = "renamed-artist";
    await saveLedgerAtomic(ledgerPath, advanced);
    const beforeReplay = catalogDigest();
    const replay = run(["--run-id", state.runId]);
    expect(replay.status, replay.stderr).toBe(0);
    expect(stage(journalState(), "load")).toMatchObject({
      status: "succeeded",
      attempt: 1,
    });
    expect(artifact(state.runId, "prepare", 1)).toEqual(originalPreflight);
    expect(catalogDigest()).toBe(beforeReplay);
    expect(readSqliteLedger(sqlitePath).events[0]).toMatchObject({
      headlinerArtistId: artistId,
      createdAtEpochMs: importObservedAtEpochMs,
    });
    expect(
      reviewed.stdout +
        reviewed.stderr +
        loaded.stdout +
        loaded.stderr +
        replay.stdout +
        replay.stderr
    ).not.toContain("THE LIST");
    expect(reviewed.stdout + loaded.stdout + replay.stdout).not.toContain(
      "U2 at Test Room"
    );
  });

  it("recovers after an actual child process is killed immediately after the catalog commit", async () => {
    const reviewed = await runWeeklyImport({
      root,
      source,
      stopAfter: "reconcile",
    });
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "dist/lib/ingestion/weekly-import-runner.js")
    ).href;
    const code = `const {runWeeklyImport}=await import(process.argv[1]);await runWeeklyImport({root:process.argv[2],runId:process.argv[3],leaseTtlMs:1000,onProgress:async({stage,phase})=>{if(stage==='load'&&phase==='effect-committed'){process.stdout.write('CATALOG_COMMITTED\\n');await new Promise(()=>{setInterval(()=>{},1000)});}}});`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", code, moduleUrl, root, reviewed.runId],
      {
        cwd: process.cwd(),
        env: { ...process.env, ZIVV_LEDGER_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    let output = "",
      errors = "";
    const closed = new Promise<void>((resolveExit) =>
      child.once("close", () => resolveExit())
    );
    try {
      await new Promise<void>((resolveCommitted, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error("Child did not reach committed interruption: " + errors)
            ),
          15_000
        );
        child.stdout.on("data", (bytes: Buffer) => {
          output += bytes.toString();
          if (output.includes("CATALOG_COMMITTED")) {
            clearTimeout(timer);
            resolveCommitted();
          }
        });
        child.stderr.on("data", (bytes: Buffer) => {
          errors += bytes.toString();
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", () => {
          clearTimeout(timer);
          if (!output.includes("CATALOG_COMMITTED"))
            reject(new Error("Child exited before catalog commit: " + errors));
        });
      });
      expect(child.kill("SIGKILL")).toBe(true);
      await closed;
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
    }
    const interrupted = journalState();
    expect(stage(interrupted, "load")).toMatchObject({
      status: "running",
      attempt: 1,
    });
    expect(artifact(interrupted.runId, "load", 1)).toBeNull();
    const db = new DatabaseSync(join(home, "weekly-runs.sqlite"), {
      readOnly: true,
    });
    let expiresAt: number;
    try {
      expiresAt = Number(
        db
          .prepare(
            "SELECT expires_at FROM ownership WHERE scope='prodigic/zivv/production'"
          )
          .get()?.expires_at
      );
    } finally {
      db.close();
    }
    await new Promise<void>((resolveExpiry) =>
      setTimeout(resolveExpiry, Math.max(0, expiresAt - Date.now()) + 50)
    );
    const before = catalogDigest();
    const recovered = await runWeeklyImport({ root, runId: interrupted.runId });
    expect(stage(recovered, "load")).toMatchObject({
      status: "succeeded",
      attempt: 1,
    });
    expect(catalogDigest()).toBe(before);
    expect(readSqliteLedger(sqlitePath).events).toHaveLength(1);
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
    expect(readSqliteLedger(sqlitePath).events[0].createdAtEpochMs).toBe(
      importObservedAtEpochMs
    );
  });

  it("retries a blocked unknown U2 bill after canonical repair without changing prepared history", async () => {
    const unknown = {
      ...source,
      raw: Buffer.from(source.raw.toString().replaceAll("Fixture Band", "U2")),
    };
    const before = catalogDigest();
    await expect(runWeeklyImport({ root, source: unknown })).rejects.toThrow(
      "CORE_RECONCILIATION_REQUIRED"
    );
    const blocked = journalState();
    expect(stage(blocked, "reconcile")).toMatchObject({
      status: "blocked",
      attempt: 1,
    });
    expect(catalogDigest()).toBe(before);
    const prepared = artifact(blocked.runId, "prepare", 1);
    const ledgerPath = join(root, "data/ingestion/ledger.json");
    const batch = prepareSteveBatch(
      await loadLedger(ledgerPath),
      "oct 16 2026 U2 at Test Room, Oakland a/a $20 8pm\n",
      importObservedAtEpochMs
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
    const resumed = await runWeeklyImport({ root, runId: blocked.runId });
    expect(stage(resumed, "prepare")).toMatchObject({
      status: "succeeded",
      attempt: 1,
    });
    expect(stage(resumed, "reconcile")).toMatchObject({
      status: "succeeded",
      attempt: 2,
    });
    expect(stage(resumed, "load").status).toBe("succeeded");
    expect(artifact(resumed.runId, "prepare", 1)).toEqual(prepared);
    expect(readSqliteLedger(sqlitePath).events).toHaveLength(1);
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
    expect(readSqliteLedger(sqlitePath).events[0].createdAtEpochMs).toBe(
      importObservedAtEpochMs
    );
  });

  it("refuses an environment switch between two identical empty physical stores before import", async () => {
    const secondHome = join(directory, "second-operator");
    const secondPath = join(secondHome, "ledger.sqlite");
    loadBackupKey(secondHome, true);
    await writeSqliteLedger(
      secondPath,
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1_000),
      true
    );
    const before = catalogDigest();
    const secondBefore = canonicalJson(readSqliteLedger(secondPath));
    let switched = false;
    await expect(
      runWeeklyImport({
        root,
        source,
        onProgress: async (event) => {
          if (event.stage === "load" && event.phase === "started") {
            switched = true;
            vi.stubEnv("ZIVV_LEDGER_HOME", secondHome);
          }
        },
      })
    ).rejects.toThrow("RUN_CONTEXT_CHANGED");
    expect(switched).toBe(true);
    expect(catalogDigest()).toBe(before);
    expect(canonicalJson(readSqliteLedger(secondPath))).toBe(secondBefore);
    expect(readSqliteLedger(sqlitePath).runs).toEqual([]);
    expect(readSqliteLedger(secondPath).runs).toEqual([]);
    expect(stage(journalState(), "load").status).not.toBe("succeeded");
  });

  it.each(["draft", "published"] as const)(
    "refuses a fresh backdated new show behind a frozen %s weekly cutoff",
    async (status: "draft" | "published") => {
      const reviewed = await runWeeklyImport({
        root,
        source,
        stopAfter: "reconcile",
      });
      freezeWeeklyCutoff(status);
      const before = catalogDigest();
      await expect(
        runWeeklyImport({ root, runId: reviewed.runId })
      ).rejects.toThrow("LATE_IMPORT_REQUIRES_REVIEW");
      expect(catalogDigest()).toBe(before);
      expect(readSqliteLedger(sqlitePath).events).toEqual([]);
      expect(readSqliteLedger(sqlitePath).runs).toEqual([]);
      expect(stage(journalState(), "load")).toMatchObject({
        errorCode: "LATE_IMPORT_REQUIRES_REVIEW",
        attempt: 1,
      });
    }
  );

  it("recovers an already committed interrupted load after its weekly membership freezes", async () => {
    const interruption = new Error("fixture interruption before weekly freeze");
    await expect(
      runWeeklyImport({
        root,
        source,
        onProgress: async (event) => {
          if (event.stage === "load" && event.phase === "effect-committed")
            throw interruption;
        },
      })
    ).rejects.toBe(interruption);
    const interrupted = journalState();
    expect(stage(interrupted, "load").status).toBe("running");
    freezeWeeklyCutoff("published");
    const before = catalogDigest();
    const resumed = await runWeeklyImport({ root, runId: interrupted.runId });
    expect(stage(resumed, "load")).toMatchObject({
      status: "succeeded",
      attempt: 1,
    });
    expect(catalogDigest()).toBe(before);
    expect(readSqliteLedger(sqlitePath).events).toHaveLength(1);
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
    expect(readSqliteLedger(sqlitePath).events[0].createdAtEpochMs).toBe(
      importObservedAtEpochMs
    );
  });
});
