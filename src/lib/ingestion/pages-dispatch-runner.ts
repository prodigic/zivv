import { execFileSync } from "node:child_process";
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

interface SavedDispatch {
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
        cwd: repositoryRoot,
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
    git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
    git([
      "merge-base",
      "--is-ancestor",
      workflowCommit,
      "refs/remotes/origin/main",
    ]);
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

function readSaved(path: string): SavedDispatch {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 2_000_000
  )
    throw new Error("Saved dispatch must be a bounded unlinked regular file");
  const saved = JSON.parse(readFileSync(path, "utf8")) as SavedDispatch;
  if (
    saved.schemaVersion !== 1 ||
    Object.keys(saved).some(
      (key) =>
        !["schemaVersion", "intent", "pendingAppend", "receipt"].includes(key)
    )
  )
    throw new Error("Invalid saved dispatch schema");
  const checked = parsePagesWorkflowDispatchIntent(saved.intent);
  if (promotionDigest(checked) !== promotionDigest(saved.intent))
    throw new Error("Saved dispatch intent changed");
  const pending = saved.pendingAppend;
  if (
    !pending ||
    Object.keys(pending).sort().join(",") !==
      "attemptedHead,bytes,createdAt,expectedHead" ||
    !sha(pending.attemptedHead) ||
    pending.expectedHead !== checked.expectedControlHead ||
    typeof pending.bytes !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(pending.bytes) ||
    !Number.isFinite(Date.parse(pending.createdAt))
  )
    throw new Error("Invalid saved prepared append");
  const state = parsePromotionControl(Buffer.from(pending.bytes, "base64"));
  if (
    promotionDigest(state.lastTransition.event) !==
      promotionDigest(checked.event) ||
    state.destination !== "production"
  )
    throw new Error("Saved append does not contain the exact dispatch intent");
  if (
    saved.receipt &&
    (promotionDigest(saved.receipt.intent) !== promotionDigest(checked) ||
      saved.receipt.controlHead !== pending.attemptedHead)
  )
    throw new Error("Saved dispatch receipt changed ownership");
  return saved;
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

/**
 * This journal checkpoints the native controller CAS, not another authorization
 * state. Every saved file is recovery-only, including a crash before CAS or POST.
 * An explicit native fence and a fresh directory are required for another attempt.
 */
export async function runPagesCandidateDispatch(
  options: PagesDispatchRunnerOptions
) {
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

  if (existsSync(path)) {
    const saved = readSaved(path);
    if (
      saved.intent.workflowCommit !== options.workflowCommit ||
      saved.intent.inputs.mode !== options.mode
    )
      throw new Error(
        "Saved dispatch does not match the selected reviewed workflow/mode"
      );
    let readback;
    try {
      readback = options.store.readback(prepared(saved));
    } catch {
      return { status: "uncertain" as const, reason: "control-readback" };
    }
    if (readback.status !== "appended") {
      // Admission can advance the control ref before the operator saves a run receipt.
      let current;
      try {
        current = options.store.read();
      } catch {
        return { status: "uncertain" as const, reason: "control-readback" };
      }
      if (!current.bytes)
        return { status: "uncertain" as const, reason: "control-readback" };
      const active = parsePromotionControl(current.bytes).active;
      const attempt =
        options.mode === "promote"
          ? active?.promotionAttempt
          : active?.rollbackAttempt;
      const event = saved.intent.event as typeof saved.intent.event & {
        dispatchNonce?: string;
      };
      const nonce =
        attempt && "dispatchNonce" in attempt
          ? attempt.dispatchNonce
          : undefined;
      if (
        active?.operationId !== event.operationId ||
        attempt?.attemptId !== event.attemptId ||
        !event.dispatchNonce ||
        nonce !== event.dispatchNonce
      )
        return { status: "uncertain" as const, reason: "control-readback" };
    }
    const result = await recoverGithubPagesWorkflowDispatch({
      ...http,
      intent: saved.intent,
      controlHead: saved.pendingAppend.attemptedHead,
      runId: saved.receipt?.runId,
    });
    if (result.status === "matched") {
      saved.receipt = result.receipt;
      writeDurableFile(path, bytes(saved));
    }
    return result;
  }
  if (options.command === "recover")
    throw new Error(
      "No saved dispatch intent exists; recovery cannot create one"
    );
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
  const tag = await ensureReviewedPagesWorkflowTag({
    ...http,
    workflowCommit: options.workflowCommit,
    reviewedMainAncestor: true,
  });
  if (tag.status !== "verified")
    return { status: "uncertain" as const, reason: "workflow-tag", tag };
  return requestGithubPagesWorkflowDispatch({
    ...http,
    intent,
    onIntent: async () => {
      saveOnce(path, saved);
      const result = options.store.compareAndAppend(pending);
      if (
        result.status !== "appended" ||
        result.attemptedHead !== pending.attemptedHead ||
        result.observedHead !== pending.attemptedHead
      )
        throw new Error("Exact prepared controller append did not win");
      return { controlHead: pending.attemptedHead };
    },
    onDispatched: async (receipt) => {
      const existing = readSaved(path);
      if (promotionDigest(existing.intent) !== promotionDigest(intent))
        throw new Error("Private intent ownership changed");
      writeDurableFile(path, bytes({ ...existing, receipt }));
    },
  });
}
