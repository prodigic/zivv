import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  prepareSteveEmailCapture,
  type GmailMessagePart,
} from "../../lib/ingestion/steve-email-intake.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";

const text =
  "THE LIST\nUpcoming shows of Interest October 16, 2026\nSynthetic Artist at Fixture Club\n";
const accountId = "synthetic-account@fixture.invalid";
const observedAtEpochMs = Date.parse("2026-10-16T17:05:00Z");
const receivedAtEpochMs = Date.parse("2026-10-16T17:00:00Z");

function email(
  options: { from?: string; fullText?: string; id?: string } = {}
) {
  const rawText = text.replace(/\n/g, "\r\n");
  const headers = [
    `From: ${options.from ?? "Steve Fixture <skoepke@stevelist.com>"}`,
    "Sender: noreply@sp.eocampaign1.com",
    "Date: Fri, 16 Oct 2026 10:00:00 -0700",
    "Subject: Steve's List 10/16/2026",
    "Message-ID: <synthetic@fixture.invalid>",
    "Authentication-Results: mx.google.com; dkim=pass header.i=@sp.eocampaign1.com; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com",
    "DKIM-Signature: v=1; a=rsa-sha256; d=sp.eocampaign1.com; s=fixture; h=from:sender:subject:date; bh=c3ludGhldGlj; b=c3ludGhldGlj",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
  ];
  const raw = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + rawText);
  const fullText = options.fullText ?? rawText;
  const payload: GmailMessagePart = {
    mime_type: "text/plain",
    headers: headers.map((line) => {
      const split = line.indexOf(":");
      return {
        name: line.slice(0, split),
        value: line.slice(split + 1).trim(),
      };
    }),
    body: {
      size: Buffer.byteLength(fullText),
      base64_url_content: Buffer.from(fullText).toString("base64url"),
    },
  };
  const id = options.id ?? "a1";
  return {
    rawBytes: raw,
    rawMessage: { id, raw: raw.toString("base64url") },
    fullMessage: {
      id,
      internal_date: String(receivedAtEpochMs),
      payload,
    },
  };
}

function input(overrides: { from?: string; fullText?: string } = {}) {
  return {
    accountId,
    ...email(overrides),
    expectedEditionId: "2026-10-16",
    observedAtEpochMs,
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("prepareSteveEmailCapture", () => {
  it("prepares the existing validated source and receipt identity without capture IO", async () => {
    const prepared = await prepareSteveEmailCapture(input());
    const normalizedText = text.replace(/\n/g, "\r\n");
    const accountSha256 = sha256(accountId);
    const sourceSha256 = sha256(Buffer.from(normalizedText));
    const receiptId = sha256(
      canonicalJson([accountSha256, "2026-10-16", sourceSha256])
    );
    expect(prepared).toMatchObject({
      accountSha256,
      editionId: "2026-10-16",
      deliveryId: `gmail-${receiptId}`,
      messageId: "a1",
      rawSha256: sha256(email().rawBytes),
      sourceSha256,
      receiptId,
      receivedAtEpochMs,
      acquisitionObservedAtEpochMs: observedAtEpochMs,
      senderDate: "Fri, 16 Oct 2026 10:00:00 -0700",
      partPath: [],
      receiverProfile: {
        policy: "steve-gmail-eocampaign-v1",
        parser: "postal-mime-4.0.7/gmail-text-v1",
        issuer: "mx.google.com",
        dkimIdentityDomain: "sp.eocampaign1.com",
        dkimSigningDomains: ["sp.eocampaign1.com"],
        spfMailFromDomain: "sp.eocampaign1.com",
        dmarcResult: null,
      },
    });
    expect(prepared.raw.equals(email().rawBytes)).toBe(true);
    expect(prepared.source.toString("utf8")).toBe(normalizedText);
    expect(prepared).not.toHaveProperty("operatorDirectory");
    expect(prepared).not.toHaveProperty("correctionOf");
  });

  it("rejects invalid sender, RAW/FULL text mismatch, and wrong edition", async () => {
    await expect(
      prepareSteveEmailCapture(input({ from: "attacker@example.invalid" }))
    ).rejects.toThrow("WRONG_STEVE_SENDER");
    await expect(
      prepareSteveEmailCapture(input({ fullText: "different cached text\r\n" }))
    ).rejects.toThrow("GMAIL_MIME_TEXT_MISMATCH");
    await expect(
      prepareSteveEmailCapture({
        ...input(),
        expectedEditionId: "2026-10-09",
      })
    ).rejects.toThrow("WRONG_EXPECTED_EDITION");
  });

  it("binds the receipt identity to account, edition, and source hashes", async () => {
    const prepared = await prepareSteveEmailCapture(input());
    expect(prepared.receiptId).toBe(
      sha256(
        canonicalJson([
          sha256(accountId),
          prepared.editionId,
          prepared.sourceSha256,
        ])
      )
    );
    expect(prepared.sourceSha256).toBe(sha256(prepared.source));
    expect(prepared.rawSha256).toBe(sha256(prepared.raw));
  });

  it("owns validated source bytes before awaiting MIME parsing", async () => {
    const args = input();
    const preparation = prepareSteveEmailCapture(args);
    args.fullMessage.payload.body!.base64_url_content =
      Buffer.from("mutated").toString("base64url");
    args.rawMessage.raw = "invalid";
    const prepared = await preparation;
    expect(prepared.source.toString("utf8")).toBe(text.replace(/\n/g, "\r\n"));
    expect(prepared.raw.equals(email().rawBytes)).toBe(true);
  });

  it("rejects a nested wide FULL tree above the aggregate part limit", async () => {
    const args = input();
    const payload = args.fullMessage.payload;
    args.fullMessage.payload = {
      mime_type: "multipart/mixed",
      parts: [
        payload,
        ...Array.from({ length: 99 }, () => ({
          mime_type: "application/octet-stream",
          filename: "attached.bin",
        })),
      ],
    };
    await expect(prepareSteveEmailCapture(args)).rejects.toThrow(
      "GMAIL_PART_LIMIT"
    );
  });
});
