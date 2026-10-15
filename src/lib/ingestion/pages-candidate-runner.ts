import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeDurableFile } from "./encrypted-backup.js";
import {
  PROMOTION_DESTINATIONS,
  candidatePublicReleaseId,
  applyPromotionTransition,
  authorizePagesCreation,
  authorizePromotionDeployment,
  pagesCreationId,
  parsePromotionControl,
  promotionDigest,
  serializePromotionControl,
  type PromotionEvent,
  type PromotionMode,
  type RunAdmission,
} from "./promotion-control.js";
import {
  type PromotionControlStore,
  type PromotionControlTransport,
} from "./promotion-control-git.js";
import { verifyLiveInventory } from "./release-live-inventory.js";
import {
  buildReleaseBrowserPlan,
  verifyReleaseBrowser,
} from "./release-browser.js";
import { readPublicationPayloadGit } from "./publication-git.js";
import { verifyPublicationPayload } from "./publication-payload.js";
import {
  getGithubPagesDeployment,
  parsePagesDeploymentReceipt,
  requestGithubPagesDeployment,
  type PagesDeploymentReceipt,
  type PagesDeploymentStatusResult,
  type PagesTestTransport,
} from "./pages-deployment.js";

export interface PagesRunnerInputs {
  request_id: string;
  operation_id: string;
  attempt_id: string;
  control_head: string;
  payload_commit: string;
  candidate_id: string;
  source_commit: string;
  mode: PromotionMode;
  destination: "production";
}
export interface PagesRunnerIdentity {
  inputs: PagesRunnerInputs;
  admission: RunAdmission;
}
interface RunnerState {
  schemaVersion: 1;
  identity: PagesRunnerIdentity;
  pendingAppend?: {
    expectedHead: string;
    attemptedHead: string;
    bytes: string;
    createdAt: string;
  };
  admittedHead?: string;
  archiveSha256?: string;
  receipt?: PagesDeploymentReceipt;
  creationId?: string;
  status?: PagesDeploymentStatusResult;
}
export interface PagesRunnerOptions {
  repositoryRoot: string;
  identity: PagesRunnerIdentity;
  statePath: string;
  siteDirectory: string;
  archivePath: string;
  store: PromotionControlStore;
  transport: PromotionControlTransport;
  githubToken: string;
  artifactId?: string;
  getOidcToken: () => Promise<string>;
  testTransport?: PagesTestTransport;
  pollAttempts?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}
/** Safe identity for manual reconciliation when local receipt persistence failed. */
export class PagesCreationUncertainError extends Error {
  readonly recovery: {
    type: "pages-creation-recovery";
    receipt: PagesDeploymentReceipt;
  };
  constructor(receipt: PagesDeploymentReceipt) {
    super(
      "Pages creation uncertain; known deployment identity requires durable reconciliation and ownership remains held"
    );
    this.recovery = {
      type: "pages-creation-recovery",
      receipt: parsePagesDeploymentReceipt(receipt),
    };
  }
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const same = (actual: unknown, expected: unknown, label: string) => {
  if (promotionDigest(actual) !== promotionDigest(expected))
    throw new Error(`Pages runner mismatch: ${label}`);
};
const inputKeys = [
  "request_id",
  "operation_id",
  "attempt_id",
  "control_head",
  "payload_commit",
  "candidate_id",
  "source_commit",
  "mode",
  "destination",
];

/** Check both resumable subsets and complete scratch without following links. */
function checkPublicScratch(
  directory: string,
  files: ReadonlyMap<string, Buffer>,
  complete: boolean
): Set<string> {
  const seen = new Set<string>();
  const directories = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++)
      directories.add(parts.slice(0, count).join("/"));
  }
  const walk = (path: string, prefix: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Pages site scratch directory is unsafe");
    for (const name of readdirSync(path)) {
      const entry = prefix ? `${prefix}/${name}` : name;
      const target = join(path, name);
      const entryStat = lstatSync(target);
      if (entryStat.isSymbolicLink())
        throw new Error("Pages site scratch contains a symlink");
      if (entryStat.isDirectory()) {
        if (!directories.has(entry))
          throw new Error("Unexpected Pages scratch directory");
        walk(target, entry);
      } else {
        const expected = files.get(entry);
        if (
          !entryStat.isFile() ||
          entryStat.nlink !== 1 ||
          !expected ||
          !readFileSync(target).equals(expected)
        )
          throw new Error(
            "Pages scratch differs from the verified public inventory"
          );
        seen.add(entry);
      }
    }
  };
  if (existsSync(directory)) walk(directory, "");
  if (complete && seen.size !== files.size)
    throw new Error("Pages scratch public inventory is incomplete");
  return seen;
}

/** USTAR with bounded PAX path records: archive trusted buffers, never mutable scratch. */
export function createPagesPublicArchive(
  files: ReadonlyMap<string, Buffer>
): Buffer {
  const chunks: Buffer[] = [];
  const header = (name: string, size: number, type: "0" | "x") => {
    if (size > 0o77777777777)
      throw new Error("Pages tar file exceeds USTAR size");
    const block = Buffer.alloc(512);
    block.write(name, 0, 100, "utf8");
    block.write("0000644\0", 100, "ascii");
    block.write("0000000\0", 108, "ascii");
    block.write("0000000\0", 116, "ascii");
    block.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    block.write("00000000000\0", 136, "ascii");
    block.fill(32, 148, 156);
    block.write(type, 156, "ascii");
    block.write("ustar\0", 257, "ascii");
    block.write("00", 263, "ascii");
    const checksum = block.reduce((total, value) => total + value, 0);
    block.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    return block;
  };
  const add = (name: string, bytes: Buffer, type: "0" | "x") => {
    chunks.push(header(name, bytes.length, type), bytes);
    if (bytes.length % 512)
      chunks.push(Buffer.alloc(512 - (bytes.length % 512)));
  };
  let index = 0;
  for (const [path, bytes] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    let name = path;
    if (Buffer.byteLength(path) > 100) {
      const content = ` path=${path}\n`;
      let length = Buffer.byteLength(content) + 1;
      while (length !== Buffer.byteLength(content) + String(length).length)
        length = Buffer.byteLength(content) + String(length).length;
      add(`PaxHeaders/${index}`, Buffer.from(String(length) + content), "x");
      name = `public-file-${index}`;
    }
    add(name, bytes, "0");
    index++;
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/** Runtime admission rechecks the actual dispatch envelope, not just convenient env aliases. */
export function readPagesRunnerIdentity(
  env: NodeJS.ProcessEnv,
  repositoryRoot: string
): PagesRunnerIdentity {
  if (
    env.ZIVV_CONTROLLED_PUBLISHING !== "enabled" ||
    env.ZIVV_MANUAL_PUBLISHER_JOINED !== "true"
  )
    throw new Error(
      "Controlled publication activation prerequisites are absent"
    );
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REPOSITORY !== "prodigic/zivv" ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    env.GITHUB_REF !== `refs/tags/zivv-workflows/${env.GITHUB_SHA}`
  )
    throw new Error(
      "Pages runner requires the immutable reviewed workflow dispatch"
    );
  let event: {
    repository?: { full_name?: string; default_branch?: string };
    inputs?: Record<string, string>;
  };
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"));
  } catch {
    throw new Error("Invalid Pages dispatch envelope JSON");
  }
  if (
    event.repository?.full_name !== "prodigic/zivv" ||
    event.repository.default_branch !== "main"
  )
    throw new Error(
      "Pages dispatch repository must have main as its default branch"
    );
  const inputs = Object.fromEntries(
    inputKeys.map((key) => [key, env[`ZIVV_${key.toUpperCase()}`]])
  ) as unknown as PagesRunnerInputs;
  same(
    Object.keys(event.inputs ?? {}).sort(),
    [...inputKeys].sort(),
    "dispatch input fields"
  );
  same(event.inputs, inputs, "dispatch envelope inputs");
  validateInputs(inputs);
  const admission = {
    workflowCommit: env.GITHUB_SHA!,
    runId: env.GITHUB_RUN_ID ?? "",
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
  if (
    !/^[1-9][0-9]{0,19}$/.test(admission.runId) ||
    !Number.isSafeInteger(admission.runAttempt) ||
    admission.runAttempt < 1
  )
    throw new Error("Invalid workflow run identity");
  const gitEnv: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
  ])
    if (env[name] !== undefined) gitEnv[name] = env[name];
  Object.assign(gitEnv, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  });
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["--no-replace-objects", "-c", "core.hooksPath=", ...args],
      {
        cwd: repositoryRoot,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 30_000,
      }
    ).trim();
  same(
    git(["rev-parse", "--verify", env.GITHUB_REF + "^{commit}"]),
    admission.workflowCommit,
    "reviewed tag commit"
  );
  same(
    git(["rev-parse", "HEAD"]),
    admission.workflowCommit,
    "executing checkout"
  );
  git([
    "merge-base",
    "--is-ancestor",
    admission.workflowCommit,
    "refs/remotes/origin/main",
  ]);
  return { inputs, admission };
}
function validateInputs(inputs: PagesRunnerInputs): void {
  same(Object.keys(inputs).sort(), [...inputKeys].sort(), "input fields");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(inputs.request_id) ||
    ![inputs.operation_id, inputs.attempt_id].every((value) =>
      /^[a-f0-9]{64}$/.test(value)
    ) ||
    ![inputs.control_head, inputs.payload_commit, inputs.source_commit].every(
      (value) => /^[a-f0-9]{40}$/.test(value)
    ) ||
    !(
      /^[a-f0-9]{64}$/.test(inputs.candidate_id) ||
      (inputs.mode === "rollback" && inputs.candidate_id === "legacy")
    ) ||
    !["promote", "rollback"].includes(inputs.mode) ||
    inputs.destination !== "production"
  )
    throw new Error("Invalid closed production Pages inputs");
}

function checkpointFields(
  value: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Pages checkpoint object");
  const object = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some(
      (key) => !required.includes(key) && !optional.includes(key)
    )
  )
    throw new Error("Invalid Pages checkpoint fields");
  return object;
}
/** Checkpoint hashes detect corruption; closed parsing prevents metadata reflection. */
function parseRunnerState(
  value: unknown,
  expected: PagesRunnerIdentity
): RunnerState {
  const state = checkpointFields(
    value,
    ["schemaVersion", "identity"],
    [
      "pendingAppend",
      "admittedHead",
      "archiveSha256",
      "receipt",
      "creationId",
      "status",
    ]
  );
  if (state.schemaVersion !== 1)
    throw new Error("Unsupported Pages checkpoint");
  const identity = checkpointFields(state.identity, ["inputs", "admission"]);
  checkpointFields(identity.inputs, inputKeys);
  checkpointFields(identity.admission, [
    "workflowCommit",
    "runId",
    "runAttempt",
  ]);
  same(identity, expected, "checkpoint identity");
  const parsed: RunnerState = {
    schemaVersion: 1,
    identity: structuredClone(expected),
  };
  for (const key of ["admittedHead", "archiveSha256", "creationId"] as const) {
    if (state[key] !== undefined) {
      const length = key === "admittedHead" ? 40 : 64;
      if (
        typeof state[key] !== "string" ||
        !new RegExp(`^[a-f0-9]{${length}}$`).test(state[key])
      )
        throw new Error("Invalid Pages checkpoint identity digest");
      parsed[key] = state[key];
    }
  }
  if (state.pendingAppend !== undefined) {
    const pending = checkpointFields(state.pendingAppend, [
      "expectedHead",
      "attemptedHead",
      "bytes",
      "createdAt",
    ]);
    if (
      typeof pending.expectedHead !== "string" ||
      typeof pending.attemptedHead !== "string" ||
      ![pending.expectedHead, pending.attemptedHead].every((sha) =>
        /^[a-f0-9]{40}$/.test(sha)
      ) ||
      typeof pending.bytes !== "string" ||
      typeof pending.createdAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(pending.createdAt) ||
      !Number.isFinite(Date.parse(pending.createdAt)) ||
      new Date(pending.createdAt).toISOString() !== pending.createdAt
    )
      throw new Error("Invalid Pages append checkpoint");
    const bytes = Buffer.from(pending.bytes, "base64");
    if (
      !bytes.length ||
      bytes.length > 1024 * 1024 ||
      bytes.toString("base64") !== pending.bytes
    )
      throw new Error("Invalid Pages append checkpoint bytes");
    try {
      parsePromotionControl(bytes);
    } catch {
      throw new Error("Invalid Pages append checkpoint control");
    }
    parsed.pendingAppend = {
      expectedHead: pending.expectedHead,
      attemptedHead: pending.attemptedHead,
      bytes: pending.bytes,
      createdAt: pending.createdAt,
    };
  }
  if (state.receipt !== undefined)
    parsed.receipt = parsePagesDeploymentReceipt(state.receipt);
  if (state.status !== undefined) {
    const status = checkpointFields(
      state.status,
      ["receipt", "classification", "apiStatus"],
      ["diagnostic"]
    );
    if (
      typeof status.classification !== "string" ||
      !["in-progress", "succeeded", "failed", "uncertain"].includes(
        status.classification
      ) ||
      (status.apiStatus !== null &&
        (typeof status.apiStatus !== "string" || status.apiStatus.length > 128))
    )
      throw new Error("Invalid Pages status checkpoint");
    parsed.status = {
      receipt: parsePagesDeploymentReceipt(status.receipt),
      classification:
        status.classification as PagesDeploymentStatusResult["classification"],
      apiStatus: status.apiStatus as string | null,
    };
    if (status.diagnostic !== undefined) {
      const diagnostic = checkpointFields(status.diagnostic, [
        "httpStatus",
        "responseBody",
      ]);
      if (
        typeof diagnostic.httpStatus !== "number" ||
        !Number.isInteger(diagnostic.httpStatus) ||
        diagnostic.httpStatus < 100 ||
        diagnostic.httpStatus > 599
      )
        throw new Error("Invalid Pages diagnostic checkpoint");
      parsed.status.diagnostic = {
        httpStatus: diagnostic.httpStatus,
        responseBody: diagnostic.responseBody,
      };
    }
    if (!parsed.receipt)
      throw new Error("Pages status checkpoint requires a deployment receipt");
    same(parsed.status.receipt, parsed.receipt, "checkpoint status receipt");
  }
  return parsed;
}

/** Caller chooses only scratch paths beneath RUNNER_TEMP, with no symlink components. */
export function requirePagesScratchPaths(
  temp: string,
  root: string,
  paths: string[]
): void {
  if (!isAbsolute(temp)) throw new Error("Runner temp must be absolute");
  const base = realpathSync(temp);
  for (const path of paths) {
    const target = resolve(path);
    const rel = relative(base, target);
    const workspaceRelative = relative(resolve(root), target);
    if (
      !isAbsolute(path) ||
      !rel ||
      rel === ".." ||
      rel.startsWith(".." + sep) ||
      isAbsolute(rel) ||
      (!workspaceRelative.startsWith(".." + sep) &&
        workspaceRelative !== ".." &&
        !isAbsolute(workspaceRelative))
    )
      throw new Error(
        "Pages output must stay in runner scratch outside the checkout"
      );
    let cursor = target;
    while (cursor !== base) {
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
        throw new Error("Pages scratch cannot contain symlinks");
      cursor = dirname(cursor);
    }
  }
  if (new Set(paths.map((path) => resolve(path))).size !== paths.length)
    throw new Error("Pages scratch outputs must be distinct");
}

/** Real controller transitions and Pages APIs, with only explicit isolated transports in tests. */
export function createPagesCandidateRunner(options: PagesRunnerOptions) {
  validateInputs(options.identity.inputs);
  const identity = structuredClone(options.identity);
  const { inputs, admission } = identity;
  let saved: RunnerState = { schemaVersion: 1, identity };
  if (existsSync(options.statePath)) {
    const stat = lstatSync(options.statePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 2 * 1024 * 1024
    )
      throw new Error("Unsafe Pages checkpoint");
    let supplied: unknown;
    try {
      supplied = JSON.parse(readFileSync(options.statePath, "utf8"));
    } catch {
      throw new Error("Invalid Pages checkpoint JSON");
    }
    const envelope = checkpointFields(supplied, ["state", "checksum"]);
    same(
      envelope.checksum,
      promotionDigest(envelope.state),
      "checkpoint checksum"
    );
    saved = parseRunnerState(envelope.state, identity);
  }
  const persist = (path = options.statePath) => {
    // Optional JSON fields are absent, never undefined in the checksummed projection.
    saved = parseRunnerState(JSON.parse(JSON.stringify(saved)), identity);
    writeDurableFile(
      path,
      Buffer.from(
        JSON.stringify({ state: saved, checksum: promotionDigest(saved) }) +
          "\n"
      )
    );
  };
  const current = () => {
    const record = options.store.read();
    if (!record.head || !record.bytes)
      throw new Error("Production promotion control is not bootstrapped");
    const state = parsePromotionControl(record.bytes);
    const operation = state.active;
    if (
      state.destination !== "production" ||
      !operation ||
      operation.operationId !== inputs.operation_id ||
      operation.request.requestId !== inputs.request_id
    )
      throw new Error("Stale Pages operation owner");
    const attempt =
      inputs.mode === "rollback"
        ? operation.rollbackAttempt
        : operation.promotionAttempt;
    if (
      !attempt ||
      attempt.attemptId !== inputs.attempt_id ||
      attempt.workflowCommit !== admission.workflowCommit ||
      attempt.expectedRunAttempt !== admission.runAttempt
    )
      throw new Error("Stale Pages workflow attempt");
    if (attempt.admission)
      same(attempt.admission, admission, "current admitted run");
    const target = inputs.mode === "rollback" ? operation.priorVerified : null;
    const request =
      target?.kind === "candidateRelease" ? target.request : operation.request;
    const legacy = target?.kind === "legacyPublicSnapshot" ? target : null;
    same(
      inputs.payload_commit,
      legacy?.retainedCommit ?? request.payloadCommit,
      "retained public commit"
    );
    same(
      inputs.candidate_id,
      legacy ? "legacy" : request.candidateId,
      "trusted candidate"
    );
    same(
      inputs.source_commit,
      legacy?.retainedCommit ?? request.sourceCommit,
      "reviewed source"
    );
    return {
      ...record,
      head: record.head,
      state,
      operation,
      attempt,
      legacy,
      inventorySha256: legacy?.inventorySha256 ?? request.publicInventorySha256,
    };
  };
  const commitAppend = (
    record: ReturnType<typeof current>,
    event: PromotionEvent
  ) => {
    const next = applyPromotionTransition(record.state, event);
    if (next.stateId === record.state.stateId) return record.head;
    const prepared = options.store.prepareAppend({
      expectedHead: record.head,
      bytes: serializePromotionControl(next),
      createdAt: new Date().toISOString(),
    });
    saved.pendingAppend = {
      expectedHead: record.head,
      attemptedHead: prepared.attemptedHead,
      bytes: prepared.bytes.toString("base64"),
      createdAt: prepared.createdAt,
    };
    // A losing writer must not overwrite the admitted owner's checkpoint.
    // Each prepared commit has a distinct recovery file before remote effects;
    // only a confirmed winner updates the shared job checkpoint below.
    persist(`${options.statePath}.append-${prepared.attemptedHead}.json`);
    const result = options.store.compareAndAppend(prepared);
    if (
      result.status !== "appended" ||
      result.observedHead !== prepared.attemptedHead
    )
      throw new Error(
        `Promotion append ${result.status}; retain ownership and reconcile the saved intent`
      );
    delete saved.pendingAppend;
    saved.admittedHead = prepared.attemptedHead;
    persist();
    return prepared.attemptedHead;
  };
  const append = (
    record: ReturnType<typeof current>,
    event: PromotionEvent
  ) => {
    commitAppend(record, event);
    return current();
  };
  const fields = {
    operationId: inputs.operation_id,
    mode: inputs.mode,
    attemptId: inputs.attempt_id,
  };
  const requireAdmitted = (record: ReturnType<typeof current>) => {
    if (!record.attempt.admission)
      throw new Error("Pages workflow has not been admitted");
    same(record.attempt.admission, admission, "admitted workflow");
  };
  const verifiedPublic = (record: ReturnType<typeof current>) => {
    requireAdmitted(record);
    if (!record.legacy) {
      options.transport.fetchCommit(inputs.source_commit);
      const gitEnv: NodeJS.ProcessEnv = {};
      for (const name of [
        "PATH",
        "Path",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
      ])
        if (process.env[name] !== undefined) gitEnv[name] = process.env[name];
      Object.assign(gitEnv, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
      });
      execFileSync(
        "git",
        [
          "--no-replace-objects",
          "-c",
          "core.hooksPath=",
          "merge-base",
          "--is-ancestor",
          inputs.source_commit,
          "refs/remotes/origin/main",
        ],
        {
          cwd: options.repositoryRoot,
          env: gitEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 30_000,
        }
      );
    }
    const ref = `refs/heads/zivv-candidate-artifacts/${inputs.payload_commit}`;
    if (options.transport.readHead(ref) !== inputs.payload_commit)
      throw new Error("Exact retained public artifact is missing or changed");
    options.transport.fetchCommit(inputs.payload_commit);
    const raw = readPublicationPayloadGit({
      repositoryRoot: options.repositoryRoot,
      payloadCommit: inputs.payload_commit,
    }).files;
    const publicFiles = record.legacy
      ? new Map(raw)
      : verifyPublicationPayload(raw, {
          expectedCandidateId: inputs.candidate_id,
          expectedSourceCommit: inputs.source_commit,
          purpose: "release",
          basePath: "/zivv/",
        }).publicFiles;
    const inventory = [...publicFiles]
      .map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: hash(bytes),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    same(
      promotionDigest(inventory),
      record.inventorySha256,
      "public inventory"
    );
    if (record.legacy)
      same(inventory, record.legacy.files, "legacy public inventory");
    return publicFiles;
  };
  const attach = (record: ReturnType<typeof current>) => {
    if (
      !saved.receipt &&
      record.attempt.deployment &&
      record.attempt.pagesCreation?.status === "attached"
    ) {
      saved.creationId = record.attempt.pagesCreation.creationId;
      saved.receipt = {
        repository: "prodigic/zivv",
        artifactId: record.attempt.deployment.artifactId,
        workflowCommit: admission.workflowCommit,
        owner: {
          operationId: inputs.operation_id,
          requestId: inputs.request_id,
          attemptId: inputs.attempt_id,
          runId: admission.runId,
          runAttempt: admission.runAttempt,
        },
        deploymentId: record.attempt.deployment.deploymentId,
        pageUrl: "https://www.prodigic.com/zivv/",
      };
      persist();
    }
    const receipt = saved.receipt
      ? parsePagesDeploymentReceipt(saved.receipt)
      : undefined;
    if (!receipt || !saved.creationId)
      throw new Error(
        "No durable exact Pages deployment receipt; creation remains uncertain"
      );
    same(
      receipt.owner,
      {
        operationId: inputs.operation_id,
        requestId: inputs.request_id,
        attemptId: inputs.attempt_id,
        runId: admission.runId,
        runAttempt: admission.runAttempt,
      },
      "deployment receipt owner"
    );
    same(
      receipt.workflowCommit,
      admission.workflowCommit,
      "deployment receipt workflow"
    );
    same(
      receipt.artifactId,
      record.attempt.pagesCreation?.artifactId,
      "deployment receipt artifact"
    );
    return append(record, {
      type: "deployed",
      ...fields,
      creationId: saved.creationId,
      deployment: {
        admission,
        artifactId: receipt.artifactId,
        deploymentId: receipt.deploymentId,
      },
    });
  };
  const api = {
    githubToken: options.githubToken,
    testTransport: options.testTransport,
  };
  return {
    admit() {
      let record = current();
      if (record.attempt.admission) {
        requireAdmitted(record);
        saved.admittedHead = record.head;
        persist();
        return { status: "admitted", controlHead: record.head };
      }
      if (record.head !== inputs.control_head)
        throw new Error("Admission requires the exact dispatched control head");
      record = append(record, { type: "admit-run", ...fields, admission });
      return { status: "admitted", controlHead: record.head };
    },
    materialize() {
      const record = current();
      authorizePromotionDeployment(record.state, { ...fields, admission });
      const files = verifiedPublic(record);
      const existing = checkPublicScratch(options.siteDirectory, files, false);
      mkdirSync(options.siteDirectory, { recursive: true });
      for (const [path, bytes] of files) {
        if (existing.has(path)) continue;
        const target = join(options.siteDirectory, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
      }
      checkPublicScratch(options.siteDirectory, files, true);
      // Only these verified public bytes are archived; no build, Git metadata or recovery material.
      writeDurableFile(options.archivePath, createPagesPublicArchive(files));
      checkPublicScratch(options.siteDirectory, files, true);
      saved.archiveSha256 = hash(readFileSync(options.archivePath));
      persist();
      return {
        status: "materialized",
        files: files.size,
        inventorySha256: record.inventorySha256,
      };
    },
    async requestDeployment() {
      let record = current();
      requireAdmitted(record);
      // A restarted requested attempt is recovery-only, even if its old nonce is readable.
      if (
        record.attempt.pagesCreation?.status === "requested" ||
        record.attempt.deployment
      ) {
        if (saved.receipt || record.attempt.deployment) record = attach(record);
        else
          throw new Error(
            "Pages creation is already requested; do not POST again, retain ownership for reconciliation"
          );
        return {
          status: "created",
          receipt: saved.receipt
            ? parsePagesDeploymentReceipt(saved.receipt)
            : undefined,
          controlHead: record.head,
        };
      }
      authorizePromotionDeployment(record.state, { ...fields, admission });
      verifiedPublic(record);
      if (
        !saved.archiveSha256 ||
        !existsSync(options.archivePath) ||
        hash(readFileSync(options.archivePath)) !== saved.archiveSha256
      )
        throw new Error(
          "Verified Pages archive checkpoint is missing or changed"
        );
      const artifactId = options.artifactId ?? "";
      if (
        !/^[1-9][0-9]{0,19}$/.test(artifactId) ||
        !Number.isSafeInteger(Number(artifactId))
      )
        throw new Error("Invalid uploaded Pages artifact identity");
      const oidcToken = await options.getOidcToken();
      const nonce = randomBytes(32).toString("hex");
      const creationNumber =
        (record.attempt.pagesCreation?.creationNumber ?? 0) + 1;
      const creationId = pagesCreationId(
        inputs.operation_id,
        inputs.attempt_id,
        creationNumber,
        nonce
      );
      const result = await requestGithubPagesDeployment({
        ...api,
        repository: "prodigic/zivv",
        artifactId,
        workflowCommit: admission.workflowCommit,
        owner: {
          operationId: inputs.operation_id,
          requestId: inputs.request_id,
          attemptId: inputs.attempt_id,
          runId: admission.runId,
          runAttempt: admission.runAttempt,
        },
        oidcToken,
        onIntent: async () => {
          // The API helper validates OIDC and authority before this remote effect.
          saved.creationId = creationId;
          record = append(record, {
            type: "pages-create-intent",
            ...fields,
            creationId,
            creationNumber,
            nonce,
            artifactId,
            admission,
          });
          authorizePagesCreation(record.state, {
            ...fields,
            admission,
            creationId,
          });
        },
        onCreated: async (receipt) => {
          saved.receipt = parsePagesDeploymentReceipt(receipt);
          persist();
        },
      });
      if (result.status === "created") {
        attach(current());
        return result;
      }
      if (result.status === "rejected") {
        append(current(), {
          type: "pages-create-rejected",
          ...fields,
          creationId,
          rejectionReceiptId: promotionDigest(result.diagnostic),
          httpStatus: result.diagnostic.httpStatus,
        });
      }
      if (result.status === "uncertain" && result.receipt)
        throw new PagesCreationUncertainError(result.receipt);
      throw new Error(
        `Pages creation ${result.status}; ownership remains held`
      );
    },
    async status() {
      let record = current();
      requireAdmitted(record);
      record = attach(record);
      if (!saved.receipt)
        throw new Error(
          "No durable deployment identity; cannot infer it from the live site"
        );
      const attempts = options.pollAttempts ?? 30;
      const interval = options.pollIntervalMs ?? 5_000;
      if (
        !Number.isSafeInteger(attempts) ||
        attempts < 1 ||
        attempts > 120 ||
        !Number.isSafeInteger(interval) ||
        interval < 0 ||
        interval > 30_000
      )
        throw new Error("Invalid bounded Pages status polling");
      for (let count = 0; count < attempts; count++) {
        const result = await getGithubPagesDeployment({
          ...api,
          receipt: saved.receipt,
        });
        saved.status = result;
        persist();
        if (result.classification === "succeeded") return result;
        if (result.classification === "failed") {
          append(current(), {
            type: "failed",
            ...fields,
            failureReceiptId: promotionDigest(result),
          });
          throw new Error(
            "Exact Pages deployment failed; controller ownership remains held"
          );
        }
        if (result.classification === "uncertain")
          throw new Error(
            "Exact Pages deployment status is uncertain; retain ownership"
          );
        if (count + 1 < attempts)
          await (
            options.sleep ??
            ((ms) => new Promise<void>((done) => setTimeout(done, ms)))
          )(interval);
      }
      throw new Error(
        "Bounded Pages status polling exhausted; retain ownership"
      );
    },
    async verifyRelease() {
      const record = current();
      requireAdmitted(record);
      if (!saved.receipt || !record.attempt.deployment)
        throw new Error(
          "Exact deployed identity is required before live verification"
        );
      same(
        record.attempt.deployment,
        {
          admission,
          artifactId: saved.receipt.artifactId,
          deploymentId: saved.receipt.deploymentId,
        },
        "live verification deployment"
      );
      // A previous poll is not a terminal-status authority for this invocation.
      const status = await getGithubPagesDeployment({
        ...api,
        receipt: saved.receipt,
      });
      if (status.classification !== "succeeded")
        throw new Error(
          "Live verification requires an exact successful terminal deployment"
        );
      const files = verifiedPublic(record);
      const prior = record.operation.priorVerified;
      const priorCommit =
        prior.kind === "legacyPublicSnapshot"
          ? prior.retainedCommit
          : prior.request.payloadCommit;
      const priorRef = `refs/heads/zivv-candidate-artifacts/${priorCommit}`;
      if (options.transport.readHead(priorRef) !== priorCommit)
        throw new Error(
          "Previous verified public recovery artifact is missing"
        );
      options.transport.fetchCommit(priorCommit);
      const priorRaw = readPublicationPayloadGit({
        repositoryRoot: options.repositoryRoot,
        payloadCommit: priorCommit,
      }).files;
      const priorFiles =
        prior.kind === "legacyPublicSnapshot"
          ? priorRaw
          : verifyPublicationPayload(priorRaw, {
              expectedCandidateId: prior.request.candidateId,
              expectedSourceCommit: prior.request.sourceCommit,
              purpose: "release",
              basePath: "/zivv/",
            }).publicFiles;
      const priorInventory = [...priorFiles]
        .map(([path, bytes]) => ({
          path,
          size: bytes.length,
          sha256: hash(bytes),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      same(
        promotionDigest(priorInventory),
        prior.kind === "legacyPublicSnapshot"
          ? prior.inventorySha256
          : prior.request.publicInventorySha256,
        "previous good recovery inventory"
      );
      let cacheSeedFiles = priorFiles;
      if (inputs.mode === "rollback") {
        const failedRequest = record.operation.request;
        const failedRef = `refs/heads/zivv-candidate-artifacts/${failedRequest.payloadCommit}`;
        if (
          options.transport.readHead(failedRef) !== failedRequest.payloadCommit
        )
          throw new Error("Failed release cache seed artifact is unavailable");
        options.transport.fetchCommit(failedRequest.payloadCommit);
        cacheSeedFiles = verifyPublicationPayload(
          readPublicationPayloadGit({
            repositoryRoot: options.repositoryRoot,
            payloadCommit: failedRequest.payloadCommit,
          }).files,
          {
            expectedCandidateId: failedRequest.candidateId,
            expectedSourceCommit: failedRequest.sourceCommit,
            purpose: "release",
            basePath: "/zivv/",
          }
        ).publicFiles;
        const failedInventory = [...cacheSeedFiles]
          .map(([path, bytes]) => ({
            path,
            size: bytes.length,
            sha256: hash(bytes),
          }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        same(
          promotionDigest(failedInventory),
          failedRequest.publicInventorySha256,
          "failed release cache seed inventory"
        );
      }
      const now = Date.now();
      try {
        const inventory = await verifyLiveInventory({
          destination: "production",
          files,
          expectedInventorySha256: record.inventorySha256,
        });
        const plan = buildReleaseBrowserPlan(files, now);
        const browser = await verifyReleaseBrowser({
          destination: "production",
          baseUrl: PROMOTION_DESTINATIONS.production.liveUrl,
          ...plan,
          prior: { files: cacheSeedFiles },
        });
        const expectedManifestSha256 = hash(files.get("data/manifest.json")!);
        if (
          !plan.routes.length ||
          browser.observations.length !== plan.routes.length * 4 ||
          browser.observations.some(
            (observation) =>
              observation.manifestSha256 !== expectedManifestSha256
          )
        )
          throw new Error(
            "Browser did not observe the exact retained manifest in every client and viewport"
          );
        // Browser loading can overlap a change at the CDN. Confirm bytes again.
        await verifyLiveInventory({
          destination: "production",
          files,
          expectedInventorySha256: record.inventorySha256,
        });
        const body = {
          destination: "production" as const,
          liveUrl: PROMOTION_DESTINATIONS.production.liveUrl,
          releaseId:
            inputs.mode === "rollback"
              ? prior.releaseId
              : candidatePublicReleaseId(
                  "production",
                  record.operation.request
                ),
          inventorySha256: inventory.inventorySha256,
          deployment: record.attempt.deployment,
          verifiedAt: new Date().toISOString(),
          checks: {
            inventory: true as const,
            routes: browser.routes,
            cachedClient: browser.cachedClient,
            freshClient: browser.freshClient,
          },
        };
        const verification = { ...body, receiptId: promotionDigest(body) };
        // Re-read after observations: stale jobs cannot verify another owner.
        const latest = current();
        same(
          latest.attempt.deployment,
          record.attempt.deployment,
          "unchanged verification owner"
        );
        writeDurableFile(
          `${options.statePath}.verification-${verification.receiptId}.json`,
          Buffer.from(
            JSON.stringify({
              verification,
              inventory,
              recoveryInventorySha256: promotionDigest(priorInventory),
              browser,
            }) + "\n"
          )
        );
        const accepted = latest.operation.verification ?? verification;
        if (!latest.operation.verification)
          commitAppend(latest, {
            type: "verified",
            ...fields,
            verification: accepted,
            replayProof: null,
          });
        return {
          type: "release-verification-receipt",
          verification: accepted,
          manifestSha256: inventory.manifestSha256,
          recoveryInventorySha256: promotionDigest(priorInventory),
          browser,
          cutoffAcknowledged: false,
        };
      } catch {
        const latest = current();
        // Do not revoke an already verified operation on an unrelated resume failure.
        if (
          latest.operation.phase ===
          (inputs.mode === "rollback" ? "rollback-deployed" : "deployed")
        )
          append(latest, {
            type: "failed",
            ...fields,
            failureReceiptId: promotionDigest({
              type: "live-verification-failed",
              operationId: inputs.operation_id,
              attemptId: inputs.attempt_id,
              deployment: record.attempt.deployment,
            }),
          });
        throw new Error(
          "Live verification failed; previous public release requires recovery and operator alert"
        );
      }
    },
    receipt() {
      const record = current();
      requireAdmitted(record);
      if (
        !saved.receipt ||
        saved.status?.classification !== "succeeded" ||
        !record.attempt.deployment
      )
        throw new Error(
          "An exact successful Pages deployment receipt is required"
        );
      same(saved.status.receipt, saved.receipt, "status receipt");
      same(
        record.attempt.deployment,
        {
          admission,
          artifactId: saved.receipt.artifactId,
          deploymentId: saved.receipt.deploymentId,
        },
        "controller deployment receipt"
      );
      return {
        type: "pages-deployment-receipt",
        deployment: parsePagesDeploymentReceipt(saved.receipt),
        classification: "succeeded",
        publicInventorySha256: record.inventorySha256,
        liveVerified: false,
        cutoffAcknowledged: false,
      };
    },
  };
}
