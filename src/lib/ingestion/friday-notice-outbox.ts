import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  planFridayMonitorNotice,
  type FridayMonitorEvaluation,
  type FridayMonitorNotice,
} from "./friday-monitor-evidence.js";
import { fridayDeliveryTimes } from "./weekly.js";

export interface FridayNoticeOutboxRecord {
  notice: FridayMonitorNotice;
  status: "pending" | "delivery-unknown" | "sent";
  attemptId: string | null;
  receiptSha256: string | null;
}

const applicationId = 0x5a564e4f;
const schema = `CREATE TABLE friday_notice (
  key TEXT PRIMARY KEY NOT NULL CHECK(length(key) <= 96),
  notice_json TEXT NOT NULL CHECK(length(notice_json) <= 256),
  status TEXT NOT NULL,
  attempt_id TEXT,
  receipt_sha256 TEXT,
  CHECK(
    (status = 'pending' AND attempt_id IS NULL AND receipt_sha256 IS NULL) OR
    (status = 'delivery-unknown' AND attempt_id IS NOT NULL AND receipt_sha256 IS NULL) OR
    (status = 'sent' AND attempt_id IS NOT NULL AND receipt_sha256 IS NOT NULL)
  )
) STRICT`;

function invalid(): never {
  throw new Error("INVALID_FRIDAY_NOTICE_OUTBOX");
}

function validKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^friday\/\d{4}-\d{2}-\d{2}\/(?:missing-source|missed-start)\/[1-9]\d{0,15}$/.test(
      value
    )
  );
}

function validAttempt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value
    )
  );
}

function validReceipt(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function noticeFromJson(key: string, json: unknown): FridayMonitorNotice {
  if (typeof json !== "string" || json.length > 256) return invalid();
  try {
    const [prefix, editionId, kind, epoch] = key.split("/");
    const dueAtEpochMs = Number(epoch);
    if (
      prefix !== "friday" ||
      (kind !== "missing-source" && kind !== "missed-start") ||
      !Number.isSafeInteger(dueAtEpochMs) ||
      !Number.isFinite(new Date(dueAtEpochMs).getTime())
    )
      return invalid();
    const timing = fridayDeliveryTimes(editionId);
    if (
      kind === "missing-source" &&
      dueAtEpochMs !== timing.missingSourceAlertAtEpochMs
    )
      return invalid();

    const notice: FridayMonitorNotice = {
      schemaVersion: 1,
      key,
      editionId,
      kind,
      dueAtEpochMs,
    };
    if (JSON.stringify(notice) !== json) return invalid();
    return notice;
  } catch {
    return invalid();
  }
}

function schemaObjects(database: DatabaseSync) {
  return database
    .prepare(
      "SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'"
    )
    .all();
}

function configureDurableWrites(database: DatabaseSync): void {
  database.exec("PRAGMA busy_timeout=5000");
  const mode = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
  if (
    mode !== "delete" &&
    mode !== "wal" &&
    mode !== "truncate" &&
    mode !== "persist"
  )
    invalid();
  database.exec("PRAGMA synchronous=FULL");
}
function settings(database: DatabaseSync) {
  return {
    id: database.prepare("PRAGMA application_id").get()?.application_id,
    version: database.prepare("PRAGMA user_version").get()?.user_version,
  };
}

function write<T>(database: DatabaseSync, operation: () => T): T {
  configureDurableWrites(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Durable notice claims in a dedicated database owned by the caller.
 * A claim records ambiguity before a sender can start. Reopen never grants
 * another claim without an explicit future provider reconciliation protocol.
 */
export class FridayNoticeOutbox {
  readonly #database: DatabaseSync;

  static initialize(database: DatabaseSync): FridayNoticeOutbox {
    write(database, () => {
      const current = settings(database);
      if (
        current.id !== 0 ||
        current.version !== 0 ||
        schemaObjects(database).length
      )
        return invalid();
      database.exec(
        `${schema}; PRAGMA application_id=${applicationId}; PRAGMA user_version=1`
      );
    });
    return new FridayNoticeOutbox(database);
  }

  constructor(database: DatabaseSync) {
    this.#database = database;
    configureDurableWrites(database);
    const current = settings(database);
    const objects = schemaObjects(database);
    if (
      current.id !== applicationId ||
      current.version !== 1 ||
      objects.length !== 1 ||
      objects[0].type !== "table" ||
      objects[0].name !== "friday_notice" ||
      objects[0].sql !== schema
    )
      return invalid();
  }

  record(input: FridayMonitorEvaluation): FridayNoticeOutboxRecord | null {
    const notice = planFridayMonitorNotice(input);
    if (!notice) return null;
    return write(this.#database, () => {
      this.#database
        .prepare(
          "INSERT INTO friday_notice(key, notice_json, status) VALUES (?, ?, 'pending') ON CONFLICT(key) DO NOTHING"
        )
        .run(notice.key, JSON.stringify(notice));
      return this.inspect(notice.key);
    });
  }

  inspect(key: string): FridayNoticeOutboxRecord | null {
    if (!validKey(key)) return invalid();
    const row = this.#database
      .prepare(
        "SELECT notice_json, status, attempt_id, receipt_sha256 FROM friday_notice WHERE key = ?"
      )
      .get(key);
    if (!row) return null;
    const notice = noticeFromJson(key, row.notice_json);
    const {
      status,
      attempt_id: attemptId,
      receipt_sha256: receiptSha256,
    } = row;
    if (status === "pending" && attemptId === null && receiptSha256 === null)
      return { notice, status, attemptId, receiptSha256 };
    if (!validAttempt(attemptId)) return invalid();
    if (status === "delivery-unknown" && receiptSha256 === null)
      return { notice, status, attemptId, receiptSha256 };
    if (status === "sent" && validReceipt(receiptSha256))
      return { notice, status, attemptId, receiptSha256 };
    return invalid();
  }

  claim(key: string): FridayNoticeOutboxRecord | null {
    return write(this.#database, () => {
      const previous = this.inspect(key);
      if (previous?.status !== "pending") return null;
      const attemptId = randomUUID();
      const result = this.#database
        .prepare(
          "UPDATE friday_notice SET status='delivery-unknown', attempt_id=? WHERE key=? AND status='pending'"
        )
        .run(attemptId, key);
      if (result.changes !== 1) return invalid();
      return {
        notice: previous.notice,
        status: "delivery-unknown",
        attemptId,
        receiptSha256: null,
      };
    });
  }

  /** Persist a separately verified provider acknowledgement for the exact claim. */
  confirmSent(
    key: string,
    attemptId: string,
    receiptSha256: string
  ): FridayNoticeOutboxRecord {
    if (!validAttempt(attemptId) || !validReceipt(receiptSha256))
      return invalid();
    return write(this.#database, () => {
      const previous = this.inspect(key);
      if (!previous || previous.attemptId !== attemptId) return invalid();
      if (previous.status === "sent") {
        if (previous.receiptSha256 !== receiptSha256) return invalid();
        return previous;
      }
      if (previous.status !== "delivery-unknown") return invalid();
      const result = this.#database
        .prepare(
          "UPDATE friday_notice SET status='sent', receipt_sha256=? WHERE key=? AND status='delivery-unknown' AND attempt_id=?"
        )
        .run(receiptSha256, key, attemptId);
      if (result.changes !== 1) return invalid();
      return {
        notice: previous.notice,
        status: "sent",
        attemptId,
        receiptSha256,
      };
    });
  }
}
