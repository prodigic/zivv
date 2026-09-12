import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Serialize local import writers; a stale lock requires explicit operator review. */
export async function withIngestionLock<T>(
  root: string,
  work: () => Promise<T>
): Promise<T> {
  const directory = join(root, "data/ingestion");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, ".writer.lock");
  const fd = openSync(path, "wx");
  const owner = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    nonce: randomUUID(),
  });
  try {
    writeFileSync(fd, owner);
    return await work();
  } finally {
    closeSync(fd);
    try {
      if (readFileSync(path, "utf8") === owner) unlinkSync(path);
    } catch {
      /* A replaced/removed lock must not mask the original result. */
    }
  }
}
