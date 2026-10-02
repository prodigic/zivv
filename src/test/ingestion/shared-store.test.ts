import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  bootstrapLedger,
  loadLedger,
  saveLedgerAtomic,
} from "../../lib/ingestion/ledger.js";
import { withIngestionLock } from "../../lib/ingestion/lock.js";
import {
  canonicalJson,
  checkStore,
  ledgerDigest,
  readSqliteLedger,
  withStoreTransaction,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import {
  decryptLedgerSnapshot,
  encryptLedgerSnapshot,
  exportRecoveryKey,
  loadBackupKey,
} from "../../lib/ingestion/encrypted-backup.js";
import type {
  Artist,
  ArtistId,
  Event,
  EventId,
  Venue,
  VenueId,
} from "../../types/events.js";

const directories: string[] = [];
const previousHome = process.env.ZIVV_LEDGER_HOME;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "zivv-shared-test-"));
  directories.push(directory);
  const home = join(directory, "operator");
  process.env.ZIVV_LEDGER_HOME = home;
  const root = join(directory, "checkout-a");
  const second = join(directory, "checkout-b");
  for (const workspace of [root, second]) {
    mkdirSync(join(workspace, "data", "ingestion"), { recursive: true });
    writeFileSync(
      join(workspace, "data", "ingestion", "store.json"),
      JSON.stringify({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
  }
  const artist: Artist = {
    id: 201 as ArtistId,
    name: "Test Band",
    normalizedName: "test band",
    slug: "test-band",
    aliases: [],
    upcomingEventCount: 0,
    totalEventCount: 1,
    upcomingEvents: [],
    createdAtEpochMs: 1234,
    updatedAtEpochMs: 1234,
  };
  const venue: Venue = {
    id: 301 as VenueId,
    name: "Test Hall",
    normalizedName: "test hall",
    slug: "test-hall",
    city: "San Francisco",
    address: "1 Test Street",
    ageRestriction: "21+",
    upcomingEventCount: 0,
    totalEventCount: 1,
    upcomingEvents: [],
    createdAtEpochMs: 1234,
    updatedAtEpochMs: 1234,
    sourceLineNumber: 1,
  };
  const event: Event = {
    id: 101 as EventId,
    slug: "event-101",
    date: "2026-12-01",
    dateEpochMs: Date.parse("2026-12-01T12:00:00Z"),
    timezone: "America/Los_Angeles",
    headlinerArtistId: artist.id,
    artistIds: [artist.id],
    venueId: venue.id,
    isFree: false,
    priceMin: 20,
    ageRestriction: "21+",
    status: "confirmed",
    tags: [],
    venueType: "club",
    createdAtEpochMs: 1234,
    updatedAtEpochMs: 1234,
    sourceLineNumber: 1,
  };
  const ledger = bootstrapLedger(
    { artists: [artist], venues: [venue], events: [event] },
    2000
  );
  loadBackupKey(home, true);
  return {
    root,
    second,
    home,
    path: join(home, "ledger.sqlite"),
    ledger,
    ledgerPath: join(root, "data", "ingestion", "ledger.json"),
  };
}
afterEach(() => {
  if (previousHome === undefined) delete process.env.ZIVV_LEDGER_HOME;
  else process.env.ZIVV_LEDGER_HOME = previousHome;
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), "zivv-shared-test-")))
      throw new Error("Unsafe test cleanup.");
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("operator command recovery", () => {
  function run(
    command: string,
    f: ReturnType<typeof fixture>,
    args: string[] = [],
    home = f.home
  ) {
    return spawnSync(
      process.execPath,
      [resolve("scripts/ledger-store.js"), command, "--root", f.root, ...args],
      {
        env: { ...process.env, ZIVV_LEDGER_HOME: home },
        encoding: "utf8",
        windowsHide: true,
      }
    );
  }
  it("backs up once, reuses unchanged ciphertext, and recovers using a portable key", async () => {
    const f = fixture();
    writeFileSync(f.ledgerPath, JSON.stringify(f.ledger));
    const migration = run("migrate", f);
    expect(migration.status, migration.stderr).toBe(0);
    expect(run("migrate", f).status).toBe(0);
    const snapshot = join(
      f.root,
      "data",
      "ingestion",
      "backups",
      "ledger.snapshot.enc"
    );
    const before = readFileSync(snapshot);
    const backup = run("backup", f);
    expect(backup.status, backup.stderr).toBe(0);
    expect(JSON.parse(backup.stdout).changed).toBe(false);
    expect(readFileSync(snapshot)).toEqual(before);
    const recoveryKey = join(f.home, "recovery", "backup-recovery.key");
    const keyExport = run("export-key", f, ["--file", recoveryKey]);
    expect(keyExport.status, keyExport.stderr).toBe(0);
    const recoveredHome = join(dirname(f.home), "recovered");
    const keyImport = run(
      "import-key",
      f,
      ["--file", recoveryKey],
      recoveredHome
    );
    expect(keyImport.status, keyImport.stderr).toBe(0);
    const restore = run("restore", f, [], recoveredHome);
    expect(restore.status, restore.stderr).toBe(0);
    expect(readSqliteLedger(join(recoveredHome, "ledger.sqlite"))).toEqual(
      f.ledger
    );
  }, 30_000);
  it("requires the current revision for rollback and retains the state being replaced", async () => {
    const f = fixture();
    writeFileSync(f.ledgerPath, JSON.stringify(f.ledger));
    expect(run("migrate", f).status).toBe(0);
    const updated = readSqliteLedger(f.path);
    updated.events[0].priceMin = 42;
    await writeSqliteLedger(f.path, updated);
    const refused = run("restore", f);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("expected-revision");
    expect(
      run("restore", f, ["--expected-revision", "outdated"]).status
    ).not.toBe(0);
    expect(readSqliteLedger(f.path)).toEqual(updated);
    const restored = run("restore", f, [
      "--expected-revision",
      ledgerDigest(updated),
    ]);
    expect(restored.status, restored.stderr).toBe(0);
    expect(readSqliteLedger(f.path)).toEqual(f.ledger);
    const rollback = readFileSync(
      join(f.home, "rollback", `${ledgerDigest(updated)}.snapshot.enc`)
    );
    expect(decryptLedgerSnapshot(rollback, loadBackupKey(f.home))).toEqual(
      updated
    );
  }, 20_000);
  it("rejects exporting a recovery key into a Git checkout", () => {
    const f = fixture();
    mkdirSync(join(f.root, ".git"));
    expect(() =>
      exportRecoveryKey(f.home, join(f.root, "recovery.key"))
    ).toThrow("Git checkout");
  });
  it("keeps one recovery key when two processes initialize the same operator directory", async () => {
    const f = fixture();
    const home = join(dirname(f.home), "new-operator");
    function initialize() {
      const script = `import { loadBackupKey } from './dist/lib/ingestion/encrypted-backup.js'; import { createHash } from 'node:crypto'; console.log(createHash('sha256').update(loadBackupKey(process.env.ZIVV_TEST_KEY_HOME,true)).digest('hex'));`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          env: { ...process.env, ZIVV_TEST_KEY_HOME: home },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      return new Promise<string>((done, reject) => {
        let output = "";
        let errors = "";
        child.stdout.on("data", (bytes) => {
          output += String(bytes);
        });
        child.stderr.on("data", (bytes) => {
          errors += String(bytes);
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) done(output.trim());
          else reject(new Error(errors));
        });
      });
    }
    const [first, second] = await Promise.all([initialize(), initialize()]);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
  }, 15_000);
});

async function childHoldingLock(path: string, crash: boolean) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.env.ZIVV_TEST_DB); db.exec('BEGIN IMMEDIATE'); ${crash ? "db.exec(\"UPDATE metadata SET digest='uncommitted' WHERE id=1\");" : ""} console.log('locked'); setTimeout(()=>{db.exec('ROLLBACK'); db.close();}, 350);`,
    ],
    {
      env: { ...process.env, ZIVV_TEST_DB: path },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  await new Promise<void>((done, reject) => {
    child.once("error", reject);
    child.stdout.once("data", () => done());
    child.once("exit", (code) => {
      if (code) reject(new Error(`Child failed ${code}`));
    });
  });
  return child;
}

describe("shared transactional ledger", () => {
  it("preserves the complete catalog and both workspaces resolve the same store", async () => {
    const f = fixture();
    await writeSqliteLedger(f.path, f.ledger, true);
    expect(await loadLedger(f.ledgerPath)).toEqual(f.ledger);
    expect(
      await loadLedger(join(f.second, "data", "ingestion", "ledger.json"))
    ).toEqual(f.ledger);
    checkStore(f.path);
  });
  it("does not fall back to an older local JSON copy when the shared database is missing", async () => {
    const f = fixture();
    writeFileSync(f.ledgerPath, JSON.stringify(f.ledger));
    await expect(loadLedger(f.ledgerPath)).rejects.toThrow(
      "Shared ledger missing"
    );
  });
  it("rejects a stale edit rather than replacing another writer's changes", async () => {
    const f = fixture();
    await writeSqliteLedger(f.path, f.ledger, true);
    const first = await loadLedger(f.ledgerPath);
    const second = await loadLedger(f.ledgerPath);
    first.events[0].priceMin = 25;
    await saveLedgerAtomic(f.ledgerPath, first);
    second.events[0].priceMin = 30;
    await expect(saveLedgerAtomic(f.ledgerPath, second)).rejects.toThrow(
      "Stale"
    );
    expect((await loadLedger(f.ledgerPath)).events[0].priceMin).toBe(25);
    expect((await loadLedger(f.ledgerPath)).events[0].createdAtEpochMs).toBe(
      1234
    );
  });
  it("rolls back a failure after writing changes", async () => {
    const f = fixture();
    await writeSqliteLedger(f.path, f.ledger, true);
    await expect(
      withIngestionLock(f.root, async () => {
        const ledger = await loadLedger(f.ledgerPath);
        ledger.events[0].priceMin = 55;
        await saveLedgerAtomic(f.ledgerPath, ledger);
        throw new Error("interrupt import");
      })
    ).rejects.toThrow("interrupt import");
    expect(await loadLedger(f.ledgerPath)).toEqual(f.ledger);
  });
  it("serializes simultaneous workspace updates without losing either edit", async () => {
    const f = fixture();
    await writeSqliteLedger(f.path, f.ledger, true);
    await Promise.all([
      withIngestionLock(f.root, async () => {
        const ledger = await loadLedger(f.ledgerPath);
        await new Promise((done) => setTimeout(done, 80));
        ledger.events[0].priceMin = 31;
        await saveLedgerAtomic(f.ledgerPath, ledger);
      }),
      withIngestionLock(f.second, async () => {
        const ledger = await loadLedger(f.ledgerPath);
        ledger.events[0].status = "sold-out";
        await saveLedgerAtomic(f.ledgerPath, ledger);
      }),
    ]);
    expect((await loadLedger(f.ledgerPath)).events[0]).toMatchObject({
      priceMin: 31,
      status: "sold-out",
    });
  });
  it("waits for a writer in another process", async () => {
    const f = fixture();
    await writeSqliteLedger(f.path, f.ledger, true);
    const child = await childHoldingLock(f.path, false);
    await withStoreTransaction(f.path, async () => {
      const ledger = readSqliteLedger(f.path);
      ledger.events[0].priceMin = 35;
      await writeSqliteLedger(f.path, ledger);
    });
    if (child.exitCode === null)
      await new Promise((done) => child.once("exit", done));
    expect(readSqliteLedger(f.path).events[0].priceMin).toBe(35);
  });
  it("recovers an interrupted process transaction without stale lock files", async () => {
    const f = fixture();
    await writeSqliteLedger(f.path, f.ledger, true);
    const child = await childHoldingLock(f.path, true);
    child.kill("SIGKILL");
    await new Promise((done) => child.once("exit", done));
    expect(readSqliteLedger(f.path)).toEqual(f.ledger);
    await withStoreTransaction(f.path, async () => undefined);
    checkStore(f.path);
  });
});

describe("encrypted snapshots", () => {
  it("restores every field and preserves IDs, source history and first-added dates", async () => {
    const f = fixture();
    const key = randomBytes(32);
    const encrypted = encryptLedgerSnapshot(f.ledger, key);
    expect(encrypted.toString()).not.toContain("Test Band");
    expect(encrypted.toString()).not.toContain("createdAtEpochMs");
    const restored = decryptLedgerSnapshot(encrypted, key);
    await writeSqliteLedger(f.path, restored, true);
    expect(readSqliteLedger(f.path)).toEqual(f.ledger);
    expect(ledgerDigest(restored)).toBe(ledgerDigest(f.ledger));
  });
  it("authenticates payloads and rejects the wrong key and altered headers", () => {
    const f = fixture();
    const key = randomBytes(32);
    const bytes = encryptLedgerSnapshot(f.ledger, key);
    expect(() => decryptLedgerSnapshot(bytes, randomBytes(32))).toThrow();
    const envelope = JSON.parse(bytes.toString());
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    ciphertext[0] ^= 1;
    envelope.ciphertext = ciphertext.toString("base64");
    expect(() =>
      decryptLedgerSnapshot(Buffer.from(JSON.stringify(envelope)), key)
    ).toThrow();
    const header = JSON.parse(bytes.toString());
    header.version = 2;
    expect(() =>
      decryptLedgerSnapshot(Buffer.from(JSON.stringify(header)), key)
    ).toThrow();
  });
  it("uses fresh nonces and deterministic logical snapshot content", () => {
    const f = fixture();
    const key = randomBytes(32);
    const first = encryptLedgerSnapshot(f.ledger, key);
    const second = encryptLedgerSnapshot(f.ledger, key);
    expect(first.equals(second)).toBe(false);
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(decryptLedgerSnapshot(first, key)).toEqual(
      decryptLedgerSnapshot(second, key)
    );
  });
});
