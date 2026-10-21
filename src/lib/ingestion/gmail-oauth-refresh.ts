const tokenEndpoint = "https://oauth2.googleapis.com/token";
const readonlyScope = "https://www.googleapis.com/auth/gmail.readonly";
const maxResponseBytes = 64 * 1024;

export class GmailOAuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "GmailOAuthError";
    this.code = code;
  }
}
function fail(code: string): never {
  throw new GmailOAuthError(code);
}
function secret(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > maximum ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    fail("GMAIL_AUTH_CONFIGURATION_REQUIRED");
  return value;
}
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* Preserve the safe error. */
  }
}
async function tokenResponse(
  response: Response
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await discard(response);
    fail(
      response.status === 429 || response.status >= 500
        ? "GMAIL_AUTH_RETRYABLE_FAILURE"
        : "GMAIL_AUTH_REQUIRED"
    );
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)
  ) {
    await discard(response);
    fail("GMAIL_TOKEN_RESPONSE_INVALID");
  }
  if (!response.body) fail("GMAIL_TOKEN_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxResponseBytes) fail("GMAIL_TOKEN_RESPONSE_INVALID");
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("GMAIL_TOKEN_RESPONSE_INVALID");
    return value as Record<string, unknown>;
  } catch {
    try {
      await reader.cancel();
    } catch {
      /* Preserve the safe error. */
    }
    return fail("GMAIL_TOKEN_RESPONSE_INVALID");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Supply the existing Gmail reader with a bounded, cached refresh-token exchange.
 * Credential provisioning/storage and mailbox identity checking remain separate.
 */
export function createGmailAccessTokenProvider(input: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  persistRefreshToken: (refreshToken: string) => Promise<void>;
  fetcher?: typeof fetch;
}): () => Promise<string> {
  const clientId = secret(input.clientId, 512);
  const clientSecret =
    input.clientSecret === undefined
      ? undefined
      : secret(input.clientSecret, 4096);
  let refreshToken = secret(input.refreshToken, 8192);
  if (typeof input.persistRefreshToken !== "function")
    fail("GMAIL_AUTH_CONFIGURATION_REQUIRED");
  const persistRefreshToken = input.persistRefreshToken;
  const fetcher = input.fetcher ?? fetch;
  let pendingRefreshToken: string | undefined;
  let cached: { token: string; started: number; until: number } | undefined;
  let inFlight: Promise<string> | undefined;
  async function persistPending(): Promise<void> {
    if (!pendingRefreshToken) return;
    try {
      await persistRefreshToken(pendingRefreshToken);
    } catch {
      fail("GMAIL_CREDENTIAL_STORAGE_FAILED");
    }
    refreshToken = pendingRefreshToken;
    pendingRefreshToken = undefined;
  }
  async function acquire(): Promise<string> {
    // A failed save is retried before any cached token or further HTTP is used.
    await persistPending();
    const started = performance.now();
    if (cached && started >= cached.started && started < cached.until)
      return cached.token;
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (clientSecret !== undefined) body.set("client_secret", clientSecret);
    let response: Response;
    try {
      response = await fetcher(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return fail("GMAIL_AUTH_TRANSPORT_FAILED");
    }
    const value = await tokenResponse(response);
    if (
      typeof value.access_token !== "string" ||
      !/^[\x21-\x7e]{1,4096}$/.test(value.access_token) ||
      typeof value.token_type !== "string" ||
      value.token_type.toLowerCase() !== "bearer" ||
      typeof value.expires_in !== "number" ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in < 1 ||
      value.expires_in > 86400
    )
      fail("GMAIL_TOKEN_RESPONSE_INVALID");
    if (
      value.scope !== undefined &&
      (typeof value.scope !== "string" ||
        !value.scope.split(" ").includes(readonlyScope))
    )
      fail("GMAIL_READONLY_SCOPE_REQUIRED");
    if (value.refresh_token !== undefined) {
      if (
        typeof value.refresh_token !== "string" ||
        !/^[\x21-\x7e]{1,8192}$/.test(value.refresh_token)
      )
        fail("GMAIL_TOKEN_RESPONSE_INVALID");
      if (value.refresh_token !== refreshToken)
        pendingRefreshToken = value.refresh_token;
    }
    const lifetime = value.expires_in * 1000;
    cached = {
      token: value.access_token,
      started,
      until: started + lifetime - Math.min(60_000, Math.floor(lifetime / 10)),
    };
    await persistPending();
    if (performance.now() < started || performance.now() >= cached.until)
      fail("GMAIL_TOKEN_EXPIRED_DURING_REFRESH");
    return cached.token;
  }
  return () => {
    if (!inFlight)
      inFlight = acquire().finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
