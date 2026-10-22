import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import PostalMime, { addressParser, type Header } from "postal-mime";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { localDateStartEpochMs } from "./weekly.js";
import {
  secureOperatorDirectory,
  writeDurableFile,
} from "./encrypted-backup.js";
import { resolvePrivateCandidateDirectory } from "./private-artifacts.js";
import { WeeklyRunJournal, type WeeklyRunLease } from "./weekly-run-journal.js";

const scope = "prodigic/zivv/production";
const provider = "sp.eocampaign1.com";
const profile = "steve-gmail-eocampaign-v1";
const parserVersion = "postal-mime-4.0.7/gmail-text-v1";
const maxBytes = 8 * 1024 * 1024;
export interface GmailMessagePart {
  mime_type: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: {
    size: number;
    base64_url_content?: string | null;
    content?: string | null;
  };
  parts?: GmailMessagePart[];
}
export interface SteveEmailReceipt {
  schemaVersion: 1;
  receiptId: string;
  accountSha256: string;
  editionId: string;
  deliveryId: string;
  messageId: string;
  rawSha256: string;
  sourceSha256: string;
  receivedAtEpochMs: number;
  firstObservedAtEpochMs: number;
  acquisitionObservedAtEpochMs: number;
  senderDate: string;
  disposition: "ready" | "review-required";
  correctionOf: string | null;
  partPath: number[];
  receiverProfile: {
    policy: typeof profile;
    parser: typeof parserVersion;
    issuer: "mx.google.com";
    dkimIdentityDomain: string;
    dkimSigningDomains: string[];
    spfMailFromDomain: string;
    dmarcResult: "pass" | "none" | null;
  };
}
class SteveEmailIntakeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
function fail(code: string): never {
  throw new SteveEmailIntakeError(code);
}
function same(a: unknown, b: unknown, code: string) {
  if (canonicalJson(a) !== canonicalJson(b)) fail(code);
}
function decode(value: string): Buffer {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(value) ||
    value.length > maxBytes * 2
  )
    fail("INVALID_GMAIL_ENCODING");
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length > maxBytes ||
    bytes.toString("base64url") !== value.replace(/=+$/, "")
  )
    fail("INVALID_GMAIL_ENCODING");
  return bytes;
}
function regular(path: string): Buffer {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (lstatSync(parent).isSymbolicLink()) fail("UNSAFE_INTAKE_DIRECTORY");
    if (dirname(parent) === parent) break;
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > maxBytes
  )
    fail("UNSAFE_INTAKE_FILE");
  return readFileSync(path);
}
function privateDirectory(path: string): void {
  if (resolvePrivateCandidateDirectory(path) !== resolve(path))
    fail("UNSAFE_INTAKE_DIRECTORY");
  secureOperatorDirectory(path);
}
function once(path: string, bytes: Buffer) {
  if (existsSync(path)) {
    if (!regular(path).equals(bytes)) fail("INTAKE_EVIDENCE_CHANGED");
  } else writeDurableFile(path, bytes);
}
function header(headers: Header[], name: string): string {
  const values = headers.filter((h) => h.key.toLowerCase() === name);
  if (values.length !== 1) fail("AMBIGUOUS_MAIL_HEADERS");
  return values[0].value;
}
function mailbox(value: string): string {
  const addresses = addressParser(value);
  if (
    addresses.length !== 1 ||
    !("address" in addresses[0]) ||
    !addresses[0].address
  )
    fail("AMBIGUOUS_MAILBOX");
  return addresses[0].address.toLowerCase();
}
function domain(value: string): string {
  return value.slice(value.lastIndexOf("@") + 1).toLowerCase();
}
// Comments cannot supply an authentication result or a forged property token.
function authClauses(value: string): string[] {
  let depth = 0,
    quoted = false,
    escaped = false,
    clean = "";
  for (const char of value) {
    if (escaped) {
      if (!depth) clean += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      if (!depth) clean += char;
      continue;
    }
    if (char === '"' && !depth) quoted = !quoted;
    if (!quoted && char === "(") {
      depth++;
      continue;
    }
    if (!quoted && char === ")") {
      if (--depth < 0) fail("INVALID_AUTH_RESULTS");
      continue;
    }
    if (!depth) clean += char === ";" && !quoted ? "\0" : char;
  }
  if (depth || quoted || escaped) fail("INVALID_AUTH_RESULTS");
  return clean.split("\0").map((v) => v.trim());
}
function receiverProfile(
  headers: Header[]
): SteveEmailReceipt["receiverProfile"] {
  if (
    mailbox(header(headers, "from")) !== "skoepke@stevelist.com" ||
    domain(mailbox(header(headers, "sender"))) !== provider
  )
    fail("WRONG_STEVE_SENDER");
  const clauses = authClauses(header(headers, "authentication-results"));
  if (clauses.shift() !== "mx.google.com") fail("UNTRUSTED_MAIL_RECEIVER");
  const dmarc = clauses.filter((c) => /^dmarc\s*=/i.test(c));
  if (
    dmarc.length > 1 ||
    (dmarc.length === 1 &&
      !/^dmarc\s*=\s*(?:pass|none)(?:\s|$)/i.test(dmarc[0]))
  )
    fail("MAIL_AUTHENTICATION_FAILED");
  const identity = (method: string, property: string) => {
    const matches = clauses.filter((c) =>
      new RegExp(`^${method}\\s*=`, "i").test(c)
    );
    if (
      matches.length !== 1 ||
      !new RegExp(`^${method}\\s*=\\s*pass(?:\\s|$)`, "i").test(matches[0])
    )
      fail("MAIL_AUTHENTICATION_FAILED");
    const properties: { name: string; value: string }[] = [];
    let rest = matches[0];
    while (rest.trim()) {
      const token =
        /^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s"]+))(?=\s|$)/.exec(
          rest
        );
      if (!token) fail("INVALID_AUTH_RESULTS");
      properties.push({
        name: token[1].toLowerCase(),
        value: token[2] ?? token[3],
      });
      rest = rest.slice(token[0].length);
    }
    const values = properties.filter((p) => p.name === property);
    if (values.length !== 1 || domain(values[0].value) !== provider)
      fail("MAIL_AUTHENTICATION_IDENTITY_CHANGED");
    return provider;
  };
  const dkimIdentityDomain = identity("dkim", "header.i"),
    spfMailFromDomain = identity("spf", "smtp.mailfrom");
  const dkimSigningDomains = [
    ...new Set(
      headers
        .filter((h) => h.key.toLowerCase() === "dkim-signature")
        .flatMap((h) =>
          [...h.value.matchAll(/(?:^|;)\s*d=([^;\s]+)/gi)].map((m) =>
            m[1].toLowerCase()
          )
        )
    ),
  ].sort();
  if (!dkimSigningDomains.includes(provider)) fail("MAIL_SIGNER_CHANGED");
  return {
    policy: profile,
    parser: parserVersion,
    issuer: "mx.google.com",
    dkimIdentityDomain,
    dkimSigningDomains,
    spfMailFromDomain,
    dmarcResult:
      dmarc.length === 0
        ? null
        : /^dmarc\s*=\s*pass(?:\s|$)/i.test(dmarc[0])
          ? "pass"
          : "none",
  };
}
function plainPart(
  part: GmailMessagePart,
  path: number[] = [],
  depth = 0
): { part: GmailMessagePart; path: number[] }[] {
  if (depth > 20 || (part.parts?.length ?? 0) > 100) fail("GMAIL_PART_LIMIT");
  if (part.filename) return [];
  return [
    ...(part.mime_type.toLowerCase() === "text/plain" ? [{ part, path }] : []),
    ...(part.parts ?? []).flatMap((child, index) =>
      plainPart(child, [...path, index], depth + 1)
    ),
  ];
}
function edition(text: string): string {
  const matches = [
    ...text.matchAll(
      /Upcoming shows of Interest\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/gi
    ),
  ];
  if (matches.length !== 1) fail("AMBIGUOUS_STEVE_EDITION");
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const match = matches[0],
    month = months.findIndex(
      (m) =>
        m === match[1].toLowerCase() || m.slice(0, 3) === match[1].toLowerCase()
    );
  if (month < 0) fail("INVALID_STEVE_EDITION");
  const date = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  localDateStartEpochMs(date);
  if (new Date(date + "T12:00:00Z").getUTCDay() !== 5)
    fail("INVALID_STEVE_EDITION");
  return date;
}
function mondayAfter(friday: string): number {
  const date = new Date(friday + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + 3);
  return localDateStartEpochMs(date.toISOString().slice(0, 10));
}
function parseReceipt(bytes: Buffer): SteveEmailReceipt {
  const value = JSON.parse(bytes.toString("utf8")) as SteveEmailReceipt;
  same(
    bytes.toString("utf8"),
    canonicalJson(value) + "\n",
    "NONCANONICAL_INTAKE_RECEIPT"
  );
  if (
    value.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(value.receiptId) ||
    !/^[a-f0-9]{64}$/.test(value.accountSha256) ||
    !/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
    !/^[a-f0-9]{64}$/.test(value.rawSha256) ||
    !/^[a-f0-9]{1,128}$/.test(value.messageId) ||
    value.deliveryId !== "gmail-" + value.receiptId ||
    !Number.isSafeInteger(value.firstObservedAtEpochMs) ||
    value.firstObservedAtEpochMs > Date.now() ||
    value.firstObservedAtEpochMs < 0 ||
    !Number.isSafeInteger(value.acquisitionObservedAtEpochMs) ||
    !Number.isSafeInteger(value.receivedAtEpochMs) ||
    value.receivedAtEpochMs > value.firstObservedAtEpochMs ||
    value.acquisitionObservedAtEpochMs > value.firstObservedAtEpochMs ||
    value.receiverProfile?.policy !== profile ||
    value.receiverProfile?.parser !== parserVersion ||
    !Number.isFinite(Date.parse(value.senderDate)) ||
    !["ready", "review-required"].includes(value.disposition)
  )
    fail("INVALID_INTAKE_RECEIPT");
  same(
    sha256(
      canonicalJson([value.accountSha256, value.editionId, value.sourceSha256])
    ),
    value.receiptId,
    "CHANGED_INTAKE_IDENTITY"
  );
  return value;
}
function bodyReceipt(
  directory: string,
  journal: WeeklyRunJournal,
  lineage = new Set<string>()
): SteveEmailReceipt {
  const bytes = regular(join(directory, "receipt.json"));
  const receipt = parseReceipt(bytes);
  const registered = journal.readIntakeEvidence(
    scope,
    "source",
    receipt.receiptId
  );
  if (!registered || !registered.equals(bytes)) fail("INTAKE_EVIDENCE_CHANGED");
  if (lineage.size >= 100 || lineage.has(receipt.receiptId))
    fail("INVALID_CORRECTION_LINEAGE");
  lineage.add(receipt.receiptId);
  same(
    sha256(regular(join(directory, "source.txt"))),
    receipt.sourceSha256,
    "CHANGED_INTAKE_TEXT"
  );
  const accountRoot = dirname(dirname(directory));
  same(
    sha256(
      regular(
        join(accountRoot, "messages", sha256(receipt.messageId), "message.eml")
      )
    ),
    receipt.rawSha256,
    "CHANGED_INTAKE_MIME"
  );
  const approvalPath = join(directory, "correction-approval.json");
  const storedApproval = journal.readIntakeEvidence(
    scope,
    "correction",
    receipt.receiptId
  );
  if (storedApproval && !existsSync(approvalPath))
    fail("PENDING_STEVE_EMAIL_INTAKE");
  if (!existsSync(approvalPath)) {
    if (receipt.correctionOf !== null) {
      if (!/^[a-f0-9]{64}$/.test(receipt.correctionOf))
        fail("INVALID_CORRECTION_LINEAGE");
      const parent = bodyReceipt(
        join(dirname(directory), receipt.correctionOf),
        journal,
        lineage
      );
      if (
        parent.accountSha256 !== receipt.accountSha256 ||
        parent.editionId !== receipt.editionId ||
        parent.disposition !== "ready"
      )
        fail("UNKNOWN_CORRECTION_PARENT");
    }
    return receipt;
  }
  const approvalBytes = regular(approvalPath),
    approval = JSON.parse(approvalBytes.toString("utf8")) as {
      schemaVersion: number;
      receiptId: string;
      correctionOf: string;
      approvedAtEpochMs: number;
    };
  same(
    approvalBytes.toString("utf8"),
    canonicalJson(approval) + "\n",
    "CHANGED_CORRECTION_APPROVAL"
  );
  if (!storedApproval || !storedApproval.equals(approvalBytes))
    fail("INTAKE_EVIDENCE_CHANGED");
  same(
    Object.keys(approval).sort(),
    ["schemaVersion", "receiptId", "correctionOf", "approvedAtEpochMs"].sort(),
    "INVALID_CORRECTION_APPROVAL"
  );
  if (
    approval.schemaVersion !== 1 ||
    approval.receiptId !== receipt.receiptId ||
    !/^[a-f0-9]{64}$/.test(approval.correctionOf) ||
    approval.correctionOf === receipt.receiptId ||
    receipt.disposition !== "review-required" ||
    !Number.isSafeInteger(approval.approvedAtEpochMs) ||
    approval.approvedAtEpochMs < receipt.firstObservedAtEpochMs ||
    approval.approvedAtEpochMs > Date.now()
  )
    fail("INVALID_CORRECTION_APPROVAL");
  const parent = bodyReceipt(
    join(dirname(directory), approval.correctionOf),
    journal,
    lineage
  );
  if (
    parent.accountSha256 !== receipt.accountSha256 ||
    parent.editionId !== receipt.editionId ||
    parent.disposition !== "ready"
  )
    fail("UNKNOWN_CORRECTION_PARENT");
  return {
    ...receipt,
    correctionOf: approval.correctionOf,
    disposition: "ready",
  };
}

/**
 * Capture snapshots obtained through the configured account-bound Gmail connector.
 * Receiver-profile matching is not a signature on arbitrary uploaded JSON/EML.
 * The caller must retain the authenticated connector acquisition boundary.
 */
export async function captureSteveEmail(input: {
  operatorDirectory: string;
  accountId: string;
  rawMessage: { id: string; raw: string };
  fullMessage: {
    id: string;
    internal_date: number | string;
    payload: GmailMessagePart;
  };
  expectedEditionId: string;
  observedAtEpochMs: number;
  correctionOf?: string;
}): Promise<{
  receipt: SteveEmailReceipt;
  source: Buffer;
  disposition: "ready" | "review-required";
}> {
  if (
    !input.accountId ||
    input.accountId.length > 256 ||
    Array.from(input.accountId).some(
      (character) => character.charCodeAt(0) < 32
    ) ||
    !/^[a-f0-9]{1,128}$/.test(input.rawMessage.id) ||
    input.rawMessage.id !== input.fullMessage.id ||
    !Number.isSafeInteger(input.observedAtEpochMs) ||
    input.observedAtEpochMs > Date.now()
  )
    fail("INVALID_GMAIL_CAPTURE");
  const received = Number(input.fullMessage.internal_date);
  if (
    !Number.isSafeInteger(received) ||
    received < 0 ||
    received > input.observedAtEpochMs
  )
    fail("INVALID_GMAIL_RECEIPT_TIME");
  const raw = decode(input.rawMessage.raw);
  const parsed = await PostalMime.parse(raw, {
    maxNestingDepth: 20,
    maxPartCount: 100,
    maxHeadersSize: 256 * 1024,
    forceRfc822Attachments: true,
  });
  const senderDate = header(parsed.headers, "date");
  if (!Number.isFinite(Date.parse(senderDate))) fail("INVALID_SENDER_DATE");
  const auth = receiverProfile(parsed.headers);
  const parts = plainPart(input.fullMessage.payload);
  if (parts.length !== 1 || !parts[0].part.body) fail("AMBIGUOUS_STEVE_TEXT");
  const body = parts[0].part.body;
  if (!body.base64_url_content && typeof body.content !== "string")
    fail("AMBIGUOUS_STEVE_TEXT");
  const source = body.base64_url_content
    ? decode(body.base64_url_content)
    : Buffer.from(body.content!, "utf8");
  if (
    typeof body.content === "string" &&
    !source.equals(Buffer.from(body.content, "utf8"))
  )
    fail("GMAIL_MIME_TEXT_MISMATCH");
  if (source.length !== body.size) fail("TRUNCATED_STEVE_TEXT");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(source);
  const comparable = (value: string) =>
    value
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .replace(/\n+$/, "");
  if (!parsed.text || comparable(parsed.text) !== comparable(text))
    fail("GMAIL_MIME_TEXT_MISMATCH");
  const editionId = edition(text);
  if (editionId !== input.expectedEditionId) fail("WRONG_EXPECTED_EDITION");
  const accountSha256 = sha256(input.accountId),
    sourceSha256 = sha256(source),
    rawSha256 = sha256(raw),
    receiptId = sha256(canonicalJson([accountSha256, editionId, sourceSha256]));
  const directory = resolvePrivateCandidateDirectory(input.operatorDirectory);
  secureOperatorDirectory(directory);
  const journal = new WeeklyRunJournal(directory);
  let lease: WeeklyRunLease | undefined;
  try {
    lease = journal.acquire(scope);
    const owned = lease;
    const root = join(directory, "email-intake", accountSha256),
      messageDirectory = join(root, "messages", sha256(input.rawMessage.id)),
      bodyRoot = join(root, "bodies"),
      bodyDirectory = join(bodyRoot, receiptId);
    const prior = journal
      .listIntakeEvidence(scope, "source")
      .map((e) => parseReceipt(e.bytes))
      .filter((r) => r.accountSha256 === accountSha256);
    // Detect mutation before committing another immutable admission.
    if (
      prior.some(
        (r) => r.messageId === input.rawMessage.id && r.rawSha256 !== rawSha256
      )
    )
      fail("INTAKE_EVIDENCE_CHANGED");
    const rawPath = join(messageDirectory, "message.eml");
    if (existsSync(rawPath) && !regular(rawPath).equals(raw))
      fail("INTAKE_EVIDENCE_CHANGED");
    let receiptBytes = journal.readIntakeEvidence(scope, "source", receiptId);
    let receipt: SteveEmailReceipt;
    if (receiptBytes) {
      receipt = parseReceipt(receiptBytes);
    } else {
      const admittedAt = Date.now();
      if (admittedAt >= mondayAfter(editionId))
        fail("SOURCE_WINDOW_REQUIRES_REVIEW");
      const siblings = prior.filter((r) => r.editionId === editionId);
      if (input.correctionOf) {
        if (
          !/^[a-f0-9]{64}$/.test(input.correctionOf) ||
          !siblings.some((r) => r.receiptId === input.correctionOf)
        )
          fail("UNKNOWN_CORRECTION_PARENT");
        const parent = bodyReceipt(join(bodyRoot, input.correctionOf), journal);
        if (parent.disposition !== "ready") fail("UNKNOWN_CORRECTION_PARENT");
        if (
          siblings.some(
            (r) =>
              bodyReceipt(join(bodyRoot, r.receiptId), journal).correctionOf ===
              input.correctionOf
          )
        )
          fail("COMPETING_CORRECTION_BRANCH");
      }
      receipt = {
        schemaVersion: 1,
        receiptId,
        accountSha256,
        editionId,
        deliveryId: "gmail-" + receiptId,
        messageId: input.rawMessage.id,
        rawSha256,
        sourceSha256,
        receivedAtEpochMs: received,
        firstObservedAtEpochMs: admittedAt,
        acquisitionObservedAtEpochMs: input.observedAtEpochMs,
        senderDate,
        disposition:
          siblings.length && !input.correctionOf ? "review-required" : "ready",
        correctionOf: input.correctionOf ?? null,
        partPath: parts[0].path,
        receiverProfile: auth,
      };
      // Commit the first admission before filesystem effects: retries cannot recapture time.
      receiptBytes = journal.saveIntakeEvidence(
        "source",
        receiptId,
        Buffer.from(canonicalJson(receipt) + "\n"),
        owned
      );
    }
    same(receipt.accountSha256, accountSha256, "CHANGED_INTAKE_ACCOUNT");
    same(receipt.editionId, editionId, "CHANGED_INTAKE_EDITION");
    same(receipt.sourceSha256, sourceSha256, "CHANGED_INTAKE_TEXT");
    if (
      receipt.messageId === input.rawMessage.id &&
      receipt.rawSha256 !== rawSha256
    )
      fail("INTAKE_EVIDENCE_CHANGED");
    let approval = journal.readIntakeEvidence(scope, "correction", receiptId);
    if (input.correctionOf) {
      if (receipt.disposition === "ready") {
        if (input.correctionOf !== receipt.correctionOf)
          fail("CHANGED_CORRECTION_PARENT");
      } else if (approval) {
        const existing = JSON.parse(approval.toString("utf8")) as {
          correctionOf: string;
        };
        if (existing.correctionOf !== input.correctionOf)
          fail("CHANGED_CORRECTION_PARENT");
      } else {
        if (
          !/^[a-f0-9]{64}$/.test(input.correctionOf) ||
          input.correctionOf === receiptId
        )
          fail("UNKNOWN_CORRECTION_PARENT");
        const parent = bodyReceipt(join(bodyRoot, input.correctionOf), journal);
        if (parent.editionId !== editionId || parent.disposition !== "ready")
          fail("UNKNOWN_CORRECTION_PARENT");
        const siblings = prior.filter(
          (r) => r.editionId === editionId && r.receiptId !== receiptId
        );
        if (
          siblings.some(
            (r) =>
              bodyReceipt(join(bodyRoot, r.receiptId), journal).correctionOf ===
              input.correctionOf
          )
        )
          fail("COMPETING_CORRECTION_BRANCH");
        approval = journal.saveIntakeEvidence(
          "correction",
          receiptId,
          Buffer.from(
            canonicalJson({
              schemaVersion: 1,
              receiptId,
              correctionOf: parent.receiptId,
              approvedAtEpochMs: Date.now(),
            }) + "\n"
          ),
          owned
        );
      }
    }
    const savedReceipt = receiptBytes;
    return await journal.guardOperation(owned, async () => {
      privateDirectory(messageDirectory);
      once(rawPath, raw);
      privateDirectory(bodyDirectory);
      once(join(bodyDirectory, "source.txt"), source);
      once(join(bodyDirectory, "receipt.json"), savedReceipt);
      if (approval)
        once(join(bodyDirectory, "correction-approval.json"), approval);
      receipt = bodyReceipt(bodyDirectory, journal);
      const capture = {
        schemaVersion: 1,
        messageId: input.rawMessage.id,
        accountSha256,
        rawSha256,
        sourceSha256,
        receiptId,
        receivedAtEpochMs: received,
      };
      once(
        join(messageDirectory, "capture.json"),
        Buffer.from(canonicalJson(capture) + "\n")
      );
      journal.checkOwnership(owned);
      return { receipt, source, disposition: receipt.disposition };
    });
  } finally {
    try {
      if (lease) journal.release(lease);
    } finally {
      journal.close();
    }
  }
}

/** Prevent an acquired pre-cutoff edition/revision disappearing before registration. */
export function assertNoPendingSteveEmail(
  operatorDirectory: string,
  journal: WeeklyRunJournal,
  selectedScope: string,
  cutoff: number
): void {
  if (selectedScope !== scope) fail("WRONG_INTAKE_SCOPE");
  const admitted = journal.listIntakeEvidence(scope, "source");
  const known = new Set(admitted.map((e) => e.id));
  const root = join(operatorDirectory, "email-intake");
  if (existsSync(root))
    for (const account of readdirSync(root)) {
      if (!/^[a-f0-9]{64}$/.test(account)) fail("UNEXPECTED_INTAKE_DIRECTORY");
      const bodies = join(root, account, "bodies");
      if (!existsSync(bodies)) continue;
      for (const body of readdirSync(bodies)) {
        if (!/^[a-f0-9]{64}$/.test(body)) fail("UNEXPECTED_INTAKE_DIRECTORY");
        if (!known.has(body) && readdirSync(join(bodies, body)).length)
          fail("PENDING_STEVE_EMAIL_INTAKE");
      }
    }
  for (const saved of admitted) {
    const receipt = parseReceipt(saved.bytes);
    same(receipt.receiptId, saved.id, "CHANGED_INTAKE_IDENTITY");
    const directory = join(
      root,
      receipt.accountSha256,
      "bodies",
      receipt.receiptId
    );
    if (
      !existsSync(join(directory, "receipt.json")) ||
      !existsSync(join(directory, "source.txt"))
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
    bodyReceipt(directory, journal);
    if (receipt.firstObservedAtEpochMs >= cutoff) continue;
    if (
      !journal
        .findDelivery(scope, receipt.editionId, receipt.deliveryId)
        .some(
          (run) =>
            run.source.rawSha256 === receipt.sourceSha256 &&
            run.source.importObservedAtEpochMs ===
              receipt.firstObservedAtEpochMs &&
            run.stages.find((stage) => stage.stage === "load")?.status ===
              "succeeded"
        )
    )
      fail("PENDING_STEVE_EMAIL_INTAKE");
  }
}
