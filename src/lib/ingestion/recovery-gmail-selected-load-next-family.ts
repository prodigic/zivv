import { resolve } from "node:path";
import type { RecoveryGmailSelectedReceiptSelector } from "./recovery-gmail-capture-admission-proof.js";
import {
  observeSelectedLoadAdmissionTail,
  selectedLoadAdmissionTailPaths,
} from "./recovery-gmail-selected-load-admission-tail.js";
import { verifySelectedNextLoadExecutionBaseline } from "./recovery-gmail-execution-baseline.js";
import type { RecoveryGmailSelectedLoadFrameInput } from "./recovery-gmail-selected-load-framing.js";
import {
  readNextSelectedLoadAdmissionForReplay,
  readNextSelectedLoadAdmissionRunId,
} from "./recovery-gmail-selected-load-next-admission.js";
import { readSelectedLoadEntry } from "./recovery-gmail-selected-load-physical-reader.js";
import { verifyThirdSelectedLoadAdmissionRecord } from "./recovery-gmail-selected-load-third-admission-format.js";
import {
  observeThirdSelectedLoadStartTail,
  type SelectedThirdLoadEvidenceTail,
} from "./recovery-gmail-selected-load-third-start-tail.js";
import { openPreparedRuntimeForAdmission } from "./recovery-runtime.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

function fail(): never {
  throw Error("INVALID_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_FAMILY");
}

/** Authenticate the historical predecessor and the successor start record.
 * Each caller independently proves the live delta appropriate to its stage. */
export function readNextSelectedLoadFamily(
  input: RecoveryGmailSelectedLoadFrameInput,
  next: RecoveryGmailSelectedReceiptSelector,
  admission: Buffer,
  thirdTail?: SelectedThirdLoadEvidenceTail
) {
  const { selector: _selector, recoveryKey: key, ...host } = input;
  const opened = openPreparedRuntimeForAdmission({
    ...host,
    recoveryKey: key,
  });
  const root = resolve(host.destination);
  if (thirdTail) {
    const { body } = verifyThirdSelectedLoadAdmissionRecord(
      thirdTail.bytes,
      key
    );
    if (
      body.runId !== thirdTail.runId ||
      body.archiveSha256 !== sha256(input.archive) ||
      body.retirementReceiptSha256 !== sha256(input.retirementReceipt) ||
      body.preparedReceiptSha256 !== opened.receiptSha256 ||
      body.secondAdmissionSha256 !== sha256(admission) ||
      canonicalJson(body.firstSelector) !== canonicalJson(input.selector) ||
      canonicalJson(body.secondSelector) !== canonicalJson(next)
    )
      return fail();
  }
  const allEntries = opened.inventoryGmailSelectedLoadExecution();
  const start =
    thirdTail?.executionBaseline === undefined
      ? undefined
      : observeThirdSelectedLoadStartTail(
          root,
          allEntries,
          thirdTail,
          thirdTail.executionBaseline,
          key
        );
  const beforeThirdStartEntries = start?.beforeStart ?? allEntries;
  const projection = thirdTail
    ? observeSelectedLoadAdmissionTail(root, beforeThirdStartEntries, thirdTail)
    : undefined;
  const entries = projection?.predecessorEntries ?? allEntries;
  const tailBase = thirdTail
    ? selectedLoadAdmissionTailPaths(root, thirdTail.runId).base
    : undefined;
  const thirdAdmissionPresence = projection
    ? projection.observed.target && !projection.observed.candidate
      ? ("installed" as const)
      : beforeThirdStartEntries.some(({ path }) => path === tailBase)
        ? ("staging" as const)
        : ("absent" as const)
    : undefined;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  if (byPath.size !== entries.length) return fail();
  const read = (path: string, limit: number) =>
    readSelectedLoadEntry(root, byPath.get(path), limit);

  const runId = readNextSelectedLoadAdmissionRunId(admission, key);
  const loadPath = "recovery-gmail-load/" + runId;
  if (!read(loadPath + "/admission.json", 65536).equals(admission))
    return fail();
  const executionBytes = read(
    loadPath + "/execution-baseline.json",
    32 * 1024 * 1024
  );
  const execution = verifySelectedNextLoadExecutionBaseline(
    executionBytes,
    key
  );
  const { record, effective } = readNextSelectedLoadAdmissionForReplay(
    input,
    next,
    admission,
    executionBytes
  );
  const admissionSha256 = sha256(admission);
  if (
    execution.admissionSha256 !== admissionSha256 ||
    execution.priorLoadFamilySha256 !== record.priorLoadFamilySha256 ||
    execution.catalogSha256 !== record.catalogSha256 ||
    execution.journalSha256 !== record.journalSha256 ||
    execution.startedAtEpochMs < record.admittedAtEpochMs ||
    execution.startedAtEpochMs > Date.now()
  )
    return fail();
  return {
    opened,
    root,
    entries,
    allEntries,
    beforeThirdStartEntries,
    thirdStartPresence: start?.presence,
    thirdAdmissionPresence,
    read,
    loadPath,
    runId,
    executionBytes,
    execution,
    record,
    effective,
    admissionSha256,
  };
}
