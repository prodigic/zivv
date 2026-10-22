import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmailAccessTokenProvider } from "../../lib/ingestion/gmail-oauth-refresh.js";
import { readSteveGmailWindow } from "../../lib/ingestion/steve-gmail-acquisition.js";

const scope = "https://www.googleapis.com/auth/gmail.readonly";
const credentials = {
  clientId: "fixture.apps.googleusercontent.com",
  clientSecret: "fixture-client-secret",
  refreshToken: "fixture-refresh-secret",
  persistRefreshToken: vi.fn(async () => {}),
};
function response(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      access_token: "fixture-access-secret",
      token_type: "Bearer",
      expires_in: 3600,
      scope,
      ...overrides,
    })
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bounded Gmail OAuth refresh provider", () => {
  it("encodes credentials only in a fixed-origin POST body and caches the token", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      expect(String(url)).not.toContain(credentials.refreshToken);
      expect(options).toMatchObject({ method: "POST", redirect: "error" });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      const form = new URLSearchParams(String(options?.body));
      expect(Object.fromEntries(form)).toEqual({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      });
      return response();
    });
    const getToken = createGmailAccessTokenProvider({
      ...credentials,
      fetcher,
    });
    expect(await getToken()).toBe("fixture-access-secret");
    expect(await getToken()).toBe("fixture-access-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("shares one in-flight refresh and refreshes before expiry using a monotonic clock", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const fetcher = vi.fn<typeof fetch>(async () => response());
    const getToken = createGmailAccessTokenProvider({
      ...credentials,
      fetcher,
    });
    expect(await Promise.all([getToken(), getToken(), getToken()])).toEqual(
      Array(3).fill("fixture-access-secret")
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(3_540_100);
    await getToken();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("persists rotation before returning access and retries a failed save without another HTTP request", async () => {
    const save = vi
      .fn<(token: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("private storage path"))
      .mockResolvedValue(undefined);
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({ refresh_token: "fixture-rotated-secret" })
    );
    const getToken = createGmailAccessTokenProvider({
      ...credentials,
      fetcher,
      persistRefreshToken: save,
    });
    await expect(getToken()).rejects.toThrow("GMAIL_CREDENTIAL_STORAGE_FAILED");
    expect(await getToken()).toBe("fixture-access-secret");
    expect(save.mock.calls).toEqual([
      ["fixture-rotated-secret"],
      ["fixture-rotated-secret"],
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403, 429, 500])(
    "redacts HTTP %s bodies and does not automatically retry",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ error_description: credentials.refreshToken }),
            { status }
          )
      );
      const getToken = createGmailAccessTokenProvider({
        ...credentials,
        fetcher,
      });
      await expect(getToken()).rejects.toThrow(
        status === 429 || status >= 500
          ? "GMAIL_AUTH_RETRYABLE_FAILURE"
          : "GMAIL_AUTH_REQUIRED"
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    { access_token: "" },
    { token_type: "MAC" },
    { expires_in: "3600" },
    { expires_in: 0 },
    { expires_in: 86401 },
    { refresh_token: "bad\nsecret" },
  ])("refuses malformed token metadata %j", async (invalid) => {
    const getToken = createGmailAccessTokenProvider({
      ...credentials,
      fetcher: async () => response(invalid),
    });
    await expect(getToken()).rejects.toThrow("GMAIL_TOKEN_RESPONSE_INVALID");
  });
  it("refuses an explicitly insufficient grant", async () => {
    const getToken = createGmailAccessTokenProvider({
      ...credentials,
      fetcher: async () => response({ scope: "unrelated" }),
    });
    await expect(getToken()).rejects.toThrow("GMAIL_READONLY_SCOPE_REQUIRED");
  });
  it("bounds streamed response bytes without trusting Content-Length", async () => {
    const getToken = createGmailAccessTokenProvider({
      ...credentials,
      fetcher: async () => new Response("x".repeat(65537)),
    });
    await expect(getToken()).rejects.toThrow("GMAIL_TOKEN_RESPONSE_INVALID");
  });
  it("redacts transport failures and can retry on a later invocation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(credentials.clientSecret))
      .mockImplementation(async () => response());
    const getToken = createGmailAccessTokenProvider({
      ...credentials,
      fetcher,
    });
    await expect(getToken()).rejects.toThrow("GMAIL_AUTH_TRANSPORT_FAILED");
    expect(await getToken()).toBe("fixture-access-secret");
  });
  it("rejects invalid private configuration before HTTP", () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() =>
      createGmailAccessTokenProvider({
        ...credentials,
        refreshToken: "\n",
        fetcher,
      })
    ).toThrow("GMAIL_AUTH_CONFIGURATION_REQUIRED");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("works as the acquisition token callback while the reader still binds the account", async () => {
    const getAccessToken = createGmailAccessTokenProvider({
      ...credentials,
      fetcher: async () => response(),
    });
    const fetcher: typeof fetch = async (url, options) => {
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer fixture-access-secret"
      );
      return new Response(
        JSON.stringify(
          String(url).endsWith("/profile")
            ? { emailAddress: "fixture@example.invalid" }
            : { messages: [] }
        )
      );
    };
    await expect(
      readSteveGmailWindow({
        expectedAccountId: "fixture@example.invalid",
        startEpochMs: 0,
        endEpochMs: 1000,
        getAccessToken,
        fetcher,
      })
    ).resolves.toEqual({ status: "missing", snapshots: [] });
  });
  it("supports desktop credentials without inventing a client secret", async () => {
    const fetcher: typeof fetch = async (_url, options) => {
      expect(
        new URLSearchParams(String(options?.body)).has("client_secret")
      ).toBe(false);
      return response();
    };
    const getToken = createGmailAccessTokenProvider({
      ...credentials,
      clientSecret: undefined,
      fetcher,
    });
    expect(await getToken()).toBe("fixture-access-secret");
  });
  it("uses the durably rotated refresh token on the next exchange", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const tokens: Array<string | null> = [];
    const fetcher: typeof fetch = async (_url, options) => {
      tokens.push(
        new URLSearchParams(String(options?.body)).get("refresh_token")
      );
      return response({ refresh_token: "rotated-fixture" });
    };
    const persistRefreshToken = vi.fn(async () => {});
    const getToken = createGmailAccessTokenProvider({
      ...credentials,
      persistRefreshToken,
      fetcher,
    });
    await getToken();
    clock.mockReturnValue(3_540_100);
    await getToken();
    expect(tokens).toEqual([credentials.refreshToken, "rotated-fixture"]);
    expect(persistRefreshToken).toHaveBeenCalledExactlyOnceWith(
      "rotated-fixture"
    );
  });
  it("refuses a token that already expired during its exchange", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const getToken = createGmailAccessTokenProvider({
      ...credentials,
      fetcher: async () => {
        clock.mockReturnValue(4_000_100);
        return response();
      },
    });
    await expect(getToken()).rejects.toThrow(
      "GMAIL_TOKEN_EXPIRED_DURING_REFRESH"
    );
  });
  it("cancels an oversized declared body and rejects malformed successful JSON", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const oversized = createGmailAccessTokenProvider({
      ...credentials,
      fetcher: async () =>
        new Response(body, { headers: { "Content-Length": "65537" } }),
    });
    await expect(oversized()).rejects.toThrow("GMAIL_TOKEN_RESPONSE_INVALID");
    expect(cancel).toHaveBeenCalledOnce();
    const malformed = createGmailAccessTokenProvider({
      ...credentials,
      fetcher: async () => new Response("not JSON fixture-private-error"),
    });
    await expect(malformed()).rejects.toThrow("GMAIL_TOKEN_RESPONSE_INVALID");
  });
});
