import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatchFridayNotice } from "../../lib/ingestion/friday-notice-dispatch.js";
import { FridayNoticeOutbox } from "../../lib/ingestion/friday-notice-outbox.js";
import { describe, expect, it } from "vitest";
import { createFridayGmailNoticeProvider } from "../../lib/ingestion/friday-gmail-notice-provider.js";
import type { FridayMonitorNotice } from "../../lib/ingestion/friday-monitor-evidence.js";

const origin = "https://gmail.googleapis.com/gmail/v1/users/me";
const sender = "synthetic-sender@example.invalid";
const recipient = "synthetic-recipient@example.invalid";
const attemptId = "12345678-1234-4234-8234-123456789abc";
const dueAtEpochMs = Date.parse("2026-10-31T01:00:00Z");
function notice(
  kind: FridayMonitorNotice["kind"] = "missing-source"
): FridayMonitorNotice {
  return {
    schemaVersion: 1,
    key: `friday/2026-10-30/${kind}/${dueAtEpochMs}`,
    editionId: "2026-10-30",
    kind,
    dueAtEpochMs,
  };
}
function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function identity(n: FridayMonitorNotice) {
  return createHash("sha256").update(`${n.key}\0${attemptId}`).digest("hex");
}
function fixture(
  options: {
    loseResponse?: boolean;
    list?: unknown;
    alter?: (metadata: {
      id: string;
      labelIds: string[];
      payload: { headers: { name: string; value: string }[] };
    }) => void;
    profile?: string;
  } = {}
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  let rawText = "";
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!url.href.startsWith(`${origin}/`))
      throw Error("unexpected synthetic endpoint");
    calls.push({ url, init: init ?? {} });
    if (url.pathname.endsWith("/profile"))
      return response({ emailAddress: options.profile ?? sender });
    if (url.pathname.endsWith("/messages/send")) {
      const body = JSON.parse(String(init?.body)) as { raw: string };
      rawText = Buffer.from(body.raw, "base64url").toString("utf8");
      if (options.loseResponse)
        throw Error("synthetic private transport detail");
      return response({ id: "a1" });
    }
    if (url.pathname.endsWith("/messages/a1")) {
      const headers = rawText
        .split(/\r?\n/)
        .filter((line) =>
          /^(from|to|subject|message-id|x-zivv-notice):/i.test(line)
        )
        .map((line) => {
          const i = line.indexOf(":");
          return { name: line.slice(0, i), value: line.slice(i + 1).trim() };
        });
      const metadata = { id: "a1", labelIds: ["SENT"], payload: { headers } };
      options.alter?.(metadata);
      return response(metadata);
    }
    if (url.pathname.endsWith("/messages"))
      return response(options.list ?? { messages: [{ id: "a1" }] });
    throw Error("unexpected synthetic endpoint");
  };
  const provider = createFridayGmailNoticeProvider({
    expectedAccountId: sender,
    recipient,
    getAccessToken: async () => "synthetic-token",
    fetcher,
  });
  return { provider, calls, fetcher, text: () => rawText };
}
function headers(text: string) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) =>
        /^(from|to|subject|message-id|x-zivv-notice):/i.test(line)
      )
      .map((line) => {
        const i = line.indexOf(":");
        return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
      })
  );
}

describe("Friday Gmail notice provider", () => {
  it.each(["missing-source", "missed-start"] as const)(
    "sends and verifies a %s notice",
    async (kind) => {
      const n = notice(kind);
      const claim = { notice: n, attemptId };
      const f = fixture();
      const prepared = await f.provider.prepare(n);
      const receipt = await f.provider.send(prepared, claim);
      const h = headers(f.text());
      expect(h.from).toBe(sender);
      expect(h.to).toBe(recipient);
      expect(h.subject).toMatch(/^[\x20-\x7e]+$/);
      expect(h["x-zivv-notice"]).toBe(identity(n));
      expect(h["message-id"]).toBe(
        `<zivv-friday-${identity(n)}@example.invalid>`
      );
      expect(receipt).toEqual({
        key: n.key,
        attemptId,
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(f.calls[0].url.pathname).toBe("/gmail/v1/users/me/profile");
      const metadata = f.calls.find((call) =>
        call.url.pathname.endsWith("/messages/a1")
      );
      expect(metadata?.url.searchParams.get("format")).toBe("metadata");
      const selected =
        metadata?.url.searchParams
          .getAll("metadataHeaders")
          .map((x) => x.toLowerCase()) ?? [];
      expect(selected).toEqual(
        expect.arrayContaining([
          "message-id",
          "x-zivv-notice",
          "from",
          "to",
          "subject",
        ])
      );
      expect(
        f.calls.filter((call) => call.url.pathname.endsWith("/messages/send"))
      ).toHaveLength(1);
    }
  );

  it("reconciles accepted mail after the send response is lost without resending", async () => {
    const n = notice();
    const claim = { notice: n, attemptId };
    const f = fixture({ loseResponse: true });
    const prepared = await f.provider.prepare(n);
    await expect(f.provider.send(prepared, claim)).rejects.toThrow();
    const first = await f.provider.findDelivery(claim);
    const second = await f.provider.findDelivery(claim);
    expect(first).toEqual({
      key: n.key,
      attemptId,
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(second).toEqual(first);
    expect(
      f.calls.filter((call) => call.url.pathname.endsWith("/messages/send"))
    ).toHaveLength(1);
    const search = f.calls.find((call) =>
      call.url.pathname.endsWith("/messages")
    );
    expect(search?.url.searchParams.getAll("labelIds")).toContain("SENT");
    expect(search?.url.searchParams.get("q")).toBe(
      `rfc822msgid:<zivv-friday-${identity(n)}@example.invalid>`
    );
  });

  it("reopens the durable claim and reconciles the real adapter without a second POST", async () => {
    const prefix = "zivv-gmail-notice-synthetic-";
    const root = mkdtempSync(join(tmpdir(), prefix));
    const path = join(root, "outbox.sqlite");
    let db: DatabaseSync | undefined;
    try {
      const f = fixture({ loseResponse: true });
      db = new DatabaseSync(path);
      const outbox = FridayNoticeOutbox.initialize(db);
      const queued = outbox.record({
        editionId: "2026-10-30",
        nowEpochMs: dueAtEpochMs,
        maxEvidenceAgeMs: 0,
        evidence: {
          kind: "mailbox-scan",
          status: "absent",
          scannedThroughEpochMs: dueAtEpochMs,
        },
      })!;
      await expect(
        dispatchFridayNotice(outbox, queued.notice.key, f.provider)
      ).rejects.toThrow("FRIDAY_NOTICE_DELIVERY_UNKNOWN");
      const held = outbox.inspect(queued.notice.key);
      expect(held?.status).toBe("delivery-unknown");
      db.close();
      db = undefined;
      db = new DatabaseSync(path);
      const reopened = new FridayNoticeOutbox(db);
      const adapter = createFridayGmailNoticeProvider({
        expectedAccountId: sender,
        recipient,
        getAccessToken: async () => "synthetic-token-after-restart",
        fetcher: f.fetcher,
      });
      const reconciled = await dispatchFridayNotice(
        reopened,
        queued.notice.key,
        adapter
      );
      expect(reconciled).toMatchObject({
        notice: queued.notice,
        status: "sent",
        attemptId: held?.attemptId,
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(reopened.inspect(queued.notice.key)).toEqual(reconciled);
      expect(
        f.calls.filter((call) => call.init.method === "POST")
      ).toHaveLength(1);
    } finally {
      db?.close();
      if (
        dirname(resolve(root)) !== resolve(tmpdir()) ||
        !basename(root).startsWith(prefix)
      )
        throw Error("UNSAFE_TEST_CLEANUP");
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("returns null for an empty Sent search without sending", async () => {
    const n = notice();
    const f = fixture({ list: { messages: [] } });
    expect(await f.provider.findDelivery({ notice: n, attemptId })).toBeNull();
    expect(
      f.calls.some((call) => call.url.pathname.endsWith("/messages/send"))
    ).toBe(false);
  });

  it.each([
    { messages: [{ id: "a1" }, { id: "b2" }] },
    { messages: [{ id: "a1" }], nextPageToken: "more" },
  ])("rejects an ambiguous Sent search", async (list) => {
    const n = notice();
    const f = fixture({ list });
    await expect(
      f.provider.findDelivery({ notice: n, attemptId })
    ).rejects.toThrow();
    expect(
      f.calls.some((call) => call.url.pathname.endsWith("/messages/send"))
    ).toBe(false);
  });

  it.each(["SENT", "Message-ID", "X-Zivv-Notice", "From", "To", "Subject"])(
    "rejects altered %s metadata",
    async (field) => {
      const n = notice();
      const f = fixture({
        alter: (metadata) => {
          if (field === "SENT") metadata.labelIds = ["INBOX"];
          else {
            const h = metadata.payload.headers.find(
              (entry) => entry.name.toLowerCase() === field.toLowerCase()
            );
            if (h) h.value = "synthetic-mismatch";
          }
        },
      });
      const prepared = await f.provider.prepare(n);
      await expect(
        f.provider.send(prepared, { notice: n, attemptId })
      ).rejects.toThrow();
    }
  );

  it("refuses a mismatched authenticated profile without leaking it", async () => {
    const n = notice();
    const f = fixture({ profile: "private-synthetic@example.invalid" });
    const error = await f.provider.prepare(n).then(
      () => null,
      (failure: unknown) => failure
    );
    expect(error).not.toBeNull();
    expect(String(error)).not.toContain("private-synthetic@example.invalid");
    expect(String(error)).not.toContain(sender);
    expect(
      f.calls.some((call) => call.url.pathname.endsWith("/messages/send"))
    ).toBe(false);
  });
});
