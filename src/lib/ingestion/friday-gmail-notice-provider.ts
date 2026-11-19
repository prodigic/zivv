import { createHash } from "node:crypto";
import type { FridayMonitorNotice } from "./friday-monitor-evidence.js";
import type {
  FridayNoticeProvider,
  FridayPublicationDeliveryNotice,
} from "./friday-notice-dispatch.js";
import { PROMOTION_DESTINATIONS } from "./promotion-control.js";
import { canonicalJson } from "./sqlite-store.js";
import { assertSteveGmailAccount } from "./steve-gmail-projection.js";

const api = "https://gmail.googleapis.com/gmail/v1/users/me";
const replyLimit = 64 * 1024;
const receiptHeaders = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Subject",
  "Message-ID",
  "X-Zivv-Notice",
];
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

interface GmailNoticeOptions {
  expectedAccountId: string;
  recipient: string;
  getAccessToken: () => Promise<string>;
  fetcher: typeof fetch;
}

function fail(code: string): never {
  throw Error(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("GMAIL_NOTICE_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function mailbox(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    value.trim() !== value ||
    !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)
  )
    return fail("GMAIL_NOTICE_CONFIGURATION_INVALID");
  return value;
}

function providerId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{1,128}$/.test(value))
    return fail("GMAIL_NOTICE_RESPONSE_INVALID");
  return value;
}

async function responseJson(response: Response) {
  const length = response.headers.get("content-length");
  if (
    !response.ok ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > replyLimit))
  ) {
    await response.body?.cancel().catch(() => {});
    return fail("GMAIL_NOTICE_REQUEST_FAILED");
  }
  if (!response.body) return fail("GMAIL_NOTICE_RESPONSE_INVALID");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > replyLimit) {
        await reader.cancel().catch(() => {});
        return fail("GMAIL_NOTICE_RESPONSE_INVALID");
      }
      chunks.push(item.value);
    }
    return record(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
      )
    );
  } catch {
    return fail("GMAIL_NOTICE_RESPONSE_INVALID");
  } finally {
    reader.releaseLock();
  }
}

function noticeMessage(notice: Readonly<FridayMonitorNotice>) {
  if (
    (notice.kind !== "missing-source" && notice.kind !== "missed-start") ||
    typeof notice.editionId !== "string" ||
    notice.editionId.length !== 10 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(notice.editionId) ||
    !Number.isSafeInteger(notice.dueAtEpochMs) ||
    notice.key !==
      `friday/${notice.editionId}/${notice.kind}/${notice.dueAtEpochMs}`
  )
    return fail("GMAIL_NOTICE_CONFIGURATION_INVALID");
  const due = new Date(notice.dueAtEpochMs).toISOString();
  if (notice.kind === "missing-source")
    return {
      subject: `Zivv Friday ${notice.editionId}: Steve's List missing`,
      body: `The verified mailbox search still shows no Steve's List source for the ${notice.editionId} edition at the alert deadline (${due}). Check the configured Gmail mailbox and the Friday intake result. Keep the last verified release in place while checking the source.`,
    };
  return {
    subject: `Zivv Friday ${notice.editionId}: expected start missed`,
    body: `The independent watcher did not observe a Friday intake start by ${due} for the ${notice.editionId} edition. Check the Windows host and the private runner journal before starting another run.`,
  };
}

function publicationMessage(notice: Readonly<FridayPublicationDeliveryNotice>) {
  const failure = "GMAIL_NOTICE_CONFIGURATION_INVALID";
  const { coverage } = notice;
  if (
    notice.status !== "verified-release" ||
    notice.editionId.length !== 10 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(notice.editionId) ||
    notice.key !== `friday/${notice.editionId}/published` ||
    notice.liveUrl !== PROMOTION_DESTINATIONS.production.liveUrl ||
    ![
      notice.candidateId,
      notice.verificationReceiptId,
      notice.acknowledgementId,
      notice.releaseId,
    ].every(
      (id) =>
        typeof id === "string" && id.length === 64 && /^[a-f0-9]{64}$/.test(id)
    ) ||
    !coverage ||
    ![
      notice.addedEventCount,
      coverage.distinctArtists,
      coverage.distinctVenues,
      coverage.missingShowArtwork,
      coverage.artistsWithoutLinks,
      coverage.artistsWithoutReviews,
      coverage.venuesWithoutMapLocation,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    coverage.missingShowArtwork > notice.addedEventCount ||
    coverage.artistsWithoutLinks > coverage.distinctArtists ||
    coverage.artistsWithoutReviews > coverage.distinctArtists ||
    coverage.venuesWithoutMapLocation > coverage.distinctVenues
  )
    return fail(failure);
  return {
    subject: `Zivv Friday ${notice.editionId}: verified publication`,
    body: [
      `The ${notice.editionId} edition is published and verified.`,
      `Live release ${notice.liveUrl}`,
      `Added shows ${notice.addedEventCount}`,
      `Shows without artwork ${coverage.missingShowArtwork} of ${notice.addedEventCount}`,
      `Artists without a link ${coverage.artistsWithoutLinks} of ${coverage.distinctArtists}`,
      `Artists without a cited review ${coverage.artistsWithoutReviews} of ${coverage.distinctArtists}`,
      `Venues without a map location ${coverage.venuesWithoutMapLocation} of ${coverage.distinctVenues}`,
    ].join("\r\n"),
  };
}

function verifyPublicationBody(
  payload: Record<string, unknown>,
  expected: string
): void {
  if (
    payload.mimeType !== "text/plain" ||
    (payload.parts !== undefined &&
      (!Array.isArray(payload.parts) || payload.parts.length !== 0))
  )
    return fail("GMAIL_NOTICE_SENT_RECEIPT_UNVERIFIED");
  const part = record(payload.body);
  const data = part.data;
  if (
    part.attachmentId !== undefined ||
    typeof data !== "string" ||
    data.length > 4096 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(data)
  )
    return fail("GMAIL_NOTICE_SENT_RECEIPT_UNVERIFIED");
  const bytes = Buffer.from(data, "base64url");
  const canonical = bytes.toString("base64url");
  const padding = "=".repeat((4 - (canonical.length % 4)) % 4);
  if (
    bytes.length !== part.size ||
    (data !== canonical && data !== canonical + padding)
  )
    return fail("GMAIL_NOTICE_SENT_RECEIPT_UNVERIFIED");
  const readback = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const normalized = readback.replace(/\r\n/g, "\n");
  const text = expected.replace(/\r\n/g, "\n");
  if (normalized !== text && normalized !== text + "\n")
    return fail("GMAIL_NOTICE_SENT_RECEIPT_UNVERIFIED");
}

function createGmailNoticeProvider<Notice extends { key: string }>(
  { expectedAccountId, recipient, getAccessToken, fetcher }: GmailNoticeOptions,
  render: (notice: Readonly<Notice>) => { subject: string; body: string },
  bindContent: boolean
): FridayNoticeProvider<object, Notice> {
  const sender = mailbox(expectedAccountId);
  const to = mailbox(recipient);
  if (typeof getAccessToken !== "function" || typeof fetcher !== "function")
    return fail("GMAIL_NOTICE_CONFIGURATION_INVALID");
  const pending = new WeakMap<
    object,
    { token: string; key: string; contentSha256: string }
  >();
  const domain = sender.slice(sender.lastIndexOf("@") + 1).toLowerCase();

  async function request(path: string, token: string, raw?: string) {
    let response: Response;
    try {
      response = await fetcher(api + path, {
        method: raw === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(raw === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(raw === undefined ? {} : { body: JSON.stringify({ raw }) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return fail("GMAIL_NOTICE_REQUEST_FAILED");
    }
    return responseJson(response);
  }

  async function authenticatedToken() {
    const token = await getAccessToken();
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(token))
      return fail("GMAIL_NOTICE_CONFIGURATION_INVALID");
    assertSteveGmailAccount(sender, await request("/profile", token));
    return token;
  }

  function contentDigest(
    notice: Readonly<Notice>,
    subject: string,
    body: string
  ): string {
    return hash(
      bindContent
        ? canonicalJson({ notice, subject, body })
        : JSON.stringify([subject, body])
    );
  }

  function envelope(claim: { notice: Readonly<Notice>; attemptId: string }) {
    const { subject, body } = render(claim.notice);
    const contentSha256 = contentDigest(claim.notice, subject, body);
    const identity = claim.notice.key + "\0" + claim.attemptId;
    const marker = hash(
      bindContent ? identity + "\0" + contentSha256 : identity
    );
    const messageId = `<zivv-friday-${marker}@${domain}>`;
    return { marker, messageId, subject, body, contentSha256 };
  }

  async function verifySent(
    claim: { notice: Readonly<Notice>; attemptId: string },
    id: string,
    token: string
  ) {
    const { marker, messageId, subject, body } = envelope(claim);
    const params = new URLSearchParams({
      format: bindContent ? "full" : "metadata",
    });
    if (!bindContent)
      for (const name of receiptHeaders) params.append("metadataHeaders", name);
    const value = await request(`/messages/${id}?${params}`, token);
    if (
      value.id !== id ||
      !Array.isArray(value.labelIds) ||
      !value.labelIds.includes("SENT")
    )
      return fail("GMAIL_NOTICE_SENT_RECEIPT_UNVERIFIED");
    const payload = record(value.payload);
    const list = payload.headers;
    if (!Array.isArray(list) || list.length > 128)
      return fail("GMAIL_NOTICE_SENT_RECEIPT_UNVERIFIED");
    const headers = new Map<string, string>();
    const requested = new Set(receiptHeaders.map((name) => name.toLowerCase()));
    for (const item of list) {
      const header = record(item);
      if (typeof header.name !== "string")
        return fail("GMAIL_NOTICE_SENT_RECEIPT_UNVERIFIED");
      const name = header.name.toLowerCase();
      if (!requested.has(name)) continue;
      if (typeof header.value !== "string" || headers.has(name))
        return fail("GMAIL_NOTICE_SENT_RECEIPT_UNVERIFIED");
      headers.set(name, header.value);
    }
    if (
      headers.get("from")?.toLowerCase() !== sender.toLowerCase() ||
      headers.get("to")?.toLowerCase() !== to.toLowerCase() ||
      headers.has("cc") ||
      headers.has("bcc") ||
      headers.get("subject") !== subject ||
      headers.get("message-id") !== messageId ||
      headers.get("x-zivv-notice") !== marker
    )
      return fail("GMAIL_NOTICE_SENT_RECEIPT_UNVERIFIED");
    if (bindContent) verifyPublicationBody(payload, body);
    return {
      key: claim.notice.key,
      attemptId: claim.attemptId,
      receiptSha256: hash(
        JSON.stringify([
          sender.toLowerCase(),
          to.toLowerCase(),
          id,
          messageId,
          subject,
        ])
      ),
    };
  }

  return {
    async prepare(notice) {
      const { subject, body } = render(notice);
      const prepared = Object.freeze({});
      pending.set(prepared, {
        key: notice.key,
        contentSha256: contentDigest(notice, subject, body),
        token: await authenticatedToken(),
      });
      return prepared;
    },
    async send(prepared, claim) {
      const saved = pending.get(prepared);
      pending.delete(prepared);
      const { marker, messageId, subject, body, contentSha256 } =
        envelope(claim);
      if (
        !saved ||
        saved.key !== claim.notice.key ||
        saved.contentSha256 !== contentSha256
      )
        return fail("GMAIL_NOTICE_PREPARATION_UNVERIFIED");
      const raw = Buffer.from(
        [
          `From: ${sender}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          `Message-ID: ${messageId}`,
          `X-Zivv-Notice: ${marker}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=UTF-8",
          "",
          body,
          "",
        ].join("\r\n"),
        "utf8"
      );
      try {
        const sent = await request(
          "/messages/send",
          saved.token,
          raw.toString("base64url")
        );
        return verifySent(claim, providerId(sent.id), saved.token);
      } finally {
        raw.fill(0);
      }
    },
    async findDelivery(claim) {
      const { messageId } = envelope(claim);
      const token = await authenticatedToken();
      const params = new URLSearchParams({
        labelIds: "SENT",
        q: `rfc822msgid:${messageId}`,
        maxResults: "2",
      });
      const listed = await request(`/messages?${params}`, token);
      const entries = listed.messages === undefined ? [] : listed.messages;
      if (
        !Array.isArray(entries) ||
        entries.length > 1 ||
        listed.nextPageToken !== undefined
      )
        return fail("GMAIL_NOTICE_SENT_RECEIPT_UNVERIFIED");
      if (entries.length === 0) return null;
      return verifySent(claim, providerId(record(entries[0]).id), token);
    },
  };
}

/** Use a separate, explicitly configured sender for Friday operator alerts. */
export function createFridayGmailNoticeProvider(options: GmailNoticeOptions) {
  return createGmailNoticeProvider(options, noticeMessage, false);
}

/** Bind the immutable success message content into its Sent lookup identity. */
export function createFridayGmailPublicationNoticeProvider(
  options: GmailNoticeOptions
) {
  return createGmailNoticeProvider(options, publicationMessage, true);
}
