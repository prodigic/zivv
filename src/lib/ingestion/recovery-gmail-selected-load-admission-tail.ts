import { join, relative, resolve, sep } from "node:path";
import { inspectRecoveryInstalledFile } from "./encrypted-backup.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { sha256 } from "./steve-preflight.js";

export interface SelectedLoadAdmissionTail {
  runId: string;
  bytes: Buffer;
}

export function selectedLoadAdmissionTailPaths(root: string, runId: string) {
  if (!/^[a-f0-9]{64}$/.test(runId)) return fail();
  const base = "recovery-gmail-load/" + runId;
  return {
    base,
    directory: join(root, base),
    target: join(root, base, "admission.json"),
    stage: join(root, base, "stages/admission"),
  };
}

function fail(): never {
  throw Error("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_ADMISSION_TAIL");
}

/** Prove the exact admission-only subtree before examining its predecessor.
 * No other subtree is omitted and no stage is adopted by this observation. */
export function observeSelectedLoadAdmissionTail(
  destination: string,
  entries: readonly RecoveryRuntimeEntry[],
  tail: SelectedLoadAdmissionTail
) {
  const root = resolve(destination);
  const { base, target, stage } = selectedLoadAdmissionTailPaths(
    root,
    tail.runId
  );
  if (
    !Buffer.isBuffer(tail.bytes) ||
    !tail.bytes.length ||
    tail.bytes.length > 65536
  )
    return fail();
  const observed = inspectRecoveryInstalledFile(target, stage, 65536);
  const expectedFiles = new Set<string>();
  for (const file of [observed.target, observed.candidate]) {
    if (!file) continue;
    if (!file.bytes.equals(tail.bytes)) return fail();
    expectedFiles.add(relative(root, file.path).split(sep).join("/"));
  }
  const directories = [base, base + "/stages", base + "/stages/admission"];
  const foundDirectories = new Set<string>();
  const expectedSha256 = sha256(tail.bytes);
  const predecessorEntries: RecoveryRuntimeEntry[] = [];
  for (const entry of entries) {
    if (entry.path !== base && !entry.path.startsWith(base + "/")) {
      predecessorEntries.push(entry);
      continue;
    }
    if (entry.kind === "directory" && directories.includes(entry.path)) {
      foundDirectories.add(entry.path);
      continue;
    }
    if (
      entry.kind !== "file" ||
      !expectedFiles.delete(entry.path) ||
      entry.size !== tail.bytes.length ||
      entry.sha256 !== expectedSha256
    )
      return fail();
  }
  if (
    expectedFiles.size ||
    directories.some(
      (path, index) =>
        index > 0 &&
        foundDirectories.has(path) &&
        !foundDirectories.has(directories[index - 1]!)
    ) ||
    ((observed.target || observed.candidate) &&
      foundDirectories.size !== directories.length)
  )
    return fail();
  return { predecessorEntries, observed };
}
