import type { FridayMonitorNotice } from "./friday-monitor-evidence.js";
import type {
  FridayNoticeOutbox,
  FridayNoticeOutboxRecord,
} from "./friday-notice-outbox.js";

interface DeliveryClaim {
  notice: Readonly<FridayMonitorNotice>;
  attemptId: string;
}

interface DeliveryReceipt {
  key: string;
  attemptId: string;
  receiptSha256: string;
}

/** Prepare performs no send. Find verifies a provider receipt without sending. */
export interface FridayNoticeProvider<Prepared> {
  prepare(notice: Readonly<FridayMonitorNotice>): Promise<Prepared>;
  send(
    prepared: Prepared,
    claim: DeliveryClaim
  ): Promise<DeliveryReceipt | null>;
  findDelivery(claim: DeliveryClaim): Promise<DeliveryReceipt | null>;
}

function deliveryClaim(record: FridayNoticeOutboxRecord): DeliveryClaim {
  if (record.status !== "delivery-unknown" || !record.attemptId)
    throw Error("INVALID_FRIDAY_NOTICE_OUTBOX");
  return { notice: { ...record.notice }, attemptId: record.attemptId };
}

function confirmReceipt(
  outbox: FridayNoticeOutbox,
  claim: DeliveryClaim,
  receipt: DeliveryReceipt | null
) {
  const key = claim.notice.key;
  if (receipt === null) return outbox.inspect(key);
  if (
    !receipt ||
    receipt.key !== key ||
    receipt.attemptId !== claim.attemptId ||
    typeof receipt.receiptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.receiptSha256)
  )
    throw Error("FRIDAY_NOTICE_RECEIPT_UNVERIFIED");
  return outbox.confirmSent(key, claim.attemptId, receipt.receiptSha256);
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
    const claim = deliveryClaim(previous);
    let receipt: DeliveryReceipt | null;
    try {
      receipt = await provider.findDelivery(structuredClone(claim));
    } catch {
      throw Error("FRIDAY_NOTICE_RECONCILIATION_UNAVAILABLE");
    }
    return confirmReceipt(outbox, claim, receipt);
  }

  let prepared: Prepared;
  try {
    prepared = await provider.prepare({ ...previous.notice });
  } catch {
    throw Error("FRIDAY_NOTICE_PREPARATION_FAILED");
  }
  const claimed = outbox.claim(key);
  if (!claimed) return outbox.inspect(key);
  const claim = deliveryClaim(claimed);
  let receipt: DeliveryReceipt | null;
  try {
    receipt = await provider.send(prepared, structuredClone(claim));
  } catch {
    throw Error("FRIDAY_NOTICE_DELIVERY_UNKNOWN");
  }
  return confirmReceipt(outbox, claim, receipt);
}
