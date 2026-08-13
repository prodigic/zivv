/**
 * Browser request boundary for the privacy charter.
 *
 * Normal application data loads are same-origin, static, read-only requests.
 * User actions, search terms, cache contents, and diagnostics must never be
 * sent through an application-level request.
 */

const READ_METHODS = new Set(["GET", "HEAD"]);

export class PrivacyRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyRequestError";
  }
}

function getApplicationOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}

/**
 * Create an allowlisted request for a static application asset.
 *
 * Relative URLs are preferred. Absolute URLs are accepted only when they
 * resolve to the current application origin.
 */
export function createStaticReadRequest(
  input: string | URL,
  init: RequestInit = {},
): Request {
  const origin = getApplicationOrigin();
  const url = new URL(input.toString(), origin);
  const method = (init.method ?? "GET").toUpperCase();

  if (url.origin !== origin) {
    throw new PrivacyRequestError("Zivv data requests must remain same-origin");
  }

  if (!READ_METHODS.has(method)) {
    throw new PrivacyRequestError("Zivv data requests must be read-only");
  }

  if (init.body !== undefined && init.body !== null) {
    throw new PrivacyRequestError("Zivv data requests cannot upload a request body");
  }

  return new Request(url, {
    ...init,
    method,
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
  });
}

export const privacyRequestPolicy = {
  allowedMethods: ["GET", "HEAD"] as const,
  referrerPolicy: "no-referrer" as const,
};
