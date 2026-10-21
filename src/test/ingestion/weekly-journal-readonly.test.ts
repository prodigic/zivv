import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
  WeeklyRunJournal,
} from "../../lib/ingestion/weekly-run-journal.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { createWeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";

const roots: string[] = [];
const source = {
  editionId: "2026-10-16",
  deliveryId: "readonly-fixture",
  rawSha256: "a".repeat(64),
  rulesSha256: "b".repeat(64),
  importObservedAtEpochMs: 1000,
};
const owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zivv-journal-readonly-"));
  roots.push(root);
  const directory = join(root, "operator");
  mkdirSync(directory);
  const path = join(directory, "weekly-runs.sqlite");
  const state = createWeeklyRunState(source);
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE ownership(scope TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence BETWEEN 1 AND 9007199254740991), expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 0 AND 9007199254740991)) STRICT;
      CREATE TABLE run_state(id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES ownership(scope), revision INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
      CREATE TABLE stage_artifact(run_id TEXT NOT NULL REFERENCES run_state(id), stage TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 9007199254740991), identity TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(run_id,stage,attempt)) STRICT;
      CREATE TABLE intake_evidence(scope TEXT NOT NULL REFERENCES ownership(scope), kind TEXT NOT NULL CHECK(kind IN ('source','correction')), id TEXT NOT NULL CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'), identity TEXT NOT NULL CHECK(length(identity)=64 AND identity NOT GLOB '*[^0-9a-f]*'), bytes BLOB NOT NULL CHECK(length(bytes)<=8388608), PRIMARY KEY(scope,kind,id)) STRICT;
      PRAGMA application_id=1514759762; PRAGMA user_version=3;
      INSERT INTO ownership VALUES('prodigic/zivv/production','${owner}',7,12000);`);
    db.prepare("INSERT INTO run_state VALUES(?,?,?,?)").run(
      state.runId,
      "prodigic/zivv/production",
      state.revision,
      canonicalJson(state)
    );
  } finally {
    db.close();
  }
  const body = {
    format: "zivv-weekly-journal-recovery",
    version: 1,
    journalSchemaVersion: 3,
    ownership: [
      {
        scope: "prodigic/zivv/production",
        owner,
        fence: 7,
        expiresAtEpochMs: 12000,
      },
    ],
    runState: [
      {
        id: state.runId,
        scope: "prodigic/zivv/production",
        revision: state.revision,
        payload: canonicalJson(state),
      },
    ],
    stageArtifacts: [],
    intakeEvidence: [],
  };
  const expected = Buffer.from(
    canonicalJson({
      ...body,
      digest: createHash("sha256").update(canonicalJson(body)).digest("hex"),
    }) + "\n"
  );
  return { root, directory, path, state, expected };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), "zivv-journal-readonly-")))
      throw new Error("Unsafe journal fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("read-only weekly journal recovery snapshot", () => {
  it("returns the canonical validated schema-3 recovery export", () => {
    const { path, expected } = fixture();
    expect(readWeeklyJournalRecoverySnapshotReadOnly(path)).toEqual(expected);
    expect(validateWeeklyJournalRecoverySnapshot(expected).format).toBe(
      "zivv-weekly-journal-recovery"
    );
  });

  it("matches a live export and remains readable after operator retirement", () => {
    const root = mkdtempSync(join(tmpdir(), "zivv-journal-readonly-live-"));
    roots.push(root);
    const operator = join(root, "operator");
    const journal = new WeeklyRunJournal(operator, () => 2000);
    const lease = journal.acquire("prodigic/zivv/production");
    const raw = Buffer.from("genuine retained source bytes\n");
    const state = createWeeklyRunState({
      ...source,
      deliveryId: "live-readonly-fixture",
      rawSha256: createHash("sha256").update(raw).digest("hex"),
    });
    journal.create(state, lease, raw);
    const path = join(operator, "weekly-runs.sqlite");
    const expected = journal.exportRecoverySnapshot(lease);

    writeFileSync(join(operator, "operator-retired.json"), "retired\n");
    expect(() => new WeeklyRunJournal(operator)).toThrow();
    journal.close();

    expect(readWeeklyJournalRecoverySnapshotReadOnly(path)).toEqual(expected);
  });

  it("does not create a missing database", () => {
    const root = mkdtempSync(join(tmpdir(), "zivv-journal-readonly-"));
    roots.push(root);
    const directory = join(root, "operator");
    mkdirSync(directory);
    const path = join(directory, "missing.sqlite");

    expect(() => readWeeklyJournalRecoverySnapshotReadOnly(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a hard-linked database file", () => {
    const { root, path } = fixture();
    const hardlink = join(root, "linked-weekly-runs.sqlite");
    linkSync(path, hardlink);

    expect(() => readWeeklyJournalRecoverySnapshotReadOnly(hardlink)).toThrow(
      `SQLite file must be regular and unlinked: ${hardlink}`
    );
  });

  it("refuses a hard-linked WAL sidecar", () => {
    const { root, path } = fixture();
    const wal = path + "-wal";
    writeFileSync(wal, "disposable WAL placeholder");
    linkSync(wal, join(root, "linked-wal-placeholder"));

    expect(() => readWeeklyJournalRecoverySnapshotReadOnly(path)).toThrow(
      `SQLite file must be regular and unlinked: ${wal}`
    );
  });

  it("refuses a hard-linked SHM sidecar", () => {
    const { root, path } = fixture();
    const shm = path + "-shm";
    writeFileSync(shm, "disposable SHM placeholder");
    linkSync(shm, join(root, "linked-shm-placeholder"));

    expect(() => readWeeklyJournalRecoverySnapshotReadOnly(path)).toThrow(
      `SQLite file must be regular and unlinked: ${shm}`
    );
  });

  it("refuses a junction or symlink as a parent directory", () => {
    const { root, directory, path } = fixture();
    const linkedParent = join(root, "linked-operator");
    symlinkSync(directory, linkedParent, "junction");
    try {
      expect(() =>
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(linkedParent, "weekly-runs.sqlite")
        )
      ).toThrow(`SQLite parent directory must not be linked: ${linkedParent}`);
    } finally {
      rmdirSync(linkedParent);
    }
    expect(readWeeklyJournalRecoverySnapshotReadOnly(path)).toBeInstanceOf(
      Buffer
    );
  });

  it("rejects an unsupported schema without migrating it", () => {
    const root = mkdtempSync(join(tmpdir(), "zivv-journal-readonly-"));
    roots.push(root);
    const directory = join(root, "operator");
    mkdirSync(directory);
    const path = join(directory, "wrong.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE unrelated(value TEXT); PRAGMA user_version=1;");
    db.close();

    expect(() => readWeeklyJournalRecoverySnapshotReadOnly(path)).toThrow(
      "Unsupported journal recovery schema"
    );
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(
        check
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => row.name)
      ).toEqual(["unrelated"]);
    } finally {
      check.close();
    }
  });

  it("rejects a changed stage artifact", () => {
    const { path, state } = fixture();
    const db = new DatabaseSync(path);
    try {
      db.prepare(
        "INSERT INTO stage_artifact(run_id,stage,attempt,identity,bytes) VALUES(?,?,?,?,?)"
      ).run(
        state.runId,
        "acquire",
        0,
        "c".repeat(64),
        Buffer.from("original artifact")
      );
      db.prepare("UPDATE stage_artifact SET bytes=?").run(
        Buffer.from("altered artifact")
      );
    } finally {
      db.close();
    }

    expect(() => readWeeklyJournalRecoverySnapshotReadOnly(path)).toThrow(
      "Invalid weekly journal recovery snapshot"
    );
  });
});
