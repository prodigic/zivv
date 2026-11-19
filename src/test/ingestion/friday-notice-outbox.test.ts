import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { FridayNoticeOutbox } from "../../lib/ingestion/friday-notice-outbox.js";
import type { FridayMonitorEvaluation } from "../../lib/ingestion/friday-monitor-evidence.js";

const prefix = "zivv-friday-notice-outbox-";
const roots: string[] = [];
const databases: DatabaseSync[] = [];
const due = Date.parse("2026-10-31T01:00:00.000Z");
const receipt = "a".repeat(64);

function open(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  databases.push(database);
  return database;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const path = join(root, "outbox.sqlite");
  const db = open(path);
  return { path, db, store: FridayNoticeOutbox.initialize(db) };
}

function evaluation(): FridayMonitorEvaluation {
  return {
    editionId: "2026-10-30",
    nowEpochMs: due,
    maxEvidenceAgeMs: 60_000,
    evidence: {
      kind: "mailbox-scan",
      status: "absent",
      scannedThroughEpochMs: due,
    },
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
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

it("persists one exact intent and refuses an ambiguous duplicate claim across reopened connections", () => {
  const { path, store } = fixture();
  const original = store.record(evaluation())!;
  expect(original).toMatchObject({
    status: "pending",
    attemptId: null,
    receiptSha256: null,
    notice: {
      schemaVersion: 1,
      kind: "missing-source",
      editionId: "2026-10-30",
      dueAtEpochMs: due,
    },
  });
  const second = new FridayNoticeOutbox(open(path));
  expect(second.record(evaluation())).toEqual(original);
  expect(second.inspect(original.notice.key)).toEqual(original);
  const claimed = second.claim(original.notice.key)!;
  expect(claimed).toMatchObject({
    notice: original.notice,
    status: "delivery-unknown",
    receiptSha256: null,
    attemptId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    ),
  });
  const reopened = new FridayNoticeOutbox(open(path));
  expect(reopened.inspect(original.notice.key)).toEqual(claimed);
  expect(reopened.record(evaluation())).toEqual(claimed);
  expect(store.claim(original.notice.key)).toBeNull();
  expect(reopened.claim(original.notice.key)).toBeNull();
  const sent = reopened.confirmSent(
    original.notice.key,
    claimed.attemptId!,
    receipt
  );
  expect(sent).toEqual({ ...claimed, status: "sent", receiptSha256: receipt });
  expect(
    store.confirmSent(original.notice.key, claimed.attemptId!, receipt)
  ).toEqual(sent);
  expect(
    new FridayNoticeOutbox(open(path)).inspect(original.notice.key)
  ).toEqual(sent);
  expect(second.record(evaluation())).toEqual(sent);
  expect(second.claim(original.notice.key)).toBeNull();
});

it("does not create intent for nonqualifying observations and propagates invalid evidence", () => {
  const { store } = fixture();
  const base = evaluation();
  expect(
    store.record({
      ...base,
      nowEpochMs: due - 1,
      evidence: {
        kind: "mailbox-scan",
        status: "absent",
        scannedThroughEpochMs: due - 1,
      },
    })
  ).toBeNull();
  expect(
    store.record({
      ...base,
      nowEpochMs: due + 60_001,
      evidence: {
        kind: "mailbox-scan",
        status: "absent",
        scannedThroughEpochMs: due,
      },
    })
  ).toBeNull();
  expect(
    store.record({
      ...base,
      evidence: {
        kind: "mailbox-scan",
        status: "unknown",
        scannedThroughEpochMs: due,
      },
    })
  ).toBeNull();
  expect(() => store.record({ ...base, maxEvidenceAgeMs: -1 })).toThrow();
  const missing = `friday/2026-10-30/missing-source/${due}`;
  expect(store.inspect(missing)).toBeNull();
  expect(store.claim(missing)).toBeNull();
});

it("binds acknowledgements to their exact claim and receipt", () => {
  const { store } = fixture();
  const first = store.record(evaluation())!;
  const priorDue = Date.parse("2026-10-24T01:00:00.000Z");
  const other = store.record({
    editionId: "2026-10-23",
    nowEpochMs: priorDue,
    maxEvidenceAgeMs: 0,
    evidence: {
      kind: "mailbox-scan",
      status: "absent",
      scannedThroughEpochMs: priorDue,
    },
  })!;
  expect(first.notice.key).not.toBe(other.notice.key);
  const firstClaim = store.claim(first.notice.key)!;
  const otherClaim = store.claim(other.notice.key)!;
  expect(firstClaim.attemptId).not.toBe(otherClaim.attemptId);
  expect(() =>
    store.confirmSent(first.notice.key, otherClaim.attemptId!, receipt)
  ).toThrow("INVALID_FRIDAY_NOTICE_OUTBOX");
  expect(store.inspect(first.notice.key)).toEqual(firstClaim);
  const sent = store.confirmSent(
    first.notice.key,
    firstClaim.attemptId!,
    receipt
  );
  expect(() =>
    store.confirmSent(first.notice.key, firstClaim.attemptId!, "b".repeat(64))
  ).toThrow("INVALID_FRIDAY_NOTICE_OUTBOX");
  expect(() =>
    store.confirmSent(first.notice.key, "not-a-uuid", receipt)
  ).toThrow("INVALID_FRIDAY_NOTICE_OUTBOX");
  expect(() =>
    store.confirmSent(other.notice.key, otherClaim.attemptId!, "not-a-digest")
  ).toThrow("INVALID_FRIDAY_NOTICE_OUTBOX");
  expect(store.inspect(first.notice.key)).toEqual(sent);
  expect(store.inspect(other.notice.key)).toEqual(otherClaim);
});

it("initializes only an empty database and refuses foreign or extra schema", () => {
  const { path, db } = fixture();
  expect(() => FridayNoticeOutbox.initialize(db)).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
  db.exec("CREATE TABLE foreign_fixture(value TEXT) STRICT");
  expect(() => new FridayNoticeOutbox(open(path))).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const foreign = open(join(root, "foreign.sqlite"));
  foreign.exec("CREATE TABLE foreign_fixture(value TEXT) STRICT");
  expect(() => FridayNoticeOutbox.initialize(foreign)).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
});

it("does not expose rejected private caller values in errors or records", () => {
  const { store } = fixture();
  const privateValue = "synthetic-private-token-example";
  try {
    store.confirmSent("f".repeat(64), privateValue, privateValue);
    throw new Error("EXPECTED_REFUSAL");
  } catch (error) {
    expect((error as Error).message).toBe("INVALID_FRIDAY_NOTICE_OUTBOX");
    expect(String(error)).not.toContain(privateValue);
  }
  const record = store.record(evaluation());
  expect(JSON.stringify(record)).not.toContain(privateValue);
});

it("refuses an unsafe journaling mode and corrupt persisted notice", () => {
  const { db, store } = fixture();
  const record = store.record(evaluation())!;
  db.prepare("UPDATE friday_notice SET notice_json=? WHERE key=?").run(
    "{}",
    record.notice.key
  );
  expect(() => store.inspect(record.notice.key)).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
  expect(() => store.record(evaluation())).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
  expect(() => store.claim(record.notice.key)).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
  const volatile = open(":memory:");
  expect(volatile.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe(
    "memory"
  );
  expect(() => FridayNoticeOutbox.initialize(volatile)).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
});

it("upgrades an existing alert outbox idempotently without changing pending, unknown or sent claims", () => {
  const { path, db, store } = fixture();
  const make = (
    editionId: string,
    deadline: number
  ): FridayMonitorEvaluation => ({
    editionId,
    nowEpochMs: deadline,
    maxEvidenceAgeMs: 0,
    evidence: {
      kind: "mailbox-scan",
      status: "absent",
      scannedThroughEpochMs: deadline,
    },
  });
  const pending = store.record(evaluation())!;
  const unknownNotice = store.record(
    make("2026-10-23", Date.parse("2026-10-24T01:00:00Z"))
  )!;
  const sentNotice = store.record(
    make("2026-10-16", Date.parse("2026-10-17T01:00:00Z"))
  )!;
  const unknown = store.claim(unknownNotice.notice.key)!;
  const sentClaim = store.claim(sentNotice.notice.key)!;
  const sent = store.confirmSent(
    sentNotice.notice.key,
    sentClaim.attemptId!,
    receipt
  );
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  store.enablePublicationNotices();
  store.enablePublicationNotices();
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  const reopened = new FridayNoticeOutbox(open(path));
  reopened.enablePublicationNotices();
  expect(reopened.inspect(pending.notice.key)).toEqual(pending);
  expect(reopened.inspect(unknown.notice.key)).toEqual(unknown);
  expect(reopened.inspect(sent.notice.key)).toEqual(sent);
  expect(reopened.claim(unknown.notice.key)).toBeNull();
  expect(reopened.claim(sent.notice.key)).toBeNull();
});

it("refuses to upgrade or reopen a corrupted versioned schema", () => {
  const { path, db, store } = fixture();
  db.exec("CREATE TABLE foreign_fixture(value TEXT) STRICT");
  expect(() => store.enablePublicationNotices()).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
  expect(() => new FridayNoticeOutbox(open(path))).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
  const other = fixture();
  other.store.enablePublicationNotices();
  other.db.exec("CREATE TABLE foreign_fixture(value TEXT) STRICT");
  expect(() => other.store.enablePublicationNotices()).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
  expect(() => new FridayNoticeOutbox(open(other.path))).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
});

it("preserves pending and ambiguous alert claims through the coverage upgrade", () => {
  const { path, store } = fixture();
  store.enablePublicationNotices();
  const pending = store.record(evaluation())!;
  const other = store.record({
    ...evaluation(),
    editionId: "2026-10-23",
    nowEpochMs: due,
    evidence: {
      kind: "independent-watchdog",
      status: "not-started",
      expectedStartEpochMs: due,
      observedAtEpochMs: due,
    },
  })!;
  const claimed = store.claim(other.notice.key)!;
  store.enablePublicationCoverage();
  store.enablePublicationCoverage();
  const reopened = new FridayNoticeOutbox(open(path));
  expect(reopened.inspect(pending.notice.key)).toEqual(pending);
  expect(reopened.inspect(other.notice.key)).toEqual(claimed);
  expect(reopened.claim(other.notice.key)).toBeNull();
  expect(
    reopened.confirmSent(other.notice.key, claimed.attemptId!, receipt)
  ).toEqual({ ...claimed, status: "sent", receiptSha256: receipt });
  expect(reopened.claim(pending.notice.key)).toMatchObject({
    status: "delivery-unknown",
    notice: pending.notice,
  });
});

it("refuses a coverage-bearing legacy publication row before upgrading", () => {
  const { db, store } = fixture();
  store.enablePublicationNotices();
  const key = "friday/2026-10-30/published";
  const json = JSON.stringify({
    status: "verified-release",
    editionId: "2026-10-30",
    liveUrl: "https://www.prodigic.com/zivv/",
    addedEventCount: 1,
    candidateId: "a".repeat(64),
    verificationReceiptId: "b".repeat(64),
    acknowledgementId: "c".repeat(64),
    releaseId: "d".repeat(64),
    deduplicationKey: key,
    coverage: {
      missingShowArtwork: 1,
      distinctArtists: 1,
      artistsWithoutLinks: 1,
      artistsWithoutReviews: 1,
      distinctVenues: 1,
      venuesWithoutMapLocation: 1,
    },
  });
  db.prepare(
    "INSERT INTO friday_publication_notice(key, notice_json, status) VALUES (?, ?, 'pending')"
  ).run(key, json);
  expect(() => store.inspectPublication(key)).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
  expect(() => store.enablePublicationCoverage()).toThrow(
    "INVALID_FRIDAY_NOTICE_OUTBOX"
  );
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(
    db
      .prepare("SELECT notice_json FROM friday_publication_notice WHERE key=?")
      .get(key)?.notice_json
  ).toBe(json);
});
