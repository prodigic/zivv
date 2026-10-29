import { basename, join } from "node:path";
import { inspectRecoveryInstalledFile } from "./encrypted-backup.js";
import {
  describeResumeSnapshot,
  resumeSnapshotChunkSize,
} from "./recovery-gmail-selected-resume-snapshot-evidence.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";

/** Read-only classification of the exact prefix of pre-intent chunk installs.
 * Callers must still prove the filtered tree, catalog and journal and recheck
 * under the writer guard; this does not authorize adoption or deletion. */
export function observeSelectedLoadStagedSnapshot(input: {
  destination: string;
  loadPath: string;
  snapshot: Buffer;
  entries: RecoveryRuntimeEntry[];
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_STAGED_SNAPSHOT");
  };
  if (!/^recovery-gmail-load\/[a-f0-9]{64}$/.test(input.loadPath))
    return fail();
  const manifest = describeResumeSnapshot(input.snapshot);
  const prefix = input.loadPath + "/resume-snapshot-";
  const relevant = input.entries.filter((entry) =>
    entry.path.startsWith(prefix)
  );
  const byPath = new Map(relevant.map((entry) => [entry.path, entry]));
  if (byPath.size !== relevant.length) return fail();
  const excluded = new Set<string>();
  let missing = false,
    partial = false,
    present = 0;
  for (const item of manifest.chunks) {
    const name = `resume-snapshot-${String(item.index).padStart(3, "0")}.bin`;
    const target = input.loadPath + "/" + name,
      stage = target + "-stage";
    const members = relevant.filter(
      (entry) =>
        entry.path === target ||
        entry.path === stage ||
        entry.path.startsWith(stage + "/")
    );
    if (!members.length) {
      missing = true;
      continue;
    }
    if (missing || partial || byPath.get(stage)?.kind !== "directory")
      return fail();
    const observation = inspectRecoveryInstalledFile(
      join(input.destination, target),
      join(input.destination, stage),
      resumeSnapshotChunkSize
    );
    const expected = input.snapshot.subarray(
      item.index * resumeSnapshotChunkSize,
      item.index * resumeSnapshotChunkSize + item.size
    );
    if (
      (observation.target && !observation.target.bytes.equals(expected)) ||
      (observation.candidate && !observation.candidate.bytes.equals(expected))
    )
      return fail();
    const matches = (path: string, present: boolean) => {
      const entry = byPath.get(path);
      if (present !== !!entry) return false;
      return (
        !present ||
        (entry?.kind === "file" &&
          entry.size === item.size &&
          entry.sha256 === item.sha256)
      );
    };
    const candidatePath = observation.candidate
      ? stage + "/" + basename(observation.candidate.path)
      : undefined;
    if (
      !matches(target, !!observation.target) ||
      (candidatePath && !matches(candidatePath, true))
    )
      return fail();
    const allowed = new Set([
      target,
      stage,
      ...(observation.candidate
        ? [stage + "/" + basename(observation.candidate.path)]
        : []),
    ]);
    for (const entry of members)
      if (!allowed.has(entry.path)) return fail();
      else excluded.add(entry.path);
    if (observation.target && !observation.candidate) present++;
    else partial = true;
  }
  if (excluded.size !== relevant.length) return fail();
  return {
    entries: input.entries.filter((entry) => !excluded.has(entry.path)),
    stagedPaths: [...excluded].sort(),
    completeChunks: present,
    partial,
    loadAllowed: false as const,
  };
}
