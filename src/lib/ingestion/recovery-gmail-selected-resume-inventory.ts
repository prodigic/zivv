import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import type { SelectedLoadResumeIntent } from "./recovery-gmail-selected-resume-intent.js";

/** Reconstruct the inventory named by an authenticated resume intent. The
 * caller must independently read and validate the real tree and run the full
 * physical delta proof on this result. This grants no replay authority. */
export function reconstructSelectedLoadResumeInventory(input: {
  completedEntries: RecoveryRuntimeEntry[];
  originalEntries: RecoveryRuntimeEntry[];
  intent: SelectedLoadResumeIntent;
  runId: string;
  reportPath: string;
  preResumeSnapshot?: Buffer;
}): RecoveryRuntimeEntry[] {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_RESUME_INVENTORY");
  };
  if (
    !/^[a-f0-9]{64}$/.test(input.runId) ||
    !/^checkout\/data\/ingestion\/reports\/[a-f0-9]{64}\.json$/.test(
      input.reportPath
    )
  )
    return fail();
  const root = "recovery-gmail-load/" + input.runId;
  const intentFile = root + "/resume-intent.json",
    intentStage = root + "/resume-intent.json-stage",
    resultFile = root + "/load-result.json",
    resultStage = root + "/load-result.json-stage";
  const snapshot = "checkout/data/ingestion/backups/ledger.snapshot.enc";
  const actual = new Map(
    input.completedEntries.map((entry) => [entry.path, entry])
  );
  const original = new Map(
    input.originalEntries.map((entry) => [entry.path, entry])
  );
  if (
    actual.size !== input.completedEntries.length ||
    original.size !== input.originalEntries.length ||
    actual.get(intentFile)?.kind !== "file" ||
    actual.get(intentStage)?.kind !== "directory" ||
    actual.get(resultFile)?.kind !== "file" ||
    actual.get(resultStage)?.kind !== "directory" ||
    actual.get(snapshot)?.kind !== "file"
  )
    return fail();
  const retainedSnapshot = input.preResumeSnapshot
    ? {
        path: snapshot,
        kind: "file" as const,
        size: input.preResumeSnapshot.length,
        sha256: sha256(input.preResumeSnapshot),
      }
    : undefined;
  const evidencePaths =
    input.intent.snapshotEvidence?.chunks.flatMap(({ index }) => {
      const name =
        root + "/resume-snapshot-" + String(index).padStart(3, "0") + ".bin";
      if (
        actual.get(name)?.kind !== "file" ||
        actual.get(name + "-stage")?.kind !== "directory"
      )
        return fail();
      return [name, name + "-stage"];
    }) ?? [];
  const priorSnapshots = [
    actual.get(snapshot),
    original.get(snapshot),
    retainedSnapshot,
    undefined,
  ];
  const candidates = new Map<string, RecoveryRuntimeEntry[]>();
  const optional = [
    resultStage,
    "checkout/data/ingestion/backups",
    "checkout/data/ingestion/reports",
    input.reportPath,
  ];
  if (actual.get(input.reportPath)?.kind !== "file") return fail();
  for (const priorSnapshot of priorSnapshots)
    for (let mask = 0; mask < 1 << optional.length; mask++) {
      const prior = input.completedEntries.filter(
        (entry) =>
          ![
            intentFile,
            intentStage,
            resultFile,
            snapshot,
            ...optional,
            ...evidencePaths,
          ].includes(entry.path)
      );
      for (let index = 0; index < optional.length; index++) {
        const entry = actual.get(optional[index]!);
        if (mask & (1 << index) && entry) prior.push(entry);
      }
      if (priorSnapshot) prior.push(priorSnapshot);
      prior.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const encoded = canonicalJson(prior);
      if (sha256(encoded) === input.intent.inventorySha256)
        candidates.set(encoded, prior);
    }
  if (candidates.size !== 1) return fail();
  return structuredClone([...candidates.values()][0]!);
}
