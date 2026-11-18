import { lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { inspectRecoveryInstalledFile } from "./encrypted-backup.js";
import {
  selectedLoadHistoryLayout,
  selectedLoadHistoryManifestFilename,
} from "./recovery-gmail-selected-load-paths.js";
import { resumeSnapshotChunkSize } from "./recovery-gmail-selected-resume-snapshot-evidence.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { sha256 } from "./steve-preflight.js";

type PlannedFile = { name: string; bytes: Buffer };
type NextFile = {
  name: string;
  state: "absent" | "stage-only" | "candidate" | "linked" | "partial";
  candidate?: NonNullable<
    ReturnType<typeof inspectRecoveryInstalledFile>["candidate"]
  >;
};

function invalid(): never {
  throw Error("INVALID_SELECTED_LOAD_COMPLETION_PREFIX");
}

function validatePlan(files: PlannedFile[], result: Buffer) {
  let offset = 0;
  for (const { prefix, chunks } of Object.values(selectedLoadHistoryLayout)) {
    let index = 0;
    for (; index < chunks; index++) {
      const file = files[offset];
      if (file?.name !== prefix + String(index).padStart(3, "0") + ".bin")
        break;
      if (
        !Buffer.isBuffer(file.bytes) ||
        file.bytes.length < 1 ||
        file.bytes.length > resumeSnapshotChunkSize ||
        (index > 0 &&
          files[offset - 1]!.bytes.length !== resumeSnapshotChunkSize)
      )
        invalid();
      offset++;
    }
    if (index === 0) invalid();
  }
  const manifest = files[offset];
  if (
    files.length !== offset + 1 ||
    manifest?.name !== selectedLoadHistoryManifestFilename ||
    !Buffer.isBuffer(manifest.bytes) ||
    manifest.bytes.length < 1 ||
    manifest.bytes.length > 65536 ||
    !Buffer.isBuffer(result) ||
    result.length < 1 ||
    result.length > 65536
  )
    invalid();
}

/** Observe the exact durable prefix of an already authenticated completion plan.
 * The caller must verify current catalog/journal state and recheck the prefix
 * under the writer guards before settling or installing anything. */
export function observeSelectedLoadCompletionPrefix(input: {
  destination: string;
  runId: string;
  entries: RecoveryRuntimeEntry[];
  files: PlannedFile[];
  result: Buffer;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.runId)) return invalid();
  validatePlan(input.files, input.result);
  const root = "recovery-gmail-load/" + input.runId + "/";
  const resultName = "load-result.json";
  const family = input.entries.filter(
    (entry) =>
      entry.path.startsWith(root + "history-") ||
      entry.path.startsWith(root + "load-result")
  );
  const remaining = new Map(family.map((entry) => [entry.path, entry]));
  if (remaining.size !== family.length) return invalid();
  const assertFile = (name: string, bytes: Buffer) => {
    const entry = remaining.get(name);
    if (
      entry?.kind !== "file" ||
      entry.size !== bytes.length ||
      entry.sha256 !== sha256(bytes)
    )
      invalid();
    remaining.delete(name);
  };
  let settledCount = 0;
  let next: NextFile | undefined;
  for (const { name, bytes } of [
    ...input.files,
    { name: resultName, bytes: input.result },
  ]) {
    const portable = root + name;
    const target = join(input.destination, portable);
    const stagePath = portable + "-stage";
    const stage = target + "-stage";
    const stageEntry = remaining.get(stagePath);
    if (stageEntry && stageEntry.kind !== "directory") return invalid();
    const stageStat = lstatSync(stage, { throwIfNoEntry: false });
    if (!!stageStat !== !!stageEntry) return invalid();
    if (stageStat) {
      if (!stageStat.isDirectory() || stageStat.isSymbolicLink())
        return invalid();
      remaining.delete(stagePath);
    }
    const { target: observed, candidate } = inspectRecoveryInstalledFile(
      target,
      stage,
      bytes.length
    );
    if (stageStat) {
      const names = readdirSync(stage);
      if (
        candidate
          ? names.length !== 1 || names[0] !== basename(candidate.path)
          : names.length !== 0
      )
        return invalid();
    }
    if (!observed && !candidate && !stageEntry) {
      if (remaining.has(portable)) return invalid();
      next ??= { name, state: "absent" };
      continue;
    }
    if (next || !stageEntry) return invalid();
    if (observed) {
      if (!observed.bytes.equals(bytes)) return invalid();
      assertFile(portable, observed.bytes);
    } else if (remaining.has(portable)) return invalid();
    if (candidate) {
      assertFile(stagePath + "/" + basename(candidate.path), candidate.bytes);
      if (candidate.bytes.equals(bytes)) {
        if (observed && (candidate.nlink !== 2 || observed.nlink !== 2))
          return invalid();
        next = { name, state: observed ? "linked" : "candidate", candidate };
      } else {
        if (
          observed ||
          candidate.nlink !== 1 ||
          !bytes.subarray(0, candidate.bytes.length).equals(candidate.bytes)
        )
          return invalid();
        next = { name, state: "partial", candidate };
      }
    } else if (observed) {
      settledCount++;
    } else {
      next = { name, state: "stage-only" };
    }
  }
  if (remaining.size !== 0) return invalid();
  return {
    settledCount,
    ...(next ? { next } : {}),
    loadAllowed: false as const,
  };
}
