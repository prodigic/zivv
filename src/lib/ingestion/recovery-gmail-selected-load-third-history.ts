import { resolve } from "node:path";
import {
  verifySelectedNextLoadExecutionBaseline,
  verifySelectedThirdLoadExecutionBaseline,
} from "./recovery-gmail-execution-baseline.js";
import { copyRecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import { observeSelectedLoadAdmissionTail } from "./recovery-gmail-selected-load-admission-tail.js";
import {
  readSettledSelectedLoadHistory,
  selectedLoadBackupPath,
} from "./recovery-gmail-selected-load-historical-predecessor.js";
import {
  readNextSelectedLoadAdmissionForReplay,
  readNextSelectedLoadAdmissionRunId,
} from "./recovery-gmail-selected-load-next-admission.js";
import { readSelectedLoadEntry } from "./recovery-gmail-selected-load-physical-reader.js";
import {
  digestThirdSelectedLoadCompletedPrefix,
  verifyThirdSelectedLoadAdmissionForHost,
} from "./recovery-gmail-selected-load-third-admission-format.js";
import type { RecoveryGmailThirdSelectedLoadFrameInput } from "./recovery-gmail-selected-load-third-framing.js";
import { openPreparedRuntimeForAdmission } from "./recovery-runtime.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

function invalid(): never {
  throw Error("INVALID_RECOVERY_GMAIL_THIRD_PREDECESSOR_HISTORY");
}

/** Bind the signed second completion to the exact installed third start.
 * Current SQL and backup may differ. A caller must still rederive the third
 * plan and prove the full live delta before treating the replacement as
 * settled or opening any writer. */
export function readThirdSelectedLoadPredecessorHistory(
  { family, third, admission }: RecoveryGmailThirdSelectedLoadFrameInput,
  baselineBytes: Buffer
) {
  try {
    const { recoveryKey: key, selector: _selector, ...runtime } = family.prior;
    if (
      !Buffer.isBuffer(baselineBytes) ||
      baselineBytes.length === 0 ||
      baselineBytes.length > 16 * 1024 * 1024
    )
      return invalid();
    const selector = copyRecoveryGmailSelectedReceiptSelector(third);
    if (
      selector.receiptId === family.prior.selector.receiptId ||
      selector.receiptId === family.next.receiptId
    )
      return invalid();
    const baseline = verifySelectedThirdLoadExecutionBaseline(
      baselineBytes,
      key
    );
    const opened = openPreparedRuntimeForAdmission({
      ...runtime,
      recoveryKey: key,
    });
    const root = resolve(runtime.destination);
    const { body, admittedAtEpochMs } = verifyThirdSelectedLoadAdmissionForHost(
      family,
      baseline.runId,
      admission,
      opened.receiptSha256
    );
    if (
      baseline.admissionSha256 !== sha256(admission) ||
      baseline.preparedReceiptSha256 !== opened.receiptSha256 ||
      baseline.completedPrefixSha256 !== body.completedPrefixSha256 ||
      baseline.catalogSha256 !== body.catalogSha256 ||
      baseline.journalSha256 !== body.journalSha256 ||
      baseline.predecessorInventorySha256 !== body.inventorySha256 ||
      baseline.generation !== body.generation ||
      baseline.startedAtEpochMs < admittedAtEpochMs ||
      baseline.startedAtEpochMs > Date.now() ||
      canonicalJson(body.selector) !== canonicalJson(selector)
    )
      return invalid();

    const allEntries = opened.inventoryGmailSelectedLoadExecution();
    const startPath =
      "recovery-gmail-load/" + baseline.runId + "/execution-baseline.json";
    const stagePath = startPath + "-stage";
    if (
      !allEntries.some(
        ({ path, kind }) => path === stagePath && kind === "directory"
      ) ||
      allEntries.some(({ path }) => path.startsWith(stagePath + "/")) ||
      !readSelectedLoadEntry(
        root,
        allEntries.find(({ path }) => path === startPath),
        16 * 1024 * 1024
      ).equals(baselineBytes)
    )
      return invalid();
    const thirdPath = "recovery-gmail-load/" + baseline.runId;
    const admissionStage = thirdPath + "/stages/admission";
    const fixedAdmissionPaths = new Set([
      thirdPath,
      thirdPath + "/admission.json",
      thirdPath + "/stages",
      admissionStage,
    ]);
    const admissionFiles = ({ path }: { path: string }) =>
      fixedAdmissionPaths.has(path) || path.startsWith(admissionStage + "/");
    if (
      canonicalJson(allEntries.filter(admissionFiles)) !==
      canonicalJson(baseline.entries.filter(admissionFiles))
    )
      return invalid();
    const admissionTail = observeSelectedLoadAdmissionTail(
      root,
      baseline.entries,
      { runId: baseline.runId, bytes: admission }
    );
    const { predecessorEntries: entries } = admissionTail;
    const inventorySha256 = sha256(canonicalJson(entries));
    if (
      !admissionTail.observed.target ||
      admissionTail.observed.candidate ||
      inventorySha256 !== baseline.predecessorInventorySha256
    )
      return invalid();
    const loadPrefix = "recovery-gmail-load/";
    const livePredecessors = allEntries.filter(
      ({ path }) =>
        path.startsWith(loadPrefix) &&
        path !== thirdPath &&
        !path.startsWith(thirdPath + "/")
    );
    if (
      canonicalJson(livePredecessors) !==
      canonicalJson(entries.filter(({ path }) => path.startsWith(loadPrefix)))
    )
      return invalid();
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    if (byPath.size !== entries.length) return invalid();
    const read = (path: string, limit: number) =>
      readSelectedLoadEntry(root, byPath.get(path), limit);

    const runId = readNextSelectedLoadAdmissionRunId(family.admission, key);
    const prefix = "recovery-gmail-load/" + runId;
    const executionBytes = read(
      prefix + "/execution-baseline.json",
      16 * 1024 * 1024
    );
    const execution = verifySelectedNextLoadExecutionBaseline(
      executionBytes,
      key
    );
    const admissionSha256 = sha256(family.admission);
    if (
      runId !== body.previousRunId ||
      !read(prefix + "/admission.json", 65536).equals(family.admission) ||
      execution.admissionSha256 !== admissionSha256 ||
      execution.generation + 1 !== baseline.generation
    )
      return invalid();
    const { record, effective } = readNextSelectedLoadAdmissionForReplay(
      family.prior,
      family.next,
      family.admission,
      executionBytes
    );
    if (
      record.priorLoadFamilySha256 !== execution.priorLoadFamilySha256 ||
      record.catalogSha256 !== execution.catalogSha256 ||
      record.journalSha256 !== execution.journalSha256 ||
      execution.startedAtEpochMs < record.admittedAtEpochMs ||
      execution.startedAtEpochMs > baseline.startedAtEpochMs
    )
      return invalid();
    const identity = {
      runId,
      admissionSha256,
      executionBaselineSha256: sha256(executionBytes),
      priorFamilySha256: record.priorLoadFamilySha256,
      ledgerRevision: baseline.catalogSha256,
      generation: baseline.generation,
    };
    const history = readSettledSelectedLoadHistory({
      root,
      entries,
      identity,
      read,
      key,
    });
    const backup = byPath.get(selectedLoadBackupPath);
    const journalSha256 = sha256(history.journal);
    const completedPrefixSha256 = digestThirdSelectedLoadCompletedPrefix({
      firstLoadFamilySha256: identity.priorFamilySha256,
      second: {
        runId,
        admissionSha256,
        executionBaselineSha256: identity.executionBaselineSha256,
        historyManifestSha256: history.historyManifestSha256,
        resultSha256: history.resultSha256,
      },
      catalogSha256: identity.ledgerRevision,
      generation: identity.generation,
      journalSha256,
      inventorySha256,
    });
    if (
      journalSha256 !== baseline.journalSha256 ||
      completedPrefixSha256 !== baseline.completedPrefixSha256 ||
      backup?.kind !== "file" ||
      backup.size !== history.snapshot.length ||
      backup.sha256 !== sha256(history.snapshot) ||
      canonicalJson(allEntries) !==
        canonicalJson(opened.inventoryGmailSelectedLoadExecution())
    )
      return invalid();
    return {
      history,
      predecessorEntries: entries,
      completedPrefixSha256,
      liveDeltaRequired: true as const,
      family: {
        opened,
        root,
        entries,
        allEntries,
        beforeThirdStartEntries: baseline.entries,
        thirdAdmissionPresence: "installed" as const,
        thirdStartPresence: "installed" as const,
        read,
        loadPath: prefix,
        runId,
        executionBytes,
        execution,
        record,
        effective,
        admissionSha256,
      },
    };
  } catch {
    return invalid();
  }
}
