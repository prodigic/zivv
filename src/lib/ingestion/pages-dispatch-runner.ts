import { execFileSync } from "node:child_process";
import { projectLedgerLocation } from "./store-location.js";
import { assertOperatorInstallationWritable } from "./operator-installation.js";
import {
  assertRecoveredFreshDispatchAllowed,
  assertRecoveredPublicationEffect,
  authorizeRecoveredDispatchReceipt,
  recoveredDispatchSelection,
  recoveredPublicationRepository,
} from "./recovery-import-admission.js";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  secureOperatorDirectory,
  writeDurableFile,
} from "./encrypted-backup.js";
import { resolvePrivateCandidateDirectory } from "./private-artifacts.js";
import {
  applyPromotionTransition,
  parsePromotionControl,
  promotionDigest,
  serializePromotionControl,
  type PromotionMode,
} from "./promotion-control.js";
import type {
  PreparedPromotionControlAppend,
  PromotionControlStore,
} from "./promotion-control-git.js";
import type { PagesTestTransport } from "./pages-deployment.js";
import {
  ensureReviewedPagesWorkflowTag,
  parsePagesWorkflowDispatchIntent,
  preparePagesWorkflowDispatch,
  recoverGithubPagesWorkflowDispatch,
  requestGithubPagesWorkflowDispatch,
  type PagesWorkflowDispatchIntent,
  type PagesWorkflowDispatchReceipt,
} from "./pages-dispatch.js";

export interface SavedPagesDispatch {
  schemaVersion: 1;
  intent: PagesWorkflowDispatchIntent;
  pendingAppend: {
    expectedHead: string;
    attemptedHead: string;
    bytes: string;
    createdAt: string;
  };
  receipt?: PagesWorkflowDispatchReceipt;
}
type SavedDispatch = SavedPagesDispatch;
export interface PagesDispatchRunnerOptions {
  command: "dispatch" | "recover";
  repositoryRoot: string;
  workflowCommit: string;
  mode: PromotionMode;
  intentDirectory: string;
  githubToken: string;
  controlledPublishing: string | undefined;
  manualPublisherJoined: string | undefined;
  store: PromotionControlStore;
  /** Exact accepted attempt to reconstruct when private dispatch metadata was lost. */
  recovery?: { operationId: string; attemptId: string };
  /** Recheck the calling worker's ownership/runtime before effect boundaries. */
  checkContext?: () => void;
  /** Explicit offline HTTP fixtures only; the CLI exposes no adapter flags. */
  testTransport?: PagesTestTransport;
}
const sha = (value: string) => /^[a-f0-9]{40}$/.test(value);
const bytes = (value: unknown) =>
  Buffer.from(JSON.stringify(value) + "\n", "utf8");

/** Local, read-only Git checks; HTTP ref identity cannot establish main ancestry. */
export function verifyReviewedPagesWorkflowCommit(
  repositoryRoot: string,
  workflowCommit: string
): void {
  if (!sha(workflowCommit))
    throw new Error("A full reviewed workflow SHA is required");
  assertRecoveredPublicationEffect();
  const repository = recoveredPublicationRepository(repositoryRoot);
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });
  const git = (args: string[]) =>
    execFileSync(
      "git",
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      {
        cwd: repository.root,
        env,
        windowsHide: true,
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 65_536,
      }
    )
      .toString()
      .trim();
  try {
    const origin = git(["remote", "get-url", "origin"]);
    if (
      ![
        "https://github.com/prodigic/zivv.git",
        "https://github.com/prodigic/zivv",
        "git@github.com:prodigic/zivv.git",
      ].includes(origin)
    )
      throw new Error();
    if (
      git(["rev-parse", "--verify", `${workflowCommit}^{commit}`]) !==
      workflowCommit
    )
      throw new Error();
    const main = repository.mainHead ?? "refs/remotes/origin/main";
    if (repository.mainHead && !sha(repository.mainHead)) throw new Error();
    const mainHead = git(["rev-parse", "--verify", `${main}^{commit}`]);
    if (repository.mainHead && mainHead !== repository.mainHead)
      throw new Error();
    git(["merge-base", "--is-ancestor", workflowCommit, main]);
    if (
      git([
        "cat-file",
        "-t",
        `${workflowCommit}:.github/workflows/publish-candidate.yml`,
      ]) !== "blob"
    )
      throw new Error();
  } catch {
    throw new Error(
      "Workflow commit must exist on the locally verified authoritative origin/main and contain the reviewed publisher"
    );
  }
}

function record(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new Error(label);
  return value as Record<string, unknown>;
}

/** Validate the exact receipt shape emitted by the workflow dispatch transport. */
export function parseSavedPagesDispatchReceipt(
  value: unknown,
  expected: { intent: PagesWorkflowDispatchIntent; controlHead: string }
): PagesWorkflowDispatchReceipt {
  const receipt = record(
    value,
    ["intent", "controlHead", "runId", "runUrl", "htmlUrl"],
    "Invalid saved dispatch receipt schema"
  );
  const intent = parsePagesWorkflowDispatchIntent(
    receipt.intent as PagesWorkflowDispatchIntent
  );
  if (
    promotionDigest(intent) !== promotionDigest(receipt.intent) ||
    promotionDigest(intent) !== promotionDigest(expected.intent) ||
    typeof receipt.controlHead !== "string" ||
    !sha(receipt.controlHead) ||
    receipt.controlHead !== expected.controlHead ||
    typeof receipt.runId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(receipt.runId) ||
    receipt.runUrl !==
      `https://api.github.com/repos/prodigic/zivv/actions/runs/${receipt.runId}` ||
    receipt.htmlUrl !==
      `https://github.com/prodigic/zivv/actions/runs/${receipt.runId}`
  )
    throw new Error("Saved dispatch receipt changed ownership");
  return receipt as unknown as PagesWorkflowDispatchReceipt;
}

/** Parse bounded producer bytes without granting remote dispatch authority. */
export function parseSavedPagesDispatch(input: Buffer): SavedPagesDispatch {
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > 2_000_000)
    throw new Error("Saved dispatch must contain bounded producer bytes");
  const value: unknown = JSON.parse(input.toString("utf8"));
  const hasReceipt =
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "receipt");
  const raw = record(
    value,
    [
      "schemaVersion",
      "intent",
      "pendingAppend",
      ...(hasReceipt ? ["receipt"] : []),
    ],
    "Invalid saved dispatch schema"
  );
  if (raw.schemaVersion !== 1 || !input.equals(bytes(raw)))
    throw new Error("Noncanonical saved dispatch bytes");
  const saved = raw as unknown as SavedPagesDispatch;
  const checked = parsePagesWorkflowDispatchIntent(saved.intent);
  if (promotionDigest(checked) !== promotionDigest(saved.intent))
    throw new Error("Saved dispatch intent changed");
  const pending = record(
    saved.pendingAppend,
    ["expectedHead", "attemptedHead", "bytes", "createdAt"],
    "Invalid saved prepared append"
  );
  if (
    typeof pending.expectedHead !== "string" ||
    !sha(pending.expectedHead) ||
    typeof pending.attemptedHead !== "string" ||
    !sha(pending.attemptedHead) ||
    pending.attemptedHead === pending.expectedHead ||
    pending.expectedHead !== checked.expectedControlHead ||
    typeof pending.bytes !== "string" ||
    Buffer.from(pending.bytes, "base64").toString("base64") !== pending.bytes ||
    typeof pending.createdAt !== "string" ||
    !Number.isFinite(Date.parse(pending.createdAt)) ||
    new Date(pending.createdAt).toISOString() !== pending.createdAt
  )
    throw new Error("Invalid saved prepared append");
  const state = parsePromotionControl(Buffer.from(pending.bytes, "base64"));
  if (
    !serializePromotionControl(state).equals(
      Buffer.from(pending.bytes, "base64")
    ) ||
    promotionDigest(state.lastTransition.event) !==
      promotionDigest(checked.event) ||
    state.destination !== "production"
  )
    throw new Error("Saved append does not contain the exact dispatch intent");
  if (hasReceipt)
    parseSavedPagesDispatchReceipt(saved.receipt, {
      intent: checked,
      controlHead: pending.attemptedHead,
    });
  return saved;
}
function readSaved(path: string): SavedDispatch {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 2_000_000
  )
    throw new Error("Saved dispatch must be a bounded unlinked regular file");
  return parseSavedPagesDispatch(readFileSync(path));
}
function saveOnce(path: string, saved: SavedDispatch): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes(saved));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== "win32") {
    const fd = openSync(join(path, ".."), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
function prepared(saved: SavedDispatch): PreparedPromotionControlAppend {
  return {
    ...saved.pendingAppend,
    bytes: Buffer.from(saved.pendingAppend.bytes, "base64"),
  };
}

function recoverCanonicalIntent(options: PagesDispatchRunnerOptions): {
  saved: SavedDispatch;
  runId?: string;
} {
  const selector = options.recovery;
  if (
    options.command !== "recover" ||
    !selector ||
    !/^[a-f0-9]{64}$/.test(selector.operationId) ||
    !/^[a-f0-9]{64}$/.test(selector.attemptId) ||
    !options.store.readCanonicalHistory
  )
    throw new Error(
      "Canonical dispatch recovery requires exact operation and attempt identities and a history-capable store"
    );
  const history = options.store.readCanonicalHistory({
    maxCommits: 1000,
    maxBytes: 16 * 1024 * 1024,
  });
  if (!history.complete)
    throw new Error("Canonical dispatch recovery history is incomplete");
  const matches = history.commits.filter((record) => {
    const state = parsePromotionControl(record.bytes),
      event = state.lastTransition.event;
    return (
      event.type === "dispatch-intent" &&
      event.operationId === selector.operationId &&
      event.attemptId === selector.attemptId &&
      event.mode === options.mode &&
      event.workflowCommit === options.workflowCommit
    );
  });
  if (matches.length !== 1)
    throw new Error("Canonical dispatch intent is missing or ambiguous");
  const record = matches[0],
    state = parsePromotionControl(record.bytes),
    event = state.lastTransition.event;
  if (
    event.type !== "dispatch-intent" ||
    !event.dispatchNonce ||
    !record.parentHead ||
    !record.parentBytes
  )
    throw new Error("Canonical dispatch lacks its original nonce or parent");
  const before = parsePromotionControl(record.parentBytes);
  const intent = preparePagesWorkflowDispatch({
    control: before,
    controlHead: record.parentHead,
    workflowCommit: options.workflowCommit,
    reviewedMainAncestor: true,
    mode: options.mode,
    dispatchNonce: event.dispatchNonce,
  });
  if (
    promotionDigest(intent.event) !== promotionDigest(event) ||
    !serializePromotionControl(
      applyPromotionTransition(before, intent.event)
    ).equals(record.bytes)
  )
    throw new Error(
      "Canonical dispatch transition does not reproduce its accepted bytes"
    );
  const admissions = new Set<string>();
  for (const item of history.commits) {
    const active = parsePromotionControl(item.bytes).active;
    if (active?.operationId !== selector.operationId) continue;
    const attempt =
      options.mode === "promote"
        ? active.promotionAttempt
        : active.rollbackAttempt;
    if (attempt?.attemptId === selector.attemptId && attempt.admission) {
      if (
        attempt.dispatchNonce !== event.dispatchNonce ||
        attempt.admission.workflowCommit !== options.workflowCommit ||
        attempt.admission.runAttempt !== event.expectedRunAttempt
      )
        throw new Error("Canonical dispatch admission changed identity");
      admissions.add(attempt.admission.runId);
    }
  }
  if (admissions.size > 1)
    throw new Error("Canonical dispatch has conflicting admissions");
  return {
    saved: {
      schemaVersion: 1,
      intent,
      pendingAppend: {
        expectedHead: record.parentHead,
        attemptedHead: record.head,
        bytes: record.bytes.toString("base64"),
        createdAt: record.createdAt,
      },
    },
    runId: [...admissions][0],
  };
}

/**
 * This journal checkpoints the native controller CAS, not another authorization
 * state. Every saved file is recovery-only, including a crash before CAS or POST.
 * An explicit native fence and a fresh directory are required for another attempt.
 */
export async function runPagesCandidateDispatch(
  options: PagesDispatchRunnerOptions
) {
  const scopedSelection = recoveredDispatchSelection();
  const originalContext = options.checkContext;
  const operator = projectLedgerLocation(options.repositoryRoot).directory;
  options = {
    ...options,
    ...(scopedSelection
      ? {
          command: "recover" as const,
          recovery: {
            operationId: scopedSelection.operationId,
            attemptId: scopedSelection.attemptId,
          },
        }
      : {}),
    checkContext: () => {
      assertOperatorInstallationWritable(operator);
      originalContext?.();
    },
  };
  const checkEffect = () => {
    assertRecoveredPublicationEffect();
    options.checkContext?.();
  };
  options.checkContext?.();
  if (options.recovery && options.command !== "recover")
    throw new Error("Canonical history selection is recovery-only");
  if (
    !sha(options.workflowCommit) ||
    !["promote", "rollback"].includes(options.mode) ||
    !["dispatch", "recover"].includes(options.command)
  )
    throw new Error("Invalid reviewed dispatch command");
  if (
    options.controlledPublishing !== "enabled" ||
    options.manualPublisherJoined !== "true"
  )
    throw new Error(
      "Controlled publication requires enabled activation and joined manual publisher flags"
    );
  if (!options.githubToken || !/^[A-Za-z0-9_-]+$/.test(options.githubToken))
    throw new Error("GITHUB_TOKEN is required for workflow REST calls");
  options.checkContext?.();
  if (!options.testTransport)
    verifyReviewedPagesWorkflowCommit(
      options.repositoryRoot,
      options.workflowCommit
    );
  const directory = resolvePrivateCandidateDirectory(options.intentDirectory);
  secureOperatorDirectory(directory);
  const path = join(directory, "pages-dispatch.json");
  const http = {
    githubToken: options.githubToken,
    testTransport: options.testTransport,
  };

  let canonical: ReturnType<typeof recoverCanonicalIntent> | undefined;
  if (options.recovery) canonical = recoverCanonicalIntent(options);
  if (!existsSync(path) && canonical) {
    options.checkContext?.();
    saveOnce(path, canonical.saved);
  }

  if (existsSync(path)) {
    const saved = readSaved(path);
    if (
      saved.intent.workflowCommit !== options.workflowCommit ||
      saved.intent.inputs.mode !== options.mode
    )
      throw new Error(
        "Saved dispatch does not match the selected reviewed workflow/mode"
      );
    if (
      canonical &&
      promotionDigest(saved.intent) !== promotionDigest(canonical.saved.intent)
    )
      throw new Error(
        "Saved dispatch differs from the selected canonical attempt"
      );
    let readback;
    try {
      readback = options.store.readback(prepared(saved));
    } catch {
      // A fresh checkout may retain the private file but not its Git objects.
      // Canonical ancestry below can fetch/prove acceptance; a failed local
      // readback alone must neither authorize effects nor preclude that proof.
    }
    if (readback?.status !== "appended") {
      // Accepted history remains GET-only recovery authority after admission,
      // completion or a later owner; a local prepared child alone is insufficient.
      let historical;
      try {
        historical = options.store.readAt(saved.pendingAppend.attemptedHead);
      } catch {
        return { status: "uncertain" as const, reason: "control-readback" };
      }
      if (
        historical.head !== saved.pendingAppend.attemptedHead ||
        !historical.bytes?.equals(
          Buffer.from(saved.pendingAppend.bytes, "base64")
        )
      )
        return { status: "uncertain" as const, reason: "control-readback" };
    }
    const result = await recoverGithubPagesWorkflowDispatch({
      ...http,
      intent: saved.intent,
      controlHead: saved.pendingAppend.attemptedHead,
      runId: scopedSelection
        ? (canonical?.runId ?? scopedSelection.runId)
        : (canonical?.runId ?? saved.receipt?.runId),
    });
    options.checkContext?.();
    if (result.status === "matched") {
      authorizeRecoveredDispatchReceipt(result.receipt);
      options.checkContext?.();
      saved.receipt = result.receipt;
      writeDurableFile(path, bytes(saved));
    }
    return result;
  }
  if (options.command === "recover")
    throw new Error(
      "No saved dispatch intent exists; recovery cannot create one"
    );
  assertRecoveredFreshDispatchAllowed();
  const current = options.store.read();
  if (!current.head || !current.bytes)
    throw new Error(
      "Dispatch requires an existing bootstrapped active production control"
    );
  const intent = preparePagesWorkflowDispatch({
    control: parsePromotionControl(current.bytes),
    controlHead: current.head,
    workflowCommit: options.workflowCommit,
    reviewedMainAncestor: true,
    mode: options.mode,
    dispatchNonce: randomBytes(32).toString("hex"),
  });
  const next = applyPromotionTransition(
    parsePromotionControl(current.bytes),
    intent.event
  );
  const pending = options.store.prepareAppend({
    expectedHead: current.head,
    bytes: serializePromotionControl(next),
    createdAt: new Date().toISOString(),
  });
  const saved: SavedDispatch = {
    schemaVersion: 1,
    intent,
    pendingAppend: {
      expectedHead: current.head,
      attemptedHead: pending.attemptedHead,
      bytes: pending.bytes.toString("base64"),
      createdAt: pending.createdAt,
    },
  };
  assertRecoveredPublicationEffect();
  options.checkContext?.();
  const tag = await ensureReviewedPagesWorkflowTag({
    ...http,
    workflowCommit: options.workflowCommit,
    reviewedMainAncestor: true,
    checkContext: checkEffect,
  });
  options.checkContext?.();
  if (tag.status !== "verified")
    return { status: "uncertain" as const, reason: "workflow-tag", tag };
  assertRecoveredPublicationEffect();
  options.checkContext?.();
  return requestGithubPagesWorkflowDispatch({
    ...http,
    intent,
    onIntent: async () => {
      options.checkContext?.();
      saveOnce(path, saved);
      assertRecoveredPublicationEffect();
      options.checkContext?.();
      const result = options.store.compareAndAppend({
        ...pending,
        checkContext: checkEffect,
      });
      if (
        result.status !== "appended" ||
        result.attemptedHead !== pending.attemptedHead ||
        result.observedHead !== pending.attemptedHead
      )
        throw new Error("Exact prepared controller append did not win");
      assertRecoveredPublicationEffect();
      options.checkContext?.();
      return { controlHead: pending.attemptedHead };
    },
    onDispatched: async (receipt) => {
      options.checkContext?.();
      const existing = readSaved(path);
      if (promotionDigest(existing.intent) !== promotionDigest(intent))
        throw new Error("Private intent ownership changed");
      writeDurableFile(path, bytes({ ...existing, receipt }));
    },
  });
}
