import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./persistence.js";
import type { FetchedText, VenueSource } from "./venue-types.js";

interface CacheEntry {
  schemaVersion: 1;
  url: string;
  text: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
  checkedAt: string;
}

export interface FetchObservation {
  url: string;
  status: number;
  bytes: number;
  fromCache: boolean;
  contentHash: string;
  error?: string;
}

const SECRET_PARAMETERS = /^(apikey|api_key|access_token|token|key)$/i;
const REDACTED_CREDENTIAL = "REDACTED";
export function publicFetchUrl(input: string): string {
  const url = new URL(input);
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_PARAMETERS.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function replaceCredentialVariants(
  text: string,
  variants: readonly string[]
): string {
  let result = text;
  for (const variant of variants) {
    if (variant) result = result.split(variant).join(REDACTED_CREDENTIAL);
  }
  return result;
}

function jsonUnicodeEscape(value: string, uppercase: boolean): string {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index).toString(16).padStart(4, "0");
    escaped += `\\u${uppercase ? code.toUpperCase() : code}`;
  }
  return escaped;
}

function credentialVariants(value: string): string[] {
  const formEncoded = new URLSearchParams([["credential", value]])
    .toString()
    .slice("credential=".length);
  const encoded = encodeURIComponent(value);
  const encodedLowerHex = encoded.replace(/%[0-9A-F]{2}/g, (match) =>
    match.toLowerCase()
  );
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  const jsonEscapedSlash = jsonEscaped.replaceAll("/", "\\/");
  return [
    value,
    encoded,
    encodedLowerHex,
    formEncoded,
    jsonEscaped,
    jsonEscapedSlash,
    jsonUnicodeEscape(value, false),
    jsonUnicodeEscape(value, true),
  ]
    .filter((variant) => variant.length > 0)
    .sort((left, right) => right.length - left.length)
    .filter((variant, index, variants) => variants.indexOf(variant) === index);
}

function redactJsonValue(value: unknown, variants: readonly string[]): unknown {
  if (typeof value === "string")
    return replaceCredentialVariants(value, variants);
  if (Array.isArray(value))
    return value.map((item) => redactJsonValue(item, variants));
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const redactedKey = replaceCredentialVariants(key, variants);
    result[redactedKey] = redactJsonValue(item, variants);
  }
  return result;
}

/** Remove credentials echoed in raw, URL-encoded, or JSON-escaped response data. */
function redactCredentialEchoes(input: string, text: string): string {
  const secrets = [...new URL(input).searchParams.entries()]
    .filter(([key, value]) => SECRET_PARAMETERS.test(key) && value.length > 0)
    .map(([, value]) => value);
  if (secrets.length === 0) return text;
  const variants = [
    ...new Set(secrets.flatMap((secret) => credentialVariants(secret))),
  ];
  // A valid JSON body can contain a mixed escape style (for example a raw
  // slash beside a \u002F sequence), and it can contain several echoes with
  // different encodings. Parse it first so every decoded string and key gets
  // scrubbed before serializing valid JSON again.
  try {
    const parsed = JSON.parse(text) as unknown;
    const redacted = redactJsonValue(parsed, variants);
    const serialized = JSON.stringify(redacted);
    return typeof serialized === "string" ? serialized : text;
  } catch {
    // Non-JSON feeds still receive the direct replacement for each supported
    // encoding while their original representation is preserved.
    return replaceCredentialVariants(text, variants);
  }
}

/** Bounded, conditional HTTP retrieval. Failed responses never replace good cache. */
export function createVenueFetcher(
  root: string,
  source: VenueSource,
  options: {
    offline?: boolean;
    fetch?: typeof globalThis.fetch;
    maxRequests?: number;
    maxBytes?: number;
    timeoutMs?: number;
    delayMs?: number;
  } = {}
) {
  const cacheDirectory = join(root, ".cache/venue-fetch");
  mkdirSync(cacheDirectory, { recursive: true });
  const allowedHosts = new Set(
    [
      source.website,
      source.calendarUrl,
      ...(source.feedUrls ?? []),
      ...(source.ticketHosts ?? []).map((host) => `https://${host}`),
      ...(source.sourceId === "fillmore-sf"
        ? ["https://app.ticketmaster.com"]
        : []),
    ].map((url) => new URL(url).hostname)
  );
  const observations: FetchObservation[] = [];
  let requestCount = 0;
  let lastRequestAt = 0;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const validateUrl = (url: URL) => {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !allowedHosts.has(url.hostname)
    )
      throw new Error(`Unapproved venue URL: ${publicFetchUrl(url.href)}`);
  };
  const fetchUnqueued = async (input: string): Promise<FetchedText> => {
    let requestUrl = new URL(input);
    validateUrl(requestUrl);
    const safeUrl = publicFetchUrl(input);
    const path = join(
      cacheDirectory,
      `${createHash("sha256").update(safeUrl).digest("hex")}.json`
    );
    let cached: CacheEntry | null = null;
    if (existsSync(path)) {
      const value: CacheEntry = JSON.parse(readFileSync(path, "utf8"));
      if (
        value.schemaVersion !== 1 ||
        value.url !== safeUrl ||
        typeof value.text !== "string" ||
        createHash("sha256").update(value.text).digest("hex") !==
          value.contentHash
      )
        throw new Error(`Corrupt venue cache: ${safeUrl}`);
      cached = value;
    }
    if (options.offline) {
      if (!cached) throw new Error(`No cached response for ${safeUrl}`);
      observations.push({
        url: safeUrl,
        status: 0,
        bytes: 0,
        fromCache: true,
        contentHash: cached.contentHash,
      });
      return {
        url: safeUrl,
        text: cached.text,
        status: 0,
        fromCache: true,
        contentHash: cached.contentHash,
      };
    }
    for (let redirect = 0; redirect <= 5; redirect++) {
      if (++requestCount > (options.maxRequests ?? 40))
        throw new Error(`Request budget exceeded for ${source.sourceId}`);
      const wait = (options.delayMs ?? 250) - (Date.now() - lastRequestAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      const headers: Record<string, string> = {
        "User-Agent": "ZivvVenuePilot/1.0",
        Accept:
          "text/html, application/rss+xml, application/json, application/xml;q=0.9",
      };
      if (
        redirect === 0 &&
        cached?.etag &&
        !(
          source.conditionalValidator === "last-modified" && cached.lastModified
        )
      )
        headers["If-None-Match"] = cached.etag;
      if (redirect === 0 && cached?.lastModified)
        headers["If-Modified-Since"] = cached.lastModified;
      let response: Response;
      try {
        response = await fetchImplementation(requestUrl, {
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
        });
      } catch {
        observations.push({
          url: safeUrl,
          status: 0,
          bytes: 0,
          fromCache: false,
          contentHash: "",
          error: "fetch-failed-or-timeout",
        });
        throw new Error(`Venue fetch failed or timed out: ${safeUrl}`);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect without location: ${safeUrl}`);
        requestUrl = new URL(location, requestUrl);
        validateUrl(requestUrl);
        continue;
      }
      if (response.status === 304) {
        if (!cached) throw new Error(`304 without cached body: ${safeUrl}`);
        observations.push({
          url: safeUrl,
          status: 304,
          bytes: 0,
          fromCache: true,
          contentHash: cached.contentHash,
        });
        writeJsonAtomic(path, {
          ...cached,
          checkedAt: new Date().toISOString(),
        });
        return {
          url: safeUrl,
          text: cached.text,
          status: 304,
          fromCache: true,
          contentHash: cached.contentHash,
        };
      }
      if (!response.ok) {
        observations.push({
          url: safeUrl,
          status: response.status,
          bytes: 0,
          fromCache: false,
          contentHash: "",
          error: "http-error",
        });
        throw new Error(`HTTP ${response.status} from ${safeUrl}`);
      }
      const maximum = options.maxBytes ?? 5_000_000;
      const declared = Number(response.headers.get("content-length"));
      if (declared > maximum)
        throw new Error(`Venue response exceeds byte limit: ${safeUrl}`);
      const parts: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`Empty response body: ${safeUrl}`);
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maximum) {
          await reader.cancel();
          throw new Error(`Venue response exceeds byte limit: ${safeUrl}`);
        }
        parts.push(part.value);
      }
      const buffer = Buffer.concat(parts);
      const probe = buffer.subarray(0, 2048).toString("ascii");
      const charset =
        response.headers
          .get("content-type")
          ?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ??
        probe.match(/(?:charset|encoding)\s*=\s*["']?([^\s;"'<>]+)/i)?.[1] ??
        "utf-8";
      let text: string;
      try {
        text = new TextDecoder(charset).decode(buffer);
      } catch {
        throw new Error(`Unsupported source encoding ${charset}: ${safeUrl}`);
      }
      // Public API paging links sometimes echo credentials; never persist them.
      text = redactCredentialEchoes(input, text);
      const contentHash = createHash("sha256").update(text).digest("hex");
      const entry: CacheEntry = {
        schemaVersion: 1,
        url: safeUrl,
        text,
        contentHash,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        checkedAt: new Date().toISOString(),
      };
      writeJsonAtomic(path, entry);
      observations.push({
        url: safeUrl,
        status: response.status,
        bytes,
        fromCache: false,
        contentHash,
      });
      return {
        url: safeUrl,
        text,
        status: response.status,
        fromCache: false,
        contentHash,
      };
    }
    throw new Error(`Redirect limit exceeded: ${safeUrl}`);
  };
  let queue: Promise<unknown> = Promise.resolve();
  const fetchText = (url: string): Promise<FetchedText> => {
    const request = queue.then(() => fetchUnqueued(url));
    queue = request.catch(() => undefined);
    return request;
  };
  return { fetchText, observations };
}
