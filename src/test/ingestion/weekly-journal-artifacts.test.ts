import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  writeSqliteLedger,
  withCanonicalStoreTransaction,
} from "../../lib/ingestion/sqlite-store.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import {
  WeeklyRunJournal,
  readGuardedWeeklyCatalogLease,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
} from "../../lib/ingestion/weekly-run-state.js";
const roots: string[] = [];
const opened = new Set<WeeklyRunJournal>();
function fixture(clock = () => 1000) {
  const root = mkdtempSync(join(tmpdir(), "zivv-journal-artifacts-"));
  roots.push(root);
  const directory = join(root, "operator");
  const journal = new WeeklyRunJournal(directory, clock);
  opened.add(journal);
  const raw = Buffer.from("exact source\r\n");
  const source = {
    editionId: "2026-10-16",
    deliveryId: "fixture",
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    rulesSha256: "b".repeat(64),
    importObservedAtEpochMs: 1000,
  };
  return { directory, journal, raw, state: createWeeklyRunState(source) };
}
function close(journal: WeeklyRunJournal) {
  journal.close();
  opened.delete(journal);
}
afterEach(() => {
  for (const journal of opened) journal.close();
  opened.clear();
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel.startsWith("zivv-journal-artifacts-") || rel.startsWith(".."))
      throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
describe("durable journal artifacts and guarded operations", () => {
  it("holds both journal and canonical catalog writer locks while checking recovery state", async () => {
    const f = fixture(),
      path = join(f.directory, "ledger.sqlite"),
      ledger = bootstrapLedger({ events: [], artists: [], venues: [] }, 1000);
    await writeSqliteLedger(path, ledger, true);
    const lease = f.journal.acquire("production", 10000);
    await f.journal.guardOperation(lease, async () =>
      withCanonicalStoreTransaction(
        path,
        { generation: 1, ledger },
        async () => {
          const competingCatalog = new DatabaseSync(path, { timeout: 0 }),
            competingJournal = new DatabaseSync(
              join(f.directory, "weekly-runs.sqlite"),
              { timeout: 0 }
            );
          try {
            expect(() => competingCatalog.exec("BEGIN IMMEDIATE")).toThrow(
              /locked|busy/i
            );
            expect(() => competingJournal.exec("BEGIN IMMEDIATE")).toThrow(
              /locked|busy/i
            );
          } finally {
            competingCatalog.close();
            competingJournal.close();
          }
        }
      )
    );
  });

  it("exposes only a live guarded lease, detached from SQL and revoked for escaped tasks", async () => {
    let now = 1000;
    const f = fixture(() => now),
      path = join(f.directory, "weekly-runs.sqlite");
    const lease = f.journal.acquire("prodigic/zivv/production", 1000);
    expect(readGuardedWeeklyCatalogLease(path)).toBeUndefined();
    let escaped: Promise<unknown> | undefined;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.journal.guardOperation(lease, async () => {
      const observed = readGuardedWeeklyCatalogLease(path)!;
      expect(observed.lease).toEqual(lease);
      expect(
        readGuardedWeeklyCatalogLease(join(f.directory, "other.sqlite"))
      ).toBeUndefined();
      observed.lease.owner = "forged";
      observed.snapshot.fill(0);
      expect(readGuardedWeeklyCatalogLease(path)!.lease).toEqual(lease);
      escaped = wait.then(() => readGuardedWeeklyCatalogLease(path));
      now = 2000;
      expect(() => readGuardedWeeklyCatalogLease(path)).toThrow(
        "Expired or fenced"
      );
      now = 1000;
    });
    expect(readGuardedWeeklyCatalogLease(path)).toBeUndefined();
    release();
    await expect(escaped).resolves.toBeUndefined();
  });

  it("renews the same fenced owner inside a guarded catalog operation", async () => {
    let now = 1000;
    const f = fixture(() => now),
      lease = f.journal.acquire("production", 1000);
    await f.journal.guardOperation(lease, async () => {
      now = 1500;
      const renewed = f.journal.renew(lease, 1000);
      expect(renewed.fence).toBe(lease.fence);
      expect(renewed.expiresAtEpochMs).toBe(2500);
      f.journal.checkOwnership(renewed);
    });
    now = 2400;
    f.journal.checkOwnership(lease);
  });
  it("migrates a genuine v1 journal without rewriting run history or ownership", () => {
    const f = fixture();
    const lease = f.journal.acquire("production");
    const state = f.journal.create(f.state, lease);
    const running = f.journal.save(
      transitionWeeklyRun(state, 0, "acquire", { status: "running" }, 1000),
      0,
      lease
    );
    close(f.journal);
    const db = new DatabaseSync(join(f.directory, "weekly-runs.sqlite"));
    db.exec(
      "DROP TABLE intake_evidence; DROP TABLE stage_artifact; PRAGMA user_version=1;"
    );
    db.close();
    const migrated = new WeeklyRunJournal(f.directory, () => 1000);
    opened.add(migrated);
    expect(migrated.loadOwned(state.runId, lease)).toEqual(running);
    migrated.checkOwnership(lease);
    const check = new DatabaseSync(migrated.path, { readOnly: true });
    expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    check.close();
  });
  it("atomically retains raw intent and immutable per-attempt evidence across reopening", () => {
    const f = fixture();
    const lease = f.journal.acquire("production");
    expect(() =>
      f.journal.create(f.state, lease, Buffer.from("different"))
    ).toThrow("Raw source");
    expect(f.journal.load(f.state.runId)).toBeNull();
    const state = f.journal.create(f.state, lease, f.raw);
    expect(f.journal.readArtifact(state.runId, "acquire", 0)).toEqual(f.raw);
    expect(() =>
      f.journal.writeArtifact(state.runId, "acquire", f.raw, lease)
    ).toThrow("running stage");
    f.journal.save(
      transitionWeeklyRun(state, 0, "acquire", { status: "running" }, 1000),
      0,
      lease
    );
    f.journal.writeArtifact(state.runId, "acquire", f.raw, lease);
    f.journal.writeArtifact(state.runId, "acquire", f.raw, lease);
    expect(() =>
      f.journal.writeArtifact(
        state.runId,
        "acquire",
        Buffer.from("overwrite"),
        lease
      )
    ).toThrow("refusing overwrite");
    close(f.journal);
    const reopened = new WeeklyRunJournal(f.directory, () => 1000);
    opened.add(reopened);
    expect(reopened.readArtifact(state.runId, "acquire", 0)).toEqual(f.raw);
    expect(reopened.readArtifact(state.runId, "acquire", 1)).toEqual(f.raw);
  });
  it("holds the SQLite ownership writer lock through a critical operation even after expiry", async () => {
    let now = 1000;
    const f = fixture(() => now);
    const lease = f.journal.acquire("production", 1000);
    await expect(
      f.journal.guardOperation(lease, async () => {
        f.journal.checkOwnership(lease);
        now = 3000;
        const child = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{timeout:50});db.prepare('UPDATE ownership SET fence=fence+1 WHERE scope=?').run('production');db.close();",
            f.journal.path,
          ],
          { encoding: "utf8", windowsHide: true }
        );
        expect(child.status).not.toBe(0);
        expect(child.stderr).toMatch(/locked/);
      })
    ).rejects.toThrow("Expired or fenced");
    expect(f.journal.acquire("production", 1000).fence).toBe(lease.fence + 1);
  });
  it("refuses a version marker with missing or unexpected journal tables", () => {
    const f = fixture();
    close(f.journal);
    const db = new DatabaseSync(join(f.directory, "weekly-runs.sqlite"));
    db.exec("ALTER TABLE stage_artifact RENAME TO unknown_artifacts;");
    db.close();
    expect(() => new WeeklyRunJournal(f.directory)).toThrow(
      "Unsupported journal tables"
    );
  });
});
