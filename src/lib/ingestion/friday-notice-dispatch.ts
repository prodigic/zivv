import type { FridayMonitorNotice } from "./friday-monitor-evidence.js";
import type {
  FridayNoticeOutbox,
  FridayNoticeOutboxRecord,
  FridayPublicationNoticeOutboxRecord,
} from "./friday-notice-outbox.js";
import { inspectFridayVerifiedReleaseCoverage } from "./friday-release-coverage.js";
import { canonicalJson } from "./sqlite-store.js";

interface DeliveryClaim<Notice> {
  notice: Readonly<Notice>;
  attemptId: string;
}

interface DeliveryReceipt {
  key: string;
  attemptId: string;
  receiptSha256: string;
}

/** Prepare performs no send. Find verifies a provider receipt without sending. */
export interface FridayNoticeProvider<Prepared, Notice = FridayMonitorNotice> {
  prepare(notice: Readonly<Notice>): Promise<Prepared>;
  send(
    prepared: Prepared,
    claim: DeliveryClaim<Notice>
  ): Promise<DeliveryReceipt | null>;
  findDelivery(claim: DeliveryClaim<Notice>): Promise<DeliveryReceipt | null>;
}

type StoredPublicationNotice = FridayPublicationNoticeOutboxRecord["notice"];
type CoverageEvidence = Parameters<
  typeof inspectFridayVerifiedReleaseCoverage
>[0];
export type FridayPublicationDeliveryNotice = Omit<
  StoredPublicationNotice,
  "deduplicationKey" | "coverage"
> & {
  key: string;
  coverage: NonNullable<StoredPublicationNotice["coverage"]>;
};

function deliveryClaim<Notice>(
  record: Pick<FridayNoticeOutboxRecord, "status" | "attemptId">,
  notice: Notice
): DeliveryClaim<Notice> {
  if (record.status !== "delivery-unknown" || !record.attemptId)
    throw Error("INVALID_FRIDAY_NOTICE_OUTBOX");
  return { notice, attemptId: record.attemptId };
}

function receiptDigest<Notice extends { key: string }>(
  claim: DeliveryClaim<Notice>,
  receipt: DeliveryReceipt | null
): string | null {
  if (receipt === null) return null;
  if (
    !receipt ||
    receipt.key !== claim.notice.key ||
    receipt.attemptId !== claim.attemptId ||
    typeof receipt.receiptSha256 !== "string" ||
    receipt.receiptSha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(receipt.receiptSha256)
  )
    throw Error("FRIDAY_NOTICE_RECEIPT_UNVERIFIED");
  return receipt.receiptSha256;
}

async function prepare<Prepared, Notice>(
  provider: FridayNoticeProvider<Prepared, Notice>,
  notice: Notice
): Promise<Prepared> {
  try {
    return await provider.prepare(structuredClone(notice));
  } catch {
    throw Error("FRIDAY_NOTICE_PREPARATION_FAILED");
  }
}

async function reconcile<Prepared, Notice extends { key: string }>(
  provider: FridayNoticeProvider<Prepared, Notice>,
  claim: DeliveryClaim<Notice>
): Promise<string | null> {
  let receipt: DeliveryReceipt | null;
  try {
    receipt = await provider.findDelivery(structuredClone(claim));
  } catch {
    throw Error("FRIDAY_NOTICE_RECONCILIATION_UNAVAILABLE");
  }
  return receiptDigest(claim, receipt);
}

async function send<Prepared, Notice extends { key: string }>(
  provider: FridayNoticeProvider<Prepared, Notice>,
  prepared: Prepared,
  claim: DeliveryClaim<Notice>
): Promise<string | null> {
  let receipt: DeliveryReceipt | null;
  try {
    receipt = await provider.send(prepared, structuredClone(claim));
  } catch {
    throw Error("FRIDAY_NOTICE_DELIVERY_UNKNOWN");
  }
  return receiptDigest(claim, receipt);
}

/**
 * Dispatch a previously queued notice once, or reconcile its existing claim.
 * No provider or schedule is installed by this function.
 */
export async function dispatchFridayNotice<Prepared>(
  outbox: FridayNoticeOutbox,
  key: string,
  provider: FridayNoticeProvider<Prepared>
): Promise<FridayNoticeOutboxRecord | null> {
  const previous = outbox.inspect(key);
  if (!previous || previous.status === "sent") return previous;
  if (previous.status === "delivery-unknown") {
    const claim = deliveryClaim(previous, previous.notice);
    const digest = await reconcile(provider, claim);
    return digest
      ? outbox.confirmSent(key, claim.attemptId, digest)
      : outbox.inspect(key);
  }

  const prepared = await prepare(provider, previous.notice);
  const claimed = outbox.claim(key);
  if (!claimed) return outbox.inspect(key);
  const claim = deliveryClaim(claimed, claimed.notice);
  const digest = await send(provider, prepared, claim);
  return digest
    ? outbox.confirmSent(key, claim.attemptId, digest)
    : outbox.inspect(key);
}

function publicationDeliveryNotice(
  stored: StoredPublicationNotice
): FridayPublicationDeliveryNotice {
  const { deduplicationKey: key, coverage, ...proof } = stored;
  if (!coverage) throw Error("FRIDAY_PUBLICATION_NOTICE_COVERAGE_REQUIRED");
  return { ...proof, key, coverage };
}

/**
 * Deliver one exact queued release or reconcile its durable claim.
 * An operator-selected provider and the verified promotion reader are required.
 */
export async function dispatchFridayPublicationNotice<Prepared>(
  outbox: FridayNoticeOutbox,
  key: string,
  readEvidence: () => CoverageEvidence,
  provider: FridayNoticeProvider<Prepared, FridayPublicationDeliveryNotice>
): Promise<FridayPublicationNoticeOutboxRecord | null> {
  const previous = outbox.inspectPublication(key);
  if (!previous || previous.status === "sent") return previous;
  const notice = publicationDeliveryNotice(previous.notice);
  if (previous.status === "delivery-unknown") {
    const claim = deliveryClaim(previous, notice);
    const digest = await reconcile(provider, claim);
    return digest
      ? outbox.confirmPublicationSent(key, claim.attemptId, digest)
      : outbox.inspectPublication(key);
  }

  const prepared = await prepare(provider, notice);
  const claimed = outbox.claimPublicationWithCoverage(key, readEvidence);
  if (!claimed) return outbox.inspectPublication(key);
  const claim = deliveryClaim(
    claimed,
    publicationDeliveryNotice(claimed.notice)
  );
  try {
    const current = inspectFridayVerifiedReleaseCoverage(readEvidence());
    if (!current || canonicalJson(current) !== canonicalJson(claimed.notice))
      throw Error("FRIDAY_PUBLICATION_NOTICE_EVIDENCE_CHANGED");
  } catch {
    // Preserve the committed claim. Its one attempt cannot be granted again.
    throw Error("FRIDAY_PUBLICATION_NOTICE_EVIDENCE_CHANGED");
  }
  const digest = await send(provider, prepared, claim);
  return digest
    ? outbox.confirmPublicationSent(key, claim.attemptId, digest)
    : outbox.inspectPublication(key);
}
