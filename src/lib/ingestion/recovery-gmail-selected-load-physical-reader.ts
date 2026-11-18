import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { sha256 } from "./steve-preflight.js";

/** Read an enumerated file only while its physical identity and bytes hold. */
export function readSelectedLoadEntry(
  root: string,
  entry: RecoveryRuntimeEntry | undefined,
  limit: number
): Buffer {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_PHYSICAL_ENTRY");
  };
  if (!entry || entry.kind !== "file" || entry.size > limit) return fail();
  const path = join(root, entry.path);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    return fail();
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    after.nlink !== 1 ||
    bytes.length !== entry.size ||
    sha256(bytes) !== entry.sha256
  )
    return fail();
  return bytes;
}
