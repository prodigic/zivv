import { randomUUID, createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { secureOperatorDirectory } from "./encrypted-backup.js";
import { canonicalJson } from "./sqlite-store.js";
import {
  parseWeeklyRunState,
  transitionWeeklyRun,
  type WeeklyRunState,
  type WeeklyRunStage,
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
  private guardedLease: WeeklyRunLease | null = null;

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
          ([1, 2].includes(schema) && application === 1514759762) ||
          (schema === 0 && application === 0 && tables === 0)
        )
      )
        throw new Error("Unsupported or uninitialized journal schema");
      if (schema > 0) {
        const names = this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          )
          .all()
          .map((row) => String(row.name));
        const expected =
          schema === 1
            ? ["ownership", "run_state"]
            : ["ownership", "run_state", "stage_artifact"];
        if (canonicalJson(names) !== canonicalJson(expected))
          throw new Error("Unsupported journal tables");
      }
      if (schema === 0) {
        this.db
          .exec(`CREATE TABLE ownership(scope TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence BETWEEN 1 AND 9007199254740991), expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 0 AND 9007199254740991)) STRICT;
          CREATE TABLE run_state(id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES ownership(scope), revision INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
          PRAGMA application_id=1514759762;
          PRAGMA user_version=1;`);
      }
      if (schema < 2) {
        this.db
          .exec(`CREATE TABLE stage_artifact(run_id TEXT NOT NULL REFERENCES run_state(id), stage TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 9007199254740991), identity TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(run_id,stage,attempt)) STRICT;
          PRAGMA user_version=2;`);
      }
      if (this.db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Corrupt journal references");
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
    if (
      this.guardedLease &&
      this.guardedLease.scope === lease.scope &&
      this.guardedLease.owner === lease.owner &&
      this.guardedLease.fence === lease.fence
    ) {
      this.assertLease(lease);
      return;
    }
    this.transaction(() => this.assertLease(lease));
  }

  /** Prevent another process taking ownership while a guarded catalog commit finishes. */
  async guardOperation<T>(
    lease: WeeklyRunLease,
    work: () => Promise<T>
  ): Promise<T> {
    if (this.guardedLease || this.db.isTransaction)
      throw new Error("Nested guarded journal operation refused");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertLease(lease);
      this.guardedLease = { ...lease };
      const result = await work();
      this.assertLease(lease);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.guardedLease = null;
    }
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
    const work = () => {
      this.assertLease(lease);
      const expiresAtEpochMs = this.now() + ttlMs;
      if (!Number.isSafeInteger(expiresAtEpochMs))
        throw new Error("Ownership expiry overflow");
      this.db
        .prepare("UPDATE ownership SET expires_at=? WHERE scope=?")
        .run(expiresAtEpochMs, lease.scope);
      return { ...lease, expiresAtEpochMs };
    };
    if (
      this.guardedLease &&
      this.guardedLease.scope === lease.scope &&
      this.guardedLease.owner === lease.owner &&
      this.guardedLease.fence === lease.fence
    )
      return work();
    return this.transaction(work);
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

  loadOwned(runId: string, lease: WeeklyRunLease): WeeklyRunState {
    return this.transaction(() => {
      this.assertLease(lease);
      const row = this.db
        .prepare("SELECT scope FROM run_state WHERE id=?")
        .get(runId);
      const state = this.load(runId);
      if (!row || row.scope !== lease.scope || !state)
        throw new Error("Missing run or wrong destination");
      return state;
    });
  }

  /** Inspect persisted delivery identities before selecting or resuming a run. */
  findDelivery(
    scope: string,
    editionId: string,
    deliveryId: string
  ): WeeklyRunState[] {
    return this.db
      .prepare("SELECT id FROM run_state WHERE scope=?")
      .all(scope)
      .map((row) => this.load(String(row.id))!)
      .filter(
        (state) =>
          state.source.editionId === editionId &&
          state.source.deliveryId === deliveryId
      );
  }

  readArtifact(
    runId: string,
    stage: WeeklyRunStage,
    attempt: number
  ): Buffer | null {
    const row = this.db
      .prepare(
        "SELECT identity,bytes FROM stage_artifact WHERE run_id=? AND stage=? AND attempt=?"
      )
      .get(runId, stage, attempt);
    if (!row) return null;
    if (typeof row.identity !== "string" || !(row.bytes instanceof Uint8Array))
      throw new Error("Corrupt stage artifact");
    const bytes = Buffer.from(row.bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== row.identity)
      throw new Error("Changed stage artifact");
    return bytes;
  }

  private insertArtifact(
    runId: string,
    stage: WeeklyRunStage,
    attempt: number,
    bytes: Buffer
  ): void {
    if (bytes.length > 64 * 1024 * 1024)
      throw new Error("Stage artifact exceeds private evidence limit");
    const existing = this.readArtifact(runId, stage, attempt);
    if (existing) {
      if (!existing.equals(bytes))
        throw new Error("Stage artifact differs; refusing overwrite");
      return;
    }
    this.db
      .prepare("INSERT INTO stage_artifact VALUES(?,?,?,?,?)")
      .run(
        runId,
        stage,
        attempt,
        createHash("sha256").update(bytes).digest("hex"),
        bytes
      );
  }

  /** Immutable per-attempt evidence; a failed attempt remains available after retry. */
  writeArtifact(
    runId: string,
    stage: WeeklyRunStage,
    bytes: Buffer,
    lease: WeeklyRunLease
  ): void {
    const captured = Buffer.from(bytes);
    this.transaction(() => {
      this.assertLease(lease);
      const row = this.db
        .prepare("SELECT scope FROM run_state WHERE id=?")
        .get(runId);
      const state = this.load(runId);
      const item = state?.stages.find((value) => value.stage === stage);
      if (
        !row ||
        row.scope !== lease.scope ||
        !item ||
        item.status !== "running"
      )
        throw new Error("Artifact requires owned running stage");
      this.insertArtifact(runId, stage, item.attempt, captured);
      this.assertLease(lease);
    });
  }

  create(
    state: WeeklyRunState,
    lease: WeeklyRunLease,
    rawSource?: Buffer
  ): WeeklyRunState {
    const validated = parseWeeklyRunState(state);
    const raw = rawSource ? Buffer.from(rawSource) : undefined;
    if (
      raw &&
      createHash("sha256").update(raw).digest("hex") !==
        validated.source.rawSha256
    )
      throw new Error("Raw source disagrees with run identity");
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
      if (existing) {
        if (
          raw &&
          !this.readArtifact(existing.runId, "acquire", 0)?.equals(raw)
        )
          throw new Error("Existing persisted source disagrees");
        return existing;
      }
      this.db
        .prepare("INSERT INTO run_state VALUES(?,?,?,?)")
        .run(validated.runId, lease.scope, 0, canonicalJson(validated));
      if (raw) this.insertArtifact(validated.runId, "acquire", 0, raw);
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
