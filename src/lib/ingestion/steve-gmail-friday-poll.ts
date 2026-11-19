import { setTimeout as wait } from "node:timers/promises";
import { captureSteveGmailWindowWithWindowsCredentials } from "./steve-gmail-credential-poll.js";
import type { SteveGmailBatchResult } from "./steve-gmail-handoff.js";
import { fridayDeliveryTimes } from "./weekly.js";

interface FridayGmailPollInput {
  editionId: string;
  scanStartsAtEpochMs: number;
}

interface FridayGmailPollDependencies {
  clock: () => number;
  wait: (delayMs: number) => Promise<void>;
  capture: (input: {
    startEpochMs: number;
    endEpochMs: number;
    requireStableMailboxForMissing: true;
  }) => Promise<SteveGmailBatchResult>;
}

const retryDelaysMs = [2_000, 8_000];
const retryableFailures = new Set([
  "GMAIL_RETRYABLE_FAILURE",
  "GMAIL_TRANSPORT_FAILED",
  "GMAIL_AUTH_RETRYABLE_FAILURE",
  "GMAIL_AUTH_TRANSPORT_FAILED",
  "GMAIL_CREDENTIAL_STORAGE_BUSY",
  "GMAIL_MAILBOX_OBSERVATION_CHANGED",
]);

function invalidWindow(): never {
  throw new Error("INVALID_GMAIL_FRIDAY_POLL_WINDOW");
}

function validEpoch(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    Number.isFinite(new Date(value).getTime())
  );
}

function timings(editionId: string) {
  try {
    return fridayDeliveryTimes(editionId);
  } catch {
    return invalidWindow();
  }
}

/** One explicit Friday invocation, with bounded retries and no scheduling side effects. */
export async function superviseFridayGmailPoll(
  { editionId, scanStartsAtEpochMs }: FridayGmailPollInput,
  deps: FridayGmailPollDependencies
) {
  const { publicationNotBeforeEpochMs, newSourceReviewAtEpochMs } =
    timings(editionId);
  if (
    !validEpoch(scanStartsAtEpochMs) ||
    scanStartsAtEpochMs > publicationNotBeforeEpochMs
  )
    return invalidWindow();

  let lastClock = 0;
  const sample = () => {
    const now = deps.clock();
    if (!validEpoch(now) || now < lastClock) return invalidWindow();
    lastClock = now;
    return now;
  };

  let previousFailure: Error | undefined;
  for (let retry = 0; ; retry++) {
    const now = sample();
    if (now < scanStartsAtEpochMs)
      return {
        status: "not-open" as const,
        editionId,
        nextAtEpochMs: scanStartsAtEpochMs,
      };
    if (now >= newSourceReviewAtEpochMs) {
      if (previousFailure) throw previousFailure;
      return {
        status: "closed-for-review" as const,
        editionId,
        reviewAtEpochMs: newSourceReviewAtEpochMs,
      };
    }
    const endEpochMs = now + 1;
    let batch: SteveGmailBatchResult;
    try {
      batch = await deps.capture({
        startEpochMs: scanStartsAtEpochMs,
        endEpochMs,
        requireStableMailboxForMissing: true,
      });
    } catch (error) {
      const delay = retryDelaysMs[retry];
      if (
        delay === undefined ||
        !(error instanceof Error) ||
        !retryableFailures.has(error.message) ||
        sample() + delay >= newSourceReviewAtEpochMs
      )
        throw error;
      // A suspended host can wake after the window. Keep the failure visible.
      previousFailure = error;
      await deps.wait(delay);
      continue;
    }
    const attempts = retry + 1;
    if (batch.status === "captured")
      return { status: "captured" as const, editionId, attempts, batch };
    if (
      batch.status !== "missing" ||
      batch.replayed !== false ||
      !Array.isArray(batch.batchIds) ||
      !Array.isArray(batch.receipts) ||
      batch.batchIds.length ||
      batch.messageCount !== 0 ||
      batch.receipts.length
    )
      throw Error("GMAIL_MAILBOX_OBSERVATION_UNVERIFIED");
    return {
      status: "missing" as const,
      editionId,
      attempts,
      mailboxEvidence: {
        kind: "mailbox-scan" as const,
        status: "absent" as const,
        scannedThroughEpochMs: endEpochMs - 1,
      },
    };
  }
}

type WindowsFridayGmailPollInput = Omit<
  Parameters<typeof captureSteveGmailWindowWithWindowsCredentials>[0],
  "startEpochMs" | "endEpochMs" | "requireStableMailboxForMissing"
> & { scanStartsAtEpochMs: number };

/** Use exact durable handoff and private OAuth for one explicitly named edition. */
export function pollFridayGmailWithWindowsCredentials({
  scanStartsAtEpochMs,
  ...input
}: WindowsFridayGmailPollInput) {
  return superviseFridayGmailPoll(
    { editionId: input.expectedEditionId, scanStartsAtEpochMs },
    {
      clock: Date.now,
      wait,
      capture: (window) =>
        captureSteveGmailWindowWithWindowsCredentials({ ...input, ...window }),
    }
  );
}
