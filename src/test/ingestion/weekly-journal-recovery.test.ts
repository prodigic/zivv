import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WeeklyRunJournal,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
} from "../../lib/ingestion/weekly-run-state.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { DatabaseSync } from "node:sqlite";

const roots: string[] = [];
const journals: WeeklyRunJournal[] = [];
const scope = "prodigic/zivv/production";
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zivv-journal-recovery-test-"));
  roots.push(root);
  const journal = new WeeklyRunJournal(join(root, "operator"), () => 10000);
  journals.push(journal);
  return { root, journal };
}

function populated() {
  const { journal, root } = fixture();
  const lease = journal.acquire(scope);
  const raw = Buffer.from("synthetic private acquisition\n");
  let state = journal.create(
    createWeeklyRunState({
      editionId: "2026-10-16",
      deliveryId: "synthetic-recovery",
      rawSha256: digest(raw),
      rulesSha256: "b".repeat(64),
      importObservedAtEpochMs: 1000,
    }),
    lease,
    raw
  );
  state = journal.save(
    transitionWeeklyRun(
      state,
      state.revision,
      "acquire",
      { status: "running" },
      10000
    ),
    state.revision,
    lease
  );
  journal.writeArtifact(state.runId, "acquire", raw, lease);
  state = journal.save(
    transitionWeeklyRun(
      state,
      state.revision,
      "acquire",
      {
        status: "succeeded",
        evidence: {
          rawSha256: digest(raw),
          deliveryId: state.source.deliveryId,
        },
      },
      10000
    ),
    state.revision,
    lease
  );
  state = journal.save(
    transitionWeeklyRun(
      state,
      state.revision,
      "prepare",
      { status: "running" },
      10000
    ),
    state.revision,
    lease
  );
  journal.writeArtifact(
    state.runId,
    "prepare",
    Buffer.from('{"attempt":1}\n'),
    lease
  );
  state = journal.save(
    transitionWeeklyRun(
      state,
      state.revision,
      "prepare",
      { status: "failed", errorCode: "SYNTHETIC_FAILURE" },
      10000
    ),
    state.revision,
    lease
  );
  state = journal.save(
    transitionWeeklyRun(
      state,
      state.revision,
      "prepare",
      { status: "running" },
      10000
    ),
    state.revision,
    lease
  );
  journal.writeArtifact(
    state.runId,
    "prepare",
    Buffer.from('{"attempt":2}\n'),
    lease
  );
  journal.saveIntakeEvidence(
    "source",
    "c".repeat(64),
    Buffer.from('{"source":"fixture"}\n'),
    lease
  );
  journal.saveIntakeEvidence(
    "correction",
    "c".repeat(64),
    Buffer.from('{"correction":"fixture"}\n'),
    lease
  );
  const preview = journal.acquire("prodigic/zivv/preview");
  journal.release(preview);
  return { root, journal, lease, state, raw };
}

function rewritten(bytes: Buffer, changes: Record<string, unknown>): Buffer {
  const body: Record<string, unknown> = {
    ...validateWeeklyJournalRecoverySnapshot(bytes),
    ...changes,
  };
  delete body.digest;
  return Buffer.from(
    canonicalJson({ ...body, digest: digest(canonicalJson(body)) }) + "\n"
  );
}

function mutateNative(
  journal: WeeklyRunJournal,
  operation: (db: DatabaseSync) => void
) {
  const db = new DatabaseSync(journal.path);
  try {
    operation(db);
  } finally {
    db.close();
  }
}

function expectEmpty(journal: WeeklyRunJournal) {
  const db = new DatabaseSync(journal.path, { readOnly: true });
  try {
    for (const table of [
      "ownership",
      "run_state",
      "stage_artifact",
      "intake_evidence",
    ])
      expect(
        db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total
      ).toBe(0);
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) {
    if (
      !resolve(root).startsWith(
        resolve(tmpdir(), "zivv-journal-recovery-test-")
      )
    )
      throw new Error("Unsafe recovery fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("logical weekly journal recovery", () => {
  it("round-trips exact state and evidence under a guard while expiring restored ownership", async () => {
    const source = populated();
    const bytes = await source.journal.guardOperation(source.lease, async () =>
      source.journal.exportRecoverySnapshot(source.lease)
    );
    const snapshot = validateWeeklyJournalRecoverySnapshot(bytes);
    expect(snapshot.runState[0].payload).toBe(canonicalJson(source.state));
    const destination = fixture().journal;
    destination.restoreRecoverySnapshot(bytes);
    expect(destination.load(source.state.runId)).toEqual(source.state);
    expect(destination.readArtifact(source.state.runId, "acquire", 0)).toEqual(
      source.raw
    );
    expect(
      destination.readArtifact(source.state.runId, "prepare", 1)?.toString()
    ).toBe('{"attempt":1}\n');
    expect(
      destination.readArtifact(source.state.runId, "prepare", 2)?.toString()
    ).toBe('{"attempt":2}\n');
    expect(
      destination
        .readIntakeEvidence(scope, "source", "c".repeat(64))
        ?.toString()
    ).toBe('{"source":"fixture"}\n');
    expect(
      destination
        .readIntakeEvidence(scope, "correction", "c".repeat(64))
        ?.toString()
    ).toBe('{"correction":"fixture"}\n');
    expect(() => destination.checkOwnership(source.lease)).toThrow("fenced");
    const successor = destination.acquire(scope);
    expect(successor.fence).toBe(source.lease.fence + 1);
    expect(destination.acquire("prodigic/zivv/preview").fence).toBe(2);
    // Restoring another local DB does not fence the original installation.
    expect(() => source.journal.checkOwnership(source.lease)).not.toThrow();
  });

  it("requires the current production owner both outside and inside a guard", async () => {
    const source = populated();
    const preview = source.journal.acquire("prodigic/zivv/preview");
    expect(() => source.journal.exportRecoverySnapshot(preview)).toThrow(
      "production"
    );
    expect(() =>
      source.journal.exportRecoverySnapshot({
        ...source.lease,
        owner: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      })
    ).toThrow("fenced");
    await source.journal.guardOperation(preview, async () => {
      expect(() => source.journal.exportRecoverySnapshot(source.lease)).toThrow(
        "guarded recovery owner"
      );
    });
    const first = source.journal.exportRecoverySnapshot(source.lease);
    expect(
      source.journal.exportRecoverySnapshot(source.lease).equals(first)
    ).toBe(true);
    source.journal.release(source.lease);
    expect(() => source.journal.exportRecoverySnapshot(source.lease)).toThrow(
      "fenced"
    );
  });

  it("rejects nonempty destinations including a released ownership row", () => {
    const source = populated();
    const bytes = source.journal.exportRecoverySnapshot(source.lease);
    const destination = fixture().journal;
    const existing = destination.acquire(scope);
    destination.release(existing);
    expect(() => destination.restoreRecoverySnapshot(bytes)).toThrow("empty");
    expect(destination.acquire(scope).fence).toBe(2);
    expect(destination.listRuns(scope)).toEqual([]);
  });

  it("rolls back every restored table if a later native insertion fails", () => {
    const source = populated();
    const bytes = source.journal.exportRecoverySnapshot(source.lease);
    const destination = fixture().journal;
    mutateNative(destination, (db) =>
      db.exec(
        "CREATE TRIGGER synthetic_restore_failure BEFORE INSERT ON stage_artifact BEGIN SELECT RAISE(ABORT,'synthetic restore interruption'); END"
      )
    );
    expect(() => destination.restoreRecoverySnapshot(bytes)).toThrow(
      "synthetic restore interruption"
    );
    expectEmpty(destination);
    mutateNative(destination, (db) =>
      db.exec("DROP TRIGGER synthetic_restore_failure")
    );
    destination.restoreRecoverySnapshot(bytes);
    expect(destination.load(source.state.runId)).toEqual(source.state);
  });

  it.each(["digest", "whitespace", "BOM", "invalid-utf8"])(
    "rejects malformed envelope %s before recording destination rows",
    (problem) => {
      const source = populated();
      const original = source.journal.exportRecoverySnapshot(source.lease);
      let bytes = original;
      if (problem === "digest")
        bytes = Buffer.from(
          canonicalJson({
            ...validateWeeklyJournalRecoverySnapshot(original),
            digest: "0".repeat(64),
          }) + "\n"
        );
      if (problem === "whitespace")
        bytes = Buffer.from(original.toString().replace("\n", "\n\n"));
      if (problem === "BOM")
        bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]);
      if (problem === "invalid-utf8") bytes = Buffer.from([0xc3, 0x28]);
      const destination = fixture().journal;
      expect(() => destination.restoreRecoverySnapshot(bytes)).toThrow();
      expectEmpty(destination);
    }
  );

  it.each([
    "future-envelope",
    "future-schema",
    "extra-field",
    "duplicate-owner",
    "duplicate-run",
    "duplicate-artifact",
    "duplicate-intake",
    "missing-owner",
    "orphan-run",
    "orphan-artifact",
    "orphan-intake",
    "run-revision",
    "noncanonical-payload",
    "future-attempt",
    "non-acquire-zero",
    "raw-binding",
    "artifact-hash",
    "intake-hash",
    "intake-kind",
    "noncanonical-base64",
    "unsafe-fence",
  ])("rejects a rehashed snapshot with %s", (problem) => {
    const source = populated();
    const original = source.journal.exportRecoverySnapshot(source.lease);
    const snapshot = validateWeeklyJournalRecoverySnapshot(original);
    let changes: Record<string, unknown> = {};
    if (problem === "future-envelope") changes = { version: 2 };
    if (problem === "future-schema") changes = { journalSchemaVersion: 4 };
    if (problem === "extra-field") changes = { privateUnknown: true };
    if (problem === "duplicate-owner")
      changes = { ownership: [...snapshot.ownership, snapshot.ownership[0]] };
    if (problem === "duplicate-run")
      changes = { runState: [...snapshot.runState, snapshot.runState[0]] };
    if (problem === "duplicate-artifact")
      changes = {
        stageArtifacts: [
          ...snapshot.stageArtifacts,
          snapshot.stageArtifacts[0],
        ],
      };
    if (problem === "duplicate-intake")
      changes = {
        intakeEvidence: [
          ...snapshot.intakeEvidence,
          snapshot.intakeEvidence[0],
        ],
      };
    if (problem === "missing-owner")
      changes = {
        ownership: snapshot.ownership.filter((row) => row.scope !== scope),
      };
    if (problem === "orphan-run")
      changes = {
        runState: snapshot.runState.map((row) => ({
          ...row,
          scope: "missing-owner",
        })),
      };
    if (problem === "orphan-artifact")
      changes = {
        stageArtifacts: snapshot.stageArtifacts.map((row) => ({
          ...row,
          runId: "f".repeat(64),
        })),
      };
    if (problem === "orphan-intake")
      changes = {
        intakeEvidence: snapshot.intakeEvidence.map((row) => ({
          ...row,
          scope: "missing-owner",
        })),
      };
    if (problem === "run-revision")
      changes = {
        runState: snapshot.runState.map((row) => ({
          ...row,
          revision: row.revision + 1,
        })),
      };
    if (problem === "noncanonical-payload")
      changes = {
        runState: snapshot.runState.map((row) => ({
          ...row,
          payload: JSON.stringify(JSON.parse(row.payload), null, 2),
        })),
      };
    if (problem === "future-attempt")
      changes = {
        stageArtifacts: snapshot.stageArtifacts.map((row) => ({
          ...row,
          attempt: 999,
        })),
      };
    if (problem === "non-acquire-zero")
      changes = {
        stageArtifacts: snapshot.stageArtifacts.map((row) => ({
          ...row,
          stage: "prepare",
          attempt: 0,
        })),
      };
    if (problem === "raw-binding")
      changes = {
        stageArtifacts: snapshot.stageArtifacts.map((row) =>
          row.attempt === 0
            ? {
                ...row,
                bytes: Buffer.from("other raw").toString("base64"),
                identity: digest("other raw"),
              }
            : row
        ),
      };
    if (problem === "artifact-hash")
      changes = {
        stageArtifacts: snapshot.stageArtifacts.map((row) => ({
          ...row,
          identity: "0".repeat(64),
        })),
      };
    if (problem === "intake-hash")
      changes = {
        intakeEvidence: snapshot.intakeEvidence.map((row) => ({
          ...row,
          identity: "0".repeat(64),
        })),
      };
    if (problem === "intake-kind")
      changes = {
        intakeEvidence: snapshot.intakeEvidence.map((row) => ({
          ...row,
          kind: ["source"],
        })),
      };
    if (problem === "noncanonical-base64")
      changes = {
        stageArtifacts: snapshot.stageArtifacts.map((row) => ({
          ...row,
          bytes: row.bytes + "\n",
        })),
      };
    if (problem === "unsafe-fence")
      changes = {
        ownership: snapshot.ownership.map((row) => ({
          ...row,
          fence: Number.MAX_SAFE_INTEGER + 1,
        })),
      };
    const bytes = rewritten(original, changes);
    const destination = fixture().journal;
    expect(() => validateWeeklyJournalRecoverySnapshot(bytes)).toThrow();
    expect(() => destination.restoreRecoverySnapshot(bytes)).toThrow();
    expectEmpty(destination);
  });

  it.each([
    "artifact-hash",
    "intake-hash",
    "state-revision",
    "foreign-reference",
    "future-schema",
    "unknown-stage",
    "noncanonical-state",
  ])("refuses exporting native corruption %s", (problem) => {
    const source = populated();
    mutateNative(source.journal, (db) => {
      if (problem === "artifact-hash")
        db.prepare("UPDATE stage_artifact SET bytes=? WHERE attempt=0").run(
          Buffer.from("changed")
        );
      if (problem === "intake-hash")
        db.prepare(
          "UPDATE intake_evidence SET bytes=? WHERE kind='source'"
        ).run(Buffer.from("changed"));
      if (problem === "state-revision")
        db.exec("UPDATE run_state SET revision=revision+1");
      if (problem === "foreign-reference") {
        db.exec("PRAGMA foreign_keys=OFF");
        db.prepare("UPDATE stage_artifact SET run_id=? WHERE attempt=0").run(
          "f".repeat(64)
        );
      }
      if (problem === "future-schema") db.exec("PRAGMA user_version=4");
      if (problem === "unknown-stage")
        db.exec("UPDATE stage_artifact SET stage='unknown' WHERE attempt=0");
      if (problem === "noncanonical-state")
        db.prepare("UPDATE run_state SET payload=?").run(
          JSON.stringify(source.state)
        );
    });
    expect(() => source.journal.exportRecoverySnapshot(source.lease)).toThrow();
  });
});
