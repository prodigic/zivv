import { describe, expect, it } from "vitest";
import { readSteveGmailWindow } from "../../lib/ingestion/steve-gmail-acquisition.js";

const origin = "https://gmail.googleapis.com/gmail/v1/users/me";
const startEpochMs = 10_000;
const endEpochMs = 20_000;
const raw = Buffer.from("raw fixture").toString("base64url");
const bodyData = Buffer.from("newsletter").toString("base64url");

function profile(emailAddress = "operator@example.com") {
  return { emailAddress, messagesTotal: 2, threadsTotal: 2, historyId: "11" };
}

function message(id: string, internalDate: number) {
  return {
    id,
    internalDate: String(internalDate),
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: "skoepke@stevelist.com" }],
      body: { size: Buffer.from("newsletter").length, data: bodyData },
    },
  };
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function fixtureFetcher(options: {
  pages?: unknown[];
  messages?: Record<string, { full: unknown; raw: unknown }>;
  profileBefore?: unknown;
  profileAfter?: unknown;
  errorAt?: string;
  errorStatus?: number;
}) {
  const requests: { url: string; init: RequestInit }[] = [];
  let listCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init: init ?? {} });
    if (init?.redirect !== "error") throw new Error("redirect policy absent");
    if (url === `${origin}/profile`)
      return jsonResponse(
        requests.filter((request) => request.url === `${origin}/profile`)
          .length === 1
          ? (options.profileBefore ?? profile())
          : (options.profileAfter ?? profile())
      );
    const parsed = new URL(url);
    if (parsed.pathname === "/gmail/v1/users/me/messages") {
      if (options.errorAt === "list")
        return jsonResponse({}, options.errorStatus ?? 500);
      const pageIndex = listCalls++;
      return jsonResponse(options.pages?.[pageIndex] ?? { messages: [] });
    }
    const match = /\/messages\/([a-f0-9]+)$/.exec(parsed.pathname);
    if (!match) return jsonResponse({}, 404);
    if (options.errorAt === `get-${parsed.searchParams.get("format")}`)
      return jsonResponse({}, options.errorStatus ?? 500);
    const stored = options.messages?.[match[1]];
    return jsonResponse(
      parsed.searchParams.get("format") === "RAW"
        ? (stored?.raw ?? { id: match[1], raw })
        : (stored?.full ?? message(match[1], 15_000))
    );
  };
  return { fetcher, requests };
}

function input(fetcher: typeof fetch) {
  return {
    expectedAccountId: "Operator@example.com",
    startEpochMs,
    endEpochMs,
    getAccessToken: async () => "synthetic-token-123",
    fetcher,
  };
}

describe("readSteveGmailWindow", () => {
  it("paginates, deduplicates, filters exact bounds, sorts, and reuses one bearer token", async () => {
    const { fetcher, requests } = fixtureFetcher({
      pages: [
        {
          messages: [{ id: "b2" }, { id: "a1" }],
          nextPageToken: "page-two",
          resultSizeEstimate: 0,
        },
        { messages: [{ id: "a1" }, { id: "c3" }] },
      ],
      messages: {
        a1: { full: message("a1", startEpochMs), raw: { id: "a1", raw } },
        b2: { full: message("b2", endEpochMs), raw: { id: "b2", raw } },
        c3: { full: message("c3", startEpochMs + 1), raw: { id: "c3", raw } },
      },
    });
    let tokenCalls = 0;
    const result = await readSteveGmailWindow({
      ...input(fetcher),
      getAccessToken: async () => {
        tokenCalls++;
        return "synthetic-token-123";
      },
    });
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected snapshots");
    expect(result.snapshots.map((snapshot) => snapshot.rawMessage.id)).toEqual([
      "a1",
      "c3",
    ]);
    expect(tokenCalls).toBe(1);
    const listUrls = requests.filter((request) =>
      request.url.includes("/messages?")
    );
    expect(listUrls).toHaveLength(2);
    for (const request of listUrls) {
      const url = new URL(request.url);
      expect(url.searchParams.get("q")).toBe(
        "from:skoepke@stevelist.com after:9 before:20"
      );
      expect(url.searchParams.get("maxResults")).toBe("100");
    }
    expect(new URL(listUrls[1].url).searchParams.get("pageToken")).toBe(
      "page-two"
    );
    expect(
      requests.every(
        (request) =>
          new Headers(request.init.headers).get("authorization") ===
          "Bearer synthetic-token-123"
      )
    ).toBe(true);
  });

  it("stops after a mismatched profile and before listing", async () => {
    const { fetcher, requests } = fixtureFetcher({
      profileBefore: profile("different@example.com"),
    });
    await expect(readSteveGmailWindow(input(fetcher))).rejects.toThrow(
      "GMAIL_ACCOUNT_MISMATCH"
    );
    expect(requests).toHaveLength(1);
  });

  it.each(["full", "raw"] as const)(
    "returns no partial result on %s ID mismatch",
    async (kind) => {
      const valid = message("a1", 15_000);
      const wrong = kind === "full" ? message("c3", 15_000) : { id: "c3", raw };
      const { fetcher } = fixtureFetcher({
        pages: [{ messages: [{ id: "a1" }, { id: "b2" }] }],
        messages: {
          a1: { full: valid, raw: { id: "a1", raw } },
          b2:
            kind === "full"
              ? { full: wrong, raw: { id: "b2", raw } }
              : { full: message("b2", 15_000), raw: wrong },
        },
      });
      await expect(readSteveGmailWindow(input(fetcher))).rejects.toThrow(
        "GMAIL_MESSAGE_ID_MISMATCH"
      );
    }
  );

  it("rejects repeated page tokens", async () => {
    const { fetcher } = fixtureFetcher({
      pages: [
        { messages: [], nextPageToken: "loop" },
        { messages: [], nextPageToken: "loop" },
      ],
    });
    await expect(readSteveGmailWindow(input(fetcher))).rejects.toThrow(
      "GMAIL_PAGINATION_CYCLE"
    );
  });

  it("rejects more than one hundred unique IDs", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => ({
      id: index.toString(16),
    }));
    const { fetcher } = fixtureFetcher({
      pages: [
        { messages: ids, nextPageToken: "next" },
        { messages: [{ id: "ff" }] },
      ],
    });
    await expect(readSteveGmailWindow(input(fetcher))).rejects.toThrow(
      "GMAIL_WINDOW_LIMIT"
    );
  });

  it("does not return earlier snapshots when a later fetch fails", async () => {
    const { fetcher } = fixtureFetcher({
      pages: [{ messages: [{ id: "a1" }, { id: "b2" }] }],
      errorAt: "get-RAW",
      errorStatus: 503,
    });
    await expect(readSteveGmailWindow(input(fetcher))).rejects.toThrow(
      "GMAIL_RETRYABLE_FAILURE"
    );
  });

  it.each([
    ["malformed JSON", new Response("{", { status: 200 })],
    [
      "truncated body",
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            controller.error(new Error("cut"));
          },
        })
      ),
    ],
    [
      "oversized declared body",
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(24 * 1024 * 1024 + 1) },
      }),
    ],
    ["server failure", jsonResponse({}, 503)],
    ["authorization failure", jsonResponse({}, 401)],
  ] as const)(
    "maps %s to a safe error without returning partial snapshots",
    async (_name, response) => {
      const failingFetcher: typeof fetch = async (url, _init) =>
        String(url) === `${origin}/profile`
          ? jsonResponse(profile())
          : response;
      await expect(readSteveGmailWindow(input(failingFetcher))).rejects.toThrow(
        /^[A-Z_]+$/
      );
    }
  );

  it("enforces streamed response limits even when content-length is understated", async () => {
    const oversizedBody = new Uint8Array(24 * 1024 * 1024 + 1);
    const oversizedResponse = new Response(oversizedBody, {
      status: 200,
      headers: { "content-length": "1" },
    });
    const fetcher: typeof fetch = async (url) =>
      String(url) === `${origin}/profile`
        ? jsonResponse(profile())
        : oversizedResponse;
    await expect(readSteveGmailWindow(input(fetcher))).rejects.toThrow(
      "GMAIL_RESPONSE_TOO_LARGE"
    );
  });

  it("returns missing only after an empty complete search and second profile check", async () => {
    const { fetcher, requests } = fixtureFetcher({ pages: [{ messages: [] }] });
    await expect(readSteveGmailWindow(input(fetcher))).resolves.toEqual({
      status: "missing",
      snapshots: [],
    });
    expect(
      requests.filter((request) => request.url.endsWith("/profile"))
    ).toHaveLength(2);
  });

  it("rejects an explicit null messages page instead of treating it as empty", async () => {
    const { fetcher } = fixtureFetcher({ pages: [{ messages: null }] });
    await expect(readSteveGmailWindow(input(fetcher))).rejects.toThrow(
      "GMAIL_RESPONSE_INVALID"
    );
  });

  it.each([
    [503, {}, "GMAIL_RETRYABLE_FAILURE"],
    [
      200,
      { "content-length": String(24 * 1024 * 1024 + 1) },
      "GMAIL_RESPONSE_TOO_LARGE",
    ],
  ] as const)(
    "cancels an unread response body on early status/size failure",
    async (status, headers, code) => {
      let canceled = 0;
      const response = new Response(
        new ReadableStream({
          cancel() {
            canceled++;
          },
        }),
        { status, headers }
      );
      const fetcher: typeof fetch = async (url) =>
        String(url) === `${origin}/profile`
          ? jsonResponse(profile())
          : response;
      await expect(readSteveGmailWindow(input(fetcher))).rejects.toThrow(code);
      expect(canceled).toBe(1);
    }
  );
});
