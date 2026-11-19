import { isAbsolute } from "node:path";
import {
  loadRetainedSteveEmailSources,
  requireConfiguredSteveEmailLoadOperator,
  summarizeRetainedSteveEmailLoad,
} from "./steve-email-load.js";
import { pollFridayGmailInWindowsJob } from "./steve-gmail-friday-supervised.js";
import { readSteveGmailHandoffStatus } from "./steve-gmail-handoff.js";
import { planFridayMailboxWake } from "./weekly.js";

export interface FridayMailboxWakeDependencies {
  clock: () => number;
  poll: typeof pollFridayGmailInWindowsJob;
}

function invalid(): never {
  throw Error("INVALID_FRIDAY_MAILBOX_WAKE_INPUT");
}

function readConfig(bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 16384)
    return invalid();
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 4
    )
      return invalid();
    const {
      credentialDirectory,
      operatorDirectory,
      expectedAccountId,
      earlyScanDays,
    } = value as Record<string, unknown>;
    if (
      typeof credentialDirectory !== "string" ||
      credentialDirectory.length > 4096 ||
      !isAbsolute(credentialDirectory) ||
      typeof operatorDirectory !== "string" ||
      operatorDirectory.length > 4096 ||
      !isAbsolute(operatorDirectory) ||
      typeof expectedAccountId !== "string" ||
      expectedAccountId.length > 320 ||
      !/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u.test(expectedAccountId) ||
      typeof earlyScanDays !== "number" ||
      !Number.isInteger(earlyScanDays) ||
      earlyScanDays < 0 ||
      earlyScanDays > 4
    )
      return invalid();
    return {
      credentialDirectory,
      operatorDirectory,
      expectedAccountId,
      earlyScanDays,
    };
  } catch {
    return invalid();
  }
}

/** One explicitly requested wake. The fixed worker handles provider access,
 * then the normal private loader stops at load. */
export async function runFridayMailboxWake(
  root: string,
  bytes: Buffer,
  workerBudgetMs: number,
  { clock, poll }: FridayMailboxWakeDependencies = {
    clock: Date.now,
    poll: pollFridayGmailInWindowsJob,
  }
) {
  if (
    !isAbsolute(root) ||
    !Number.isSafeInteger(workerBudgetMs) ||
    workerBudgetMs < 1 ||
    workerBudgetMs > 600000
  )
    return invalid();
  const config = readConfig(bytes);
  const wake = planFridayMailboxWake(clock(), config.earlyScanDays);
  const { editionId } = wake;
  if (wake.status === "not-open") return wake;
  const operatorDirectory = requireConfiguredSteveEmailLoadOperator(
    root,
    config.operatorDirectory
  );
  const frame = Buffer.from(
    JSON.stringify({
      credentialDirectory: config.credentialDirectory,
      operatorDirectory,
      expectedAccountId: config.expectedAccountId,
      expectedEditionId: editionId,
      scanStartsAt: new Date(wake.scanStartsAtEpochMs).toISOString(),
    })
  );
  let report;
  try {
    report = await poll(frame, workerBudgetMs);
  } finally {
    frame.fill(0);
  }
  const { status: mailboxStatus } = report;
  if (report.editionId !== editionId)
    throw Error("FRIDAY_GMAIL_WORKER_REPORT_UNVERIFIED");
  if (mailboxStatus === "not-open" || mailboxStatus === "closed-for-review")
    return { ...wake, status: mailboxStatus };
  if (mailboxStatus !== "captured" && mailboxStatus !== "missing")
    throw Error("FRIDAY_GMAIL_WORKER_REPORT_UNVERIFIED");
  const loaded = await loadRetainedSteveEmailSources({
    root,
    operatorDirectory,
    accountId: config.expectedAccountId,
    expectedEditionId: editionId,
  });
  const summary = summarizeRetainedSteveEmailLoad(loaded);
  const result = { ...summary, mailboxStatus };
  if (mailboxStatus !== "missing" || summary.status !== "no-retained-source")
    return result;

  const observation = report.mailboxEvidence;
  if (
    !observation ||
    typeof observation !== "object" ||
    Array.isArray(observation) ||
    !("kind" in observation) ||
    observation.kind !== "mailbox-scan" ||
    !("status" in observation) ||
    observation.status !== "absent" ||
    !("scannedThroughEpochMs" in observation) ||
    typeof observation.scannedThroughEpochMs !== "number" ||
    !Number.isSafeInteger(observation.scannedThroughEpochMs) ||
    observation.scannedThroughEpochMs < wake.scanStartsAtEpochMs ||
    observation.scannedThroughEpochMs >= wake.newSourceReviewAtEpochMs ||
    observation.scannedThroughEpochMs > clock()
  )
    throw Error("FRIDAY_GMAIL_WORKER_REPORT_UNVERIFIED");

  const handoff = readSteveGmailHandoffStatus({
    operatorDirectory,
    expectedAccountId: config.expectedAccountId,
    expectedEditionId: editionId,
  });
  if (handoff.batches.length !== 0) return result;
  return {
    ...result,
    missingSourceEvidence: {
      kind: "mailbox-scan" as const,
      status: "absent" as const,
      scannedThroughEpochMs: observation.scannedThroughEpochMs,
    },
  };
}
