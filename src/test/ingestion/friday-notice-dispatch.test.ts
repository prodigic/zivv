import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { FridayNoticeOutbox } from "../../lib/ingestion/friday-notice-outbox.js";
import { dispatchFridayNotice } from "../../lib/ingestion/friday-notice-dispatch.js";
import type { FridayMonitorNotice } from "../../lib/ingestion/friday-monitor-evidence.js";

const prefix = "zivv-friday-notice-dispatch-";
const roots: string[] = [];
const databases: DatabaseSync[] = [];
const due = Date.parse("2026-10-31T01:00:00Z");
const digest = "a".repeat(64);
type Claim = { notice: Readonly<FridayMonitorNotice>; attemptId: string };
type Receipt = { key: string; attemptId: string; receiptSha256: string };
function open(path: string) {
  const db = new DatabaseSync(path);
  databases.push(db);
  return db;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const path = join(root, "outbox.sqlite");
  const store = FridayNoticeOutbox.initialize(open(path));
  const record = store.record({
    editionId: "2026-10-30",
    nowEpochMs: due,
    maxEvidenceAgeMs: 0,
    evidence: {
      kind: "mailbox-scan",
      status: "absent",
      scannedThroughEpochMs: due,
    },
  })!;
  return {
    path,
    store,
    record,
    reopen: () => new FridayNoticeOutbox(open(path)),
  };
}
function provider() {
  return {
    prepare: vi.fn(
      async (_notice: Readonly<FridayMonitorNotice>) => "prepared"
    ),
    send: vi.fn(
      async (_prepared: string, claim: Claim): Promise<Receipt | null> => ({
        key: claim.notice.key,
        attemptId: claim.attemptId,
        receiptSha256: digest,
      })
    ),
    findDelivery: vi.fn(async (_claim: Claim): Promise<Receipt | null> => null),
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (
      dirname(absolute) !== resolve(tmpdir()) ||
      !basename(absolute).startsWith(prefix)
    )
      throw Error("UNSAFE_TEST_CLEANUP");
    rmSync(absolute, { recursive: true, force: true });
  }
});

it("ignores absent and already sent records without invoking provider", async () => {
  const { store, record } = fixture();
  const p = provider();
  const missing = `friday/2026-10-23/missing-source/${Date.parse("2026-10-24T01:00:00Z")}`;
  expect(await dispatchFridayNotice(store, missing, p)).toBeNull();
  const claim = store.claim(record.notice.key)!;
  const sent = store.confirmSent(record.notice.key, claim.attemptId!, digest);
  expect(await dispatchFridayNotice(store, record.notice.key, p)).toEqual(sent);
  expect(p.prepare).not.toHaveBeenCalled();
  expect(p.send).not.toHaveBeenCalled();
  expect(p.findDelivery).not.toHaveBeenCalled();
});

it("prepares while pending and retains pending on sanitized preparation failure", async () => {
  const { store, record } = fixture();
  const p = provider();
  p.prepare.mockImplementation(async () => {
    expect(store.inspect(record.notice.key)).toEqual(record);
    throw Error("private provider detail");
  });
  await expect(
    dispatchFridayNotice(store, record.notice.key, p)
  ).rejects.toThrow(/^FRIDAY_NOTICE_PREPARATION_FAILED$/);
  expect(store.inspect(record.notice.key)).toEqual(record);
  expect(p.send).not.toHaveBeenCalled();
  expect(p.findDelivery).not.toHaveBeenCalled();
});

it("durably claims before sending and persists the exact positive acknowledgement", async () => {
  const { store, record, reopen } = fixture();
  const p = provider();
  p.send.mockImplementation(async (prepared, claim) => {
    expect(prepared).toBe("prepared");
    expect(reopen().inspect(record.notice.key)).toMatchObject({
      status: "delivery-unknown",
      attemptId: claim.attemptId,
      notice: claim.notice,
    });
    return {
      key: claim.notice.key,
      attemptId: claim.attemptId,
      receiptSha256: digest,
    };
  });
  const result = await dispatchFridayNotice(store, record.notice.key, p);
  expect(result).toMatchObject({
    status: "sent",
    receiptSha256: digest,
    notice: record.notice,
  });
  expect(reopen().inspect(record.notice.key)).toEqual(result);
  expect(p.findDelivery).not.toHaveBeenCalled();
});

it("reconciles a genuinely accepted delivery whose response was lost without sending again", async () => {
  const { store, record, reopen } = fixture();
  const p = provider();
  let accepted: Receipt | null = null;
  p.send.mockImplementation(async (_prepared, claim) => {
    accepted = {
      key: claim.notice.key,
      attemptId: claim.attemptId,
      receiptSha256: digest,
    };
    throw Error("private provider detail");
  });
  await expect(
    dispatchFridayNotice(store, record.notice.key, p)
  ).rejects.toThrow(/^FRIDAY_NOTICE_DELIVERY_UNKNOWN$/);
  const held = reopen().inspect(record.notice.key)!;
  expect(held).toMatchObject({
    status: "delivery-unknown",
    receiptSha256: null,
  });
  p.findDelivery.mockImplementation(async (claim) => {
    expect(claim).toEqual({ notice: held.notice, attemptId: held.attemptId });
    return accepted;
  });
  const result = await dispatchFridayNotice(reopen(), record.notice.key, p);
  expect(result).toEqual({ ...held, status: "sent", receiptSha256: digest });
  expect(reopen().inspect(record.notice.key)).toEqual(result);
  expect(p.prepare).toHaveBeenCalledTimes(1);
  expect(p.send).toHaveBeenCalledTimes(1);
  expect(p.findDelivery).toHaveBeenCalledTimes(1);
  await dispatchFridayNotice(reopen(), record.notice.key, p);
  expect(p.send).toHaveBeenCalledTimes(1);
  expect(p.findDelivery).toHaveBeenCalledTimes(1);
});

it("holds a null send and uses only lookup after reopen", async () => {
  const { store, record, reopen } = fixture();
  const p = provider();
  p.send.mockResolvedValue(null);
  const held = await dispatchFridayNotice(store, record.notice.key, p);
  expect(held).toMatchObject({ status: "delivery-unknown" });
  expect(await dispatchFridayNotice(reopen(), record.notice.key, p)).toEqual(
    held
  );
  expect(p.prepare).toHaveBeenCalledTimes(1);
  expect(p.send).toHaveBeenCalledTimes(1);
  expect(p.findDelivery).toHaveBeenCalledTimes(1);
});

it("sanitizes lookup errors and preserves the durable unknown claim", async () => {
  const { store, record, reopen } = fixture();
  const held = store.claim(record.notice.key)!;
  const p = provider();
  p.findDelivery.mockRejectedValue(Error("private provider detail"));
  await expect(
    dispatchFridayNotice(reopen(), record.notice.key, p)
  ).rejects.toThrow(/^FRIDAY_NOTICE_RECONCILIATION_UNAVAILABLE$/);
  expect(reopen().inspect(record.notice.key)).toEqual(held);
  expect(p.prepare).not.toHaveBeenCalled();
  expect(p.send).not.toHaveBeenCalled();
});

it.each(["key", "attemptId", "receiptSha256"] as const)(
  "refuses a receipt with invalid %s",
  async (field) => {
    const { store, record, reopen } = fixture();
    const held = store.claim(record.notice.key)!;
    const p = provider();
    p.findDelivery.mockResolvedValue({
      key: field === "key" ? "wrong" : record.notice.key,
      attemptId: field === "attemptId" ? "wrong" : held.attemptId!,
      receiptSha256: field === "receiptSha256" ? "wrong" : digest,
    });
    await expect(
      dispatchFridayNotice(reopen(), record.notice.key, p)
    ).rejects.toThrow(/^FRIDAY_NOTICE_RECEIPT_UNVERIFIED$/);
    expect(reopen().inspect(record.notice.key)).toEqual(held);
  }
);

it("allows only one sender after concurrent preparation", async () => {
  const { store, record, reopen } = fixture();
  const p = provider();
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolveBarrier) => {
    release = resolveBarrier;
  });
  p.prepare.mockImplementation(async () => {
    if (++arrivals === 2) release();
    await barrier;
    return "prepared";
  });
  await Promise.all([
    dispatchFridayNotice(store, record.notice.key, p),
    dispatchFridayNotice(reopen(), record.notice.key, p),
  ]);
  expect(p.prepare).toHaveBeenCalledTimes(2);
  expect(p.send).toHaveBeenCalledTimes(1);
  expect(reopen().inspect(record.notice.key)).toMatchObject({
    status: "sent",
    receiptSha256: digest,
  });
});
