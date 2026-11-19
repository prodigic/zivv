import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  planFridayMonitorNotice,
  type FridayMonitorEvaluation,
  type FridayMonitorNotice,
} from "./friday-monitor-evidence.js";
import { inspectFridayVerifiedRelease } from "./friday-verified-release.js";
import { PROMOTION_DESTINATIONS } from "./promotion-control.js";
import { fridayDeliveryTimes } from "./weekly.js";

type PublicationNotice = NonNullable<
  ReturnType<typeof inspectFridayVerifiedRelease>
>;
type PublicationEvidence = Parameters<typeof inspectFridayVerifiedRelease>[0];

interface OutboxRecord<Notice> {
  notice: Notice;
  status: "pending" | "delivery-unknown" | "sent";
  attemptId: string | null;
  receiptSha256: string | null;
}

export type FridayNoticeOutboxRecord = OutboxRecord<FridayMonitorNotice>;
export type FridayPublicationNoticeOutboxRecord =
  OutboxRecord<PublicationNotice>;

const applicationId = 0x5a564e4f;
const monitorTable = "friday_notice";
const publicationTable = "friday_publication_notice";
type NoticeTable = typeof monitorTable | typeof publicationTable;
function noticeSchema(table: NoticeTable, jsonLimit: number): string {
  return `CREATE TABLE ${table} (
  key TEXT PRIMARY KEY NOT NULL CHECK(length(key) <= 96),
  notice_json TEXT NOT NULL CHECK(length(notice_json) <= ${jsonLimit}),
  status TEXT NOT NULL,
  attempt_id TEXT,
  receipt_sha256 TEXT,
  CHECK(
    (status = 'pending' AND attempt_id IS NULL AND receipt_sha256 IS NULL) OR
    (status = 'delivery-unknown' AND attempt_id IS NOT NULL AND receipt_sha256 IS NULL) OR
    (status = 'sent' AND attempt_id IS NOT NULL AND receipt_sha256 IS NOT NULL)
  )
) STRICT`;
}

const schema = noticeSchema(monitorTable, 256);
const publicationSchema = noticeSchema(publicationTable, 1024);

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

function publicationEdition(key: string): string {
  const match = /^friday\/(\d{4}-\d{2}-\d{2})\/published$/.exec(key);
  if (!match || match[0] !== key) return invalid();
  return match[1];
}

function publicationFromJson(key: string, json: unknown): PublicationNotice {
  if (typeof json !== "string" || json.length > 1024) return invalid();
  try {
    const editionId = publicationEdition(key);
    fridayDeliveryTimes(editionId);
    const fields = JSON.parse(json) as Record<string, unknown>;
    const {
      addedEventCount,
      candidateId,
      verificationReceiptId,
      acknowledgementId,
      releaseId,
    } = fields;
    if (
      typeof addedEventCount !== "number" ||
      !Number.isSafeInteger(addedEventCount) ||
      addedEventCount < 0 ||
      !validReceipt(candidateId) ||
      !validReceipt(verificationReceiptId) ||
      !validReceipt(acknowledgementId) ||
      !validReceipt(releaseId)
    )
      return invalid();

    const notice: PublicationNotice = {
      status: "verified-release",
      editionId,
      liveUrl: PROMOTION_DESTINATIONS.production.liveUrl,
      addedEventCount,
      candidateId,
      verificationReceiptId,
      acknowledgementId,
      releaseId,
      deduplicationKey: key,
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

function outboxVersion(database: DatabaseSync): 1 | 2 {
  const objects = database
    .prepare(
      "SELECT application_id, user_version, name, type, sql " +
        "FROM pragma_application_id(), pragma_user_version(), sqlite_schema " +
        "WHERE name NOT GLOB 'sqlite_*'"
    )
    .all();
  const current = objects[0];
  const tableMatches = (name: NoticeTable, sql: string) =>
    objects.some(
      (object) =>
        object.name === name && object.type === "table" && object.sql === sql
    );
  if (
    current?.application_id !== applicationId ||
    !tableMatches(monitorTable, schema)
  )
    return invalid();
  if (current.user_version === 1 && objects.length === 1) return 1;
  if (
    current.user_version === 2 &&
    objects.length === 2 &&
    tableMatches(publicationTable, publicationSchema)
  )
    return 2;
  return invalid();
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
    outboxVersion(database);
  }

  /** Explicitly upgrade a dedicated outbox while preserving every earlier claim. */
  enablePublicationNotices(): void {
    write(this.#database, () => {
      if (outboxVersion(this.#database) === 2) return;
      this.#database.exec(`${publicationSchema}; PRAGMA user_version=2`);
    });
  }

  record(input: FridayMonitorEvaluation): FridayNoticeOutboxRecord | null {
    const notice = planFridayMonitorNotice(input);
    if (!notice) return null;
    return write(this.#database, () =>
      this.#record(
        monitorTable,
        notice.key,
        JSON.stringify(notice),
        noticeFromJson
      )
    );
  }

  /** Accept only the current, durably acknowledged production release. */
  recordVerifiedPublication(
    input: PublicationEvidence
  ): FridayPublicationNoticeOutboxRecord | null {
    const notice = inspectFridayVerifiedRelease(input);
    if (!notice) return null;
    return write(this.#database, () => {
      this.#requirePublication();
      const json = JSON.stringify(notice);
      const record = this.#record(
        publicationTable,
        notice.deduplicationKey,
        json,
        publicationFromJson
      );
      if (JSON.stringify(record.notice) !== json)
        throw Error("FRIDAY_PUBLICATION_NOTICE_CONFLICT");
      return record;
    });
  }

  #record<Notice>(
    table: NoticeTable,
    key: string,
    json: string,
    decode: (key: string, json: unknown) => Notice
  ): OutboxRecord<Notice> {
    this.#database
      .prepare(
        `INSERT INTO ${table}(key, notice_json, status) VALUES (?, ?, 'pending') ON CONFLICT(key) DO NOTHING`
      )
      .run(key, json);
    return this.#inspect(table, key, decode) ?? invalid();
  }

  inspect(key: string): FridayNoticeOutboxRecord | null {
    if (!validKey(key)) return invalid();
    return this.#inspect(monitorTable, key, noticeFromJson);
  }

  #requirePublication(): void {
    if (outboxVersion(this.#database) !== 2) return invalid();
  }

  inspectPublication(key: string): FridayPublicationNoticeOutboxRecord | null {
    publicationEdition(key);
    this.#requirePublication();
    return this.#inspect(publicationTable, key, publicationFromJson);
  }

  #inspect<Notice>(
    table: NoticeTable,
    key: string,
    decode: (key: string, json: unknown) => Notice
  ): OutboxRecord<Notice> | null {
    const row = this.#database
      .prepare(
        `SELECT notice_json, status, attempt_id, receipt_sha256 FROM ${table} WHERE key = ?`
      )
      .get(key);
    if (!row) return null;
    const notice = decode(key, row.notice_json);
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
    return write(this.#database, () =>
      this.#claim(monitorTable, key, this.inspect(key))
    );
  }

  /**
   * Recheck the existing pending intent against a fresh authoritative
   * observation. An uncertain attempt is reconciled through its saved claim.
   */
  claimPublication(
    key: string,
    readEvidence: () => PublicationEvidence
  ): FridayPublicationNoticeOutboxRecord | null {
    return write(this.#database, () => {
      const previous = this.inspectPublication(key);
      if (previous?.status !== "pending") return null;
      let input: PublicationEvidence;
      try {
        input = readEvidence();
      } catch {
        throw Error("FRIDAY_PUBLICATION_NOTICE_EVIDENCE_UNAVAILABLE");
      }
      const notice = inspectFridayVerifiedRelease(input);
      if (!notice || JSON.stringify(notice) !== JSON.stringify(previous.notice))
        throw Error("FRIDAY_PUBLICATION_NOTICE_CONFLICT");
      return this.#claim(publicationTable, key, previous);
    });
  }

  #claim<Notice>(
    table: NoticeTable,
    key: string,
    previous: OutboxRecord<Notice> | null
  ): OutboxRecord<Notice> | null {
    if (previous?.status !== "pending") return null;
    const attemptId = randomUUID();
    const result = this.#database
      .prepare(
        `UPDATE ${table} SET status='delivery-unknown', attempt_id=? WHERE key=? AND status='pending'`
      )
      .run(attemptId, key);
    if (result.changes !== 1) return invalid();
    return {
      notice: previous.notice,
      status: "delivery-unknown",
      attemptId,
      receiptSha256: null,
    };
  }

  /** Persist a separately verified provider acknowledgement for the exact claim. */
  confirmSent(
    key: string,
    attemptId: string,
    receiptSha256: string
  ): FridayNoticeOutboxRecord {
    if (!validAttempt(attemptId) || !validReceipt(receiptSha256))
      return invalid();
    return write(this.#database, () =>
      this.#confirmSent(
        monitorTable,
        key,
        attemptId,
        receiptSha256,
        this.inspect(key)
      )
    );
  }

  confirmPublicationSent(
    key: string,
    attemptId: string,
    receiptSha256: string
  ): FridayPublicationNoticeOutboxRecord {
    if (!validAttempt(attemptId) || !validReceipt(receiptSha256))
      return invalid();
    return write(this.#database, () =>
      this.#confirmSent(
        publicationTable,
        key,
        attemptId,
        receiptSha256,
        this.inspectPublication(key)
      )
    );
  }

  #confirmSent<Notice>(
    table: NoticeTable,
    key: string,
    attemptId: string,
    receiptSha256: string,
    previous: OutboxRecord<Notice> | null
  ): OutboxRecord<Notice> {
    if (!previous || previous.attemptId !== attemptId) return invalid();
    if (previous.status === "sent") {
      if (previous.receiptSha256 !== receiptSha256) return invalid();
      return previous;
    }
    if (previous.status !== "delivery-unknown") return invalid();
    const result = this.#database
      .prepare(
        `UPDATE ${table} SET status='sent', receipt_sha256=? WHERE key=? AND status='delivery-unknown' AND attempt_id=?`
      )
      .run(receiptSha256, key, attemptId);
    if (result.changes !== 1) return invalid();
    return {
      notice: previous.notice,
      status: "sent",
      attemptId,
      receiptSha256,
    };
  }
}
