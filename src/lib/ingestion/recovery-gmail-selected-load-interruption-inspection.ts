import { createSelectedGmailLoadEffectPlan } from "./recovery-gmail-selected-load-effects.js";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  readCanonicalSqliteLedgerReadOnly,
} from "./sqlite-store.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "./weekly-run-journal.js";
import { openPreparedRuntimeForAdmission } from "./recovery-runtime.js";
import {
  encodeRecoveryGmailSelectedLoadFrame,
  decodeRecoveryGmailSelectedLoadFrame,
  type RecoveryGmailSelectedLoadFrameInput,
} from "./recovery-gmail-selected-load-framing.js";
import { validateRecoveryPreparedHostBinding } from "./recovery-host-binding.js";
import { restoreRecoveryGmailSelectedLoadEvidence } from "./recovery-gmail-selected-load-evidence.js";
import { proveRecoveryGmailSelectedLoadBaseline } from "./recovery-gmail-selected-load-proof.js";
import { proveSelectedLoadJournalDelta } from "./recovery-gmail-selected-journal-delta.js";
import { proveSelectedLoadPhysicalDelta } from "./recovery-gmail-selected-physical-delta.js";
import { sha256 } from "./steve-preflight.js";

/** Strict, read-only observation of a first-attempt commit gap. No handles,
 * key, mutation authority or resumability claim are returned. */
export function inspectSelectedLoadInterruption(
  supplied: RecoveryGmailSelectedLoadFrameInput
) {
  const wire = encodeRecoveryGmailSelectedLoadFrame(supplied),
    input = decodeRecoveryGmailSelectedLoadFrame(wire);
  const fail = (): never => {
    throw Error("INVALID_SELECTED_LOAD_INTERRUPTION_INSPECTION");
  };
  try {
    const { selector, ...runtime } = input,
      opened = openPreparedRuntimeForAdmission(runtime),
      root = resolve(runtime.destination);
    opened.assertRuntime();
    const entries = opened.inventoryGmailSelectedLoadExecution(),
      entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    if (entriesByPath.size !== entries.length) return fail();
    const read = (path: string, limit: number): Buffer => {
      const entry = entriesByPath.get(path);
      if (!entry || entry.kind !== "file" || entry.size > limit) return fail();
      const full = join(root, path),
        before = lstatSync(full);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
        return fail();
      const bytes = readFileSync(full),
        after = lstatSync(full);
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
    };
    const loadNames = entries.filter(
      (entry) =>
        entry.kind === "directory" &&
        /^recovery-gmail-load\/[a-f0-9]{64}$/.test(entry.path)
    );
    if (loadNames.length !== 1) return fail();
    const load = loadNames[0]!.path,
      runId = load.slice("recovery-gmail-load/".length);
    const admission = read(load + "/admission.json", 65536),
      record = JSON.parse(admission.toString("utf8")) as {
        binding: unknown;
        selector: unknown;
        runId: unknown;
      };
    const binding = validateRecoveryPreparedHostBinding(
      record.binding,
      input.recoveryKey
    );
    if (
      record.runId !== runId ||
      canonicalJson(record.selector) !== canonicalJson(selector) ||
      binding.capsuleSha256 !== sha256(input.archive) ||
      binding.retirementSha256 !== sha256(input.retirementReceipt) ||
      binding.checkpointSha256 !== sha256(canonicalJson(opened.checkpoint)) ||
      binding.preparedReceiptSha256 !== opened.receiptSha256 ||
      binding.preparedTreeSha256 !== opened.report.treeSha256 ||
      binding.physicalRoot !== root ||
      binding.physicalOperatorDirectory !== join(root, "operator") ||
      binding.physicalNpmPath !== resolve(input.npmCli)
    )
      return fail();
    const captureNames = entries.filter(
      (entry) =>
        entry.kind === "directory" &&
        /^recovery-gmail-capture\/[a-f0-9]{64}$/.test(entry.path)
    );
    const family = captureNames
      .map((entry) => {
        const bytes = read(entry.path + "/admission.json", 65536),
          value = JSON.parse(bytes.toString("utf8")) as {
            priorCompleted?: { count?: number };
          };
        const count = value.priorCompleted?.count;
        if (
          !Number.isSafeInteger(count) ||
          typeof count !== "number" ||
          count < 0
        )
          return fail();
        const resultPath = entry.path + "/result.json";
        return {
          count,
          admission: bytes,
          result: entriesByPath.has(resultPath)
            ? read(resultPath, 16 * 1024 * 1024)
            : null,
        };
      })
      .sort((a, b) => a.count - b.count);
    const completed: { admission: Buffer; result: Buffer }[] = [],
      unfinishedAdmissions: Buffer[] = [];
    for (const item of family) {
      if (item.count !== completed.length) return fail();
      if (item.result) {
        if (unfinishedAdmissions.length) return fail();
        completed.push({ admission: item.admission, result: item.result });
      } else {
        unfinishedAdmissions.push(item.admission);
        if (unfinishedAdmissions.length > 1) return fail();
      }
    }
    const chunks = entries.flatMap((entry) => {
      const prefix = load + "/chunks/";
      if (entry.kind !== "file" || !entry.path.startsWith(prefix)) return [];
      const name = entry.path.slice(prefix.length);
      if (!/^[a-f0-9]{64}\.bin$/.test(name)) return fail();
      return [
        { id: name.slice(0, 64), bytes: read(entry.path, 8 * 1024 * 1024) },
      ];
    });
    // Preparation deliberately clears archived ownership expiry before capture.
    // Reconstruct that same baseline, while the host binding remains tied to the original archive.
    const checkpoint = structuredClone(opened.checkpoint);
    const archivedJournal = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(checkpoint.journal, "base64")
    );
    const { digest: _digest, ...journalBody } = {
      ...archivedJournal,
      ownership: archivedJournal.ownership.map((row) => ({
        ...row,
        expiresAtEpochMs: 0,
      })),
    };
    checkpoint.journal = Buffer.from(
      canonicalJson({
        ...journalBody,
        digest: sha256(canonicalJson(journalBody)),
      }) + "\n"
    ).toString("base64");
    const restored = restoreRecoveryGmailSelectedLoadEvidence({
      checkpoint,
      recoveryKey: input.recoveryKey,
      binding,
      completed,
      unfinishedAdmissions,
      manifest: read(load + "/baseline.json", 16 * 1024 * 1024),
      chunks,
      observedAdmission: admission,
    });
    const baseline = {
      checkpoint,
      recoveryKey: input.recoveryKey,
      completed,
      unfinishedAdmissions,
      ...restored.originalBaseline,
    };
    const proof = proveRecoveryGmailSelectedLoadBaseline(baseline),
      source = proof.selection.canonicalEvidence.find((file) =>
        file.path.endsWith("/bodies/" + selector.receiptId + "/source.txt")
      );
    if (!source) return fail();
    const raw = read("operator/" + source.path, 64 * 1024 * 1024),
      executionBaseline = read(
        load + "/execution-baseline.json",
        32 * 1024 * 1024
      );
    const catalog = readCanonicalSqliteLedgerReadOnly(
        join(root, "operator/ledger.sqlite")
      ),
      journal = readWeeklyJournalRecoverySnapshotReadOnly(
        join(root, "operator/weekly-runs.sqlite")
      );
    const common = {
      baseline,
      executionBaseline,
      admissionSha256: sha256(admission),
      evidenceSha256: restored.evidenceSha256,
      physicalSnapshotSha256: restored.physicalSnapshotSha256,
      raw,
      observedGeneration: catalog.generation,
      observedLedger: catalog.ledger,
    };
    const j = proveSelectedLoadJournalDelta({
      ...common,
      observedJournal: journal,
    });
    const key =
      "operator/" +
      (process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin");
    const snapshot = "checkout/data/ingestion/backups/ledger.snapshot.enc";
    const plan = createSelectedGmailLoadEffectPlan(
      opened.checkpoint,
      proof,
      raw
    );
    const report =
      "checkout/data/ingestion/reports/" +
      sha256(plan.result.report.runId) +
      ".json";
    const changedFiles = {
      ...(entriesByPath.has(key) ? { key: read(key, 16384) } : {}),
      ...(entriesByPath.has(snapshot)
        ? { snapshot: read(snapshot, 512 * 1024 * 1024) }
        : {}),
      ...(entriesByPath.has(report)
        ? { report: read(report, 64 * 1024 * 1024) }
        : {}),
    };
    const physical = proveSelectedLoadPhysicalDelta({
      ...common,
      observedEntries: entries,
      changedFiles,
    });
    const inventory = opened.inventoryGmailSelectedLoadExecution();
    if (
      canonicalJson(entries) !== canonicalJson(inventory) ||
      canonicalJson(catalog) !==
        canonicalJson(
          readCanonicalSqliteLedgerReadOnly(
            join(root, "operator/ledger.sqlite")
          )
        ) ||
      !journal.equals(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(root, "operator/weekly-runs.sqlite")
        )
      )
    )
      return fail();
    return {
      status: j.status,
      runId: j.runId ?? runId,
      journalSha256: j.journalSha256,
      inventorySha256: physical.inventorySha256,
      physicalValidationRequired: true as const,
      loadAllowed: false as const,
      activationAllowed: false as const,
    };
  } finally {
    input.recoveryKey.fill(0);
    wire.fill(0);
  }
}
