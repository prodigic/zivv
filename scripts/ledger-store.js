#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { loadLedger, validateLedger } from "../dist/lib/ingestion/ledger.js";
import { projectLedgerLocation } from "../dist/lib/ingestion/store-location.js";
import {
  checkStore,
  inheritStoreRevision,
  ledgerDigest,
  readSqliteLedger,
  withStoreTransaction,
  writeSqliteLedger,
} from "../dist/lib/ingestion/sqlite-store.js";
import {
  decryptLedgerSnapshot,
  encryptLedgerSnapshot,
  exportRecoveryKey,
  importRecoveryKey,
  loadBackupKey,
  secureOperatorDirectory,
  writeDurableFile,
} from "../dist/lib/ingestion/encrypted-backup.js";

const options = {};
const [command, ...args] = process.argv.slice(2);
const commands = [
  "migrate",
  "status",
  "backup",
  "verify",
  "restore",
  "export-key",
  "import-key",
];
if (!commands.includes(command))
  throw new Error(
    `Usage: node scripts/ledger-store.js <${commands.join("|")}> [--root PATH] [--file PATH] [--source PATH] [--expected-revision SHA256]`
  );
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]?.slice(2);
  if (
    !args[index]?.startsWith("--") ||
    !["root", "file", "source", "expected-revision"].includes(name) ||
    !args[index + 1] ||
    args[index + 1].startsWith("--")
  )
    throw new Error("Invalid ledger command arguments.");
  options[name] = args[index + 1];
}
const root = resolve(
  options.root || join(dirname(fileURLToPath(import.meta.url)), "..")
);
const location = projectLedgerLocation(root);
if (location.backend !== "sqlite")
  throw new Error(
    "This checkout must have data/ingestion/store.json configured for the shared SQLite store."
  );
const defaultSnapshot = join(
  root,
  "data",
  "ingestion",
  "backups",
  "ledger.snapshot.enc"
);
const snapshotPath = resolve(options.file || defaultSnapshot);
const keyPath = resolve(
  options.file || join(location.directory, "recovery", "backup-recovery.key")
);

function summary(ledger) {
  return {
    revision: ledgerDigest(ledger),
    events: ledger.events.length,
    artists: ledger.artists.length,
    venues: ledger.venues.length,
    runs: ledger.runs.length,
    redirects: ledger.redirects.length,
  };
}
function cleanupStage(path) {
  if (
    dirname(path) !== location.directory ||
    !path.startsWith(join(location.directory, ".verify-"))
  )
    throw new Error("Unsafe verification cleanup path.");
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(path + suffix, { force: true });
}
async function verifyRestorable(ledger) {
  validateLedger(ledger);
  const stage = join(
    location.directory,
    `.verify-${randomBytes(12).toString("hex")}.sqlite`
  );
  try {
    await writeSqliteLedger(stage, ledger, true);
    checkStore(stage);
    if (ledgerDigest(readSqliteLedger(stage)) !== ledgerDigest(ledger))
      throw new Error("Snapshot restore changed ledger content.");
  } finally {
    cleanupStage(stage);
  }
}
function saveSnapshot(path, ledger, key) {
  if (existsSync(path)) {
    const old = decryptLedgerSnapshot(readFileSync(path), key);
    if (ledgerDigest(old) === ledgerDigest(ledger)) return false;
  }
  const bytes = encryptLedgerSnapshot(ledger, key);
  if (ledgerDigest(decryptLedgerSnapshot(bytes, key)) !== ledgerDigest(ledger))
    throw new Error("Snapshot encryption round-trip failed.");
  writeDurableFile(path, bytes);
  return true;
}

if (command === "export-key") {
  exportRecoveryKey(location.directory, keyPath);
  console.log(
    JSON.stringify({
      recoveryKeyFile: keyPath,
      instruction:
        "Keep this file in a password manager or separate secure device. Never commit it.",
    })
  );
} else if (command === "import-key") {
  if (!options.file)
    throw new Error(
      "import-key requires --file with the separately saved recovery key."
    );
  importRecoveryKey(location.directory, keyPath);
  console.log("Recovery key installed privately for this operator.");
} else if (command === "migrate") {
  const source = resolve(
    options.source || join(root, "data", "ingestion", "ledger.json")
  );
  const ledger = JSON.parse(readFileSync(source, "utf8"));
  validateLedger(ledger);
  if (existsSync(location.path)) {
    if (ledgerDigest(readSqliteLedger(location.path)) !== ledgerDigest(ledger))
      throw new Error(
        "Shared ledger differs from this workspace copy. Migration will not overwrite it; review the differences."
      );
    console.log(
      JSON.stringify({
        migrated: false,
        database: location.path,
        ...summary(ledger),
      })
    );
  } else {
    secureOperatorDirectory(location.directory);
    // Back up the exact source before creating the authoritative database.
    if (
      existsSync(snapshotPath) &&
      !existsSync(
        join(
          location.directory,
          process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
        )
      )
    )
      throw new Error(
        "An encrypted snapshot already exists. Recover its key before migration."
      );
    const key = loadBackupKey(location.directory, true);
    await verifyRestorable(ledger);
    saveSnapshot(snapshotPath, ledger, key);
    await writeSqliteLedger(location.path, ledger, true);
    console.log(
      JSON.stringify({
        migrated: true,
        database: location.path,
        encryptedSnapshot: snapshotPath,
        ...summary(ledger),
      })
    );
  }
} else if (command === "status") {
  checkStore(location.path);
  console.log(
    JSON.stringify({
      database: location.path,
      ...summary(readSqliteLedger(location.path)),
    })
  );
} else if (command === "backup") {
  const key = loadBackupKey(location.directory);
  await withStoreTransaction(location.path, async () => {
    const ledger = await loadLedger(
      join(root, "data", "ingestion", "ledger.json")
    );
    await verifyRestorable(ledger);
    const changed = saveSnapshot(snapshotPath, ledger, key);
    console.log(
      JSON.stringify({
        encryptedSnapshot: snapshotPath,
        changed,
        verified: true,
        ...summary(ledger),
      })
    );
  });
} else if (command === "verify" || command === "restore") {
  const key = loadBackupKey(location.directory);
  const ledger = decryptLedgerSnapshot(readFileSync(snapshotPath), key);
  await verifyRestorable(ledger);
  if (command === "restore") {
    if (existsSync(location.path)) {
      if (!options["expected-revision"])
        throw new Error(
          "Restoring over an active ledger requires --expected-revision from ledger:status. This is an explicit rollback, not a merge."
        );
      await withStoreTransaction(location.path, async () => {
        const current = readSqliteLedger(location.path);
        if (ledgerDigest(current) !== options["expected-revision"])
          throw new Error(
            "Ledger changed since the restore was prepared; rollback rejected."
          );
        const rollback = join(
          location.directory,
          "rollback",
          `${ledgerDigest(current)}.snapshot.enc`
        );
        saveSnapshot(rollback, current, key);
        inheritStoreRevision(current, ledger);
        await writeSqliteLedger(location.path, ledger);
      });
    } else await writeSqliteLedger(location.path, ledger, true);
  }
  console.log(
    JSON.stringify({
      verified: true,
      restored: command === "restore",
      ...summary(ledger),
    })
  );
}
