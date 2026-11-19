import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import {
  inspectRetiredOperatorLeaseFence,
  verifyOperatorRetirementEvidence,
} from "./operator-recovery.js";
import { inspectComposedRecoveryGmailObligations } from "./recovery-gmail-inspector.js";
import type { RecoveryGmailNextSelectedLoadFrameInput } from "./recovery-gmail-selected-load-next-framing.js";
import { readNextSelectedLoadCompletionEvidence } from "./recovery-gmail-selected-load-next-replay.js";
import { readSelectedLoadEntry } from "./recovery-gmail-selected-load-physical-reader.js";
import { observeReplacementAcknowledgedWatermarkForTest } from "./recovery-import-remote.js";
import {
  verifyPreparedOperatorRuntime,
  type RecoveryRuntimeInput,
} from "./recovery-runtime.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

interface ReplacementPreflightFixtureInput {
  oldRoot: string;
  oldNpmCli: string;
  prepared: RecoveryRuntimeInput;
  repositoryRoot: string;
  bareDirectory: string;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function invalid(): never {
  throw Error("REPLACEMENT_HOST_PREFLIGHT_UNVERIFIED");
}

function observeReplacementBase({
  oldRoot,
  oldNpmCli,
  prepared,
  repositoryRoot,
  bareDirectory,
}: ReplacementPreflightFixtureInput) {
  const { checkpoint } = verifyOperatorRetirementEvidence(prepared);
  const replacement = realpathSync(prepared.destination);
  for (const original of [
    checkpoint.originalCheckout,
    checkpoint.originalOperatorDirectory,
  ]) {
    if (contains(original, replacement) || contains(replacement, original))
      return invalid();
  }
  const old = {
    root: oldRoot,
    npmCli: oldNpmCli,
    archive: prepared.archive,
    retirementReceipt: prepared.retirementReceipt,
    recoveryKey: prepared.recoveryKey,
  };
  const oldFence = inspectRetiredOperatorLeaseFence(old);
  const watermark = observeReplacementAcknowledgedWatermarkForTest({
    repositoryRoot,
    bareDirectory,
    checkpoint,
    recoveryKey: prepared.recoveryKey,
  });
  if (watermark.binding.acknowledgedLedgerRevision !== oldFence.ledgerRevision)
    return invalid();
  return {
    checkpoint,
    replacement,
    oldFence,
    watermark: watermark.binding,
    assertCurrent() {
      if (
        realpathSync(prepared.destination) !== replacement ||
        canonicalJson(inspectRetiredOperatorLeaseFence(old)) !==
          canonicalJson(oldFence)
      )
        return invalid();
      watermark.assertCurrent();
    },
  };
}

/** Observe an exact pristine replacement tree with the cooperative old fence. */
export function inspectReplacementPreflightForTest(
  input: ReplacementPreflightFixtureInput
) {
  try {
    const base = observeReplacementBase(input);
    const successor = verifyPreparedOperatorRuntime(input.prepared);
    if (
      successor.checkpointSha256 !== base.oldFence.checkpointSha256 ||
      successor.ledgerRevision !== base.oldFence.ledgerRevision ||
      canonicalJson(verifyPreparedOperatorRuntime(input.prepared)) !==
        canonicalJson(successor)
    )
      return invalid();
    base.assertCurrent();
    return {
      status: "replacement-preflight-observed" as const,
      activationAllowed: false as const,
      oldFence: base.oldFence,
      successor,
      watermark: base.watermark,
    };
  } catch {
    return invalid();
  }
}

/** Observe lawful private load effects while preserving the acknowledged watermark. */
export function inspectLoadedReplacementPreflightForTest({
  loaded,
  laterCutoffEpochMs,
  ...location
}: Omit<ReplacementPreflightFixtureInput, "prepared"> & {
  loaded: RecoveryGmailNextSelectedLoadFrameInput;
  laterCutoffEpochMs: number;
}) {
  try {
    const base = observeReplacementBase({
      ...location,
      prepared: loaded.prior,
    });
    const publishedCutoff = base.watermark.acknowledgedCutoffEpochMs;
    if (
      !Number.isSafeInteger(laterCutoffEpochMs) ||
      laterCutoffEpochMs <= publishedCutoff ||
      laterCutoffEpochMs > Date.now()
    )
      return invalid();
    const weeklyPath = "data/ingestion/weekly-editions.json";
    const archived = base.checkpoint.files.find(
      (entry) => entry.area === "checkout" && entry.path === weeklyPath
    );
    if (!archived?.bytes) return invalid();
    const archivedWeekly = Buffer.from(archived.bytes, "base64");

    const observeSuccessor = () => {
      const complete = readNextSelectedLoadCompletionEvidence(
        loaded.prior,
        loaded.next,
        loaded.admission
      );
      const { lease, status, generation, ledgerRevision, resultSha256 } =
        complete.report;
      if (
        status !== "selected-load-complete" ||
        lease.status !== "released" ||
        generation !== 3 ||
        ledgerRevision === base.oldFence.ledgerRevision
      )
        return invalid();
      const weekly = readSelectedLoadEntry(
        base.replacement,
        complete.physicalEntries.find(
          (entry) => entry.path === "checkout/" + weeklyPath
        ),
        archivedWeekly.length
      );
      if (!weekly.equals(archivedWeekly)) return invalid();
      const audit = inspectComposedRecoveryGmailObligations({
        ...loaded,
        cutoffEpochMs: laterCutoffEpochMs,
      });
      if (
        audit.catalogSha256 !== ledgerRevision ||
        audit.generation !== generation ||
        audit.journalSha256 !== sha256(complete.observedJournal) ||
        audit.runId !== complete.report.runId
      )
        return invalid();
      const acknowledgedBlockingBatchCount = audit.batches.filter(
        (batch) =>
          batch.firstSavedAtEpochMs < publishedCutoff &&
          batch.messages.some((message) => message.status !== "loaded")
      ).length;
      if (acknowledgedBlockingBatchCount !== 0) return invalid();
      return {
        successor: {
          generation,
          ledgerRevision,
          resultSha256,
          journalSha256: audit.journalSha256,
          weeklySha256: sha256(weekly),
        },
        acknowledgedBlockingBatchCount,
        laterBlockingBatchCount: audit.blockingBatchCount,
        batches: audit.batches,
      };
    };
    const observed = observeSuccessor();
    if (canonicalJson(observeSuccessor()) !== canonicalJson(observed))
      return invalid();
    base.assertCurrent();
    return {
      status: "loaded-replacement-preflight-observed" as const,
      activationAllowed: false as const,
      freezeAllowed: false as const,
      oldFence: base.oldFence,
      watermark: base.watermark,
      ...observed,
    };
  } catch {
    return invalid();
  }
}
