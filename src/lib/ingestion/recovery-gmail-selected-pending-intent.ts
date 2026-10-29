import { basename, join } from "node:path";
import { inspectRecoveryInstalledFile } from "./encrypted-backup.js";
import { verifySelectedLoadResumeIntent } from "./recovery-gmail-selected-resume-intent.js";
import { describeResumeSnapshot } from "./recovery-gmail-selected-resume-snapshot-evidence.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import type { WeeklyRunLease } from "./weekly-run-journal.js";

/** Read-only proof of a complete signed pre-lease intent. The caller must
 * independently prove the underlying tree, catalog and journal; this grants no
 * adoption, file mutation, load or activation authority. */
export function observeSelectedLoadPendingIntent(input: {
  destination: string;
  loadPath: string;
  entries: RecoveryRuntimeEntry[];
  priorEntries: RecoveryRuntimeEntry[];
  journal: Buffer;
  previousOwner: WeeklyRunLease;
  admissionSha256: string;
  executionBaselineSha256: string;
  ledgerRevision: string;
  generation: number;
  snapshot?: Buffer;
  key: Buffer;
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_PENDING_INTENT");
  };
  if (!/^recovery-gmail-load\/[a-f0-9]{64}$/.test(input.loadPath))
    return fail();
  const target = input.loadPath + "/resume-intent.json",
    stage = target + "-stage";
  const members = input.entries.filter(
    (entry) =>
      entry.path === target ||
      entry.path === stage ||
      entry.path.startsWith(stage + "/")
  );
  const map = new Map(members.map((entry) => [entry.path, entry]));
  if (map.size !== members.length || map.get(stage)?.kind !== "directory")
    return fail();
  const observed = inspectRecoveryInstalledFile(
    join(input.destination, target),
    join(input.destination, stage),
    65536
  );
  const file = observed.target ?? observed.candidate;
  if (!file) return fail();
  const candidate = observed.candidate
    ? stage + "/" + basename(observed.candidate.path)
    : undefined;
  const allowed = new Set([
    stage,
    ...(observed.target ? [target] : []),
    ...(candidate ? [candidate] : []),
  ]);
  if (
    members.length !== allowed.size ||
    members.some((entry) => !allowed.has(entry.path))
  )
    return fail();
  for (const [path, item] of [
    [target, observed.target],
    [candidate, observed.candidate],
  ] as const) {
    if (!path || !item) continue;
    const entry = map.get(path);
    if (
      !entry ||
      entry.kind !== "file" ||
      entry.size !== item.bytes.length ||
      entry.sha256 !== sha256(item.bytes)
    )
      return fail();
  }
  const intent = verifySelectedLoadResumeIntent(file.bytes, input.key);
  if (
    intent.admissionSha256 !== input.admissionSha256 ||
    intent.executionBaselineSha256 !== input.executionBaselineSha256 ||
    intent.ledgerRevision !== input.ledgerRevision ||
    intent.generation !== input.generation ||
    intent.journalSha256 !== sha256(input.journal) ||
    intent.inventorySha256 !== sha256(canonicalJson(input.priorEntries)) ||
    canonicalJson(intent.previousOwner) !==
      canonicalJson(input.previousOwner) ||
    canonicalJson(intent.snapshotEvidence) !==
      canonicalJson(
        input.snapshot ? describeResumeSnapshot(input.snapshot) : null
      )
  )
    return fail();
  return {
    intent,
    intentSha256: sha256(file.bytes),
    intentBytes: Buffer.from(file.bytes),
    settled: !!observed.target && !observed.candidate,
    intentPaths: [...allowed].sort(),
    targetPresent: !!observed.target,
    loadAllowed: false as const,
    activationAllowed: false as const,
  };
}
