import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IngestionLedger } from "../../types/ingestion.js";

interface StoreSession {
  path: string;
  db: DatabaseSync;
}
const sessions = new AsyncLocalStorage<StoreSession>();
const revisions = new WeakMap<
  IngestionLedger,
  { path: string; generation: number }
>();

/** Carry the loaded revision through pure reconciliation or an explicitly checked restore. */
export function inheritStoreRevision(
  base: IngestionLedger,
  next: IngestionLedger
): IngestionLedger {
  const revision = revisions.get(base);
  if (revision) revisions.set(next, revision);
  return next;
}

/** Produce stable object keys while retaining meaningful array order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      );
    return item;
  });
}

export function ledgerDigest(ledger: IngestionLedger): string {
  return createHash("sha256").update(canonicalJson(ledger)).digest("hex");
}

/** Open the local WAL store; an absent ledger never becomes an empty catalog. */
export function openStore(path: string, create = false): DatabaseSync {
  if (!create && !existsSync(path))
    throw new Error(
      `Shared ledger missing: ${path}. Restore an encrypted snapshot or run ledger:migrate.`
    );
  if (create) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    const schema = Number(
      db.prepare("PRAGMA user_version").get()?.user_version
    );
    if (schema !== 1 && !(create && schema === 0))
      throw new Error("Unsupported shared ledger database schema.");
    const row = db.prepare("SELECT sqlite_version() AS version").get();
    const version = String(row?.version).split(".").map(Number);
    if (
      version[0] < 3 ||
      (version[0] === 3 &&
        (version[1] < 51 || (version[1] === 51 && version[2] < 3)))
    )
      throw new Error(
        "Shared ledger requires SQLite 3.51.3 or later (WAL recovery fixes)."
      );
    db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
    if (create) {
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS artists (id INTEGER PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS venues (id INTEGER PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, position INTEGER NOT NULL, date TEXT NOT NULL, venue_id INTEGER NOT NULL REFERENCES venues(id) DEFERRABLE INITIALLY DEFERRED, headliner_id INTEGER NOT NULL REFERENCES artists(id) DEFERRABLE INITIALLY DEFERRED, payload TEXT NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS event_date ON events(date);
        CREATE INDEX IF NOT EXISTS event_match ON events(venue_id,headliner_id,date);
        CREATE TABLE IF NOT EXISTS event_artists (event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, position INTEGER NOT NULL, artist_id INTEGER NOT NULL REFERENCES artists(id) DEFERRABLE INITIALLY DEFERRED, PRIMARY KEY(event_id,position)) STRICT;
        CREATE TABLE IF NOT EXISTS sources (event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, position INTEGER NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT, url TEXT, session TEXT, PRIMARY KEY(event_id,position)) STRICT;
        CREATE INDEX IF NOT EXISTS source_identity ON sources(kind,source_id,external_id,session);
        CREATE INDEX IF NOT EXISTS source_url ON sources(kind,source_id,url,session);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS redirects (position INTEGER PRIMARY KEY, payload TEXT NOT NULL) STRICT;
        PRAGMA user_version=1;`);
    }
    if (Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 1)
      throw new Error("Unsupported shared ledger database schema.");
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal")
      throw new Error("The shared ledger requires WAL mode.");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Wait without blocking other async writers in this process. SQLite releases locks on crashes. */
async function beginWrite(db: DatabaseSync): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/locked|busy/iu.test(error.message) ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
}

/** Serialize all import, repair and export operations against the shared database. */
export async function withStoreTransaction<T>(
  path: string,
  work: () => Promise<T>,
  create = false
): Promise<T> {
  const active = sessions.getStore();
  if (active?.path === resolve(path)) return work();
  const db = openStore(path, create);
  try {
    await beginWrite(db);
    const result = await sessions.run({ path: resolve(path), db }, work);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function readFrom(db: DatabaseSync, path: string): IngestionLedger {
  const meta = db
    .prepare("SELECT generation,digest,payload FROM metadata WHERE id=1")
    .get();
  if (!meta)
    throw new Error(
      "Shared ledger is uninitialized; explicit migration or restore is required."
    );
  const ledger = JSON.parse(String(meta.payload)) as IngestionLedger;
  for (const table of [
    "events",
    "artists",
    "venues",
    "runs",
    "redirects",
  ] as const) {
    const records = db
      .prepare(`SELECT payload FROM ${table} ORDER BY position`)
      .all()
      .map((row) => JSON.parse(String(row.payload)));
    Object.assign(ledger, { [table]: records });
  }
  if (ledgerDigest(ledger) !== meta.digest)
    throw new Error("Shared ledger content checksum mismatch.");
  revisions.set(ledger, {
    path: resolve(path),
    generation: Number(meta.generation),
  });
  return ledger;
}

/** Read every table from the same committed revision. */
export function readSqliteLedger(path: string): IngestionLedger {
  const active = sessions.getStore();
  if (active?.path === resolve(path)) return readFrom(active.db, path);
  const db = openStore(path);
  try {
    db.exec("BEGIN");
    const ledger = readFrom(db, path);
    db.exec("COMMIT");
    return ledger;
  } finally {
    db.close();
  }
}

function writeTo(
  db: DatabaseSync,
  path: string,
  ledger: IngestionLedger,
  initialize: boolean
): void {
  const current = db
    .prepare("SELECT generation,digest FROM metadata WHERE id=1")
    .get();
  const revision = revisions.get(ledger);
  if (initialize && current)
    throw new Error(
      "Shared ledger already exists; migration cannot overwrite it."
    );
  if (!initialize && !current)
    throw new Error("Shared ledger must be initialized explicitly.");
  if (
    !initialize &&
    ((sessions.getStore()?.path !== resolve(path) && !revision) ||
      (revision &&
        (revision.path !== resolve(path) ||
          revision.generation !== Number(current?.generation))))
  )
    throw new Error(
      "Stale or unversioned ledger write rejected; reload and reapply the change."
    );
  const digest = ledgerDigest(ledger);
  if (current?.digest === digest) return;
  const generation = Number(current?.generation || 0) + 1;
  const { events, artists, venues, runs, redirects, ...header } = ledger;
  // Rows are compared before writing: unchanged event payloads never enter the WAL.
  for (const [table, records] of [
    ["artists", artists],
    ["venues", venues],
    ["events", events],
    ["runs", runs],
  ] as const) {
    const existing = new Map(
      db
        .prepare(`SELECT id,position,payload FROM ${table}`)
        .all()
        .map((row) => [String(row.id), row])
    );
    records.forEach((record, position) => {
      const id = "id" in record ? record.id : record.runId;
      const payload = canonicalJson(record);
      const previous = existing.get(String(id));
      existing.delete(String(id));
      if (
        previous?.payload === payload &&
        Number(previous.position) === position
      )
        return;
      if (table === "events") {
        const event = record as IngestionLedger["events"][number];
        db.prepare(
          "INSERT INTO events VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,date=excluded.date,venue_id=excluded.venue_id,headliner_id=excluded.headliner_id,payload=excluded.payload"
        ).run(
          event.id,
          position,
          event.date,
          event.venueId,
          event.headlinerArtistId,
          payload
        );
        db.prepare("DELETE FROM sources WHERE event_id=?").run(event.id);
        db.prepare("DELETE FROM event_artists WHERE event_id=?").run(event.id);
        const sourceInsert = db.prepare(
          "INSERT INTO sources VALUES (?,?,?,?,?,?,?)"
        );
        event.sources.forEach((source, index) =>
          sourceInsert.run(
            event.id,
            index,
            source.kind,
            source.sourceId,
            source.externalEventId,
            source.canonicalUrl,
            source.session
          )
        );
        const artistInsert = db.prepare(
          "INSERT INTO event_artists VALUES (?,?,?)"
        );
        event.artistIds.forEach((artist, index) =>
          artistInsert.run(event.id, index, artist)
        );
      } else {
        db.prepare(
          `INSERT INTO ${table} VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,payload=excluded.payload`
        ).run(id, position, payload);
      }
    });
    for (const id of existing.keys())
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(
        table === "runs" ? id : Number(id)
      );
  }
  db.exec("DELETE FROM redirects");
  const redirectInsert = db.prepare("INSERT INTO redirects VALUES (?,?)");
  redirects.forEach((record, index) =>
    redirectInsert.run(index, canonicalJson(record))
  );
  db.prepare(
    "INSERT INTO metadata VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,digest=excluded.digest,payload=excluded.payload"
  ).run(generation, digest, canonicalJson(header));
  revisions.set(ledger, { path: resolve(path), generation });
}

/** Commit a validated ledger and its receipts together, rejecting stale standalone writes. */
export async function writeSqliteLedger(
  path: string,
  ledger: IngestionLedger,
  initialize = false
): Promise<void> {
  const active = sessions.getStore();
  if (active?.path === resolve(path)) {
    writeTo(active.db, path, ledger, initialize);
    return;
  }
  const db = openStore(path, initialize);
  try {
    await beginWrite(db);
    writeTo(db, path, ledger, initialize);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

/** Integrity checks supplement application schema and content checksums. */
export function checkStore(path: string): void {
  const db = openStore(path);
  try {
    if (
      db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Shared ledger integrity validation failed.");
  } finally {
    db.close();
  }
}
