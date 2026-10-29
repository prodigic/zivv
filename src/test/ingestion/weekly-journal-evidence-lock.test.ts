import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  WeeklyRunJournal,
  readWeeklyJournalRecoverySnapshotInTransaction,
  readWeeklyJournalRecoverySnapshotReadOnly,
} from "../../lib/ingestion/weekly-run-journal.js";

it("reads the exact journal while a real writer lock excludes another writer", () => {
  const root = mkdtempSync(join(tmpdir(), "zivv-journal-evidence-lock-"));
  const journal = new WeeklyRunJournal(root);
  const lease = journal.acquire("prodigic/zivv/production");
  journal.release(lease);
  journal.close();
  const path = join(root, "weekly-runs.sqlite");
  const baseline = readWeeklyJournalRecoverySnapshotReadOnly(path);
  const held = new DatabaseSync(path, { timeout: 0 }),
    other = new DatabaseSync(path, { timeout: 0 });
  const probe = () =>
    spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1],{timeout:0}); try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); process.exitCode=0; } catch(e) { process.exitCode=/locked|busy/i.test(String(e.message))?17:18; } finally { db.close(); }",
        path,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10000 }
    );
  try {
    expect(() =>
      readWeeklyJournalRecoverySnapshotInTransaction(held)
    ).toThrow();
    held.exec("BEGIN IMMEDIATE");
    expect(
      readWeeklyJournalRecoverySnapshotInTransaction(held).equals(baseline)
    ).toBe(true);
    expect(() => other.exec("BEGIN IMMEDIATE")).toThrow();
    expect(probe().status).toBe(17);
    held.exec("ROLLBACK");
    expect(probe().status).toBe(0);
    other.exec("BEGIN IMMEDIATE");
    expect(
      readWeeklyJournalRecoverySnapshotInTransaction(other).equals(baseline)
    ).toBe(true);
    other.exec("ROLLBACK");
  } finally {
    if (held.isTransaction) held.exec("ROLLBACK");
    if (other.isTransaction) other.exec("ROLLBACK");
    held.close();
    other.close();
    rmSync(root, { recursive: true, force: true });
  }
});
