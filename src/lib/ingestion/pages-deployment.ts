import { PROMOTION_DESTINATIONS } from "./promotion-control.js";

const REPOSITORY = "prodigic/zivv";
const API = "https://api.github.com";
const MAX_BODY_BYTES = 65_536;

/** Safe durable ownership; credentials belong only in the transient HTTP request. */
export interface PagesDeploymentOwner {
  operationId: string;
  requestId: string;
  attemptId: string;
  runId: string;
  runAttempt: number;
}
export interface PagesDeploymentIntent {
  repository: "prodigic/zivv";
  artifactId: string;
  workflowCommit: string;
  owner: PagesDeploymentOwner;
}
export interface PagesDeploymentReceipt extends PagesDeploymentIntent {
  deploymentId: string;
  pageUrl: string;
}
/** Only loopback HTTP may replace the closed production API in transport tests. */
export interface PagesTestTransport {
  kind: "local-test";
  apiBaseUrl: string;
  fetch?: typeof fetch;
}
interface TransportOptions {
  githubToken: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  testTransport?: PagesTestTransport;
}
export interface PagesApiDiagnostic {
  httpStatus: number;
  responseBody: unknown;
}
export type PagesDeploymentCreateResult =
  | { status: "created"; receipt: PagesDeploymentReceipt }
  | {
      status: "rejected";
      intent: PagesDeploymentIntent;
      diagnostic: PagesApiDiagnostic;
    }
  | {
      status: "uncertain";
      intent: PagesDeploymentIntent;
      receipt?: PagesDeploymentReceipt;
      reason: "transport" | "api" | "response" | "receipt-persistence";
      diagnostic?: PagesApiDiagnostic;
    };
export type PagesDeploymentStatusResult = {
  receipt: PagesDeploymentReceipt;
  classification: "in-progress" | "succeeded" | "failed" | "uncertain";
  apiStatus: string | null;
  diagnostic?: PagesApiDiagnostic;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Pages response object");
  return value as Record<string, unknown>;
}
function decimal(value: string): boolean {
  return /^[1-9][0-9]{0,19}$/.test(value);
}
/** Pages documents SHA IDs; numeric and UUID IDs are also preserved verbatim. */
export function normalizePagesDeploymentId(value: unknown): string {
  const id =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  if (
    !decimal(id) &&
    !/^[a-f0-9]{40}$/.test(id) &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  )
    throw new Error("Invalid Pages deployment identity");
  return id;
}
function safePageUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Pages destination");
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname !== "www.prodigic.com" ||
    url.port ||
    url.pathname.replace(/\/$/, "") !== "/zivv"
  )
    throw new Error("Invalid Pages destination");
  return PROMOTION_DESTINATIONS.production.liveUrl;
}
function intent(input: PagesDeploymentIntent): PagesDeploymentIntent {
  const owner = input.owner;
  if (
    input.repository !== REPOSITORY ||
    !/^[a-f0-9]{40}$/.test(input.workflowCommit) ||
    !decimal(input.artifactId) ||
    !Number.isSafeInteger(Number(input.artifactId)) ||
    !owner ||
    ![owner.operationId, owner.attemptId].every((id) =>
      /^[a-f0-9]{64}$/.test(id)
    ) ||
    typeof owner.requestId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(owner.requestId) ||
    !decimal(owner.runId) ||
    !Number.isSafeInteger(owner.runAttempt) ||
    owner.runAttempt < 1
  )
    throw new Error("Invalid Pages deployment authority");
  return Object.freeze({
    repository: REPOSITORY,
    artifactId: input.artifactId,
    workflowCommit: input.workflowCommit,
    owner: Object.freeze({
      operationId: owner.operationId,
      requestId: owner.requestId,
      attemptId: owner.attemptId,
      runId: owner.runId,
      runAttempt: owner.runAttempt,
    }),
  });
}
function receipt(input: PagesDeploymentReceipt): PagesDeploymentReceipt {
  return Object.freeze({
    ...intent(input),
    deploymentId: normalizePagesDeploymentId(input.deploymentId),
    pageUrl: safePageUrl(input.pageUrl),
  });
}

/** Canonical public-safe receipt boundary for durable checkpoint readers. */
export function parsePagesDeploymentReceipt(
  value: unknown
): PagesDeploymentReceipt {
  const fields = record(value);
  if (
    Object.keys(fields).sort().join(",") !==
    "artifactId,deploymentId,owner,pageUrl,repository,workflowCommit"
  )
    throw new Error("Invalid Pages receipt fields");
  const owner = record(fields.owner);
  if (
    Object.keys(owner).sort().join(",") !==
      "attemptId,operationId,requestId,runAttempt,runId" ||
    ![
      fields.artifactId,
      fields.deploymentId,
      fields.pageUrl,
      fields.workflowCommit,
      owner.operationId,
      owner.requestId,
      owner.attemptId,
      owner.runId,
    ].every((entry) => typeof entry === "string") ||
    fields.repository !== REPOSITORY ||
    typeof owner.runAttempt !== "number"
  )
    throw new Error("Invalid Pages receipt identity");
  return receipt(fields as unknown as PagesDeploymentReceipt);
}
function validateOidc(token: string, expected: PagesDeploymentIntent): void {
  try {
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)) ||
      token.length > 32_768
    )
      throw new Error();
    const claims = record(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    );
    if (
      claims.iss !== "https://token.actions.githubusercontent.com" ||
      claims.repository !== expected.repository ||
      claims.sha !== expected.workflowCommit ||
      claims.ref !== `refs/tags/zivv-workflows/${expected.workflowCommit}` ||
      claims.environment !== "github-pages" ||
      claims.run_id !== expected.owner.runId ||
      claims.run_attempt !== String(expected.owner.runAttempt) ||
      typeof claims.exp !== "number" ||
      claims.exp <= Date.now() / 1000
    )
      throw new Error();
  } catch {
    throw new Error("OIDC claims do not match the admitted Pages run");
  }
  // Local claims are a consistency check. GitHub verifies the JWT signature and policy.
}
function transport(options: TransportOptions, deferDeadline = false) {
  if (
    typeof options.githubToken !== "string" ||
    !options.githubToken ||
    !/^[A-Za-z0-9_-]+$/.test(options.githubToken)
  )
    throw new Error("A Pages GitHub credential is required");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("Invalid bounded Pages timeout");
  let base = API;
  let request = fetch;
  if (options.testTransport) {
    const url = new URL(options.testTransport.apiBaseUrl);
    if (
      options.testTransport.kind !== "local-test" ||
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Pages test transport must use a loopback HTTP origin");
    base = url.origin;
    request = options.testTransport.fetch ?? fetch;
  }
  const manualSignal = options.signal;
  let signal = manualSignal ?? new AbortController().signal;
  const startRequest = () => {
    const deadline = AbortSignal.timeout(timeoutMs);
    signal = manualSignal
      ? AbortSignal.any([deadline, manualSignal])
      : deadline;
  };
  if (!deferDeadline) startRequest();
  return {
    base,
    request,
    get signal() {
      return signal;
    },
    startRequest,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  };
}
function redact(value: string, secrets: string[]): string {
  let safe = value;
  for (const secret of secrets)
    if (secret) safe = safe.split(secret).join("[redacted]");
  return safe
    .replace(
      /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[redacted-jwt]"
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
      "[redacted-token]"
    );
}
async function body(response: Response, secrets: string[]): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Pages response exceeds bounded size");
    }
    chunks.push(part.value);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    // Normalize JSON escapes before redaction so an escaped credential cannot reappear.
    return JSON.parse(
      redact(JSON.stringify(JSON.parse(raw)), secrets)
    ) as unknown;
  } catch {
    return redact(raw, secrets);
  }
}

/**
 * Persist intent before the single POST, then persist its returned identity before polling.
 * A lost response has no documented idempotency/list recovery: retain ownership and stop.
 */
export async function requestGithubPagesDeployment(
  input: PagesDeploymentIntent &
    TransportOptions & {
      oidcToken: string;
      onIntent: (intent: PagesDeploymentIntent) => Promise<void>;
      onCreated: (receipt: PagesDeploymentReceipt) => Promise<void>;
    }
): Promise<PagesDeploymentCreateResult> {
  const checked = intent(input);
  const oidcToken = input.oidcToken;
  const githubToken = input.githubToken;
  const onIntent = input.onIntent;
  const onCreated = input.onCreated;
  validateOidc(oidcToken, checked);
  const http = transport(input, true);
  if (http.signal.aborted)
    throw new Error("Pages deployment was aborted before creation");
  try {
    await onIntent(checked);
  } catch {
    throw new Error("Pages deployment intent could not be persisted");
  }
  if (http.signal.aborted)
    throw new Error("Pages deployment was aborted before creation");
  http.startRequest();
  let response: Response;
  let responseBody: unknown;
  try {
    response = await http.request(
      `${http.base}/repos/${REPOSITORY}/pages/deployments`,
      {
        method: "POST",
        headers: http.headers,
        redirect: "error",
        signal: http.signal,
        body: JSON.stringify({
          artifact_id: Number(checked.artifactId),
          pages_build_version: checked.workflowCommit,
          oidc_token: oidcToken,
          environment: "github-pages",
        }),
      }
    );
    responseBody = await body(response, [githubToken, oidcToken]);
  } catch {
    return { status: "uncertain", intent: checked, reason: "transport" };
  }
  const diagnostic = { httpStatus: response.status, responseBody };
  if (
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 408
  )
    return { status: "rejected", intent: checked, diagnostic };
  if (response.status !== 200)
    return { status: "uncertain", intent: checked, reason: "api", diagnostic };
  let created: PagesDeploymentReceipt;
  try {
    const fields = record(responseBody);
    created = receipt({
      ...checked,
      deploymentId: normalizePagesDeploymentId(fields.id),
      pageUrl: safePageUrl(fields.page_url),
    });
    const statusUrl = new URL(String(fields.status_url));
    const expected = `${API}/repos/${REPOSITORY}/pages/deployments/${created.deploymentId}`;
    if (statusUrl.href !== expected && statusUrl.href !== `${expected}/status`)
      throw new Error("Invalid Pages status URL");
  } catch {
    return {
      status: "uncertain",
      intent: checked,
      reason: "response",
      diagnostic,
    };
  }
  try {
    await onCreated(created);
  } catch {
    return {
      status: "uncertain",
      intent: checked,
      receipt: created,
      reason: "receipt-persistence",
    };
  }
  return { status: "created", receipt: created };
}

/** Read only the durable exact ID; never infer identity from the currently served site. */
export async function getGithubPagesDeployment(
  input: TransportOptions & { receipt: PagesDeploymentReceipt }
): Promise<PagesDeploymentStatusResult> {
  const checked = receipt(input.receipt);
  const http = transport(input);
  const githubToken = input.githubToken;
  let diagnostic: PagesApiDiagnostic | undefined;
  try {
    const response = await http.request(
      `${http.base}/repos/${REPOSITORY}/pages/deployments/${checked.deploymentId}`,
      { headers: http.headers, redirect: "error", signal: http.signal }
    );
    const responseBody = await body(response, [githubToken]);
    diagnostic = { httpStatus: response.status, responseBody };
    if (response.status !== 200)
      return {
        receipt: checked,
        classification: "uncertain",
        apiStatus: null,
        diagnostic,
      };
    const fields = record(responseBody);
    if (
      fields.id !== undefined &&
      normalizePagesDeploymentId(fields.id) !== checked.deploymentId
    )
      return {
        receipt: checked,
        classification: "uncertain",
        apiStatus: null,
        diagnostic,
      };
    const apiStatus = typeof fields.status === "string" ? fields.status : null;
    const classification =
      apiStatus === "succeed"
        ? "succeeded"
        : [
              "deployment_failed",
              "deployment_perms_error",
              "deployment_content_failed",
              "deployment_cancelled",
            ].includes(apiStatus ?? "")
          ? "failed"
          : [
                "deployment_queued",
                "deployment_in_progress",
                "queued",
                "in_progress",
                "unknown_status",
                "not_found",
                "deployment_attempt_error",
              ].includes(apiStatus ?? "")
            ? "in-progress"
            : "uncertain";
    return { receipt: checked, classification, apiStatus, diagnostic };
  } catch {
    return {
      receipt: checked,
      classification: "uncertain",
      apiStatus: null,
      diagnostic,
    };
  }
}

/** Cancellation acceptance is not terminal evidence; read the exact ID afterward. */
export async function cancelGithubPagesDeployment(
  input: TransportOptions & { receipt: PagesDeploymentReceipt }
): Promise<{
  status: "accepted" | "uncertain";
  receipt: PagesDeploymentReceipt;
  diagnostic?: PagesApiDiagnostic;
}> {
  const checked = receipt(input.receipt);
  const http = transport(input);
  const githubToken = input.githubToken;
  try {
    const response = await http.request(
      `${http.base}/repos/${REPOSITORY}/pages/deployments/${checked.deploymentId}/cancel`,
      {
        method: "POST",
        headers: http.headers,
        redirect: "error",
        signal: http.signal,
      }
    );
    const responseBody = await body(response, [githubToken]);
    return {
      status: response.status === 204 ? "accepted" : "uncertain",
      receipt: checked,
      diagnostic: { httpStatus: response.status, responseBody },
    };
  } catch {
    return { status: "uncertain", receipt: checked };
  }
}
