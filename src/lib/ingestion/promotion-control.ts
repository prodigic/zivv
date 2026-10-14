import { createHash } from "node:crypto";

/** Destinations are policy, never caller-supplied repositories, refs or URLs. */
export const PROMOTION_DESTINATIONS = {
  production: {
    repository: "prodigic/zivv",
    purpose: "release",
    basePath: "/zivv/",
    liveUrl: "https://www.prodigic.com/zivv/",
  },
  preview: {
    repository: "prodigic/zivv-test",
    purpose: "preview",
    basePath: "/zivv-test/",
    liveUrl: "https://www.prodigic.com/zivv-test/",
  },
} as const;
export type PromotionDestination = keyof typeof PROMOTION_DESTINATIONS;
export type PromotionMode = "promote" | "rollback";

export interface PublicFileInventory {
  path: string;
  size: number;
  sha256: string;
}
export interface LiveChecks {
  inventory: true;
  routes: true;
  cachedClient: true;
  freshClient: true;
}
export interface LegacyLiveVerification {
  receiptId: string;
  destination: PromotionDestination;
  liveUrl: string;
  retainedCommit: string;
  inventorySha256: string;
  verifiedAt: string;
  checks: LiveChecks;
}
/** Retained public bytes have no invented candidate or authenticated ledger pair. */
export interface LegacyPublicSnapshot {
  kind: "legacyPublicSnapshot";
  releaseId: string;
  destination: PromotionDestination;
  retainedCommit: string;
  files: PublicFileInventory[];
  inventorySha256: string;
  verification: LegacyLiveVerification;
}
export interface PromotionRequest {
  requestId: string;
  payloadCommit: string;
  candidateId: string;
  sourceCommit: string;
  basePath: string;
  purpose: "release" | "preview";
  publicInventorySha256: string;
  expectedVerifiedReleaseId: string;
}
export interface RunAdmission {
  workflowCommit: string;
  runId: string;
  runAttempt: number;
}
export interface PromotionDeployment {
  admission: RunAdmission;
  artifactId: string;
  deploymentId: string;
}
export interface PromotionVerification {
  receiptId: string;
  destination: PromotionDestination;
  liveUrl: string;
  releaseId: string;
  inventorySha256: string;
  deployment: PromotionDeployment;
  verifiedAt: string;
  checks: LiveChecks;
}
export interface CandidatePublicRelease {
  kind: "candidateRelease";
  releaseId: string;
  destination: PromotionDestination;
  request: PromotionRequest;
  deployment: PromotionDeployment;
  verification: PromotionVerification;
}
export type VerifiedPublicRelease =
  | LegacyPublicSnapshot
  | CandidatePublicRelease;
export interface PromotionAttempt {
  attemptId: string;
  attemptNumber: number;
  workflowCommit: string;
  expectedRunAttempt: number;
  status:
    | "planned"
    | "uncertain"
    | "fenced"
    | "admitted"
    | "deployed"
    | "failed";
  fenceReceiptId: string | null;
  admission: RunAdmission | null;
  deployment: PromotionDeployment | null;
  failureReceiptId: string | null;
}
export type PromotionPhase =
  | "claimed"
  | "dispatch-planned"
  | "dispatch-uncertain"
  | "dispatch-fenced"
  | "admitted"
  | "deployed"
  | "verified"
  | "rollback-required"
  | "rollback-planned"
  | "rollback-uncertain"
  | "rollback-fenced"
  | "rollback-admitted"
  | "rollback-deployed";
export interface PromotionOperation {
  operationId: string;
  request: PromotionRequest;
  priorVerified: VerifiedPublicRelease;
  phase: PromotionPhase;
  promotionAttemptNumber: number;
  promotionAttempt: PromotionAttempt | null;
  rollbackAttemptNumber: number;
  rollbackAttempt: PromotionAttempt | null;
  completionProof: CompletionProof;
  verification: PromotionVerification | null;
}
export interface CompletedPromotion {
  operationId: string;
  destination: PromotionDestination;
  request: PromotionRequest;
  priorVerifiedReleaseId: string;
  priorInventorySha256: string;
  terminalAttemptId: string;
  outcome: "acknowledged" | "rolled-back";
  acknowledgementId: string | null;
  verification: PromotionVerification;
}
export interface CompletionTreeEntry {
  name: string;
  objectId: string;
}
/** Exactly 64 levels of at most 15 sibling entries; no cumulative release history. */
export interface CompletionProof {
  key: string;
  record: CompletedPromotion | null;
  levels: CompletionTreeEntry[][];
}
export interface CompletionGitObject {
  type: "tree" | "blob";
  bytes: Buffer;
}
export interface PromotionAppendObjects {
  completionTree: string;
  objects: Map<string, CompletionGitObject>;
}
export type CompletionObjectReader = (
  objectId: string,
  type: "tree" | "blob"
) => Buffer;
export type PromotionEvent =
  | { type: "bootstrap"; snapshot: LegacyPublicSnapshot }
  | { type: "claim"; request: PromotionRequest; proof: CompletionProof }
  | {
      type: "dispatch-intent";
      operationId: string;
      mode: PromotionMode;
      attemptId: string;
      attemptNumber: number;
      workflowCommit: string;
      expectedRunAttempt: number;
    }
  | {
      type: "dispatch-uncertain";
      operationId: string;
      mode: PromotionMode;
      attemptId: string;
    }
  | {
      type: "fence-dispatch";
      operationId: string;
      mode: PromotionMode;
      attemptId: string;
      fenceReceiptId: string;
    }
  | {
      type: "admit-run";
      operationId: string;
      mode: PromotionMode;
      attemptId: string;
      admission: RunAdmission;
    }
  | {
      type: "deployed";
      operationId: string;
      mode: PromotionMode;
      attemptId: string;
      deployment: PromotionDeployment;
    }
  | {
      type: "failed";
      operationId: string;
      mode: PromotionMode;
      attemptId: string;
      failureReceiptId: string;
    }
  | {
      type: "verified";
      operationId: string;
      mode: PromotionMode;
      attemptId: string;
      verification: PromotionVerification;
      replayProof: CompletionProof | null;
    }
  | {
      type: "acknowledged";
      operationId: string;
      verificationReceiptId: string;
      acknowledgementId: string;
      replayProof: CompletionProof | null;
    };
export interface PromotionTransitionRecord {
  previousStateId: string | null;
  event: PromotionEvent;
}
export interface PromotionControl {
  schemaVersion: 1;
  stateId: string;
  revision: number;
  destination: PromotionDestination;
  lastVerified: VerifiedPublicRelease;
  active: PromotionOperation | null;
  completedCount: number;
  completionRoot: string;
  lastTransition: PromotionTransitionRecord;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported promotion metadata");
}
/** Stable identity for public-safe typed receipts; does not verify external effects. */
export function promotionDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function same(actual: unknown, expected: unknown, label: string): void {
  if (canonical(actual) !== canonical(expected))
    throw new Error(`Promotion mismatch: ${label}`);
}
function object(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid promotion object");
  const result = value as Record<string, unknown>;
  same(Object.keys(result).sort(), [...keys].sort(), "schema fields");
  return result;
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid promotion SHA256");
}
function commit(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value))
    throw new Error("Invalid promotion Git commit");
}
function positive(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid promotion attempt number");
}
function githubId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value))
    throw new Error("Invalid GitHub effect identity");
}
function destination(value: unknown): asserts value is PromotionDestination {
  if (value !== "production" && value !== "preview")
    throw new Error("Unsupported promotion destination");
}
function mode(value: unknown): asserts value is PromotionMode {
  if (value !== "promote" && value !== "rollback")
    throw new Error("Invalid promotion mode");
}
function checks(value: unknown): void {
  const fields = object(value, [
    "inventory",
    "routes",
    "cachedClient",
    "freshClient",
  ]);
  if (Object.values(fields).some((checked) => checked !== true))
    throw new Error("Incomplete live verification");
}
function timestamp(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  )
    throw new Error("Invalid verification timestamp");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new Error("Noncanonical verification timestamp");
}
function receiptIdentity(value: Record<string, unknown>): void {
  const { receiptId, ...body } = value;
  digest(receiptId);
  same(receiptId, promotionDigest(body), "receipt identity");
}
function parseAdmission(value: unknown): RunAdmission {
  const fields = object(value, ["workflowCommit", "runId", "runAttempt"]);
  commit(fields.workflowCommit);
  githubId(fields.runId);
  positive(fields.runAttempt);
  return fields as unknown as RunAdmission;
}
function parseDeployment(value: unknown): PromotionDeployment {
  const fields = object(value, ["admission", "artifactId", "deploymentId"]);
  parseAdmission(fields.admission);
  githubId(fields.artifactId);
  githubId(fields.deploymentId);
  return fields as unknown as PromotionDeployment;
}
function parseVerification(value: unknown): PromotionVerification {
  const fields = object(value, [
    "receiptId",
    "destination",
    "liveUrl",
    "releaseId",
    "inventorySha256",
    "deployment",
    "verifiedAt",
    "checks",
  ]);
  destination(fields.destination);
  same(
    fields.liveUrl,
    PROMOTION_DESTINATIONS[fields.destination].liveUrl,
    "live URL"
  );
  digest(fields.releaseId);
  digest(fields.inventorySha256);
  parseDeployment(fields.deployment);
  timestamp(fields.verifiedAt);
  checks(fields.checks);
  receiptIdentity(fields);
  return fields as unknown as PromotionVerification;
}
function publicPath(path: unknown): asserts path is string {
  if (
    typeof path !== "string" ||
    !(
      [
        "index.html",
        "404.html",
        "manifest.json",
        "vite.svg",
        ".nojekyll",
      ].includes(path) ||
      /^assets\/[A-Za-z0-9_-]+\.(?:js|css|png|jpg|jpeg|webp|svg|woff2)$/.test(
        path
      ) ||
      [
        "manifest.json",
        "artists.json",
        "venues.json",
        "indexes.json",
        "recent-additions.json",
        "search-documents.json",
        "search-terms.json",
        "local-artists.json",
        "local-artist-exclude.json",
      ].some((name) => path === `data/${name}`) ||
      /^data\/events-\d{4}-(?:0[1-9]|1[0-2])\.json$/.test(path)
    )
  )
    throw new Error("Unsupported retained public path");
}
function parseLegacy(value: unknown): LegacyPublicSnapshot {
  const fields = object(value, [
    "kind",
    "releaseId",
    "destination",
    "retainedCommit",
    "files",
    "inventorySha256",
    "verification",
  ]);
  same(fields.kind, "legacyPublicSnapshot", "bootstrap kind");
  destination(fields.destination);
  commit(fields.retainedCommit);
  digest(fields.inventorySha256);
  digest(fields.releaseId);
  if (!Array.isArray(fields.files) || fields.files.length === 0)
    throw new Error("Missing retained public inventory");
  let previousPath = "";
  const foldedPaths = new Set<string>();
  for (const entry of fields.files) {
    const file = object(entry, ["path", "size", "sha256"]);
    publicPath(file.path);
    if (
      file.path <= previousPath ||
      foldedPaths.has(file.path.toLowerCase()) ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new Error("Invalid retained public inventory");
    digest(file.sha256);
    foldedPaths.add(file.path.toLowerCase());
    previousPath = file.path;
  }
  for (const required of ["index.html", "data/manifest.json"])
    if (
      !fields.files.some(
        (file: unknown) =>
          (file as PublicFileInventory).path === required &&
          (file as PublicFileInventory).size > 0
      )
    )
      throw new Error("Incomplete retained public inventory");
  same(
    fields.inventorySha256,
    promotionDigest(fields.files),
    "retained inventory"
  );
  const { releaseId, verification, ...identity } = fields;
  same(releaseId, promotionDigest(identity), "legacy release identity");
  const receipt = object(verification, [
    "receiptId",
    "destination",
    "liveUrl",
    "retainedCommit",
    "inventorySha256",
    "verifiedAt",
    "checks",
  ]);
  same(
    receipt.destination,
    fields.destination,
    "legacy verification destination"
  );
  same(
    receipt.liveUrl,
    PROMOTION_DESTINATIONS[fields.destination].liveUrl,
    "legacy live URL"
  );
  same(receipt.retainedCommit, fields.retainedCommit, "legacy retained commit");
  same(
    receipt.inventorySha256,
    fields.inventorySha256,
    "legacy observed inventory"
  );
  timestamp(receipt.verifiedAt);
  checks(receipt.checks);
  receiptIdentity(receipt);
  return fields as unknown as LegacyPublicSnapshot;
}
function parseRequest(value: unknown): PromotionRequest {
  const fields = object(value, [
    "requestId",
    "payloadCommit",
    "candidateId",
    "sourceCommit",
    "basePath",
    "purpose",
    "publicInventorySha256",
    "expectedVerifiedReleaseId",
  ]);
  if (
    typeof fields.requestId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(fields.requestId)
  )
    throw new Error("Invalid promotion request ID");
  commit(fields.payloadCommit);
  commit(fields.sourceCommit);
  digest(fields.candidateId);
  digest(fields.publicInventorySha256);
  digest(fields.expectedVerifiedReleaseId);
  if (
    !Object.values(PROMOTION_DESTINATIONS).some(
      (target) =>
        target.purpose === fields.purpose && target.basePath === fields.basePath
    )
  )
    throw new Error("Unsupported promotion purpose/base");
  return fields as unknown as PromotionRequest;
}
function parseEvent(value: unknown): PromotionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid promotion event");
  const type = (value as Record<string, unknown>).type;
  if (type === "bootstrap") {
    const fields = object(value, ["type", "snapshot"]);
    parseLegacy(fields.snapshot);
  } else if (type === "claim") {
    const fields = object(value, ["type", "request", "proof"]);
    parseRequest(fields.request);
    parseCompletionProof(fields.proof);
  } else if (type === "acknowledged") {
    const fields = object(value, [
      "type",
      "operationId",
      "verificationReceiptId",
      "acknowledgementId",
      "replayProof",
    ]);
    digest(fields.operationId);
    digest(fields.verificationReceiptId);
    digest(fields.acknowledgementId);
    if (fields.replayProof !== null) parseCompletionProof(fields.replayProof);
  } else {
    const extra: Record<string, string[]> = {
      "dispatch-intent": [
        "attemptNumber",
        "workflowCommit",
        "expectedRunAttempt",
      ],
      "dispatch-uncertain": [],
      "fence-dispatch": ["fenceReceiptId"],
      "admit-run": ["admission"],
      deployed: ["deployment"],
      failed: ["failureReceiptId"],
      verified: ["verification", "replayProof"],
    };
    if (typeof type !== "string" || !Object.hasOwn(extra, type))
      throw new Error("Unknown promotion event");
    const fields = object(value, [
      "type",
      "operationId",
      "mode",
      "attemptId",
      ...extra[type],
    ]);
    digest(fields.operationId);
    digest(fields.attemptId);
    mode(fields.mode);
    if (type === "dispatch-intent") {
      positive(fields.attemptNumber);
      positive(fields.expectedRunAttempt);
      commit(fields.workflowCommit);
    }
    if (type === "fence-dispatch") digest(fields.fenceReceiptId);
    if (type === "admit-run") parseAdmission(fields.admission);
    if (type === "deployed") parseDeployment(fields.deployment);
    if (type === "failed") digest(fields.failureReceiptId);
    if (type === "verified") {
      parseVerification(fields.verification);
      if (fields.replayProof !== null) parseCompletionProof(fields.replayProof);
    }
  }
  return value as PromotionEvent;
}
function releaseInventory(release: VerifiedPublicRelease): string {
  return release.kind === "legacyPublicSnapshot"
    ? release.inventorySha256
    : release.request.publicInventorySha256;
}
export function candidatePublicReleaseId(
  destinationId: PromotionDestination,
  request: PromotionRequest
): string {
  return promotionDigest({
    kind: "candidateRelease",
    destination: destinationId,
    request,
  });
}
export function promotionOperationId(
  destinationId: PromotionDestination,
  request: PromotionRequest
): string {
  return promotionDigest({ destination: destinationId, request });
}
export function promotionAttemptId(
  operationId: string,
  modeId: PromotionMode,
  attemptNumber: number,
  workflowCommit: string,
  expectedRunAttempt: number
): string {
  return promotionDigest({
    operationId,
    mode: modeId,
    attemptNumber,
    workflowCommit,
    expectedRunAttempt,
  });
}
export const EMPTY_COMPLETION_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
function gitHash(type: "tree" | "blob", bytes: Buffer): string {
  return createHash("sha1")
    .update(type + " " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
}
function treeBytes(entries: CompletionTreeEntry[], leaf: boolean): Buffer {
  return Buffer.concat(
    entries.map((entry) =>
      Buffer.concat([
        Buffer.from(
          (leaf ? "100644" : "40000") + " " + entry.name + "\0",
          "ascii"
        ),
        Buffer.from(entry.objectId, "hex"),
      ])
    )
  );
}
function completionKey(requestId: string): string {
  return promotionDigest(requestId);
}
function parseCompleted(value: unknown): CompletedPromotion {
  const fields = object(value, [
    "operationId",
    "destination",
    "request",
    "priorVerifiedReleaseId",
    "priorInventorySha256",
    "terminalAttemptId",
    "outcome",
    "acknowledgementId",
    "verification",
  ]);
  destination(fields.destination);
  const request = parseRequest(fields.request);
  const target = PROMOTION_DESTINATIONS[fields.destination];
  same(request.basePath, target.basePath, "completed destination base");
  same(request.purpose, target.purpose, "completed destination purpose");
  same(
    fields.operationId,
    promotionOperationId(fields.destination, request),
    "completed operation"
  );
  digest(fields.priorVerifiedReleaseId);
  digest(fields.priorInventorySha256);
  digest(fields.terminalAttemptId);
  same(
    request.expectedVerifiedReleaseId,
    fields.priorVerifiedReleaseId,
    "completed prior release"
  );
  const verification = parseVerification(fields.verification);
  same(
    verification.destination,
    fields.destination,
    "completed verification destination"
  );
  if (fields.outcome === "acknowledged") {
    digest(fields.acknowledgementId);
    same(
      verification.releaseId,
      candidatePublicReleaseId(fields.destination, request),
      "completed candidate verification"
    );
    same(
      verification.inventorySha256,
      request.publicInventorySha256,
      "completed candidate inventory"
    );
  } else if (fields.outcome === "rolled-back") {
    same(fields.acknowledgementId, null, "rollback acknowledgement");
    same(
      verification.releaseId,
      fields.priorVerifiedReleaseId,
      "completed rollback release"
    );
    same(
      verification.inventorySha256,
      fields.priorInventorySha256,
      "completed rollback inventory"
    );
  } else throw new Error("Invalid completed promotion outcome");
  return fields as unknown as CompletedPromotion;
}
function parseCompletionProof(value: unknown): CompletionProof {
  const fields = object(value, ["key", "record", "levels"]);
  digest(fields.key);
  if (fields.record !== null) {
    const record = parseCompleted(fields.record);
    same(
      fields.key,
      completionKey(record.request.requestId),
      "completion record key"
    );
  }
  if (!Array.isArray(fields.levels) || fields.levels.length !== 64)
    throw new Error("Completion proof must have 64 bounded levels");
  fields.levels.forEach((level: unknown, depth: number) => {
    if (!Array.isArray(level) || level.length > 15)
      throw new Error("Invalid completion proof level");
    let prior = "";
    for (const entry of level) {
      const item = object(entry, ["name", "objectId"]);
      if (
        typeof item.name !== "string" ||
        !/^[0-9a-f]$/.test(item.name) ||
        item.name <= prior ||
        item.name === (fields.key as string)[depth]
      )
        throw new Error("Invalid completion sibling name");
      commit(item.objectId);
      if (depth < 63 && item.objectId === EMPTY_COMPLETION_TREE)
        throw new Error("Completion proof contains empty child tree");
      prior = item.name;
    }
  });
  return fields as unknown as CompletionProof;
}
function proofTree(
  proof: CompletionProof,
  replacement: CompletedPromotion | null
): PromotionAppendObjects {
  const objects = new Map<string, CompletionGitObject>();
  let child: string | null = null;
  if (replacement !== null) {
    const bytes = Buffer.from(canonical(parseCompleted(replacement)), "utf8");
    child = gitHash("blob", bytes);
    objects.set(child, { type: "blob", bytes });
  }
  for (let depth = 63; depth >= 0; depth--) {
    const entries = [...proof.levels[depth]];
    if (child !== null)
      entries.push({ name: proof.key[depth], objectId: child });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const bytes = treeBytes(entries, depth === 63);
    const hash = gitHash("tree", bytes);
    if (hash !== EMPTY_COMPLETION_TREE)
      objects.set(hash, { type: "tree", bytes });
    child = hash === EMPTY_COMPLETION_TREE ? null : hash;
  }
  return { completionTree: child ?? EMPTY_COMPLETION_TREE, objects };
}
/** Validate immutable membership/nonmembership against the exact control root. */
export function verifyCompletionProof(
  root: string,
  requestId: string,
  supplied: CompletionProof
): CompletedPromotion | null {
  commit(root);
  const proof = parseCompletionProof(supplied);
  same(proof.key, completionKey(requestId), "completion lookup key");
  same(
    proofTree(proof, proof.record).completionTree,
    root,
    "completion proof root"
  );
  return proof.record;
}
function readTree(bytes: Buffer, depth: number): CompletionTreeEntry[] {
  const entries: CompletionTreeEntry[] = [];
  let offset = 0;
  let prior = "";
  while (offset < bytes.length) {
    const nul = bytes.indexOf(0, offset);
    if (nul < 0 || nul + 21 > bytes.length)
      throw new Error("Malformed completion Git tree");
    const header = bytes.subarray(offset, nul).toString("ascii");
    const match = /^(40000|100644) ([0-9a-f])$/.exec(header);
    if (
      !match ||
      match[1] !== (depth === 63 ? "100644" : "40000") ||
      match[2] <= prior
    )
      throw new Error("Unsupported completion Git tree entry");
    const objectId = bytes.subarray(nul + 1, nul + 21).toString("hex");
    if (depth < 63 && objectId === EMPTY_COMPLETION_TREE)
      throw new Error("Empty completion child tree");
    entries.push({ name: match[2], objectId });
    prior = match[2];
    offset = nul + 21;
  }
  if (entries.length > 16) throw new Error("Unbounded completion tree fanout");
  return entries;
}
/** Read only one bounded Git path; no scan of historical control commits. */
export function createCompletionProof(
  root: string,
  requestId: string,
  reader: CompletionObjectReader
): CompletionProof {
  commit(root);
  const key = completionKey(requestId);
  const levels: CompletionTreeEntry[][] = [];
  let current: string | null = root === EMPTY_COMPLETION_TREE ? null : root;
  for (let depth = 0; depth < 64; depth++) {
    if (current === null) {
      levels.push([]);
      continue;
    }
    const bytes = reader(current, "tree");
    if (!Buffer.isBuffer(bytes) || gitHash("tree", bytes) !== current)
      throw new Error("Completion tree object hash mismatch");
    const entries = readTree(bytes, depth);
    levels.push(entries.filter((entry) => entry.name !== key[depth]));
    current =
      entries.find((entry) => entry.name === key[depth])?.objectId ?? null;
  }
  let record: CompletedPromotion | null = null;
  if (current !== null) {
    const bytes = reader(current, "blob");
    if (!Buffer.isBuffer(bytes) || gitHash("blob", bytes) !== current)
      throw new Error("Completion record object hash mismatch");
    record = parseCompleted(JSON.parse(bytes.toString("utf8")));
    same(
      bytes.toString("utf8"),
      canonical(record),
      "canonical completion record"
    );
  }
  const proof = { key, record, levels };
  verifyCompletionProof(root, requestId, proof);
  return proof;
}
function seal(body: Omit<PromotionControl, "stateId">): PromotionControl {
  return { ...body, stateId: promotionDigest(body) };
}
function bootstrap(snapshot: LegacyPublicSnapshot): PromotionControl {
  return seal({
    schemaVersion: 1,
    revision: 0,
    destination: snapshot.destination,
    lastVerified: snapshot,
    active: null,
    completedCount: 0,
    completionRoot: EMPTY_COMPLETION_TREE,
    lastTransition: {
      previousStateId: null,
      event: { type: "bootstrap", snapshot },
    },
  });
}
function parseRelease(value: unknown): VerifiedPublicRelease {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).kind === "legacyPublicSnapshot"
  )
    return parseLegacy(value);
  const fields = object(value, [
    "kind",
    "releaseId",
    "destination",
    "request",
    "deployment",
    "verification",
  ]);
  same(fields.kind, "candidateRelease", "verified release kind");
  destination(fields.destination);
  const request = parseRequest(fields.request);
  same(
    request.basePath,
    PROMOTION_DESTINATIONS[fields.destination].basePath,
    "verified release base"
  );
  same(
    request.purpose,
    PROMOTION_DESTINATIONS[fields.destination].purpose,
    "verified release purpose"
  );
  same(
    fields.releaseId,
    candidatePublicReleaseId(fields.destination, request),
    "verified candidate release identity"
  );
  parseDeployment(fields.deployment);
  const verification = parseVerification(fields.verification);
  same(
    verification.destination,
    fields.destination,
    "verified release destination"
  );
  same(verification.releaseId, fields.releaseId, "verified release receipt");
  same(
    verification.inventorySha256,
    request.publicInventorySha256,
    "verified release inventory"
  );
  same(
    verification.deployment,
    fields.deployment,
    "verified release deployment"
  );
  return fields as unknown as CandidatePublicRelease;
}
function nonnegative(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid promotion counter");
}
function parseAttempt(
  value: unknown,
  operationId: string,
  modeId: PromotionMode,
  counter: number
): PromotionAttempt | null {
  if (counter === 0) {
    same(value, null, "zero attempt counter");
    return null;
  }
  const fields = object(value, [
    "attemptId",
    "attemptNumber",
    "workflowCommit",
    "expectedRunAttempt",
    "status",
    "fenceReceiptId",
    "admission",
    "deployment",
    "failureReceiptId",
  ]);
  same(fields.attemptNumber, counter, "current attempt counter");
  positive(fields.expectedRunAttempt);
  commit(fields.workflowCommit);
  same(
    fields.attemptId,
    promotionAttemptId(
      operationId,
      modeId,
      counter,
      fields.workflowCommit,
      fields.expectedRunAttempt
    ),
    "current attempt identity"
  );
  if (
    ![
      "planned",
      "uncertain",
      "fenced",
      "admitted",
      "deployed",
      "failed",
    ].includes(String(fields.status))
  )
    throw new Error("Invalid attempt status");
  if (fields.status === "fenced") digest(fields.fenceReceiptId);
  else same(fields.fenceReceiptId, null, "unfenced attempt receipt");
  if (["planned", "uncertain", "fenced"].includes(String(fields.status))) {
    same(fields.admission, null, "unadmitted attempt");
    same(fields.deployment, null, "undeployed attempt");
    same(fields.failureReceiptId, null, "unfailed attempt");
  } else {
    const admission = parseAdmission(fields.admission);
    same(admission.workflowCommit, fields.workflowCommit, "attempt workflow");
    same(admission.runAttempt, fields.expectedRunAttempt, "attempt run number");
    if (fields.deployment !== null) {
      const deployed = parseDeployment(fields.deployment);
      same(deployed.admission, admission, "attempt deployment admission");
    }
    if (fields.status === "admitted")
      same(fields.deployment, null, "admitted attempt deployment");
    if (fields.status === "deployed" && fields.deployment === null)
      throw new Error("Missing deployed attempt");
    if (fields.status === "failed") digest(fields.failureReceiptId);
    else same(fields.failureReceiptId, null, "unfailed admitted attempt");
  }
  return fields as unknown as PromotionAttempt;
}
function parseOperation(
  value: unknown,
  state: {
    destination: PromotionDestination;
    lastVerified: VerifiedPublicRelease;
    completionRoot: string;
  }
): PromotionOperation {
  const fields = object(value, [
    "operationId",
    "request",
    "priorVerified",
    "phase",
    "promotionAttemptNumber",
    "promotionAttempt",
    "rollbackAttemptNumber",
    "rollbackAttempt",
    "completionProof",
    "verification",
  ]);
  const request = parseRequest(fields.request);
  same(
    request.basePath,
    PROMOTION_DESTINATIONS[state.destination].basePath,
    "operation base"
  );
  same(
    request.purpose,
    PROMOTION_DESTINATIONS[state.destination].purpose,
    "operation purpose"
  );
  const operationId = promotionOperationId(state.destination, request);
  same(fields.operationId, operationId, "operation identity");
  const prior = parseRelease(fields.priorVerified);
  same(prior.destination, state.destination, "prior destination");
  same(
    request.expectedVerifiedReleaseId,
    prior.releaseId,
    "operation prior release"
  );
  const proof = parseCompletionProof(fields.completionProof);
  same(
    verifyCompletionProof(state.completionRoot, request.requestId, proof),
    null,
    "claimed request completion absence"
  );
  nonnegative(fields.promotionAttemptNumber);
  nonnegative(fields.rollbackAttemptNumber);
  const promotion = parseAttempt(
    fields.promotionAttempt,
    operationId,
    "promote",
    fields.promotionAttemptNumber
  );
  const rollback = parseAttempt(
    fields.rollbackAttempt,
    operationId,
    "rollback",
    fields.rollbackAttemptNumber
  );
  const expected: Record<string, string | null> = {
    claimed: null,
    "dispatch-planned": "planned",
    "dispatch-uncertain": "uncertain",
    "dispatch-fenced": "fenced",
    admitted: "admitted",
    deployed: "deployed",
    verified: "deployed",
  };
  if (typeof fields.phase !== "string")
    throw new Error("Invalid operation phase");
  if (Object.hasOwn(expected, fields.phase)) {
    same(
      promotion?.status ?? null,
      expected[fields.phase],
      "promotion phase status"
    );
    same(fields.rollbackAttemptNumber, 0, "premature rollback counter");
  } else {
    same(
      promotion?.status,
      "failed",
      "rollback requires terminal promotion failure"
    );
    const rollbackStatuses: Record<string, string> = {
      "rollback-planned": "planned",
      "rollback-uncertain": "uncertain",
      "rollback-fenced": "fenced",
      "rollback-admitted": "admitted",
      "rollback-deployed": "deployed",
    };
    if (fields.phase === "rollback-required") {
      if (rollback !== null && rollback.status !== "failed")
        throw new Error("Unresolved rollback effect");
    } else if (Object.hasOwn(rollbackStatuses, fields.phase))
      same(
        rollback?.status,
        rollbackStatuses[fields.phase],
        "rollback phase status"
      );
    else throw new Error("Invalid operation phase");
  }
  if (fields.phase === "verified") {
    const verification = parseVerification(fields.verification);
    same(
      verification.destination,
      state.destination,
      "operation verification destination"
    );
    same(
      verification.releaseId,
      candidatePublicReleaseId(state.destination, request),
      "operation verification release"
    );
    same(
      verification.inventorySha256,
      request.publicInventorySha256,
      "operation verification inventory"
    );
    same(
      verification.deployment,
      promotion?.deployment,
      "operation verification deployment"
    );
    same(
      state.lastVerified,
      {
        kind: "candidateRelease",
        releaseId: verification.releaseId,
        destination: state.destination,
        request,
        deployment: verification.deployment,
        verification,
      },
      "verified operation public pointer"
    );
  } else {
    same(fields.verification, null, "premature operation verification");
    same(state.lastVerified, prior, "unverified operation public pointer");
  }
  return fields as unknown as PromotionOperation;
}
function requirePhase(operation: PromotionOperation, phases: string[]): void {
  if (!phases.includes(operation.phase))
    throw new Error("Unsupported promotion transition from " + operation.phase);
}
function completedRecord(
  state: PromotionControl,
  operation: PromotionOperation,
  verification: PromotionVerification,
  acknowledgementId: string | null
): CompletedPromotion {
  return {
    operationId: operation.operationId,
    destination: state.destination,
    request: operation.request,
    priorVerifiedReleaseId: operation.priorVerified.releaseId,
    priorInventorySha256: releaseInventory(operation.priorVerified),
    terminalAttemptId: (acknowledgementId === null
      ? operation.rollbackAttempt
      : operation.promotionAttempt)!.attemptId,
    outcome: acknowledgementId === null ? "rolled-back" : "acknowledged",
    acknowledgementId,
    verification,
  };
}
function terminalObjects(
  previous: PromotionControl,
  next: PromotionControl
): PromotionAppendObjects {
  if (next.completedCount === previous.completedCount)
    return { completionTree: next.completionRoot, objects: new Map() };
  const operation = previous.active;
  if (!operation) throw new Error("Completion requires current owner");
  const event = next.lastTransition.event;
  let record: CompletedPromotion;
  if (event.type === "acknowledged" && operation.verification)
    record = completedRecord(
      previous,
      operation,
      operation.verification,
      event.acknowledgementId
    );
  else if (event.type === "verified" && event.mode === "rollback")
    record = completedRecord(previous, operation, event.verification, null);
  else throw new Error("Invalid terminal promotion event");
  const output = proofTree(operation.completionProof, record);
  same(output.completionTree, next.completionRoot, "terminal completion root");
  return output;
}
function reduce(
  previous: PromotionControl,
  event: Exclude<PromotionEvent, { type: "bootstrap" }>
): PromotionControl {
  const next: Omit<PromotionControl, "stateId"> = {
    schemaVersion: 1,
    revision: previous.revision + 1,
    destination: previous.destination,
    lastVerified: previous.lastVerified,
    active: previous.active,
    completedCount: previous.completedCount,
    completionRoot: previous.completionRoot,
    lastTransition: { previousStateId: previous.stateId, event },
  };
  if (event.type === "claim") {
    const completed = verifyCompletionProof(
      previous.completionRoot,
      event.request.requestId,
      event.proof
    );
    if (completed) {
      same(
        completed.destination,
        previous.destination,
        "completed replay destination"
      );
      same(event.request, completed.request, "completed request replay");
      return previous;
    }
    if (previous.active) {
      same(event.request, previous.active.request, "active owner request");
      same(event.proof, previous.active.completionProof, "claim proof replay");
      return previous;
    }
    const target = PROMOTION_DESTINATIONS[previous.destination];
    same(event.request.basePath, target.basePath, "destination base");
    same(event.request.purpose, target.purpose, "destination purpose");
    same(
      event.request.expectedVerifiedReleaseId,
      previous.lastVerified.releaseId,
      "prior verified release"
    );
    next.active = {
      operationId: promotionOperationId(previous.destination, event.request),
      request: event.request,
      priorVerified: previous.lastVerified,
      phase: "claimed",
      promotionAttemptNumber: 0,
      promotionAttempt: null,
      rollbackAttemptNumber: 0,
      rollbackAttempt: null,
      completionProof: event.proof,
      verification: null,
    };
    return seal(next);
  }
  if (!previous.active || previous.active.operationId !== event.operationId) {
    if (
      (event.type === "acknowledged" || event.type === "verified") &&
      event.replayProof !== null
    ) {
      const proof = event.replayProof;
      if (proof.record === null)
        throw new Error("Missing completed replay record");
      const completed = verifyCompletionProof(
        previous.completionRoot,
        proof.record.request.requestId,
        proof
      );
      if (
        !completed ||
        completed.operationId !== event.operationId ||
        completed.destination !== previous.destination
      )
        throw new Error("Stale promotion owner");
      if (event.type === "acknowledged") {
        same(
          completed.outcome,
          "acknowledged",
          "completed acknowledgement outcome"
        );
        same(
          completed.acknowledgementId,
          event.acknowledgementId,
          "completed acknowledgement replay"
        );
        same(
          completed.verification.receiptId,
          event.verificationReceiptId,
          "completed acknowledgement verification"
        );
      } else {
        same(event.mode, "rollback", "completed verification mode");
        same(
          event.attemptId,
          completed.terminalAttemptId,
          "completed rollback attempt"
        );
        same(completed.outcome, "rolled-back", "completed rollback outcome");
        same(
          completed.verification,
          event.verification,
          "completed rollback verification"
        );
      }
      return previous;
    }
    throw new Error("Stale promotion owner");
  }
  const operation: PromotionOperation = {
    ...previous.active,
    promotionAttempt: previous.active.promotionAttempt
      ? { ...previous.active.promotionAttempt }
      : null,
    rollbackAttempt: previous.active.rollbackAttempt
      ? { ...previous.active.rollbackAttempt }
      : null,
  };
  next.active = operation;
  if (event.type === "acknowledged") {
    same(event.replayProof, null, "active acknowledgement replay proof");
    requirePhase(operation, ["verified"]);
    same(
      event.verificationReceiptId,
      operation.verification?.receiptId,
      "acknowledgement verification"
    );
    const record = completedRecord(
      previous,
      operation,
      operation.verification!,
      event.acknowledgementId
    );
    next.completionRoot = proofTree(
      operation.completionProof,
      record
    ).completionTree;
    next.completedCount++;
    next.active = null;
    return seal(next);
  }
  if (event.type === "verified")
    same(event.replayProof, null, "active verification replay proof");
  const rollback = event.mode === "rollback";
  const attempt = rollback
    ? operation.rollbackAttempt
    : operation.promotionAttempt;
  const prefix = rollback ? "rollback" : "dispatch";
  if (event.type === "dispatch-intent") {
    if (attempt?.attemptId === event.attemptId) {
      same(
        {
          attemptNumber: attempt.attemptNumber,
          workflowCommit: attempt.workflowCommit,
          expectedRunAttempt: attempt.expectedRunAttempt,
        },
        {
          attemptNumber: event.attemptNumber,
          workflowCommit: event.workflowCommit,
          expectedRunAttempt: event.expectedRunAttempt,
        },
        "dispatch intent replay"
      );
      return previous;
    }
    requirePhase(
      operation,
      rollback
        ? ["rollback-required", "rollback-fenced"]
        : ["claimed", "dispatch-fenced"]
    );
    const counter = rollback
      ? operation.rollbackAttemptNumber
      : operation.promotionAttemptNumber;
    same(event.attemptNumber, counter + 1, "next dispatch attempt");
    same(
      event.attemptId,
      promotionAttemptId(
        operation.operationId,
        event.mode,
        event.attemptNumber,
        event.workflowCommit,
        event.expectedRunAttempt
      ),
      "dispatch attempt identity"
    );
    const created: PromotionAttempt = {
      attemptId: event.attemptId,
      attemptNumber: event.attemptNumber,
      workflowCommit: event.workflowCommit,
      expectedRunAttempt: event.expectedRunAttempt,
      status: "planned",
      fenceReceiptId: null,
      admission: null,
      deployment: null,
      failureReceiptId: null,
    };
    if (rollback) {
      operation.rollbackAttempt = created;
      operation.rollbackAttemptNumber++;
    } else {
      operation.promotionAttempt = created;
      operation.promotionAttemptNumber++;
    }
    operation.phase = rollback ? "rollback-planned" : "dispatch-planned";
    return seal(next);
  }
  if (!attempt || attempt.attemptId !== event.attemptId)
    throw new Error("Stale dispatch attempt");
  if (event.type === "dispatch-uncertain") {
    if (attempt.status === "uncertain") return previous;
    requirePhase(operation, [prefix + "-planned"]);
    attempt.status = "uncertain";
    operation.phase = rollback ? "rollback-uncertain" : "dispatch-uncertain";
  } else if (event.type === "fence-dispatch") {
    if (attempt.status === "fenced") {
      same(event.fenceReceiptId, attempt.fenceReceiptId, "fence replay");
      return previous;
    }
    requirePhase(operation, [prefix + "-planned", prefix + "-uncertain"]);
    // Successful CAS, rather than an empty remote run listing, fences delayed admission.
    attempt.status = "fenced";
    attempt.fenceReceiptId = event.fenceReceiptId;
    operation.phase = rollback ? "rollback-fenced" : "dispatch-fenced";
  } else if (event.type === "admit-run") {
    if (attempt.admission) {
      same(event.admission, attempt.admission, "run admission replay");
      return previous;
    }
    requirePhase(operation, [prefix + "-planned", prefix + "-uncertain"]);
    same(
      event.admission.workflowCommit,
      attempt.workflowCommit,
      "reviewed workflow commit"
    );
    same(
      event.admission.runAttempt,
      attempt.expectedRunAttempt,
      "planned workflow attempt"
    );
    attempt.admission = event.admission;
    attempt.status = "admitted";
    operation.phase = rollback ? "rollback-admitted" : "admitted";
  } else if (event.type === "deployed") {
    if (attempt.deployment) {
      same(event.deployment, attempt.deployment, "deployment replay");
      return previous;
    }
    requirePhase(operation, rollback ? ["rollback-admitted"] : ["admitted"]);
    same(
      event.deployment.admission,
      attempt.admission,
      "deployment admitted run"
    );
    attempt.deployment = event.deployment;
    attempt.status = "deployed";
    operation.phase = rollback ? "rollback-deployed" : "deployed";
  } else if (event.type === "failed") {
    if (attempt.status === "failed") {
      same(
        event.failureReceiptId,
        attempt.failureReceiptId,
        "terminal effect failure replay"
      );
      return previous;
    }
    requirePhase(
      operation,
      rollback
        ? ["rollback-admitted", "rollback-deployed"]
        : ["admitted", "deployed"]
    );
    // Effects must independently be terminal; network errors cannot resolve admitted runs.
    attempt.failureReceiptId = event.failureReceiptId;
    attempt.status = "failed";
    operation.phase = "rollback-required";
  } else if (event.type === "verified") {
    if (!rollback && operation.verification) {
      same(
        event.verification,
        operation.verification,
        "live verification replay"
      );
      return previous;
    }
    requirePhase(operation, rollback ? ["rollback-deployed"] : ["deployed"]);
    const targetId = rollback
      ? operation.priorVerified.releaseId
      : candidatePublicReleaseId(previous.destination, operation.request);
    same(
      event.verification.destination,
      previous.destination,
      "verification destination"
    );
    same(event.verification.releaseId, targetId, "verified public release");
    same(
      event.verification.inventorySha256,
      rollback
        ? releaseInventory(operation.priorVerified)
        : operation.request.publicInventorySha256,
      "verified inventory"
    );
    same(
      event.verification.deployment,
      attempt.deployment,
      "verified exact deployment"
    );
    if (rollback) {
      const record = completedRecord(
        previous,
        operation,
        event.verification,
        null
      );
      next.completionRoot = proofTree(
        operation.completionProof,
        record
      ).completionTree;
      next.completedCount++;
      next.lastVerified = operation.priorVerified;
      next.active = null;
    } else {
      operation.verification = event.verification;
      operation.phase = "verified";
      next.lastVerified = {
        kind: "candidateRelease",
        releaseId: targetId,
        destination: previous.destination,
        request: operation.request,
        deployment: event.verification.deployment,
        verification: event.verification,
      };
    }
  }
  return seal(next);
}
/** Matching is pure; effect adapters must independently verify retained bytes and live checks. */
export function createPromotionControl(
  snapshot: LegacyPublicSnapshot
): PromotionControl {
  return parsePromotionControl(bootstrap(parseLegacy(snapshot)));
}
function validateLastEventProjection(
  state: PromotionControl,
  event: PromotionEvent
): void {
  if (event.type === "bootstrap") return;
  if (event.type === "claim") {
    if (!state.active) throw new Error("Claim requires active projection");
    requirePhase(state.active, ["claimed"]);
    same(state.active.request, event.request, "claim request projection");
    same(state.active.completionProof, event.proof, "claim proof projection");
    return;
  }
  if (event.type === "acknowledged") {
    same(state.active, null, "acknowledged owner projection");
    same(event.replayProof, null, "persisted acknowledgement replay proof");
    if (
      state.lastVerified.kind !== "candidateRelease" ||
      state.completedCount < 1
    )
      throw new Error("Acknowledgement requires verified public release");
    same(
      event.operationId,
      promotionOperationId(state.destination, state.lastVerified.request),
      "acknowledged operation projection"
    );
    same(
      event.verificationReceiptId,
      state.lastVerified.verification.receiptId,
      "acknowledged verification projection"
    );
    return;
  }
  if (event.type === "verified" && event.mode === "rollback") {
    same(state.active, null, "verified rollback owner projection");
    same(event.replayProof, null, "persisted rollback replay proof");
    if (state.completedCount < 1)
      throw new Error("Rollback requires completion record");
    same(
      event.verification.destination,
      state.destination,
      "rollback destination projection"
    );
    same(
      event.verification.releaseId,
      state.lastVerified.releaseId,
      "rollback release projection"
    );
    same(
      event.verification.inventorySha256,
      releaseInventory(state.lastVerified),
      "rollback inventory projection"
    );
    return;
  }
  const operation = state.active;
  if (!operation || operation.operationId !== event.operationId)
    throw new Error("Last event requires current owner projection");
  const rollback = event.mode === "rollback";
  const attempt = rollback
    ? operation.rollbackAttempt
    : operation.promotionAttempt;
  if (!attempt || attempt.attemptId !== event.attemptId)
    throw new Error("Last event requires current attempt projection");
  const prefix = rollback ? "rollback" : "dispatch";
  if (event.type === "dispatch-intent") {
    requirePhase(operation, [prefix + "-planned"]);
    same(
      attempt.attemptNumber,
      event.attemptNumber,
      "intent attempt projection"
    );
    same(
      attempt.workflowCommit,
      event.workflowCommit,
      "intent workflow projection"
    );
    same(
      attempt.expectedRunAttempt,
      event.expectedRunAttempt,
      "intent run attempt projection"
    );
  } else if (event.type === "dispatch-uncertain") {
    requirePhase(operation, [prefix + "-uncertain"]);
  } else if (event.type === "fence-dispatch") {
    requirePhase(operation, [prefix + "-fenced"]);
    same(
      attempt.fenceReceiptId,
      event.fenceReceiptId,
      "fence receipt projection"
    );
  } else if (event.type === "admit-run") {
    requirePhase(operation, rollback ? ["rollback-admitted"] : ["admitted"]);
    same(attempt.admission, event.admission, "admission projection");
  } else if (event.type === "deployed") {
    requirePhase(operation, rollback ? ["rollback-deployed"] : ["deployed"]);
    same(attempt.deployment, event.deployment, "deployment projection");
  } else if (event.type === "failed") {
    requirePhase(operation, ["rollback-required"]);
    same(
      attempt.failureReceiptId,
      event.failureReceiptId,
      "failure receipt projection"
    );
    if (!rollback)
      same(
        operation.rollbackAttemptNumber,
        0,
        "initial failure rollback projection"
      );
  } else if (event.type === "verified") {
    requirePhase(operation, ["verified"]);
    same(event.replayProof, null, "persisted verification replay proof");
    same(operation.verification, event.verification, "verification projection");
  }
}
/** Validate bounded state invariants. Git admission also validates the exact parent append. */
export function parsePromotionControl(input: unknown): PromotionControl {
  const parsed: unknown = Buffer.isBuffer(input)
    ? JSON.parse(input.toString("utf8"))
    : typeof input === "string"
      ? JSON.parse(input)
      : input;
  const fields = object(parsed, [
    "schemaVersion",
    "stateId",
    "revision",
    "destination",
    "lastVerified",
    "active",
    "completedCount",
    "completionRoot",
    "lastTransition",
  ]);
  if (fields.schemaVersion !== 1)
    throw new Error("Unsupported promotion control schema");
  digest(fields.stateId);
  nonnegative(fields.revision);
  nonnegative(fields.completedCount);
  destination(fields.destination);
  commit(fields.completionRoot);
  same(
    fields.completedCount === 0,
    fields.completionRoot === EMPTY_COMPLETION_TREE,
    "empty completion index counter"
  );
  const lastVerified = parseRelease(fields.lastVerified);
  same(
    lastVerified.destination,
    fields.destination,
    "control verified destination"
  );
  if (fields.active !== null)
    parseOperation(fields.active, {
      destination: fields.destination,
      lastVerified,
      completionRoot: fields.completionRoot,
    });
  const transition = object(fields.lastTransition, [
    "previousStateId",
    "event",
  ]);
  const event = parseEvent(transition.event);
  if (fields.revision === 0) {
    same(transition.previousStateId, null, "bootstrap predecessor");
    if (event.type !== "bootstrap")
      throw new Error("Initial control requires bootstrap");
    same(parsed, bootstrap(event.snapshot), "bootstrap state");
  } else {
    digest(transition.previousStateId);
    if (event.type === "bootstrap")
      throw new Error("Repeated promotion bootstrap");
    if (fields.completedCount > fields.revision)
      throw new Error("Invalid completion count");
    validateLastEventProjection(parsed as PromotionControl, event);
  }
  const { stateId, ...body } = fields;
  same(stateId, promotionDigest(body), "control state checksum");
  return JSON.parse(canonical(parsed)) as PromotionControl;
}
export function applyPromotionTransition(
  state: PromotionControl,
  event: PromotionEvent
): PromotionControl {
  const checked = parsePromotionControl(state);
  const parsedEvent = parseEvent(JSON.parse(canonical(event)));
  if (parsedEvent.type === "bootstrap")
    throw new Error("Promotion bootstrap is not an append");
  return reduce(checked, parsedEvent);
}
/** Exact Git objects to retain in the SAME control CAS tree; historical events stay in Git parents. */
export function validatePromotionControlTransition(
  previous: PromotionControl | null,
  next: PromotionControl
): PromotionAppendObjects {
  const checkedNext = parsePromotionControl(next);
  if (previous === null) {
    if (checkedNext.revision !== 0)
      throw new Error("Initial control must be a bootstrap");
    return { completionTree: EMPTY_COMPLETION_TREE, objects: new Map() };
  }
  const checkedPrevious = parsePromotionControl(previous);
  same(
    checkedNext.lastTransition.previousStateId,
    checkedPrevious.stateId,
    "append predecessor"
  );
  same(
    checkedNext.destination,
    checkedPrevious.destination,
    "append destination"
  );
  const expected = applyPromotionTransition(
    checkedPrevious,
    checkedNext.lastTransition.event
  );
  if (expected.stateId === checkedPrevious.stateId)
    throw new Error("Replay must reuse existing control commit");
  same(checkedNext, expected, "legal control append");
  return terminalObjects(checkedPrevious, checkedNext);
}
export function validatePromotionAppend(
  previousBytes: Buffer | null,
  nextBytes: Buffer
): PromotionAppendObjects {
  return validatePromotionControlTransition(
    previousBytes === null ? null : parsePromotionControl(previousBytes),
    parsePromotionControl(nextBytes)
  );
}
export function serializePromotionControl(state: PromotionControl): Buffer {
  return Buffer.from(canonical(parsePromotionControl(state)) + "\n", "utf8");
}
export function claimPromotion(
  state: PromotionControl,
  request: PromotionRequest,
  proof?: CompletionProof
): PromotionControl {
  const supplied =
    proof ??
    createCompletionProof(state.completionRoot, request.requestId, () => {
      throw new Error("Completion index reader required");
    });
  return applyPromotionTransition(state, {
    type: "claim",
    request,
    proof: supplied,
  });
}

export interface PromotionDeploymentAuthorization {
  operationId: string;
  mode: PromotionMode;
  attemptId: string;
  admission: RunAdmission;
}
export interface AuthorizedPromotionDeployment {
  destination: PromotionDestination;
  repository: string;
  purpose: "preview" | "release";
  basePath: string;
  liveUrl: string;
  operationId: string;
  attemptId: string;
  admission: RunAdmission;
  publicCommit: string;
  candidateId: string | null;
  sourceCommit: string | null;
  publicInventorySha256: string;
  releaseId: string;
}
/** Current admission only. Remote CAS and reconciliation still precede external effects. */
export function authorizePromotionDeployment(
  state: PromotionControl,
  supplied: PromotionDeploymentAuthorization
): AuthorizedPromotionDeployment {
  const checked = parsePromotionControl(state);
  const input = object(supplied, [
    "operationId",
    "mode",
    "attemptId",
    "admission",
  ]);
  digest(input.operationId);
  digest(input.attemptId);
  mode(input.mode);
  const admission = parseAdmission(input.admission);
  const operation = checked.active;
  if (!operation || operation.operationId !== input.operationId)
    throw new Error("Stale promotion deployment owner");
  const rollback = input.mode === "rollback";
  requirePhase(operation, rollback ? ["rollback-admitted"] : ["admitted"]);
  const attempt = rollback
    ? operation.rollbackAttempt
    : operation.promotionAttempt;
  if (
    !attempt ||
    attempt.status !== "admitted" ||
    attempt.attemptId !== input.attemptId
  )
    throw new Error("Stale promotion deployment attempt");
  same(admission, attempt.admission, "authorized admitted run");
  const prior = operation.priorVerified;
  const request =
    rollback && prior.kind === "candidateRelease"
      ? prior.request
      : operation.request;
  const legacy = rollback && prior.kind === "legacyPublicSnapshot";
  return {
    destination: checked.destination,
    ...PROMOTION_DESTINATIONS[checked.destination],
    operationId: operation.operationId,
    attemptId: attempt.attemptId,
    admission: { ...admission },
    publicCommit: legacy ? prior.retainedCommit : request.payloadCommit,
    candidateId: legacy ? null : request.candidateId,
    sourceCommit: legacy ? null : request.sourceCommit,
    publicInventorySha256: rollback
      ? releaseInventory(prior)
      : request.publicInventorySha256,
    releaseId: rollback
      ? prior.releaseId
      : candidatePublicReleaseId(checked.destination, request),
  };
}
