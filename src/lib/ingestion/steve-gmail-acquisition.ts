import {
  assertSteveGmailAccount,
  projectSteveGmailSnapshot,
  type SteveGmailSnapshot,
} from "./steve-gmail-projection.js";

const apiRoot = "https://gmail.googleapis.com/gmail/v1/users/me";
const sender = "skoepke@stevelist.com";
const maxResponseBytes = 24 * 1024 * 1024;
const maxSnapshotsBytes = 32 * 1024 * 1024;
const maxPages = 10;
const maxMessageIds = 100;

export interface SteveGmailWindow {
  expectedAccountId: string;
  startEpochMs: number;
  endEpochMs: number;
  getAccessToken: () => Promise<string>;
  fetcher?: typeof fetch;
}

export type SteveGmailWindowResult =
  | { status: "missing"; snapshots: [] }
  | { status: "found"; snapshots: SteveGmailSnapshot[] };

function fail(code: string): never {
  throw new Error(code);
}

function validToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    return fail("GMAIL_AUTH_REQUIRED");
  return value;
}

function statusCode(status: number): string {
  if (status === 401 || status === 403) return "GMAIL_AUTH_REQUIRED";
  if (status === 429 || status >= 500) return "GMAIL_RETRYABLE_FAILURE";
  return "GMAIL_REQUEST_FAILED";
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup is best-effort; preserve the original safe failure code.
  }
}

async function readJson(
  fetcher: typeof fetch,
  url: string,
  token: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return fail("GMAIL_TRANSPORT_FAILED");
  }
  if (!response.ok) {
    await discardBody(response);
    return fail(statusCode(response.status));
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)
  ) {
    await discardBody(response);
    return fail("GMAIL_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return fail("GMAIL_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxResponseBytes) {
        tooLarge = true;
        await reader.cancel();
        break;
      }
      chunks.push(next.value);
    }
  } catch {
    if (!tooLarge) return fail("GMAIL_RESPONSE_INVALID");
  }
  if (tooLarge) return fail("GMAIL_RESPONSE_TOO_LARGE");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("GMAIL_RESPONSE_INVALID");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("GMAIL_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function pageToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    return fail("GMAIL_RESPONSE_INVALID");
  return value;
}

function listedMessageIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100)
    return fail("GMAIL_RESPONSE_INVALID");
  const ids: string[] = [];
  for (const item of value) {
    const id = object(item).id;
    if (typeof id !== "string" || !/^[a-f0-9]{1,128}$/.test(id))
      return fail("GMAIL_RESPONSE_INVALID");
    ids.push(id);
  }
  return ids;
}

function validateWindow(start: number, end: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start
  )
    fail("INVALID_GMAIL_WINDOW");
}

/** Read one bounded Gmail window; this performs no local writes or mutations. */
export async function readSteveGmailWindow(
  input: SteveGmailWindow
): Promise<SteveGmailWindowResult> {
  validateWindow(input.startEpochMs, input.endEpochMs);
  let token: string;
  try {
    token = validToken(await input.getAccessToken());
  } catch {
    return fail("GMAIL_AUTH_REQUIRED");
  }
  const fetcher = input.fetcher ?? fetch;
  const profileBefore = await readJson(fetcher, `${apiRoot}/profile`, token);
  const accountId = assertSteveGmailAccount(
    input.expectedAccountId,
    profileBefore
  );
  const afterSeconds = Math.floor(input.startEpochMs / 1000) - 1;
  const beforeSeconds = Math.ceil(input.endEpochMs / 1000);
  const query = `from:${sender} after:${afterSeconds} before:${beforeSeconds}`;
  const ids = new Set<string>();
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ q: query, maxResults: "100" });
    if (nextToken) params.set("pageToken", nextToken);
    const listed = object(
      await readJson(fetcher, `${apiRoot}/messages?${params.toString()}`, token)
    );
    for (const id of listedMessageIds(
      listed.messages === undefined ? [] : listed.messages
    )) {
      ids.add(id);
      if (ids.size > maxMessageIds) return fail("GMAIL_WINDOW_LIMIT");
    }
    if (listed.nextPageToken === undefined) {
      nextToken = undefined;
      break;
    }
    nextToken = pageToken(listed.nextPageToken);
    if (seenTokens.has(nextToken)) return fail("GMAIL_PAGINATION_CYCLE");
    seenTokens.add(nextToken);
    if (page === maxPages - 1) return fail("GMAIL_WINDOW_LIMIT");
  }
  const snapshots: SteveGmailSnapshot[] = [];
  let snapshotBytes = 0;
  const orderedIds = [...ids].sort();
  for (const id of orderedIds) {
    const encodedId = encodeURIComponent(id);
    const fullMessage = await readJson(
      fetcher,
      `${apiRoot}/messages/${encodedId}?format=FULL`,
      token
    );
    const rawMessage = await readJson(
      fetcher,
      `${apiRoot}/messages/${encodedId}?format=RAW`,
      token
    );
    const snapshot = projectSteveGmailSnapshot({
      expectedAccountId: accountId,
      profile: profileBefore,
      messageId: id,
      fullMessage,
      rawMessage,
      observedAtEpochMs: Date.now(),
    });
    if (
      snapshot.fullMessage.internal_date < input.startEpochMs ||
      snapshot.fullMessage.internal_date >= input.endEpochMs
    )
      continue;
    snapshotBytes += Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (snapshotBytes > maxSnapshotsBytes) return fail("GMAIL_WINDOW_LIMIT");
    snapshots.push(snapshot);
  }
  const profileAfter = await readJson(fetcher, `${apiRoot}/profile`, token);
  assertSteveGmailAccount(input.expectedAccountId, profileAfter);
  snapshots.sort(
    (left, right) =>
      left.fullMessage.internal_date - right.fullMessage.internal_date ||
      left.rawMessage.id.localeCompare(right.rawMessage.id)
  );
  return snapshots.length
    ? { status: "found", snapshots }
    : { status: "missing", snapshots: [] };
}
