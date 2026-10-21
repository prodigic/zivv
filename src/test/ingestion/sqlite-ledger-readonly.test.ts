import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  readSqliteLedgerReadOnly,
  withStoreTransaction,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";

const roots: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "zivv-ledger-readonly-"));
  roots.push(root);
  return root;
}
async function fixture() {
  const root = directory();
  const path = join(root, "ledger.sqlite");
  const ledger = bootstrapLedger({ events: [], artists: [], venues: [] }, 1000);
  await writeSqliteLedger(path, ledger, true);
  return { root, path, ledger };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const offset = relative(resolve(tmpdir()), resolve(root));
    if (!offset.startsWith("zivv-ledger-readonly-") || offset.includes(".."))
      throw new Error("Unsafe read-only ledger fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
describe("read-only catalog recovery observation", () => {
  it("reads the committed catalog without issuing a write revision", async () => {
    const { path, ledger } = await fixture();
    const observed = readSqliteLedgerReadOnly(path);
    expect(observed).toEqual(ledger);
    await expect(writeSqliteLedger(path, observed)).rejects.toThrow(
      "Stale or unversioned ledger write rejected"
    );
  });
  it("refuses to certify an enclosing writer's uncommitted state", async () => {
    const { path } = await fixture();
    await withStoreTransaction(path, async () => {
      expect(() => readSqliteLedgerReadOnly(path)).toThrow(
        "RECOVERY_REQUIRES_OWN_CATALOG_TRANSACTION"
      );
    });
  });
  it("does not create a missing database", () => {
    const path = join(directory(), "missing.sqlite");
    expect(() => readSqliteLedgerReadOnly(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });
  it("refuses linked database files", async () => {
    const { root, path } = await fixture();
    const linked = join(root, "linked.sqlite");
    linkSync(path, linked);
    expect(() => readSqliteLedgerReadOnly(path)).toThrow(/linked/i);
    expect(() => readSqliteLedgerReadOnly(linked)).toThrow(/linked/i);
  });
  it("rejects an unsupported schema without migrating it", () => {
    const path = join(directory(), "wrong.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE unrelated(value TEXT); PRAGMA user_version=7;");
    db.close();
    expect(() => readSqliteLedgerReadOnly(path)).toThrow("Unsupported");
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
    } finally {
      check.close();
    }
  });
  it.each(["-wal", "-shm"])(
    "refuses a linked %s sidecar before SQLite opens it",
    async (suffix) => {
      const { root, path } = await fixture();
      const target = join(root, "linked-target");
      writeFileSync(target, "private sidecar target");
      linkSync(target, path + suffix);
      expect(() => readSqliteLedgerReadOnly(path)).toThrow(/linked/i);
    }
  );
  it("rejects catalog checksum drift", async () => {
    const { path } = await fixture();
    const db = new DatabaseSync(path);
    db.exec("UPDATE metadata SET digest='changed' WHERE id=1");
    db.close();
    expect(() => readSqliteLedgerReadOnly(path)).toThrow("checksum mismatch");
  });
});
