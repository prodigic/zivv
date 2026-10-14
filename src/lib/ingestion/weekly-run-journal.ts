import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { secureOperatorDirectory } from "./encrypted-backup.js";
import { canonicalJson } from "./sqlite-store.js";
import {
  parseWeeklyRunState,
  transitionWeeklyRun,
  type WeeklyRunState,
} from "./weekly-run-state.js";

export interface WeeklyRunLease {
  scope: string;
  owner: string;
  fence: number;
  expiresAtEpochMs: number;
}

/** Independent private coordination database; does not alter the ingestion catalog. */
export class WeeklyRunJournal {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly clock: () => number;

  constructor(directory: string, clock: () => number = Date.now) {
    this.clock = clock;
    let ancestor = resolve(directory);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const actual = resolve(
      realpathSync(ancestor),
      relative(ancestor, resolve(directory))
    );
    if (actual.startsWith("\\\\"))
      throw new Error("Journal requires local private storage");
    for (let parent = actual; ; parent = dirname(parent)) {
      if (existsSync(join(parent, ".git")))
        throw new Error("Journal must be outside Git repositories");
      if (dirname(parent) === parent) break;
    }
    secureOperatorDirectory(actual);
    this.path = join(actual, "weekly-runs.sqlite");
    for (const path of [this.path, this.path + "-wal", this.path + "-shm"]) {
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("Journal file must not be linked");
    }
    this.db = new DatabaseSync(this.path, { timeout: 10000 });
    try {
      if (process.platform !== "win32") chmodSync(this.path, 0o600);
      this.db.exec(
        "PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;"
      );
      const schema = Number(
        this.db.prepare("PRAGMA user_version").get()?.user_version
      );
      const application = Number(
        this.db.prepare("PRAGMA application_id").get()?.application_id
      );
      const tables = Number(
        this.db
          .prepare(
            "SELECT count(*) AS total FROM sqlite_master WHERE type='table'"
          )
          .get()?.total
      );
      // An empty store can remain after a process dies before schema commit.
      // Inspect under the writer lock, so simultaneous initializers wait.
      if (
        !(
          (schema === 1 && application === 1514759762) ||
          (schema === 0 && application === 0 && tables === 0)
        )
      )
        throw new Error("Unsupported or uninitialized journal schema");
      if (schema === 0) {
        this.db
          .exec(`CREATE TABLE ownership(scope TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence BETWEEN 1 AND 9007199254740991), expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 0 AND 9007199254740991)) STRICT;
          CREATE TABLE run_state(id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES ownership(scope), revision INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
          PRAGMA application_id=1514759762;
          PRAGMA user_version=1;`);
      }
      this.db.exec("COMMIT");
      this.db.exec("PRAGMA journal_mode=WAL;");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Verify an owner immediately before a guarded external/catalog operation. */
  checkOwnership(lease: WeeklyRunLease): void {
    this.transaction(() => this.assertLease(lease));
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("Invalid journal clock");
    return now;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertLease(lease: WeeklyRunLease): void {
    const row = this.db
      .prepare(
        "SELECT scope,owner,fence,expires_at FROM ownership WHERE scope=?"
      )
      .get(lease.scope);
    if (row) this.validateOwner(row);
    if (
      !row ||
      row.owner !== lease.owner ||
      row.fence !== lease.fence ||
      Number(row.expires_at) <= this.now()
    )
      throw new Error("Expired or fenced weekly run owner");
  }

  private validateOwner(
    row: Record<string, string | number | bigint | Uint8Array | null>
  ): void {
    if (
      typeof row.scope !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(row.scope) ||
      typeof row.owner !== "string" ||
      !/^[a-f0-9-]{36}$/.test(row.owner) ||
      typeof row.fence !== "number" ||
      !Number.isSafeInteger(row.fence) ||
      row.fence < 1 ||
      typeof row.expires_at !== "number" ||
      !Number.isSafeInteger(row.expires_at) ||
      row.expires_at < 0
    )
      throw new Error("Corrupt journal ownership row");
  }

  /** Serialize one destination. Takeover after expiry increments the fencing token. */
  acquire(scope: string, ttlMs = 120000): WeeklyRunLease {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(scope) ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1000 ||
      ttlMs > 3600000
    )
      throw new Error("Invalid ownership scope/TTL");
    return this.transaction(() => {
      const now = this.now();
      const old = this.db
        .prepare(
          "SELECT scope,owner,fence,expires_at FROM ownership WHERE scope=?"
        )
        .get(scope);
      if (old) this.validateOwner(old);
      if (old && Number(old.expires_at) > now)
        throw new Error("Weekly destination already has an active owner");
      const lease = {
        scope,
        owner: randomUUID(),
        fence: Number(old?.fence ?? 0) + 1,
        expiresAtEpochMs: now + ttlMs,
      };
      if (
        !Number.isSafeInteger(lease.fence) ||
        !Number.isSafeInteger(lease.expiresAtEpochMs)
      )
        throw new Error("Ownership counter overflow");
      this.db
        .prepare(
          "INSERT INTO ownership VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,expires_at=excluded.expires_at"
        )
        .run(scope, lease.owner, lease.fence, lease.expiresAtEpochMs);
      return lease;
    });
  }

  renew(lease: WeeklyRunLease, ttlMs = 120000): WeeklyRunLease {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000)
      throw new Error("Invalid ownership TTL");
    return this.transaction(() => {
      this.assertLease(lease);
      const expiresAtEpochMs = this.now() + ttlMs;
      if (!Number.isSafeInteger(expiresAtEpochMs))
        throw new Error("Ownership expiry overflow");
      this.db
        .prepare("UPDATE ownership SET expires_at=? WHERE scope=?")
        .run(expiresAtEpochMs, lease.scope);
      return { ...lease, expiresAtEpochMs };
    });
  }

  release(lease: WeeklyRunLease): void {
    this.transaction(() => {
      this.assertLease(lease);
      this.db
        .prepare("UPDATE ownership SET expires_at=0 WHERE scope=?")
        .run(lease.scope);
    });
  }

  load(runId: string): WeeklyRunState | null {
    const row = this.db
      .prepare("SELECT revision,payload FROM run_state WHERE id=?")
      .get(runId);
    if (!row) return null;
    const state = parseWeeklyRunState(JSON.parse(String(row.payload)));
    if (state.runId !== runId || state.revision !== row.revision)
      throw new Error("Corrupt journal row identity/revision");
    return state;
  }

  create(state: WeeklyRunState, lease: WeeklyRunLease): WeeklyRunState {
    const validated = parseWeeklyRunState(state);
    if (validated.revision !== 0)
      throw new Error("New run must begin at revision zero");
    return this.transaction(() => {
      this.assertLease(lease);
      const row = this.db
        .prepare("SELECT scope FROM run_state WHERE id=?")
        .get(validated.runId);
      if (row && row.scope !== lease.scope)
        throw new Error("Run belongs to another destination");
      const existing = this.load(validated.runId);
      if (existing) return existing;
      this.db
        .prepare("INSERT INTO run_state VALUES(?,?,?,?)")
        .run(validated.runId, lease.scope, 0, canonicalJson(validated));
      return validated;
    });
  }

  /** Atomic expected-revision write, accepting exactly one valid state transition. */
  save(
    state: WeeklyRunState,
    expectedRevision: number,
    lease: WeeklyRunLease
  ): WeeklyRunState {
    const validated = parseWeeklyRunState(state);
    return this.transaction(() => {
      this.assertLease(lease);
      const row = this.db
        .prepare("SELECT scope FROM run_state WHERE id=?")
        .get(validated.runId);
      if (!row || row.scope !== lease.scope)
        throw new Error("Missing run or wrong destination");
      const previous = this.load(validated.runId);
      if (
        !previous ||
        previous.revision !== expectedRevision ||
        validated.revision !== expectedRevision + 1
      )
        throw new Error("Stale journal revision");
      const changed = validated.stages.filter(
        (item, index) =>
          canonicalJson(item) !== canonicalJson(previous.stages[index])
      );
      if (changed.length !== 1)
        throw new Error("Journal write must contain one transition");
      const item = changed[0];
      let transition: Parameters<typeof transitionWeeklyRun>[3];
      if (item.status === "running") transition = { status: "running" };
      else if (item.status === "succeeded" && item.evidence)
        transition = { status: "succeeded", evidence: item.evidence };
      else if (
        (item.status === "blocked" || item.status === "failed") &&
        item.errorCode
      )
        transition = { status: item.status, errorCode: item.errorCode };
      else throw new Error("Invalid journal transition");
      const derived = transitionWeeklyRun(
        previous,
        expectedRevision,
        item.stage,
        transition,
        this.now()
      );
      if (canonicalJson(derived) !== canonicalJson(validated))
        throw new Error("Journal history changed");
      this.assertLease(lease);
      this.db
        .prepare(
          "UPDATE run_state SET revision=?,payload=? WHERE id=? AND revision=?"
        )
        .run(
          validated.revision,
          canonicalJson(validated),
          validated.runId,
          expectedRevision
        );
      return validated;
    });
  }
}
