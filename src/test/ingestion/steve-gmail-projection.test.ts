import { describe, expect, it } from "vitest";
import { projectSteveGmailSnapshot } from "../../lib/ingestion/steve-gmail-projection.js";

const observedAtEpochMs = Date.now();
const content = Buffer.from("hello\n", "utf8");
const data = content.toString("base64url");
interface ApiPartFixture {
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size: number; data?: string; attachmentId?: string };
  parts?: ApiPartFixture[];
}

interface SnapshotFixture {
  expectedAccountId: string;
  profile: { emailAddress: string };
  messageId: string;
  rawMessage: { id: string; raw: string };
  fullMessage: {
    id: string;
    internalDate: unknown;
    payload: ApiPartFixture;
  };
  observedAtEpochMs: number;
}

const base = (): SnapshotFixture => ({
  expectedAccountId: "operator@example.com",
  profile: { emailAddress: "Operator@Example.com" },
  messageId: "a1b2",
  rawMessage: {
    id: "a1b2",
    raw: Buffer.from("raw mail").toString("base64url"),
  },
  fullMessage: {
    id: "a1b2",
    internalDate: String(observedAtEpochMs - 1000),
    payload: {
      mimeType: "multipart/alternative",
      body: { size: 0 },
      parts: [
        {
          mimeType: "text/plain",
          headers: [
            { name: "Content-Type", value: "text/plain; charset=utf-8" },
          ],
          body: { size: content.length, data },
        },
      ],
    },
  },
  observedAtEpochMs,
});

describe("projectSteveGmailSnapshot", () => {
  it("maps nested multipart and detached attachment projections without decoding content", () => {
    const input = base();
    const payload = input.fullMessage.payload;
    payload.parts!.push({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "application/pdf",
          filename: "show-list.pdf",
          body: { size: 4096, attachmentId: "opaque-attachment-id" },
        },
      ],
    });
    const result = projectSteveGmailSnapshot(input);
    expect(result.accountId).toBe("Operator@Example.com");
    expect(result.fullMessage.internal_date).toBe(observedAtEpochMs - 1000);
    expect(result.fullMessage.payload.mime_type).toBe("multipart/alternative");
    expect(result.fullMessage.payload.parts?.[0].body).toEqual({
      size: content.length,
      base64_url_content: data,
    });
    expect(result.fullMessage.payload.parts?.[1].parts?.[0]).toEqual({
      mime_type: "application/pdf",
      filename: "show-list.pdf",
      body: { size: 4096 },
    });
    expect(result).not.toBe(input);
    expect(result.fullMessage.payload).not.toBe(payload);
    expect(input.fullMessage.payload.parts?.[0].body).toEqual({
      size: content.length,
      data,
    });
  });

  it.each([
    [
      "profile mismatch",
      (input: ReturnType<typeof base>) => {
        input.profile.emailAddress = "other@example.com";
      },
      "GMAIL_ACCOUNT_MISMATCH",
    ],
    [
      "invalid mailbox",
      (input: ReturnType<typeof base>) => {
        input.profile.emailAddress = "not an email";
      },
      "INVALID_GMAIL_ACCOUNT",
    ],
    [
      "listed id mismatch",
      (input: ReturnType<typeof base>) => {
        input.messageId = "c3";
      },
      "GMAIL_MESSAGE_ID_MISMATCH",
    ],
    [
      "raw id mismatch",
      (input: ReturnType<typeof base>) => {
        input.rawMessage.id = "c3";
      },
      "GMAIL_MESSAGE_ID_MISMATCH",
    ],
    [
      "full id mismatch",
      (input: ReturnType<typeof base>) => {
        input.fullMessage.id = "c3";
      },
      "GMAIL_MESSAGE_ID_MISMATCH",
    ],
    [
      "future internal date",
      (input: ReturnType<typeof base>) => {
        input.fullMessage.internalDate = String(input.observedAtEpochMs + 1);
      },
      "INVALID_GMAIL_RECEIPT_TIME",
    ],
    [
      "invalid observation date",
      (input: ReturnType<typeof base>) => {
        input.observedAtEpochMs = Date.now() + 1000;
      },
      "INVALID_GMAIL_OBSERVATION_TIME",
    ],
    [
      "invalid raw base64url",
      (input: ReturnType<typeof base>) => {
        input.rawMessage.raw = "@@";
      },
      "INVALID_GMAIL_ENCODING",
    ],
    [
      "body size mismatch",
      (input: ReturnType<typeof base>) => {
        input.fullMessage.payload.parts![0].body!.size += 1;
      },
      "GMAIL_BODY_SIZE_MISMATCH",
    ],
    [
      "missing plain text body",
      (input: ReturnType<typeof base>) => {
        delete input.fullMessage.payload.parts![0].body;
      },
      "INCOMPLETE_GMAIL_PROJECTION",
    ],
    [
      "detached plain text",
      (input: ReturnType<typeof base>) => {
        input.fullMessage.payload.parts![0].body = {
          size: content.length,
          attachmentId: "text-part",
        };
      },
      "INCOMPLETE_GMAIL_PROJECTION",
    ],
  ] as const)("rejects %s with a safe code", (_name, mutate, code) => {
    const input = base();
    mutate(input);
    expect(() => projectSteveGmailSnapshot(input)).toThrow(code);
  });

  it("rejects MIME trees beyond the depth bound", () => {
    const input = base();
    const root: ApiPartFixture = {
      mimeType: "application/octet-stream",
    };
    input.fullMessage.payload.parts![0] = root;
    let part = root;
    for (let index = 0; index < 22; index++) {
      const child: ApiPartFixture = { mimeType: "multipart/mixed", parts: [] };
      part.parts = [child];
      part = child;
    }
    expect(() => projectSteveGmailSnapshot(input)).toThrow("GMAIL_PART_LIMIT");
  });

  it("rejects coerced or non-decimal internalDate values", () => {
    for (const malformed of [null, false, "", "1e3", "0x10"]) {
      const input = base();
      input.fullMessage.internalDate = malformed;
      expect(() => projectSteveGmailSnapshot(input)).toThrow(
        "INVALID_GMAIL_RECEIPT_TIME"
      );
    }
  });

  it("rejects control characters in either mailbox identity", () => {
    for (const field of ["expectedAccountId", "profile"] as const) {
      const input = base();
      if (field === "expectedAccountId")
        input.expectedAccountId = "bad\u0000@example.com";
      else input.profile.emailAddress = "bad\u007f@example.com";
      expect(() => projectSteveGmailSnapshot(input)).toThrow(
        "INVALID_GMAIL_ACCOUNT"
      );
    }
  });

  it("requires an explicit empty data string for a zero-byte plain-text part", () => {
    const input = base();
    input.fullMessage.payload.parts![0].body = { size: 0 };
    expect(() => projectSteveGmailSnapshot(input)).toThrow(
      "INCOMPLETE_GMAIL_PROJECTION"
    );
    input.fullMessage.payload.parts![0].body = { size: 0, data: "" };
    expect(
      projectSteveGmailSnapshot(input).fullMessage.payload.parts?.[0].body
    ).toEqual({ size: 0, base64_url_content: "" });
  });

  it("bounds aggregate metadata bytes before retaining projected strings", () => {
    const input = base();
    const sharedHeaderValue = "x".repeat(16 * 1024);
    const parts: ApiPartFixture[] = [];
    for (let index = 0; index < 5; index++) {
      const part: ApiPartFixture = { mimeType: "application/json" };
      part.headers = Array.from({ length: 256 }, () => ({
        name: "X-Meta",
        value: sharedHeaderValue,
      }));
      parts.push(part);
    }
    input.fullMessage.payload.parts = parts;
    expect(() => projectSteveGmailSnapshot(input)).toThrow("GMAIL_PART_LIMIT");
  });
});
