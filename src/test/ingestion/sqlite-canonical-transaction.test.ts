import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  canonicalJson,
  readSqliteLedger,
  readCanonicalSqliteLedgerReadOnly,
  writeSqliteLedger,
  withStoreTransaction,
  withCanonicalStoreTransaction,
} from "../../lib/ingestion/sqlite-store.js";
import type {
  Artist,
  ArtistId,
  Venue,
  VenueId,
  Event,
  EventId,
} from "../../types/events.js";
const roots: string[] = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zivv-canonical-writer-"));
  roots.push(root);
  const path = join(root, "ledger.sqlite");
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

  await writeSqliteLedger(path, ledger, true);
  return { root, path, ledger };
}
function generation(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT generation FROM metadata WHERE id=1").get()
      ?.generation;
  } finally {
    db.close();
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const offset = relative(resolve(tmpdir()), resolve(root));
    if (!offset.startsWith("zivv-canonical-writer-") || offset.includes(".."))
      throw Error("Unsafe canonical fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
it("checks the complete owned baseline before committing a catalog write", async () => {
  const { path, ledger } = await fixture();
  await withCanonicalStoreTransaction(
    path,
    { generation: 1, ledger },
    async () => {
      const next = readSqliteLedger(path);
      next.version = String(Number(next.version) + 1);
      await writeSqliteLedger(path, next);
    }
  );
  expect(generation(path)).toBe(2);
  expect(readSqliteLedger(path).version).not.toBe(ledger.version);
  const work = vi.fn(async () => {});
  await expect(
    withCanonicalStoreTransaction(path, { generation: 1, ledger }, work)
  ).rejects.toThrow("CANONICAL_STORE_BASELINE_CHANGED");
  expect(work).not.toHaveBeenCalled();
  await withCanonicalStoreTransaction(
    path,
    { generation: 2, ledger: readSqliteLedger(path) },
    async () => {}
  );
});
it("detects generation-only drift after waiting for the actual SQLite writer lock", async () => {
  const { path, ledger } = await fixture();
  const blocker = new DatabaseSync(path);
  try {
    blocker.exec("BEGIN IMMEDIATE;");
    const work = vi.fn(async () => {});
    const pending = withCanonicalStoreTransaction(
      path,
      { generation: 1, ledger },
      work
    );
    blocker.exec("UPDATE metadata SET generation=generation+1; COMMIT;");
    await expect(pending).rejects.toThrow("CANONICAL_STORE_BASELINE_CHANGED");
    expect(work).not.toHaveBeenCalled();
    expect(readSqliteLedger(path)).toEqual(ledger);
    expect(generation(path)).toBe(2);
  } finally {
    if (blocker.isTransaction) blocker.exec("ROLLBACK");
    blocker.close();
  }
});
it("owns expected bytes before waiting rather than rereading a mutable baseline", async () => {
  const { path, ledger } = await fixture();
  const blocker = new DatabaseSync(path);
  const expected = { generation: 1, ledger: structuredClone(ledger) };
  try {
    blocker.exec("BEGIN IMMEDIATE;");
    const work = vi.fn(async () => {});
    const pending = withCanonicalStoreTransaction(path, expected, work);
    expected.ledger.version = "caller changed after start";
    expected.generation = 999;
    blocker.exec("COMMIT;");
    await pending;
    expect(work).toHaveBeenCalledOnce();
    expect(readSqliteLedger(path)).toEqual(ledger);
  } finally {
    if (blocker.isTransaction) blocker.exec("ROLLBACK");
    blocker.close();
  }
});
it.each([
  "UPDATE sources SET url='https://fixture.invalid/changed'",
  "UPDATE event_artists SET position=position+1",
  "UPDATE events SET date='2027-12-01'",
  "CREATE TABLE unexpected(value TEXT)",
  "CREATE TRIGGER injected AFTER UPDATE ON metadata BEGIN DELETE FROM events; END",
])("refuses hidden relational/schema drift before work: %s", async (sql) => {
  const { path, ledger } = await fixture();
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
  // The ordinary payload reader and logical digest alone do not expose this drift.
  expect(canonicalJson(readSqliteLedger(path))).toBe(canonicalJson(ledger));
  const work = vi.fn(async () => {});
  await expect(
    withCanonicalStoreTransaction(path, { generation: 1, ledger }, work)
  ).rejects.toThrow("CANONICAL_STORE_BASELINE_CHANGED");
  expect(work).not.toHaveBeenCalled();
  expect(generation(path)).toBe(1);
});
it("refuses borrowing either the same or another enclosing catalog transaction", async () => {
  const one = await fixture(),
    two = await fixture();
  await withStoreTransaction(one.path, async () => {
    for (const value of [one, two]) {
      const work = vi.fn(async () => {});
      await expect(
        withCanonicalStoreTransaction(
          value.path,
          { generation: 1, ledger: value.ledger },
          work
        )
      ).rejects.toThrow("RECOVERY_REQUIRES_OWN_CATALOG_TRANSACTION");
      expect(work).not.toHaveBeenCalled();
    }
  });
});
it("rolls back all catalog work on failure after a successful baseline check", async () => {
  const { path, ledger } = await fixture();
  await expect(
    withCanonicalStoreTransaction(path, { generation: 1, ledger }, async () => {
      const next = readSqliteLedger(path);
      next.version = String(Number(next.version) + 1);
      await writeSqliteLedger(path, next);
      throw Error("TEST_ABORT");
    })
  ).rejects.toThrow("TEST_ABORT");
  expect(generation(path)).toBe(1);
  expect(readSqliteLedger(path)).toEqual(ledger);
});
it("does not create a missing catalog and rejects baseline accessors without calling them", async () => {
  const { root, ledger } = await fixture(),
    path = join(root, "missing.sqlite");
  await expect(
    withCanonicalStoreTransaction(
      path,
      { generation: 1, ledger },
      async () => {}
    )
  ).rejects.toThrow();
  expect(existsSync(path)).toBe(false);
  const getter = vi.fn(() => 1);
  const expected = Object.defineProperty(
    { generation: 1, ledger },
    "generation",
    { get: getter }
  );
  await expect(
    withCanonicalStoreTransaction(path, expected, async () => {})
  ).rejects.toThrow("INVALID_CANONICAL_STORE_BASELINE");
  expect(getter).not.toHaveBeenCalled();
});

it.each(["main", "-wal"])(
  "refuses a linked %s file before opening the catalog",
  async (kind) => {
    const { root, path, ledger } = await fixture();
    const target = kind === "main" ? join(root, "linked.sqlite") : path + kind;
    const source = kind === "main" ? path : join(root, "sidecar-target");
    if (kind !== "main") {
      const db = new DatabaseSync(source);
      db.close();
    }
    linkSync(source, target);
    const work = vi.fn(async () => {});
    await expect(
      withCanonicalStoreTransaction(
        kind === "main" ? target : path,
        { generation: 1, ledger },
        work
      )
    ).rejects.toThrow(/linked/i);
    expect(work).not.toHaveBeenCalled();
  }
);

it("observes a canonical catalog and generation without write authority", async () => {
  const { path, ledger } = await fixture();
  expect(readCanonicalSqliteLedgerReadOnly(path)).toEqual({
    ledger,
    generation: 1,
  });
});
it.each([
  "UPDATE sources SET url='https://fixture.invalid/changed'",
  "UPDATE event_artists SET position=position+1",
  "UPDATE events SET date='2027-12-01'",
  "CREATE TABLE unexpected(value TEXT)",
])(
  "refuses hidden drift in the read-only canonical observation: %s",
  async (sql) => {
    const { path, ledger } = await fixture(),
      db = new DatabaseSync(path);
    db.exec(sql);
    db.close();
    expect(readSqliteLedger(path)).toEqual(ledger);
    expect(() => readCanonicalSqliteLedgerReadOnly(path)).toThrow(
      "CANONICAL_STORE_BASELINE_CHANGED"
    );
  }
);

it("reports generation drift and rejects a missing or linked canonical catalog", async () => {
  const { root, path, ledger } = await fixture(),
    db = new DatabaseSync(path);
  db.exec("UPDATE metadata SET generation=2");
  db.close();
  expect(readCanonicalSqliteLedgerReadOnly(path)).toEqual({
    ledger,
    generation: 2,
  });
  expect(() =>
    readCanonicalSqliteLedgerReadOnly(join(root, "missing.sqlite"))
  ).toThrow();
  const linked = join(root, "linked-observation.sqlite");
  linkSync(path, linked);
  expect(() => readCanonicalSqliteLedgerReadOnly(linked)).toThrow(/linked/i);
});
