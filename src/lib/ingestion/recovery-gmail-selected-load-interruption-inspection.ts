import { reconstructSelectedLoadIntentBaseline } from "./recovery-gmail-selected-intent-baseline.js";
import { observeSelectedLoadIntentSuccessors } from "./recovery-gmail-selected-intent-successors.js";
import { observeSelectedLoadPendingIntent } from "./recovery-gmail-selected-pending-intent.js";
import { observeSelectedLoadStagedSnapshot } from "./recovery-gmail-selected-staged-snapshot.js";
import { observeSelectedLoadCompletedJournal } from "./recovery-gmail-selected-completed-journal.js";
import { restoreResumeSnapshot } from "./recovery-gmail-selected-resume-snapshot-evidence.js";
import type { RecoveryRuntimeEntry } from "./recovery-runtime.js";
import type { RecoveryGmailSelectedLoadBaselineInput } from "./recovery-gmail-selected-load-proof.js";
import type { IngestionLedger } from "../../types/ingestion.js";
import { observeSelectedLoadLease } from "./recovery-gmail-selected-lease-observation.js";
import {
  createSelectedGmailLoadEffectPlan,
  assertSelectedGmailLoadArtifact,
  selectedGmailLoadEvidence,
} from "./recovery-gmail-selected-load-effects.js";
import { verifySelectedLoadResumeIntent } from "./recovery-gmail-selected-resume-intent.js";
import { reconstructSelectedLoadResumeJournal } from "./recovery-gmail-selected-resume-journal.js";
import { reconstructSelectedLoadResumeInventory } from "./recovery-gmail-selected-resume-inventory.js";
import { verifySelectedLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import { verifySelectedLoadResult } from "./recovery-gmail-selected-result-proof.js";
import {
  decryptLedgerSnapshot,
  inspectRecoveryInstalledFile,
} from "./encrypted-backup.js";
import { ledgerDigest } from "./sqlite-store.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";
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

export interface SelectedLoadInterruptionEvidence {
  report: {
    status:
      | "before-run"
      | "unchanged"
      | "committed"
      | "completed"
      | "pending-intent";
    runId: string;
    journalSha256: string;
    inventorySha256: string;
    lease: ReturnType<typeof observeSelectedLoadLease>;
    pendingSuccessorCount?: number;
    physicalValidationRequired: true;
    loadAllowed: false;
    activationAllowed: false;
  };
  originalBaseline: Omit<RecoveryGmailSelectedLoadBaselineInput, "recoveryKey">;
  admissionSha256: string;
  evidenceSha256: string;
  physicalSnapshotSha256: string;
  executionBaseline: Buffer;
  completedResultSha256?: string;
  pendingIntentSha256?: string;
  raw: Buffer;
  observedEntries: RecoveryRuntimeEntry[];
  physicalEntries: RecoveryRuntimeEntry[];
  pendingIntent?: ReturnType<typeof observeSelectedLoadPendingIntent>;
  pendingSuccessors?: ReturnType<typeof observeSelectedLoadIntentSuccessors>;
  stagedSnapshotPaths: string[];
  incompleteSnapshotCandidate?: {
    path: string;
    bytes: Buffer;
    dev: number;
    ino: number;
  };
  observedCatalog: { ledger: IngestionLedger; generation: number };
  observedJournal: Buffer;
  changedFiles: { key?: Buffer; snapshot?: Buffer; report?: Buffer };
}
/** Strict, read-only observation of a first-attempt commit gap. No handles,
 * key, mutation authority or resumability claim are returned. */
export function readSelectedLoadInterruptionEvidence(
  supplied: RecoveryGmailSelectedLoadFrameInput
): SelectedLoadInterruptionEvidence {
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
    const resultPath = load + "/load-result.json";
    const intentPath = load + "/resume-intent.json";
    const hasResult = entriesByPath.has(resultPath);
    let priorJournal = journal;
    let priorEntries = entries;
    let stagedSnapshotPaths: string[] = [];
    let incompleteSnapshotCandidate:
      | { path: string; bytes: Buffer; dev: number; ino: number }
      | undefined;
    let completedResultSha256: string | undefined;
    let priorSnapshot: Buffer | undefined;
    let pendingIntentSha256: string | undefined;
    let pendingSuccessorCount: number | undefined;
    let pendingIntent:
      | ReturnType<typeof observeSelectedLoadPendingIntent>
      | undefined;
    let pendingSuccessors:
      | ReturnType<typeof observeSelectedLoadIntentSuccessors>
      | undefined;
    let stagedChunkCount = 0;
    let stagedChunkPartial = false;
    if (hasResult) {
      const intent = verifySelectedLoadResumeIntent(
        read(intentPath, 65536),
        input.recoveryKey
      );
      if (
        intent.admissionSha256 !== common.admissionSha256 ||
        intent.executionBaselineSha256 !== sha256(executionBaseline) ||
        intent.ledgerRevision !== ledgerDigest(catalog.ledger) ||
        intent.generation !== catalog.generation
      )
        return fail();
      const completedJournal = observeSelectedLoadCompletedJournal(
        journal,
        intent
      );
      priorJournal = reconstructSelectedLoadResumeJournal({
        completedJournal: completedJournal.releasedJournal,
        intent,
        runId,
      });
      const execution = verifySelectedLoadExecutionBaseline(
        executionBaseline,
        input.recoveryKey
      );
      if (intent.snapshotEvidence)
        priorSnapshot = restoreResumeSnapshot(
          intent.snapshotEvidence,
          intent.snapshotEvidence.chunks.map(({ index }) =>
            read(
              load +
                "/resume-snapshot-" +
                String(index).padStart(3, "0") +
                ".bin",
              4 * 1024 * 1024
            )
          )
        );
      priorEntries = reconstructSelectedLoadResumeInventory({
        completedEntries: entries,
        originalEntries: execution.entries,
        preResumeSnapshot: priorSnapshot,
        intent,
        runId,
        reportPath: report,
      });
      const finalJournal = validateWeeklyJournalRecoverySnapshot(journal);
      const selected = finalJournal.runState.find((row) => row.id === runId);
      if (!selected) return fail();
      const state = parseWeeklyRunState(JSON.parse(selected.payload));
      const loadState = state.stages.find((stage) => stage.stage === "load");
      if (
        !loadState ||
        canonicalJson(loadState.evidence) !==
          canonicalJson(
            selectedGmailLoadEvidence(
              plan,
              proof.source,
              "load",
              catalog.ledger
            )
          )
      )
        return fail();
      const artifact = finalJournal.stageArtifacts.find(
        (row) =>
          row.runId === runId && row.stage === "load" && row.attempt === 1
      );
      if (!artifact) return fail();
      assertSelectedGmailLoadArtifact(
        plan,
        "load",
        Buffer.from(artifact.bytes, "base64"),
        raw,
        catalog.ledger
      );
      if (
        !changedFiles.report ||
        !changedFiles.report.equals(
          Buffer.from(JSON.stringify(plan.result.report, null, 2) + "\n")
        )
      )
        return fail();
      if (
        !changedFiles.snapshot ||
        canonicalJson(
          decryptLedgerSnapshot(changedFiles.snapshot, input.recoveryKey)
        ) !== canonicalJson(catalog.ledger)
      )
        return fail();
      const resultProof = verifySelectedLoadResult(
        read(resultPath, 65536),
        input.recoveryKey,
        {
          admissionSha256: common.admissionSha256,
          executionBaselineSha256: sha256(executionBaseline),
          runId,
          ledgerRevision: ledgerDigest(catalog.ledger),
          generation: catalog.generation,
          journalSha256: sha256(completedJournal.releasedJournal),
          runStateSha256: sha256(canonicalJson(state)),
          reportSha256: plan.receipt.reportSha256,
        }
      );
      if (
        completedJournal.guardedJournalSha256 &&
        completedJournal.guardedJournalSha256 !==
          resultProof.guardedJournalSha256
      )
        return fail();
      completedResultSha256 = resultProof.resultSha256;
    }
    if (
      !hasResult &&
      entries.some((entry) => entry.path.startsWith(load + "/resume-snapshot-"))
    ) {
      if (!changedFiles.snapshot) return fail();
      const staged = observeSelectedLoadStagedSnapshot({
        destination: root,
        loadPath: load,
        snapshot: changedFiles.snapshot,
        entries,
      });
      priorEntries = staged.entries;
      stagedSnapshotPaths = staged.stagedPaths;
      stagedChunkCount = staged.completeChunks;
      stagedChunkPartial = staged.partial;
      incompleteSnapshotCandidate = staged.incompleteCandidate;
    }
    const intentStage = intentPath + "-stage";
    const hasIntentEvidence =
      !hasResult &&
      entries.some(
        (entry) =>
          entry.path === intentPath ||
          entry.path === intentStage ||
          entry.path.startsWith(intentStage + "/")
      );
    if (hasIntentEvidence) {
      if (stagedChunkPartial) return fail();
      const prior = priorEntries.filter(
        (entry) =>
          entry.path !== intentPath &&
          entry.path !== intentStage &&
          !entry.path.startsWith(intentStage + "/") &&
          !entry.path.startsWith(load + "/resume-successor-")
      );
      // Authenticate the initial installed bytes before using its hashes. The
      // pending observer below independently closes and rechecks this family.
      const installed = inspectRecoveryInstalledFile(
        join(root, intentPath),
        join(root, intentStage),
        65536
      );
      const initialBytes =
        installed.target?.bytes ?? installed.candidate?.bytes;
      if (!initialBytes) return fail();
      const initial = verifySelectedLoadResumeIntent(
        initialBytes,
        input.recoveryKey
      );
      const settled = !!installed.target && !installed.candidate;
      const successors = observeSelectedLoadIntentSuccessors({
        destination: root,
        loadPath: load,
        entries,
        initial: initialBytes,
        key: input.recoveryKey,
        initialSettled: settled,
      });
      const baselineJournal = reconstructSelectedLoadIntentBaseline({
        observedJournal: journal,
        initial,
        latest: successors.latestV2Successor,
      });
      if (baselineJournal.acquired && !successors.lastSettled) return fail();
      const pending = observeSelectedLoadPendingIntent({
        destination: root,
        loadPath: load,
        entries,
        priorEntries: prior,
        journal: baselineJournal.baselineJournal,
        previousOwner: initial.previousOwner,
        admissionSha256: common.admissionSha256,
        executionBaselineSha256: sha256(executionBaseline),
        ledgerRevision: ledgerDigest(catalog.ledger),
        generation: catalog.generation,
        snapshot: changedFiles.snapshot,
        key: input.recoveryKey,
      });
      if (
        !pending.intentBytes.equals(initialBytes) ||
        stagedChunkCount !==
          (pending.intent.snapshotEvidence?.chunks.length ?? 0)
      )
        return fail();
      pendingSuccessorCount = successors.successorCount;
      pendingIntent = pending;
      pendingSuccessors = successors;
      priorJournal = pending.priorJournal;
      priorEntries = prior;
      pendingIntentSha256 = pending.intentSha256;
    }
    const j = proveSelectedLoadJournalDelta({
      ...common,
      observedJournal: priorJournal,
    });
    const physical = proveSelectedLoadPhysicalDelta({
      ...common,
      observedEntries: priorEntries,
      changedFiles: {
        ...changedFiles,
        ...(hasResult ? { snapshot: priorSnapshot } : {}),
      },
    });
    if (
      hasResult &&
      (j.status !== "committed" || physical.status !== "committed")
    )
      return fail();
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
    const owner = validateWeeklyJournalRecoverySnapshot(journal).ownership.find(
      (row) => row.scope === "prodigic/zivv/production"
    );
    if (!owner) return fail();
    const lease = observeSelectedLoadLease(owner.expiresAtEpochMs);
    return {
      report: {
        status: hasResult
          ? ("completed" as const)
          : pendingIntentSha256
            ? ("pending-intent" as const)
            : j.status,
        runId: j.runId ?? runId,
        journalSha256:
          hasResult || pendingIntentSha256 ? sha256(journal) : j.journalSha256,
        inventorySha256: hasResult
          ? sha256(canonicalJson(entries))
          : physical.inventorySha256,
        lease,
        ...(pendingSuccessorCount !== undefined
          ? { pendingSuccessorCount }
          : {}),
        physicalValidationRequired: true as const,
        loadAllowed: false as const,
        activationAllowed: false as const,
      },
      originalBaseline: {
        checkpoint,
        completed,
        unfinishedAdmissions,
        ...restored.originalBaseline,
      },
      admissionSha256: sha256(admission),
      evidenceSha256: restored.evidenceSha256,
      physicalSnapshotSha256: restored.physicalSnapshotSha256,
      executionBaseline,
      ...(completedResultSha256 ? { completedResultSha256 } : {}),
      ...(pendingIntentSha256 ? { pendingIntentSha256 } : {}),
      raw,
      observedEntries: priorEntries,
      physicalEntries: entries,
      ...(pendingIntent ? { pendingIntent } : {}),
      ...(pendingSuccessors ? { pendingSuccessors } : {}),
      stagedSnapshotPaths,
      ...(incompleteSnapshotCandidate ? { incompleteSnapshotCandidate } : {}),
      observedCatalog: catalog,
      observedJournal: journal,
      changedFiles,
    };
  } finally {
    input.recoveryKey.fill(0);
    wire.fill(0);
  }
}

/** Public summary of the same detached observation; no private evidence is returned. */
export function inspectSelectedLoadInterruption(
  supplied: RecoveryGmailSelectedLoadFrameInput
) {
  return readSelectedLoadInterruptionEvidence(supplied).report;
}
