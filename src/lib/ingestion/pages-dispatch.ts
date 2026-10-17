import {
  applyPromotionTransition,
  parsePromotionControl,
  promotionAttemptId,
  type PromotionControl,
  type PromotionEvent,
  type PromotionMode,
} from "./promotion-control.js";
import type { PagesTestTransport } from "./pages-deployment.js";

const API = "https://api.github.com";
const REPOSITORY = "prodigic/zivv";
const WORKFLOW = "publish-candidate.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`;
const ROOT = `/repos/${REPOSITORY}`;
const MAX_BYTES = 65_536;
type DispatchEvent = Extract<PromotionEvent, { type: "dispatch-intent" }>;

/** Safe metadata for the controller's existing intent; never a second state store. */
export interface PagesWorkflowDispatchIntent {
  repository: "prodigic/zivv";
  workflow: "publish-candidate.yml";
  workflowCommit: string;
  ref: string;
  runName: string;
  expectedControlHead: string;
  event: DispatchEvent;
  inputs: {
    request_id: string;
    operation_id: string;
    attempt_id: string;
    payload_commit: string;
    candidate_id: string;
    source_commit: string;
    mode: PromotionMode;
    destination: "production";
  };
}
export interface PagesWorkflowDispatchReceipt {
  intent: PagesWorkflowDispatchIntent;
  controlHead: string;
  runId: string;
  runUrl: string;
  htmlUrl: string;
}
interface Transport {
  githubToken: string;
  testTransport?: PagesTestTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type PagesWorkflowDispatchResult =
  | { status: "dispatched"; receipt: PagesWorkflowDispatchReceipt }
  | {
      status: "uncertain";
      intent: PagesWorkflowDispatchIntent;
      controlHead: string;
      reason: "transport" | "api" | "response" | "receipt-persistence";
      httpStatus?: number;
      receipt?: PagesWorkflowDispatchReceipt;
    };

function sha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value))
    throw new Error("Invalid reviewed workflow Git identity");
}
function id(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value))
    return value;
  throw new Error("Invalid workflow run identity");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid workflow API response");
  return value as Record<string, unknown>;
}
function freezeIntent(value: PagesWorkflowDispatchIntent) {
  return Object.freeze({
    ...value,
    inputs: Object.freeze({ ...value.inputs }),
    event: Object.freeze({ ...value.event }),
  });
}
/** Run-name is shared with the reviewed workflow, and includes the unique attempt. */
export function pagesWorkflowRunName(
  operationId: string,
  mode: PromotionMode,
  attemptId: string
): string {
  return `zivv-pages/${operationId}/${mode}/${attemptId}`;
}

/**
 * The caller must independently verify review and main ancestry. A tag/ref API
 * response proves its target, not code review or ancestry. This prepares a NEW
 * native control transition; seeing an existing planned/uncertain attempt is
 * recovery-only and cannot authorize another POST.
 */
export function preparePagesWorkflowDispatch(input: {
  control: PromotionControl;
  controlHead: string;
  workflowCommit: string;
  reviewedMainAncestor: true;
  mode: PromotionMode;
  dispatchNonce?: string;
}): PagesWorkflowDispatchIntent {
  sha(input.controlHead);
  sha(input.workflowCommit);
  if (input.reviewedMainAncestor !== true)
    throw new Error("Independently reviewed main ancestry is required");
  const state = parsePromotionControl(input.control);
  const operation = state.active;
  if (state.destination !== "production" || !operation)
    throw new Error("Dispatch requires an active production operation");
  const rollback = input.mode === "rollback";
  const legacy =
    rollback && operation.priorVerified.kind === "legacyPublicSnapshot";
  const request = rollback
    ? operation.priorVerified.kind === "candidateRelease"
      ? operation.priorVerified.request
      : {
          payloadCommit: operation.priorVerified.retainedCommit,
          candidateId: "legacy",
          sourceCommit: operation.priorVerified.retainedCommit,
        }
    : operation.request;
  const number =
    (rollback
      ? operation.rollbackAttemptNumber
      : operation.promotionAttemptNumber) + 1;
  const event: DispatchEvent = {
    type: "dispatch-intent",
    operationId: operation.operationId,
    mode: input.mode,
    attemptId: promotionAttemptId(
      operation.operationId,
      input.mode,
      number,
      input.workflowCommit,
      1
    ),
    attemptNumber: number,
    workflowCommit: input.workflowCommit,
    expectedRunAttempt: 1,
    ...(input.dispatchNonce === undefined
      ? {}
      : { dispatchNonce: input.dispatchNonce }),
  };
  // Validate phase, destination and identity with the native controller reducer.
  applyPromotionTransition(state, event);
  return freezeIntent({
    repository: REPOSITORY,
    workflow: WORKFLOW,
    workflowCommit: input.workflowCommit,
    ref: `zivv-workflows/${input.workflowCommit}`,
    runName: pagesWorkflowRunName(
      operation.operationId,
      input.mode,
      event.attemptId
    ),
    expectedControlHead: input.controlHead,
    event,
    inputs: {
      request_id: operation.request.requestId,
      operation_id: operation.operationId,
      attempt_id: event.attemptId,
      payload_commit: request.payloadCommit,
      candidate_id: legacy ? "legacy" : request.candidateId,
      source_commit: request.sourceCommit,
      mode: input.mode,
      destination: "production",
    },
  });
}

export function parsePagesWorkflowDispatchIntent(
  value: PagesWorkflowDispatchIntent
): PagesWorkflowDispatchIntent {
  sha(value.workflowCommit);
  sha(value.expectedControlHead);
  const fields = value.inputs;
  const event = value.event as DispatchEvent & { dispatchNonce?: string };
  if (
    value.repository !== REPOSITORY ||
    value.workflow !== WORKFLOW ||
    value.ref !== `zivv-workflows/${value.workflowCommit}` ||
    !fields ||
    fields.destination !== "production" ||
    !["promote", "rollback"].includes(fields.mode) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fields.request_id) ||
    ![fields.operation_id, fields.attempt_id].every((v) =>
      /^[a-f0-9]{64}$/.test(v)
    ) ||
    (!/^[a-f0-9]{64}$/.test(fields.candidate_id) &&
      !(
        fields.mode === "rollback" &&
        fields.candidate_id === "legacy" &&
        fields.source_commit === fields.payload_commit
      )) ||
    ![fields.payload_commit, fields.source_commit].every((v) =>
      /^[a-f0-9]{40}$/.test(v)
    ) ||
    Object.keys(fields).sort().join(",") !==
      "attempt_id,candidate_id,destination,mode,operation_id,payload_commit,request_id,source_commit" ||
    event.type !== "dispatch-intent" ||
    event.operationId !== fields.operation_id ||
    event.mode !== fields.mode ||
    event.attemptId !== fields.attempt_id ||
    event.workflowCommit !== value.workflowCommit ||
    event.expectedRunAttempt !== 1 ||
    (event.dispatchNonce !== undefined &&
      !/^[a-f0-9]{64}$/.test(event.dispatchNonce)) ||
    !Number.isSafeInteger(event.attemptNumber) ||
    event.attemptNumber < 1 ||
    promotionAttemptId(
      event.operationId,
      event.mode,
      event.attemptNumber,
      event.workflowCommit,
      1
    ) !== event.attemptId ||
    value.runName !==
      pagesWorkflowRunName(fields.operation_id, fields.mode, fields.attempt_id)
  )
    throw new Error("Invalid production workflow dispatch authority");
  // Explicit projection prevents caller-supplied credentials entering durable metadata.
  return freezeIntent({
    repository: REPOSITORY,
    workflow: WORKFLOW,
    workflowCommit: value.workflowCommit,
    ref: value.ref,
    runName: value.runName,
    expectedControlHead: value.expectedControlHead,
    event: {
      type: event.type,
      operationId: event.operationId,
      mode: event.mode,
      attemptId: event.attemptId,
      attemptNumber: event.attemptNumber,
      workflowCommit: event.workflowCommit,
      expectedRunAttempt: 1,
      ...(event.dispatchNonce === undefined
        ? {}
        : { dispatchNonce: event.dispatchNonce }),
    },
    inputs: { ...fields },
  });
}
function transport(options: Transport, deferDeadline = false) {
  if (!options.githubToken || !/^[A-Za-z0-9_-]+$/.test(options.githubToken))
    throw new Error("A workflow GitHub credential is required");
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
    throw new Error("Invalid bounded workflow timeout");
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
      throw new Error(
        "Workflow fixture transport requires a loopback HTTP origin"
      );
    base = url.origin;
    request = options.testTransport.fetch ?? fetch;
  }
  const manualSignal = options.signal;
  let signal = manualSignal ?? new AbortController().signal;
  const startRequest = () => {
    const deadline = AbortSignal.timeout(timeout);
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
async function json(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing workflow API body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Workflow API body exceeds bound");
    }
    chunks.push(chunk.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
function runReceipt(
  intent: PagesWorkflowDispatchIntent,
  controlHead: string,
  runId: string
): PagesWorkflowDispatchReceipt {
  return Object.freeze({
    intent,
    controlHead,
    runId,
    runUrl: `${API}${ROOT}/actions/runs/${runId}`,
    htmlUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
  });
}

/**
 * onIntent must win a NEW native controller CAS (reject replay), and return its
 * exact commit. Persist onDispatched before further effects. No POST retries;
 * every post-intent failure retains ownership for recovery or explicit fencing.
 * Error/response bodies are intentionally omitted to prevent credential echo.
 */
export async function requestGithubPagesWorkflowDispatch(
  input: Transport & {
    intent: PagesWorkflowDispatchIntent;
    onIntent: (
      intent: PagesWorkflowDispatchIntent
    ) => Promise<{ controlHead: string }>;
    onDispatched: (receipt: PagesWorkflowDispatchReceipt) => Promise<void>;
  }
): Promise<PagesWorkflowDispatchResult> {
  const intent = parsePagesWorkflowDispatchIntent(input.intent);
  const http = transport(input, true);
  const onIntent = input.onIntent;
  const onDispatched = input.onDispatched;
  if (http.signal.aborted)
    throw new Error("Workflow dispatch aborted before intent");
  let controlHead: string;
  try {
    const saved = await onIntent(intent);
    sha(saved.controlHead);
    if (saved.controlHead === intent.expectedControlHead) throw new Error();
    controlHead = saved.controlHead;
  } catch {
    throw new Error(
      "Workflow dispatch requires a newly persisted control intent"
    );
  }
  let response: Response;
  try {
    if (http.signal.aborted) throw new Error();
    http.startRequest();
    response = await http.request(
      `${http.base}${ROOT}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: http.headers,
        redirect: "error",
        signal: http.signal,
        body: JSON.stringify({
          ref: intent.ref,
          inputs: { ...intent.inputs, control_head: controlHead },
          return_run_details: true,
        }),
      }
    );
  } catch {
    return { status: "uncertain", intent, controlHead, reason: "transport" };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return {
      status: "uncertain",
      intent,
      controlHead,
      reason: "api",
      httpStatus: response.status,
    };
  }
  let receipt: PagesWorkflowDispatchReceipt;
  try {
    const fields = object(await json(response));
    receipt = runReceipt(intent, controlHead, id(fields.workflow_run_id));
    if (
      fields.run_url !== receipt.runUrl ||
      fields.html_url !== receipt.htmlUrl
    )
      throw new Error();
  } catch {
    return { status: "uncertain", intent, controlHead, reason: "response" };
  }
  try {
    await onDispatched(receipt);
  } catch {
    return {
      status: "uncertain",
      intent,
      controlHead,
      receipt,
      reason: "receipt-persistence",
    };
  }
  return { status: "dispatched", receipt };
}

export type PagesWorkflowRecoveryResult =
  | { status: "matched"; receipt: PagesWorkflowDispatchReceipt }
  | {
      status: "uncertain";
      reason:
        | "transport"
        | "api"
        | "response"
        | "no-match"
        | "ambiguous"
        | "incomplete-list";
    };

function matchRun(
  run: Record<string, unknown>,
  intent: PagesWorkflowDispatchIntent,
  controlHead: string
): boolean {
  if (
    run.display_title !== intent.runName ||
    run.event !== "workflow_dispatch" ||
    run.head_sha !== intent.workflowCommit ||
    run.path !== WORKFLOW_PATH ||
    run.head_branch !== intent.ref ||
    run.run_attempt !== 1
  )
    return false;
  const repository = object(run.repository);
  if (repository.full_name !== REPOSITORY) return false;
  if (
    run.ref !== undefined &&
    run.ref !== `refs/tags/${intent.ref}` &&
    run.ref !== intent.ref
  )
    return false;
  // GitHub does not promise inputs on run-list records; validate them if exposed.
  if (run.inputs !== undefined) {
    const actual = object(run.inputs);
    const expected = { ...intent.inputs, control_head: controlHead };
    if (
      Object.keys(actual).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)
    )
      return false;
  }
  return true;
}

/** Bounded read-only recovery; a missing/ambiguous run never permits redispatch. */
export async function recoverGithubPagesWorkflowDispatch(
  input: Transport & {
    intent: PagesWorkflowDispatchIntent;
    controlHead: string;
    runId?: string;
  }
): Promise<PagesWorkflowRecoveryResult> {
  const intent = parsePagesWorkflowDispatchIntent(input.intent);
  sha(input.controlHead);
  const runId = input.runId === undefined ? undefined : id(input.runId);
  const http = transport(input);
  try {
    const query = new URLSearchParams({
      event: "workflow_dispatch",
      head_sha: intent.workflowCommit,
      per_page: "100",
    });
    const route = runId
      ? `${ROOT}/actions/runs/${runId}`
      : `${ROOT}/actions/workflows/${WORKFLOW}/runs?${query}`;
    const response = await http.request(`${http.base}${route}`, {
      headers: http.headers,
      redirect: "error",
      signal: http.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: "uncertain", reason: "api" };
    }
    const fields = object(await json(response));
    const candidates = runId ? [fields] : fields.workflow_runs;
    if (!Array.isArray(candidates))
      return { status: "uncertain", reason: "response" };
    // Never select an apparent unique match from an incomplete response window.
    if (
      !runId &&
      (typeof fields.total_count !== "number" ||
        !Number.isSafeInteger(fields.total_count) ||
        fields.total_count !== candidates.length ||
        response.headers.has("link"))
    )
      return { status: "uncertain", reason: "incomplete-list" };
    const matches = candidates
      .map(object)
      .filter((run) => matchRun(run, intent, input.controlHead));
    if (matches.length !== 1)
      return {
        status: "uncertain",
        reason: matches.length ? "ambiguous" : "no-match",
      };
    const matchedId = id(matches[0].id);
    if (runId && matchedId !== runId)
      return { status: "uncertain", reason: "response" };
    const receipt = runReceipt(intent, input.controlHead, matchedId);
    if (
      matches[0].url !== receipt.runUrl ||
      matches[0].html_url !== receipt.htmlUrl
    )
      return { status: "uncertain", reason: "response" };
    return { status: "matched", receipt };
  } catch {
    return { status: "uncertain", reason: "transport" };
  }
}

/** Create the reviewed lightweight tag once; never update/delete a conflicting ref. */
export async function ensureReviewedPagesWorkflowTag(
  input: Transport & {
    workflowCommit: string;
    reviewedMainAncestor: true;
  }
): Promise<{ status: "verified" | "uncertain" | "conflict"; ref: string }> {
  sha(input.workflowCommit);
  if (input.reviewedMainAncestor !== true)
    throw new Error("Independently reviewed main ancestry is required");
  const ref = `refs/tags/zivv-workflows/${input.workflowCommit}`;
  const http = transport(input);
  const route = `${http.base}${ROOT}/git/ref/tags/zivv-workflows/${input.workflowCommit}`;
  async function read() {
    const response = await http.request(route, {
      headers: http.headers,
      redirect: "error",
      signal: http.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return response.status;
    }
    const fields = object(await json(response));
    const target = object(fields.object);
    return fields.ref === ref &&
      target.type === "commit" &&
      target.sha === input.workflowCommit
      ? "verified"
      : "conflict";
  }
  try {
    const existing = await read();
    if (existing === "verified" || existing === "conflict")
      return { status: existing, ref };
    if (existing !== 404) return { status: "uncertain", ref };
    const response = await http.request(`${http.base}${ROOT}/git/refs`, {
      method: "POST",
      headers: http.headers,
      redirect: "error",
      signal: http.signal,
      body: JSON.stringify({ ref, sha: input.workflowCommit }),
    });
    await response.body?.cancel();
    // Re-read even after 422: another operator may have created the exact tag.
    if (response.status !== 201 && response.status !== 422)
      return { status: "uncertain", ref };
    const verified = await read();
    return {
      status:
        verified === "verified" || verified === "conflict"
          ? verified
          : "uncertain",
      ref,
    };
  } catch {
    return { status: "uncertain", ref };
  }
}
