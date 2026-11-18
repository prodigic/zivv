import { reconstructSelectedLoadCompletionJournals } from "./recovery-gmail-selected-load-completion-intent.js";
import { regenerateSelectedLoadCompletionPlan } from "./recovery-gmail-selected-load-completion-plan.js";
import {
  observeSelectedLoadCompletionIntentFile,
  observeSelectedLoadCompletionPrefix,
} from "./recovery-gmail-selected-load-completion-prefix.js";
import { selectedLoadCompletionIntentFilename } from "./recovery-gmail-selected-load-paths.js";
import { readSelectedLoadHistoryFiles } from "./recovery-gmail-selected-load-history.js";
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
  assertSelectedGmailLoadCatalog,
  selectedGmailLoadEvidence,
} from "./recovery-gmail-selected-load-effects.js";
import {
  verifySelectedLoadResumeIntent,
  type SelectedLoadResumeIntent,
} from "./recovery-gmail-selected-resume-intent.js";
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
import { proveSelectedLoadCatalogDelta } from "./recovery-gmail-selected-catalog-delta.js";
import { proveSelectedLoadPhysicalDelta } from "./recovery-gmail-selected-physical-delta.js";
import { sha256 } from "./steve-preflight.js";

export interface SelectedLoadInterruptionEvidence {
  report: {
    status:
      | "before-run"
      | "unchanged"
      | "committed"
      | "completed"
      | "pending-intent"
      | "completion-pending";
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
  completionPending?: {
    intent: ReturnType<typeof observeSelectedLoadCompletionIntentFile>;
    plan: ReturnType<typeof regenerateSelectedLoadCompletionPlan>;
    prefix: ReturnType<typeof observeSelectedLoadCompletionPrefix>;
  };
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
    const resultStage = resultPath + "-stage";
    const completionPath = load + "/" + selectedLoadCompletionIntentFilename;
    const hasCompletionIntent = entries.some((entry) =>
      entry.path.startsWith(completionPath)
    );
    const resultTargetPresent = entriesByPath.has(resultPath);
    const interruptedCompletion =
      hasCompletionIntent &&
      (!resultTargetPresent ||
        entries.some((entry) => entry.path.startsWith(resultStage + "/")));
    const hasResult = resultTargetPresent || interruptedCompletion;
    let completionPending: SelectedLoadInterruptionEvidence["completionPending"];
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
    const intentStage = intentPath + "-stage";
    const restoreIntentSnapshot = (intent: SelectedLoadResumeIntent) =>
      intent.snapshotEvidence
        ? restoreResumeSnapshot(
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
          )
        : undefined;
    const assertCommittedRollback = (intent: SelectedLoadResumeIntent) => {
      const original = proveSelectedLoadCatalogDelta({
        ...common,
        observedGeneration: intent.generation,
        observedLedger: checkpoint.ledger,
      });
      if (
        original.disposition !== "unchanged" ||
        original.ledgerRevision !== intent.ledgerRevision ||
        catalog.generation !== intent.generation + 1
      )
        return fail();
      assertSelectedGmailLoadCatalog(
        plan,
        checkpoint.ledger,
        catalog.ledger,
        intent.startedAtEpochMs
      );
    };
    if (hasResult) {
      const historyPrefix = load + "/history-";
      const withHistory = entries.some((entry) =>
        entry.path.startsWith(historyPrefix)
      );
      const completedEntries = entries.filter(
        (entry) =>
          !entry.path.startsWith(historyPrefix) &&
          !entry.path.startsWith(completionPath)
      );
      const historyIdentity = {
        runId,
        admissionSha256: common.admissionSha256,
        executionBaselineSha256: sha256(executionBaseline),
        priorFamilySha256: sha256(canonicalJson([])),
        ledgerRevision: ledgerDigest(catalog.ledger),
        generation: catalog.generation,
      };
      const completion = hasCompletionIntent
        ? observeSelectedLoadCompletionIntentFile({
            destination: root,
            entries,
            identity: historyIdentity,
            key: input.recoveryKey,
          })
        : undefined;
      if (
        completion &&
        !interruptedCompletion &&
        completion.state !== "settled"
      )
        return fail();
      const finalJournal = validateWeeklyJournalRecoverySnapshot(journal);
      const selected = finalJournal.runState.find((row) => row.id === runId);
      if (!selected) return fail();
      const state = parseWeeklyRunState(JSON.parse(selected.payload));
      const hasResume = entries.some(
        (entry) =>
          entry.path === intentPath ||
          entry.path === intentStage ||
          entry.path.startsWith(intentStage + "/") ||
          entry.path.startsWith(load + "/resume-")
      );
      const successors = hasResume
        ? observeSelectedLoadIntentSuccessors({
            destination: root,
            loadPath: load,
            entries: completedEntries,
            initial: read(intentPath, 65536),
            key: input.recoveryKey,
            initialSettled: true,
          })
        : undefined;
      if (
        successors &&
        (!successors.lastSettled ||
          (successors.successorCount && !successors.latestV2Successor))
      )
        return fail();
      let resultBytes: Buffer;
      let history: ReturnType<typeof readSelectedLoadHistoryFiles> | undefined;
      if (interruptedCompletion) {
        if (!completion || !changedFiles.snapshot) return fail();
        const regenerated = regenerateSelectedLoadCompletionPlan({
          intent: completion.fields,
          observedJournal: journal,
          encryptedCatalog: changedFiles.snapshot,
          entries,
          runStateSha256: sha256(canonicalJson(state)),
          reportSha256: plan.receipt.reportSha256,
          ...(successors?.latestV2Successor
            ? { successorSha256: successors.latestV2Successor.successorSha256 }
            : {}),
          key: input.recoveryKey,
        });
        const prefix = observeSelectedLoadCompletionPrefix({
          destination: root,
          runId,
          entries,
          files: regenerated.files,
          result: regenerated.result,
        });
        if (
          completion.state !== "settled" &&
          (prefix.settledCount !== 0 || prefix.next?.state !== "absent")
        )
          return fail();
        if (!prefix.next) return fail();
        completionPending = { intent: completion, plan: regenerated, prefix };
        resultBytes = regenerated.result;
        history = {
          manifestSha256: completion.fields.historyManifestSha256,
          parts: {
            encryptedCatalog: changedFiles.snapshot,
            guardedJournal: regenerated.guardedJournal,
            inventory: Buffer.from(canonicalJson(regenerated.inventory) + "\n"),
          },
          loadAllowed: false,
        };
      } else {
        resultBytes = read(resultPath, 65536);
        if (
          completion &&
          completion.fields.resultSha256 !== sha256(resultBytes)
        )
          return fail();
        history = withHistory
          ? readSelectedLoadHistoryFiles({
              loadPath: load,
              entries,
              read,
              identity: historyIdentity,
              key: input.recoveryKey,
            })
          : undefined;
      }
      if (
        completion &&
        (!history ||
          completion.fields.historyManifestSha256 !== history.manifestSha256)
      )
        return fail();
      let historyOwner:
        | ReturnType<
            typeof validateWeeklyJournalRecoverySnapshot
          >["ownership"][number]
        | undefined;
      let historyInventory: RecoveryRuntimeEntry[] | undefined;
      let historyReleasedJournal: Buffer | undefined;
      if (history) {
        if (
          !changedFiles.snapshot?.equals(history.parts.encryptedCatalog) ||
          (!completionPending &&
            entriesByPath.get(resultStage)?.kind !== "directory")
        )
          return fail();
        const projected =
          completionPending?.plan.inventory ??
          completedEntries.filter((entry) => entry.path !== resultPath);
        const withoutStage = projected.filter(
          (entry) => entry.path !== resultStage
        );
        if (
          history.parts.inventory.equals(
            Buffer.from(canonicalJson(projected) + "\n")
          )
        )
          historyInventory = projected;
        else if (
          history.parts.inventory.equals(
            Buffer.from(canonicalJson(withoutStage) + "\n")
          )
        )
          historyInventory = withoutStage;
        else return fail();
        const retained = validateWeeklyJournalRecoverySnapshot(
          history.parts.guardedJournal
        );
        historyOwner = retained.ownership.find(
          (row) => row.scope === "prodigic/zivv/production"
        );
        if (!historyOwner || historyOwner.expiresAtEpochMs <= 0) return fail();
        const currentOwner = validateWeeklyJournalRecoverySnapshot(
          journal
        ).ownership.find((row) => row.scope === historyOwner!.scope);
        if (
          currentOwner &&
          observeSelectedLoadLease(currentOwner.expiresAtEpochMs).status ===
            "active"
        )
          throw Error("RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE");
        const { digest: _digest, ...body } = retained;
        const released = {
          ...body,
          ownership: body.ownership.map((row) =>
            row.scope === historyOwner!.scope
              ? { ...row, expiresAtEpochMs: 0 }
              : row
          ),
        };
        const releasedBytes = Buffer.from(
          canonicalJson({
            ...released,
            digest: sha256(canonicalJson(released)),
          }) + "\n"
        );
        if (
          !releasedBytes.equals(journal) &&
          (!history.parts.guardedJournal.equals(journal) ||
            observeSelectedLoadLease(historyOwner.expiresAtEpochMs).status !==
              "expired")
        )
          return fail();
        historyReleasedJournal = releasedBytes;
        if (completion) {
          const journals = reconstructSelectedLoadCompletionJournals(
            journal,
            completion.fields
          );
          if (
            !journals.guardedJournal.equals(history.parts.guardedJournal) ||
            !journals.releasedJournal.equals(releasedBytes)
          )
            return fail();
        }
      }
      let successorSha256: string | undefined;
      let guardedJournalSha256: string | null;
      let releasedJournal: Buffer;
      if (
        !hasResume &&
        history &&
        historyInventory &&
        historyOwner &&
        historyReleasedJournal
      ) {
        const execution = verifySelectedLoadExecutionBaseline(
          executionBaseline,
          input.recoveryKey
        );
        if (
          historyOwner.expiresAtEpochMs < execution.startedAtEpochMs ||
          historyOwner.expiresAtEpochMs > execution.startedAtEpochMs + 180000
        )
          return fail();
        priorEntries = historyInventory;
        priorJournal = history.parts.guardedJournal;
        priorSnapshot = history.parts.encryptedCatalog;
        guardedJournalSha256 = sha256(priorJournal);
        releasedJournal = historyReleasedJournal;
      } else {
        const intent = verifySelectedLoadResumeIntent(
          read(intentPath, 65536),
          input.recoveryKey
        );
        if (
          intent.admissionSha256 !== common.admissionSha256 ||
          intent.executionBaselineSha256 !== sha256(executionBaseline)
        )
          return fail();
        if (intent.version === 3) {
          assertCommittedRollback(intent);
        } else if (
          intent.ledgerRevision !== ledgerDigest(catalog.ledger) ||
          intent.generation !== catalog.generation
        )
          return fail();
        if (!successors) return fail();
        const completedSuccessors = successors;
        const effective = completedSuccessors.latestV2Successor ?? intent;
        const completedJournal = observeSelectedLoadCompletedJournal(
          journal,
          effective
        );
        if (
          historyOwner &&
          (historyOwner.owner !== effective.owner ||
            historyOwner.fence !== effective.fence ||
            historyOwner.expiresAtEpochMs < effective.startedAtEpochMs ||
            historyOwner.expiresAtEpochMs > effective.deadlineEpochMs)
        )
          return fail();
        guardedJournalSha256 = history
          ? sha256(history.parts.guardedJournal)
          : completedJournal.guardedJournalSha256;
        releasedJournal = completedJournal.releasedJournal;
        successorSha256 =
          completedSuccessors.latestV2Successor?.successorSha256;
        const preEffectiveJournal = reconstructSelectedLoadResumeJournal({
          completedJournal: completedJournal.releasedJournal,
          intent: effective,
          runId,
        });
        priorJournal = reconstructSelectedLoadIntentBaseline({
          observedJournal: preEffectiveJournal,
          initial: intent,
          latest: completedSuccessors.latestV2Successor,
        }).baselineJournal;
        const execution = verifySelectedLoadExecutionBaseline(
          executionBaseline,
          input.recoveryKey
        );
        priorSnapshot = restoreIntentSnapshot(intent);
        priorEntries = reconstructSelectedLoadResumeInventory({
          observedEntries: (
            completionPending?.plan.inventory ?? completedEntries
          ).filter(
            (entry) => !completedSuccessors.successorPaths.includes(entry.path)
          ),
          ...(completionPending
            ? { outcome: "completion-staging" as const }
            : {}),
          originalEntries: execution.entries,
          preResumeSnapshot: priorSnapshot,
          intent,
          runId,
          reportPath: report,
        });
      }
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
        resultBytes,
        input.recoveryKey,
        {
          admissionSha256: common.admissionSha256,
          executionBaselineSha256: sha256(executionBaseline),
          runId,
          ledgerRevision: ledgerDigest(catalog.ledger),
          generation: catalog.generation,
          journalSha256: sha256(releasedJournal),
          runStateSha256: sha256(canonicalJson(state)),
          reportSha256: plan.receipt.reportSha256,
          ...(successorSha256 ? { successorSha256 } : {}),
          ...(history && guardedJournalSha256
            ? {
                historyManifestSha256: history.manifestSha256,
                guardedJournalSha256,
              }
            : {}),
        }
      );
      if (
        guardedJournalSha256 &&
        guardedJournalSha256 !== resultProof.guardedJournalSha256
      )
        return fail();
      if (!completionPending) completedResultSha256 = resultProof.resultSha256;
    }
    const hasIntentEvidence =
      !hasResult &&
      entries.some(
        (entry) =>
          entry.path === intentPath ||
          entry.path === intentStage ||
          entry.path.startsWith(intentStage + "/")
      );
    const installed = hasIntentEvidence
      ? inspectRecoveryInstalledFile(
          join(root, intentPath),
          join(root, intentStage),
          65536
        )
      : undefined;
    const initialBytes =
      installed?.target?.bytes ?? installed?.candidate?.bytes;
    const initial = initialBytes
      ? verifySelectedLoadResumeIntent(initialBytes, input.recoveryKey)
      : undefined;
    if (hasIntentEvidence && !initial) return fail();
    const settled = !!installed?.target && !installed.candidate;
    const committedRollback =
      initial?.version === 3 && catalog.generation === 2;
    if (committedRollback) {
      if (!settled) return fail();
      assertCommittedRollback(initial);
      priorSnapshot = restoreIntentSnapshot(initial);
      if (
        !priorSnapshot ||
        canonicalJson(
          decryptLedgerSnapshot(priorSnapshot, input.recoveryKey)
        ) !== canonicalJson(checkpoint.ledger)
      )
        return fail();
    }
    const pendingSnapshot = committedRollback
      ? priorSnapshot
      : changedFiles.snapshot;
    if (
      !hasResult &&
      entries.some((entry) => entry.path.startsWith(load + "/resume-snapshot-"))
    ) {
      if (!pendingSnapshot) return fail();
      const staged = observeSelectedLoadStagedSnapshot({
        destination: root,
        loadPath: load,
        snapshot: pendingSnapshot,
        entries,
      });
      priorEntries = staged.entries;
      stagedSnapshotPaths = staged.stagedPaths;
      stagedChunkCount = staged.completeChunks;
      stagedChunkPartial = staged.partial;
      incompleteSnapshotCandidate = staged.incompleteCandidate;
    }
    if (initial && initialBytes) {
      if (stagedChunkPartial) return fail();
      let prior = priorEntries.filter(
        (entry) =>
          entry.path !== intentPath &&
          entry.path !== intentStage &&
          !entry.path.startsWith(intentStage + "/") &&
          !entry.path.startsWith(load + "/resume-successor-")
      );
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
      if (committedRollback) {
        if (
          !successors.lastSettled ||
          (!baselineJournal.acquired && !successors.latestV2Successor)
        )
          return fail();
        const state = validateWeeklyJournalRecoverySnapshot(journal);
        const currentRun = state.runState.find((row) => row.id === runId);
        if (
          !currentRun ||
          parseWeeklyRunState(JSON.parse(currentRun.payload)).stages[3]
            ?.status !== "running" ||
          state.stageArtifacts.some(
            (item) => item.runId === runId && item.stage === "load"
          )
        )
          return fail();
        proveSelectedLoadPhysicalDelta({
          ...common,
          observedEntries: prior,
          changedFiles,
        });
        const execution = verifySelectedLoadExecutionBaseline(
          executionBaseline,
          input.recoveryKey
        );
        prior = reconstructSelectedLoadResumeInventory({
          observedEntries: entries.filter(
            (entry) => !successors.successorPaths.includes(entry.path)
          ),
          originalEntries: execution.entries,
          preResumeSnapshot: priorSnapshot,
          intent: initial,
          runId,
          reportPath: report,
          outcome: "committed-pending",
        });
      }
      const pending = observeSelectedLoadPendingIntent({
        destination: root,
        loadPath: load,
        entries,
        priorEntries: prior,
        journal: baselineJournal.baselineJournal,
        previousOwner: initial.previousOwner,
        admissionSha256: common.admissionSha256,
        executionBaselineSha256: sha256(executionBaseline),
        ledgerRevision: committedRollback
          ? ledgerDigest(checkpoint.ledger)
          : ledgerDigest(catalog.ledger),
        generation: committedRollback ? 1 : catalog.generation,
        snapshot: pendingSnapshot,
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
        ...(hasResult || committedRollback ? { snapshot: priorSnapshot } : {}),
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
        status: completionPending
          ? ("completion-pending" as const)
          : hasResult
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
      ...(completionPending ? { completionPending } : {}),
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
