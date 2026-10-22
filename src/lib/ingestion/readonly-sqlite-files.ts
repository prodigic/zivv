import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ReadOnlySqliteFileIdentity {
  dev: number;
  ino: number;
}

export interface ReadOnlySqliteFileSnapshot {
  main: ReadOnlySqliteFileIdentity;
  wal: ReadOnlySqliteFileIdentity | null;
  shm: ReadOnlySqliteFileIdentity | null;
}

function linkedFileError(path: string): Error {
  return new Error(`SQLite file must be regular and unlinked: ${path}`);
}

function fileIdentity(path: string): ReadOnlySqliteFileIdentity | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw linkedFileError(path);
  return { dev: stat.dev, ino: stat.ino };
}

/** Check SQLite's database and sidecar paths without opening or changing them. */
export function assertReadOnlySqliteFiles(
  path: string,
  previous?: ReadOnlySqliteFileSnapshot
): ReadOnlySqliteFileSnapshot {
  const absolute = resolve(path);
  for (let parent = dirname(absolute); ; parent = dirname(parent)) {
    let stat;
    try {
      stat = lstatSync(parent);
    } catch {
      throw new Error(`SQLite parent directory must exist: ${parent}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`SQLite parent directory must not be linked: ${parent}`);
    if (dirname(parent) === parent) break;
  }

  const main = fileIdentity(absolute);
  if (!main) throw new Error(`SQLite database must exist: ${absolute}`);
  const wal = fileIdentity(absolute + "-wal");
  const shm = fileIdentity(absolute + "-shm");
  const current = { main, wal, shm };
  if (previous) {
    const same = (
      before: ReadOnlySqliteFileIdentity | null,
      after: ReadOnlySqliteFileIdentity | null
    ) =>
      before === null ||
      (after !== null && before.dev === after.dev && before.ino === after.ino);
    if (
      previous.main.dev !== main.dev ||
      previous.main.ino !== main.ino ||
      !same(previous.wal, wal) ||
      !same(previous.shm, shm)
    )
      throw new Error("SQLite file identities changed during read-only access");
  }
  return current;
}
