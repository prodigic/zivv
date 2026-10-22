import { randomUUID, createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { secureOperatorDirectory } from "./encrypted-backup.js";
import { canonicalJson } from "./sqlite-store.js";
import { assertOperatorInstallationWritable } from "./operator-installation.js";
import { assertReadOnlySqliteFiles } from "./readonly-sqlite-files.js";
import {
  WEEKLY_RUN_STAGES,
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

export type WeeklyIntakeEvidenceKind = "source" | "correction";
const maxIntakeEvidenceBytes = 8 * 1024 * 1024;
const maxRecoveryBytes = 256 * 1024 * 1024;
const maxRecoveryRows = 100000;
const productionScope = "prodigic/zivv/production";

/** Logical schema-3 recovery data. Evidence strings encode exact bytes as canonical base64. */
export interface WeeklyJournalRecoverySnapshot {
  format: "zivv-weekly-journal-recovery";
  version: 1;
  journalSchemaVersion: 3;
  digest: string;
  ownership: {
    scope: string;
    owner: string;
    fence: number;
    expiresAtEpochMs: number;
  }[];
  runState: { id: string; scope: string; revision: number; payload: string }[];
  stageArtifacts: {
    runId: string;
    stage: WeeklyRunStage;
    attempt: number;
    identity: string;
    bytes: string;
  }[];
  intakeEvidence: {
    scope: string;
    kind: WeeklyIntakeEvidenceKind;
    id: string;
    identity: string;
    bytes: string;
  }[];
}

function recoveryFailure(): never {
  throw new Error("Invalid weekly journal recovery snapshot");
}
function recoveryObject(
  value: unknown,
  keys: string[]
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort())
  )
    recoveryFailure();
  return value as Record<string, unknown>;
}
function recoveryArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > maxRecoveryRows)
    recoveryFailure();
  return value;
}
function recoveryInteger(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}
function recoveryHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function recoveryScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value)
  );
}
function recoveryOrder(keys: string[]): void {
  if (keys.some((key, index) => index > 0 && key <= keys[index - 1]))
    recoveryFailure();
}
function recoveryEvidence(
  value: unknown,
  identity: unknown,
  maximum: number
): Buffer {
  if (
    typeof value !== "string" ||
    !recoveryHash(identity) ||
    value.length > Math.ceil(maximum / 3) * 4
  )
    recoveryFailure();
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length > maximum ||
    bytes.toString("base64") !== value ||
    createHash("sha256").update(bytes).digest("hex") !== identity
  )
    recoveryFailure();
  return bytes;
}
function recoveryBytes(input: unknown): Buffer {
  const body = recoveryObject(input, [
    "format",
    "version",
    "journalSchemaVersion",
    "ownership",
    "runState",
    "stageArtifacts",
    "intakeEvidence",
  ]);
  const bytes = Buffer.from(
    canonicalJson({
      ...body,
      digest: createHash("sha256").update(canonicalJson(body)).digest("hex"),
    }) + "\n"
  );
  if (bytes.length > maxRecoveryBytes) recoveryFailure();
  return bytes;
}

function assertRecoveryDatabase(db: DatabaseSync): void {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);
  if (
    db.prepare("PRAGMA user_version").get()?.user_version !== 3 ||
    db.prepare("PRAGMA application_id").get()?.application_id !== 1514759762 ||
    canonicalJson(names) !==
      canonicalJson([
        "intake_evidence",
        "ownership",
        "run_state",
        "stage_artifact",
      ])
  )
    throw new Error("Unsupported journal recovery schema");
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (
    integrity.length !== 1 ||
    integrity[0].integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("Corrupt journal recovery database");
}

function recoverySnapshot(db: DatabaseSync): Buffer {
  for (const table of [
    "ownership",
    "run_state",
    "stage_artifact",
    "intake_evidence",
  ])
    if (
      Number(
        db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total
      ) > maxRecoveryRows
    )
      recoveryFailure();
  const size = db
    .prepare(
      "SELECT (SELECT COALESCE(SUM(length(payload)),0) FROM run_state)+(SELECT COALESCE(SUM(length(bytes)),0) FROM stage_artifact)+(SELECT COALESCE(SUM(length(bytes)),0) FROM intake_evidence) AS total"
    )
    .get()?.total;
  if (!recoveryInteger(size) || size > (maxRecoveryBytes * 3) / 4)
    recoveryFailure();
  const encode = (
    row: Record<string, string | number | bigint | Uint8Array | null>
  ) => {
    if (!(row.bytes instanceof Uint8Array)) recoveryFailure();
    return { ...row, bytes: Buffer.from(row.bytes).toString("base64") };
  };
  const bytes = recoveryBytes({
    format: "zivv-weekly-journal-recovery",
    version: 1,
    journalSchemaVersion: 3,
    ownership: db
      .prepare(
        "SELECT scope,owner,fence,expires_at AS expiresAtEpochMs FROM ownership ORDER BY scope"
      )
      .all(),
    runState: db
      .prepare("SELECT id,scope,revision,payload FROM run_state ORDER BY id")
      .all(),
    stageArtifacts: db
      .prepare(
        "SELECT run_id AS runId,stage,attempt,identity,bytes FROM stage_artifact ORDER BY run_id,stage,attempt"
      )
      .all()
      .map(encode),
    intakeEvidence: db
      .prepare(
        "SELECT scope,kind,id,identity,bytes FROM intake_evidence ORDER BY scope,kind,id"
      )
      .all()
      .map(encode),
  });
  validateWeeklyJournalRecoverySnapshot(bytes);
  return bytes;
}

/** Read a validated schema-3 journal snapshot without constructing a writer or migrating storage. */
export function readWeeklyJournalRecoverySnapshotReadOnly(
  path: string
): Buffer {
  const absolute = resolve(path);
  const fileSnapshot = assertReadOnlySqliteFiles(absolute);
  const db = new DatabaseSync(absolute, { readOnly: true });
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN;");
    assertRecoveryDatabase(db);
    const bytes = recoverySnapshot(db);
    db.exec("ROLLBACK;");
    assertReadOnlySqliteFiles(absolute, fileSnapshot);
    return bytes;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.close();
  }
}

/** Validate the entire opaque snapshot before a recovery orchestrator uses its rows. */
export function validateWeeklyJournalRecoverySnapshot(
  bytes: Buffer
): WeeklyJournalRecoverySnapshot {
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > maxRecoveryBytes
  )
    recoveryFailure();
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const value = recoveryObject(JSON.parse(text) as unknown, [
    "format",
    "version",
    "journalSchemaVersion",
    "digest",
    "ownership",
    "runState",
    "stageArtifacts",
    "intakeEvidence",
  ]);
  if (
    value.format !== "zivv-weekly-journal-recovery" ||
    value.version !== 1 ||
    value.journalSchemaVersion !== 3 ||
    !recoveryHash(value.digest) ||
    canonicalJson(value) + "\n" !== text
  )
    recoveryFailure();
  const { digest, ...body } = value;
  if (createHash("sha256").update(canonicalJson(body)).digest("hex") !== digest)
    recoveryFailure();
  const owners = new Set<string>();
  const ownership = recoveryArray(value.ownership).map((item) => {
    const row = recoveryObject(item, [
      "scope",
      "owner",
      "fence",
      "expiresAtEpochMs",
    ]);
    if (
      !recoveryScope(row.scope) ||
      typeof row.owner !== "string" ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(row.owner) ||
      !recoveryInteger(row.fence, 1) ||
      !recoveryInteger(row.expiresAtEpochMs)
    )
      recoveryFailure();
    owners.add(row.scope);
    return row as unknown as WeeklyJournalRecoverySnapshot["ownership"][number];
  });
  recoveryOrder(ownership.map((row) => row.scope));
  if (!owners.has(productionScope)) recoveryFailure();
  const states = new Map<string, WeeklyRunState>();
  const runState = recoveryArray(value.runState).map((item) => {
    const row = recoveryObject(item, ["id", "scope", "revision", "payload"]);
    if (
      !recoveryHash(row.id) ||
      !recoveryScope(row.scope) ||
      !owners.has(row.scope) ||
      !recoveryInteger(row.revision) ||
      typeof row.payload !== "string"
    )
      recoveryFailure();
    const state = parseWeeklyRunState(JSON.parse(row.payload) as unknown);
    if (
      state.runId !== row.id ||
      state.revision !== row.revision ||
      canonicalJson(state) !== row.payload
    )
      recoveryFailure();
    states.set(row.id, state);
    return row as unknown as WeeklyJournalRecoverySnapshot["runState"][number];
  });
  recoveryOrder(runState.map((row) => row.id));
  const stageArtifacts = recoveryArray(value.stageArtifacts).map((item) => {
    const row = recoveryObject(item, [
      "runId",
      "stage",
      "attempt",
      "identity",
      "bytes",
    ]);
    if (
      !recoveryHash(row.runId) ||
      typeof row.stage !== "string" ||
      !WEEKLY_RUN_STAGES.includes(row.stage as WeeklyRunStage) ||
      !recoveryInteger(row.attempt)
    )
      recoveryFailure();
    const state = states.get(row.runId),
      stage = state?.stages.find((item) => item.stage === row.stage);
    if (
      !state ||
      !stage ||
      (row.attempt === 0
        ? row.stage !== "acquire"
        : row.attempt > stage.attempt)
    )
      recoveryFailure();
    recoveryEvidence(row.bytes, row.identity, 64 * 1024 * 1024);
    if (row.attempt === 0 && row.identity !== state.source.rawSha256)
      recoveryFailure();
    return row as unknown as WeeklyJournalRecoverySnapshot["stageArtifacts"][number];
  });
  recoveryOrder(
    stageArtifacts.map(
      (row) =>
        `${row.runId}\0${row.stage}\0${String(row.attempt).padStart(16, "0")}`
    )
  );
  const intakeEvidence = recoveryArray(value.intakeEvidence).map((item) => {
    const row = recoveryObject(item, [
      "scope",
      "kind",
      "id",
      "identity",
      "bytes",
    ]);
    if (
      !recoveryScope(row.scope) ||
      !owners.has(row.scope) ||
      typeof row.kind !== "string" ||
      !["source", "correction"].includes(row.kind) ||
      !recoveryHash(row.id)
    )
      recoveryFailure();
    recoveryEvidence(row.bytes, row.identity, maxIntakeEvidenceBytes);
    return row as unknown as WeeklyJournalRecoverySnapshot["intakeEvidence"][number];
  });
  recoveryOrder(
    intakeEvidence.map((row) => `${row.scope}\0${row.kind}\0${row.id}`)
  );
  return {
    format: "zivv-weekly-journal-recovery",
    version: 1,
    journalSchemaVersion: 3,
    digest,
    ownership,
    runState,
    stageArtifacts,
    intakeEvidence,
  };
}

function validateIntakeKey(
  scope: string,
  kind: WeeklyIntakeEvidenceKind,
  id?: string
): void {
  if (
    typeof scope !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(scope) ||
    !["source", "correction"].includes(kind) ||
    (id !== undefined && (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)))
  )
    throw new Error("Invalid intake evidence key");
}

/** Independent private coordination database; does not alter the ingestion catalog. */
export class WeeklyRunJournal {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private guardedLease: WeeklyRunLease | null = null;

  constructor(directory: string, clock: () => number = Date.now) {
    assertOperatorInstallationWritable(resolve(directory));
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
      assertOperatorInstallationWritable(dirname(this.path));
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
          ([1, 2, 3].includes(schema) && application === 1514759762) ||
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
            : schema === 2
              ? ["ownership", "run_state", "stage_artifact"]
              : ["intake_evidence", "ownership", "run_state", "stage_artifact"];
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
      if (schema < 3) {
        this.db
          .exec(`CREATE TABLE intake_evidence(scope TEXT NOT NULL REFERENCES ownership(scope), kind TEXT NOT NULL CHECK(kind IN ('source','correction')), id TEXT NOT NULL CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'), identity TEXT NOT NULL CHECK(length(identity)=64 AND identity NOT GLOB '*[^0-9a-f]*'), bytes BLOB NOT NULL CHECK(length(bytes)<=8388608), PRIMARY KEY(scope,kind,id)) STRICT;
          PRAGMA user_version=3;`);
      }
      const intakeColumns = this.db
        .prepare("PRAGMA table_info(intake_evidence)")
        .all()
        .map((row) => ({
          name: row.name,
          type: row.type,
          notnull: row.notnull,
          pk: row.pk,
        }));
      if (
        canonicalJson(intakeColumns) !==
          canonicalJson([
            { name: "scope", type: "TEXT", notnull: 1, pk: 1 },
            { name: "kind", type: "TEXT", notnull: 1, pk: 2 },
            { name: "id", type: "TEXT", notnull: 1, pk: 3 },
            { name: "identity", type: "TEXT", notnull: 1, pk: 0 },
            { name: "bytes", type: "BLOB", notnull: 1, pk: 0 },
          ]) ||
        this.db.prepare("PRAGMA table_list('intake_evidence')").get()
          ?.strict !== 1
      )
        throw new Error("Unsupported intake evidence schema");
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

  private assertRecoveryDatabase(): void {
    assertRecoveryDatabase(this.db);
  }

  private recoverySnapshot(): Buffer {
    return recoverySnapshot(this.db);
  }

  /** Capture all committed evidence under the valid production owner, borrowing its guard if present. */
  exportRecoverySnapshot(lease: WeeklyRunLease): Buffer {
    if (lease.scope !== productionScope)
      throw new Error("Journal recovery requires production ownership");
    const work = () => {
      this.assertLease(lease);
      this.assertRecoveryDatabase();
      const bytes = this.recoverySnapshot();
      this.assertLease(lease);
      return bytes;
    };
    if (this.guardedLease) {
      if (
        this.guardedLease.scope !== lease.scope ||
        this.guardedLease.owner !== lease.owner ||
        this.guardedLease.fence !== lease.fence
      )
        throw new Error("Wrong guarded recovery owner");
      return work();
    }
    if (this.db.isTransaction)
      throw new Error("Nested journal recovery export refused");
    return this.transaction(work);
  }

  /** Restore only into an empty journal. Expiry clearing does not fence another machine. */
  restoreRecoverySnapshot(bytes: Buffer): void {
    const snapshot = validateWeeklyJournalRecoverySnapshot(bytes);
    if (this.guardedLease || this.db.isTransaction)
      throw new Error("Nested journal recovery restore refused");
    this.transaction(() => {
      this.assertRecoveryDatabase();
      for (const table of [
        "ownership",
        "run_state",
        "stage_artifact",
        "intake_evidence",
      ])
        if (this.db.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get())
          throw new Error("Journal recovery destination must be empty");
      const ownership = this.db.prepare(
        "INSERT INTO ownership(scope,owner,fence,expires_at) VALUES(?,?,?,0)"
      );
      for (const row of snapshot.ownership)
        ownership.run(row.scope, row.owner, row.fence);
      const state = this.db.prepare(
        "INSERT INTO run_state(id,scope,revision,payload) VALUES(?,?,?,?)"
      );
      for (const row of snapshot.runState)
        state.run(row.id, row.scope, row.revision, row.payload);
      const artifact = this.db.prepare(
        "INSERT INTO stage_artifact(run_id,stage,attempt,identity,bytes) VALUES(?,?,?,?,?)"
      );
      for (const row of snapshot.stageArtifacts)
        artifact.run(
          row.runId,
          row.stage,
          row.attempt,
          row.identity,
          Buffer.from(row.bytes, "base64")
        );
      const intake = this.db.prepare(
        "INSERT INTO intake_evidence(scope,kind,id,identity,bytes) VALUES(?,?,?,?,?)"
      );
      for (const row of snapshot.intakeEvidence)
        intake.run(
          row.scope,
          row.kind,
          row.id,
          row.identity,
          Buffer.from(row.bytes, "base64")
        );
      this.assertRecoveryDatabase();
      const expected: Record<string, unknown> = {
        ...snapshot,
        ownership: snapshot.ownership.map((row) => ({
          ...row,
          expiresAtEpochMs: 0,
        })),
      };
      delete expected.digest;
      if (!this.recoverySnapshot().equals(recoveryBytes(expected)))
        throw new Error("Journal recovery readback differs");
    });
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
    assertOperatorInstallationWritable(dirname(this.path));
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
    assertOperatorInstallationWritable(dirname(this.path));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertOperatorInstallationWritable(dirname(this.path));
      const result = work();
      assertOperatorInstallationWritable(dirname(this.path));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertLease(lease: WeeklyRunLease): void {
    assertOperatorInstallationWritable(dirname(this.path));
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

  listRuns(scope: string): WeeklyRunState[] {
    return this.db
      .prepare("SELECT id FROM run_state WHERE scope=? ORDER BY id")
      .all(scope)
      .map((row) => this.load(String(row.id))!);
  }

  private intakeEvidence(
    row: Record<string, string | number | bigint | Uint8Array | null>
  ): { id: string; bytes: Buffer } {
    if (
      typeof row.scope !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(row.scope) ||
      !["source", "correction"].includes(String(row.kind)) ||
      typeof row.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.id) ||
      typeof row.identity !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.identity) ||
      !(row.bytes instanceof Uint8Array) ||
      row.bytes.length > maxIntakeEvidenceBytes
    )
      throw new Error("Corrupt intake evidence");
    const bytes = Buffer.from(row.bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== row.identity)
      throw new Error("Changed intake evidence");
    return { id: row.id, bytes };
  }

  /** Read immutable acquisition evidence; callers may already hold a guarded operation. */
  readIntakeEvidence(
    scope: string,
    kind: WeeklyIntakeEvidenceKind,
    id: string
  ): Buffer | null {
    validateIntakeKey(scope, kind, id);
    const row = this.db
      .prepare(
        "SELECT scope,kind,id,identity,bytes FROM intake_evidence WHERE scope=? AND kind=? AND id=?"
      )
      .get(scope, kind, id);
    return row ? this.intakeEvidence(row).bytes : null;
  }

  /** Enumerate and verify all retained acquisition evidence for a destination and kind. */
  listIntakeEvidence(
    scope: string,
    kind: WeeklyIntakeEvidenceKind
  ): { id: string; bytes: Buffer }[] {
    validateIntakeKey(scope, kind);
    return this.db
      .prepare(
        "SELECT scope,kind,id,identity,bytes FROM intake_evidence WHERE scope=? AND kind=? ORDER BY id"
      )
      .all(scope, kind)
      .map((row) => this.intakeEvidence(row));
  }

  /** Commit intake intent before external file effects. Exact replay preserves its first bytes. */
  saveIntakeEvidence(
    kind: WeeklyIntakeEvidenceKind,
    id: string,
    bytes: Buffer,
    lease: WeeklyRunLease
  ): Buffer {
    validateIntakeKey(lease.scope, kind, id);
    if (!Buffer.isBuffer(bytes) || bytes.length > maxIntakeEvidenceBytes)
      throw new Error("Intake evidence exceeds private evidence limit");
    if (this.guardedLease || this.db.isTransaction)
      throw new Error("Nested intake evidence write refused");
    const captured = Buffer.from(bytes);
    return this.transaction(() => {
      this.assertLease(lease);
      const existing = this.readIntakeEvidence(lease.scope, kind, id);
      if (existing) {
        if (!existing.equals(captured))
          throw new Error("Intake evidence differs; refusing overwrite");
        this.assertLease(lease);
        return existing;
      }
      this.db
        .prepare(
          "INSERT INTO intake_evidence(scope,kind,id,identity,bytes) VALUES(?,?,?,?,?)"
        )
        .run(
          lease.scope,
          kind,
          id,
          createHash("sha256").update(captured).digest("hex"),
          captured
        );
      this.assertLease(lease);
      return captured;
    });
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
