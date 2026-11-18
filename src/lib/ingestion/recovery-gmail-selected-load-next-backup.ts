import { lstatSync } from "node:fs";
import { join } from "node:path";
import { decryptLedgerSnapshot } from "./encrypted-backup.js";
import { selectedLoadBackupPath } from "./recovery-gmail-selected-load-historical-predecessor.js";
import { readSelectedLoadEntry } from "./recovery-gmail-selected-load-physical-reader.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { canonicalJson } from "./sqlite-store.js";
import type { IngestionLedger } from "../../types/ingestion.js";

const maxSnapshotBytes = 512 * 1024 * 1024;

function fail(): never {
  throw Error("INVALID_NEXT_SELECTED_LOAD_BACKUP_STAGE");
}

function identity(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    return fail();
  return { dev: stat.dev, ino: stat.ino };
}

export function observeNextSelectedLoadBackupStage(input: {
  root: string;
  entries: RecoveryRuntimeEntry[];
  catalog: IngestionLedger;
  key: Buffer;
  inheritedBackup: boolean;
}) {
  const candidates = input.entries.filter((entry) =>
    entry.path.startsWith(selectedLoadBackupPath + ".")
  );
  if (!candidates.length) return undefined;
  const entry = candidates[0]!;
  const suffix = entry.path.slice(selectedLoadBackupPath.length);
  const target = input.entries.find(
    (entry) => entry.path === selectedLoadBackupPath
  );
  if (
    candidates.length !== 1 ||
    !input.inheritedBackup ||
    target?.kind !== "file" ||
    entry.kind !== "file" ||
    !/^\.[1-9][0-9]*\.[a-f0-9]{16}\.tmp$/.test(suffix)
  )
    return fail();
  const targetIdentity = identity(join(input.root, target.path));
  const candidateIdentity = identity(join(input.root, entry.path));
  if (canonicalJson(targetIdentity) === canonicalJson(candidateIdentity))
    return fail();
  const bytes = readSelectedLoadEntry(input.root, entry, maxSnapshotBytes);
  if (
    canonicalJson(decryptLedgerSnapshot(bytes, input.key)) !==
      canonicalJson(input.catalog) ||
    canonicalJson(identity(join(input.root, entry.path))) !==
      canonicalJson(candidateIdentity)
  )
    return fail();
  return { entry, target, candidateIdentity, targetIdentity, bytes };
}
