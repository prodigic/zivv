import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import {
  decryptLedgerSnapshot,
  validateRecoveredBackupKeyBytes,
} from "./encrypted-backup.js";
import { verifySelectedLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import {
  proveRecoveryGmailSelectedLoadBaseline,
  type RecoveryGmailSelectedLoadBaselineInput,
} from "./recovery-gmail-selected-load-proof.js";
import { proveSelectedLoadCatalogDelta } from "./recovery-gmail-selected-catalog-delta.js";
import { createSelectedGmailLoadEffectPlan } from "./recovery-gmail-selected-load-effects.js";
import type { IngestionLedger } from "../../types/ingestion.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";

/** Detached closed-family comparison, not a filesystem reader or mutation permit.
 * Actual tree enumeration, unlinked identities and canonical SQL are separate. */
export function proveSelectedLoadPhysicalDelta(input: {
  baseline: RecoveryGmailSelectedLoadBaselineInput;
  executionBaseline: Buffer;
  admissionSha256: string;
  evidenceSha256: string;
  physicalSnapshotSha256: string;
  raw: Buffer;
  observedGeneration: number;
  observedLedger: IngestionLedger;
  observedEntries: RecoveryRuntimeEntry[];
  changedFiles: { key?: Buffer; snapshot?: Buffer; report?: Buffer };
}) {
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_PHYSICAL_DELTA");
  };
  const original = verifySelectedLoadExecutionBaseline(
    input.executionBaseline,
    input.baseline.recoveryKey
  );
  const catalog = proveSelectedLoadCatalogDelta(input),
    proof = proveRecoveryGmailSelectedLoadBaseline(input.baseline);
  const plan = createSelectedGmailLoadEffectPlan(
    input.baseline.checkpoint,
    proof,
    input.raw
  );
  const sql = /^operator\/(?:ledger|weekly-runs)\.sqlite(?:-wal|-shm)?$/;
  const load = /^recovery-gmail-load(?:\/|$)/;
  if (
    sha256(
      canonicalJson(
        original.entries.filter(
          (entry) =>
            !/^operator\/weekly-runs\.sqlite(?:-wal|-shm)?$/.test(entry.path) &&
            !load.test(entry.path)
        )
      )
    ) !== original.physicalSnapshotSha256
  )
    return fail();
  const root = "recovery-gmail-load/" + proof.runState.runId,
    key =
      "operator/" +
      (process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"),
    snapshot = "checkout/data/ingestion/backups/ledger.snapshot.enc",
    report =
      "checkout/data/ingestion/reports/" +
      sha256(plan.result.report.runId) +
      ".json",
    execution = root + "/execution-baseline.json";
  const dirs = new Set([
    root + "/key-stage",
    root + "/execution-baseline.json-stage",
    root + "/load-result.json-stage",
    "checkout/data/ingestion/backups",
    "checkout/data/ingestion/reports",
  ]);
  const old = new Map(
    original.entries
      .filter((entry) => !sql.test(entry.path))
      .map((entry) => [entry.path, entry])
  );
  if (
    old.size !==
      original.entries.filter((entry) => !sql.test(entry.path)).length ||
    !Array.isArray(input.observedEntries)
  )
    return fail();
  const seen = new Set<string>();
  let hasKey = false,
    hasExecution = false;
  for (const entry of input.observedEntries) {
    if (seen.has(entry.path) || sql.test(entry.path)) return fail();
    seen.add(entry.path);
    const before = old.get(entry.path);
    if (before && canonicalJson(before) === canonicalJson(entry)) {
      if (entry.path === key) hasKey = true;
      continue;
    }
    if (entry.kind === "directory" && dirs.has(entry.path)) {
      if (before) return fail();
      continue;
    }
    if (entry.kind !== "file") return fail();
    const bytes =
      entry.path === key
        ? input.changedFiles.key
        : entry.path === snapshot
          ? input.changedFiles.snapshot
          : entry.path === report
            ? input.changedFiles.report
            : entry.path === execution
              ? input.executionBaseline
              : undefined;
    if (
      !Buffer.isBuffer(bytes) ||
      entry.size !== bytes.length ||
      entry.sha256 !== sha256(bytes)
    )
      return fail();
    if (entry.path === key) {
      validateRecoveredBackupKeyBytes(bytes, input.baseline.recoveryKey);
      hasKey = true;
    } else if (entry.path === snapshot) {
      const restored = decryptLedgerSnapshot(bytes, input.baseline.recoveryKey);
      if (
        canonicalJson(restored) !==
          canonicalJson(input.baseline.checkpoint.ledger) &&
        canonicalJson(restored) !== canonicalJson(input.observedLedger)
      )
        return fail();
    } else if (entry.path === report) {
      if (
        !bytes.equals(
          Buffer.from(JSON.stringify(plan.result.report, null, 2) + "\n")
        )
      )
        return fail();
    } else if (entry.path === execution) hasExecution = true;
    else return fail();
  }
  for (const entry of old.values()) if (!seen.has(entry.path)) return fail();
  if (!hasExecution || (catalog.disposition === "committed" && !hasKey))
    return fail();
  return {
    status: catalog.disposition,
    inventorySha256: sha256(canonicalJson(input.observedEntries)),
    loadAllowed: false as const,
  };
}
