import { join, relative, resolve, sep } from "node:path";
import { inspectRecoveryInstalledFile } from "./encrypted-backup.js";
import { verifySelectedThirdLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import type { SelectedLoadAdmissionTail } from "./recovery-gmail-selected-load-admission-tail.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

const maximum = 16 * 1024 * 1024;

export interface SelectedThirdLoadEvidenceTail extends SelectedLoadAdmissionTail {
  executionBaseline?: Buffer;
}

function invalid(): never {
  throw Error("INVALID_RECOVERY_GMAIL_THIRD_START_TAIL");
}

/** Observe one signed baseline file and its fixed installer stage. The
 * remaining inventory must equal the authenticated pre-effect inventory. */
export function observeThirdSelectedLoadStartTail(
  destination: string,
  entries: RecoveryRuntimeEntry[],
  tail: SelectedLoadAdmissionTail,
  baselineBytes: Buffer,
  key: Buffer
) {
  if (
    !Buffer.isBuffer(baselineBytes) ||
    baselineBytes.length === 0 ||
    baselineBytes.length > maximum
  )
    return invalid();
  const baseline = verifySelectedThirdLoadExecutionBaseline(baselineBytes, key);
  if (
    baseline.runId !== tail.runId ||
    baseline.admissionSha256 !== sha256(tail.bytes)
  )
    return invalid();

  const root = resolve(destination);
  const filename =
    "recovery-gmail-load/" + baseline.runId + "/execution-baseline.json";
  const stagePath = filename + "-stage";
  const observed = inspectRecoveryInstalledFile(
    join(root, filename),
    join(root, stagePath),
    maximum
  );
  const digest = sha256(baselineBytes);
  const expected = new Set<string>();
  for (const file of [observed.target, observed.candidate]) {
    if (!file) continue;
    if (!file.bytes.equals(baselineBytes)) return invalid();
    expected.add(relative(root, file.path).split(sep).join("/"));
  }

  let stagePresent = false;
  const beforeStart: RecoveryRuntimeEntry[] = [];
  for (const entry of entries) {
    if (entry.path === stagePath) {
      if (stagePresent || entry.kind !== "directory") return invalid();
      stagePresent = true;
    } else if (
      entry.path === filename ||
      entry.path.startsWith(stagePath + "/")
    ) {
      if (
        !expected.delete(entry.path) ||
        entry.kind !== "file" ||
        entry.size !== baselineBytes.length ||
        entry.sha256 !== digest
      )
        return invalid();
    } else {
      beforeStart.push(entry);
    }
  }
  if (
    expected.size !== 0 ||
    ((observed.target || observed.candidate) && !stagePresent) ||
    canonicalJson(beforeStart) !== canonicalJson(baseline.entries)
  )
    return invalid();

  const presence =
    observed.target && !observed.candidate
      ? ("installed" as const)
      : stagePresent
        ? ("staging" as const)
        : ("absent" as const);
  return { beforeStart, presence, observed };
}
