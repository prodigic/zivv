import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { runRecoveryWorkerProcess } from "./recovery-worker-process.js";
import { withRecoveryWindowsJobRunner } from "./recovery-windows-job-runner.js";
import { resolveSeparateGmailStorage } from "./steve-gmail-credential-poll.js";
import { pollFridayGmailWithWindowsCredentials } from "./steve-gmail-friday-poll.js";
import { fridayDeliveryTimes } from "./weekly.js";

const frameLimit = 16 * 1024;
const frameFields = [
  "credentialDirectory",
  "operatorDirectory",
  "expectedAccountId",
  "expectedEditionId",
  "scanStartsAt",
] as const;

function invalid(): never {
  throw Error("INVALID_FRIDAY_GMAIL_WORKER_INPUT");
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}

function exactFields(
  record: Record<string, unknown>,
  fields: readonly string[]
) {
  return (
    Object.keys(record).length === fields.length &&
    fields.every((field) => Object.hasOwn(record, field))
  );
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > maximum ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return invalid();
  return value;
}

function decodeInput(bytes: Buffer) {
  if (!bytes.length || bytes.length > frameLimit) return invalid();
  try {
    const record = objectRecord(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    );
    if (!exactFields(record, frameFields)) return invalid();
    const credentialDirectory = text(record.credentialDirectory, 4096);
    const operatorDirectory = text(record.operatorDirectory, 4096);
    const expectedAccountId = text(record.expectedAccountId, 320);
    const expectedEditionId = text(record.expectedEditionId, 10);
    const start = text(record.scanStartsAt, 32);
    const scanStartsAtEpochMs = Date.parse(start);
    if (
      !isAbsolute(credentialDirectory) ||
      !isAbsolute(operatorDirectory) ||
      !/^[^\s@]+@[^\s@]+$/u.test(expectedAccountId) ||
      expectedEditionId.length !== 10 ||
      !Number.isSafeInteger(scanStartsAtEpochMs) ||
      new Date(scanStartsAtEpochMs).toISOString() !== start
    )
      return invalid();
    resolveSeparateGmailStorage(operatorDirectory, credentialDirectory);
    const timing = fridayDeliveryTimes(expectedEditionId);
    if (
      scanStartsAtEpochMs < 0 ||
      scanStartsAtEpochMs > timing.publicationNotBeforeEpochMs
    )
      return invalid();
    return {
      credentialDirectory,
      operatorDirectory,
      expectedAccountId,
      expectedEditionId,
      scanStartsAtEpochMs,
      reviewAtEpochMs: timing.newSourceReviewAtEpochMs,
    };
  } catch {
    return invalid();
  }
}

/** Read a small, owned frame. Credentials and message bodies never enter it. */
export async function readFridayGmailWorkerInput(
  input: AsyncIterable<Uint8Array>
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const raw of input) {
      size += raw.byteLength;
      if (size > frameLimit) return invalid();
      chunks.push(Buffer.from(raw));
    }
    if (!size) return invalid();
    return Buffer.concat(chunks, size);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Fixed child entry. Return a bounded summary, including for cached large batches. */
export async function runFridayGmailWorker(bytes: Buffer) {
  const { reviewAtEpochMs: _reviewAt, ...input } = decodeInput(bytes);
  const result = await pollFridayGmailWithWindowsCredentials(input);
  if (result.status !== "captured") return result;
  const { batch, ...report } = result;
  return {
    ...report,
    batchCount: batch.batchIds.length,
    messageCount: batch.messageCount,
    readyCount: batch.receipts.filter(
      (receipt) => receipt.disposition === "ready"
    ).length,
    reviewRequiredCount: batch.receipts.filter(
      (receipt) => receipt.disposition === "review-required"
    ).length,
    replayed: batch.replayed,
  };
}

function readReport(stdout: Buffer, input: ReturnType<typeof decodeInput>) {
  const bad = () => {
    throw Error("FRIDAY_GMAIL_WORKER_REPORT_UNVERIFIED");
  };
  try {
    const report = objectRecord(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout))
    );
    if (report.editionId !== input.expectedEditionId) return bad();
    const base = ["status", "editionId"];
    const count = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (report.status === "not-open") {
      if (
        !exactFields(report, [...base, "nextAtEpochMs"]) ||
        report.nextAtEpochMs !== input.scanStartsAtEpochMs
      )
        return bad();
      return report;
    }
    if (report.status === "closed-for-review") {
      if (
        !exactFields(report, [...base, "reviewAtEpochMs"]) ||
        report.reviewAtEpochMs !== input.reviewAtEpochMs
      )
        return bad();
      return report;
    }
    if (report.attempts !== 1 && report.attempts !== 2 && report.attempts !== 3)
      return bad();
    if (report.status === "missing") {
      const evidence = objectRecord(report.mailboxEvidence);
      if (
        !exactFields(report, [...base, "attempts", "mailboxEvidence"]) ||
        !exactFields(evidence, ["kind", "status", "scannedThroughEpochMs"]) ||
        evidence.kind !== "mailbox-scan" ||
        evidence.status !== "absent" ||
        typeof evidence.scannedThroughEpochMs !== "number" ||
        !Number.isSafeInteger(evidence.scannedThroughEpochMs) ||
        evidence.scannedThroughEpochMs < input.scanStartsAtEpochMs ||
        evidence.scannedThroughEpochMs >= input.reviewAtEpochMs ||
        evidence.scannedThroughEpochMs > Date.now()
      )
        return bad();
      return report;
    }
    const counts = [
      "batchCount",
      "messageCount",
      "readyCount",
      "reviewRequiredCount",
    ];
    if (
      report.status !== "captured" ||
      !exactFields(report, [...base, "attempts", "replayed", ...counts]) ||
      typeof report.replayed !== "boolean" ||
      !counts.every((field) => count(report[field]))
    )
      return bad();
    return report;
  } catch {
    return bad();
  }
}

/** Run only the packaged mailbox worker under the reviewed Windows job helper. */
export async function pollFridayGmailInWindowsJob(
  bytes: Buffer,
  deadlineMs: number
) {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 600_000
  )
    throw Error("INVALID_FRIDAY_GMAIL_WORKER_BUDGET");
  const input = decodeInput(bytes);
  const worker = fileURLToPath(
    new URL("../../../scripts/steve-gmail-friday-worker.js", import.meta.url)
  );
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const result = await withRecoveryWindowsJobRunner((jobRunner) =>
    runRecoveryWorkerProcess({
      cwd: dirname(dirname(worker)),
      env,
      nodeArgs: [worker],
      input: bytes,
      deadlineMs,
      jobRunner,
    })
  );
  if (result.status === "setup-refused")
    throw Error("FRIDAY_GMAIL_WORKER_SETUP_REFUSED");
  if (result.status === "stopped") throw Error("FRIDAY_GMAIL_WORKER_STOPPED");
  if (result.status === "termination-unconfirmed")
    throw Error("FRIDAY_GMAIL_WORKER_TERMINATION_UNCONFIRMED");
  if (result.status !== "exited")
    throw Error("FRIDAY_GMAIL_WORKER_REPORT_UNVERIFIED");
  if (result.code !== 0 || result.signal) {
    const code =
      /(?:^|\n)\{"pollError":"([A-Z][A-Z0-9_]{2,95})"\}\r?(?:\n|$)/u.exec(
        result.stderr.toString("utf8")
      )?.[1];
    throw Error(code ?? "FRIDAY_GMAIL_WORKER_FAILED");
  }
  return readReport(result.stdout, input);
}
