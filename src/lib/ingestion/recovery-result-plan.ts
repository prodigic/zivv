import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { decryptRecoveryResultChain } from "./recovery-result-chain.js";
import {
  validateOperatorRecoveryCheckpoint,
  type OperatorRecoveryCheckpoint,
} from "./operator-recovery.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { secureOperatorDirectory } from "./encrypted-backup.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

const kind = "zivv-recovery-result-plan";
const domain = kind + "/v1\0";
const receiptDomain = "zivv-recovery-result-portable-receipt/v1\0";
const magic = Buffer.from("ZIVV-RESULT-PLAN\0", "ascii");
const headerBytes = magic.length + 1 + 8;
const maxMetadata = 64 * 1024;
const maxChain = 752_242_215;
const maxPlan = headerBytes + maxMetadata + maxChain;
const productionScope = "prodigic/zivv/production";
const contextKeys = [
  "root",
  "operator",
  "repositoryRoot",
  "npmCli",
  "out",
  "runId",
  "admissionSha256",
  "resultSha256",
  "preparedReceiptSha256",
] as const;
export interface RecoveryResultPlanContext {
  root: string;
  operator: string;
  repositoryRoot: string;
  npmCli: string;
  out: string;
  runId: string;
  admissionSha256: string;
  resultSha256: string;
  preparedReceiptSha256: string;
}
export interface RecoveryResultPlanInput {
  context: RecoveryResultPlanContext;
  recoveryKey: Buffer;
}
function fail(code: string): never {
  throw new Error("RECOVERY_RESULT_PLAN_" + code);
}
function same(a: unknown, b: unknown, code = "CONTEXT_MISMATCH"): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail(code);
}
function object(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_FORMAT");
  same(Object.keys(value).sort(), [...keys].sort(), "INVALID_FIELDS");
  return value as Record<string, unknown>;
}
function key(value: Buffer): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== 32) fail("INVALID_KEY");
  return Buffer.from(value);
}
function context(value: RecoveryResultPlanContext): RecoveryResultPlanContext {
  const fields = object(value, contextKeys);
  for (const name of [
    "root",
    "operator",
    "repositoryRoot",
    "npmCli",
    "out",
  ] as const) {
    const path = fields[name];
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      resolve(path) !== path ||
      path.startsWith("\\\\") ||
      path.startsWith("//") ||
      path.includes("\0") ||
      path.length > 4096 ||
      (process.platform === "win32" &&
        path
          .slice(3)
          .split("\\")
          .some(
            (part) =>
              /[<>:"|?*]/.test(part) ||
              [...part].some((character) => character.charCodeAt(0) < 32) ||
              /[. ]$/.test(part) ||
              /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
          ))
    )
      fail("INVALID_PATH");
  }
  for (const name of [
    "runId",
    "admissionSha256",
    "resultSha256",
    "preparedReceiptSha256",
  ] as const)
    if (
      typeof fields[name] !== "string" ||
      !/^[a-f0-9]{64}$/.test(fields[name])
    )
      fail("INVALID_CONTEXT");
  return { ...value };
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) &&
      suffix !== ".." &&
      !suffix.startsWith("..\\") &&
      !suffix.startsWith("../"))
  );
}
function directory(
  path: string,
  privateOutput: boolean,
  required = true
): void {
  let firstExisting: string | undefined;
  for (let current = path; ; current = dirname(current)) {
    if (
      privateOutput &&
      (existsSync(join(current, ".git")) ||
        (existsSync(join(current, "HEAD")) &&
          existsSync(join(current, "objects")) &&
          existsSync(join(current, "refs"))))
    )
      fail("GIT_OUTPUT_REFUSED");
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH");
      firstExisting ??= current;
    }
    if (dirname(current) === current) break;
  }
  if (
    !firstExisting ||
    (required && firstExisting !== path) ||
    realpathSync(firstExisting) !== firstExisting
  )
    fail("UNSAFE_PATH");
}
function paths(input: RecoveryResultPlanContext) {
  const value = context(input),
    plan = value.out + ".plan",
    stage = value.out + ".plan-stage",
    receipt = value.out + ".receipt.json";
  directory(value.root, false);
  directory(value.operator, false);
  directory(value.repositoryRoot, false);
  directory(dirname(value.npmCli), false);
  const npm = lstatSync(value.npmCli);
  if (
    !npm.isFile() ||
    npm.isSymbolicLink() ||
    npm.nlink !== 1 ||
    realpathSync(value.npmCli) !== value.npmCli
  )
    fail("UNSAFE_PATH");
  for (const target of [value.out, plan, stage, receipt]) {
    if (
      [
        value.root,
        value.operator,
        join(value.root, "checkout"),
        value.repositoryRoot,
      ].some((source) => inside(source, target) || inside(target, source))
    )
      fail("UNSAFE_OUTPUT");
    directory(dirname(target), true);
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (
        stat.isSymbolicLink() ||
        (target === stage ? !stat.isDirectory() : !stat.isFile())
      )
        fail("UNSAFE_PATH");
    }
  }
  return { context: value, plan, stage, receipt };
}

/** Ignore only capture wall-clock and the production ownership lease bookkeeping. */
export function recoveryResultSourceFingerprint(
  input: OperatorRecoveryCheckpoint
): string {
  const checkpoint = validateOperatorRecoveryCheckpoint(structuredClone(input));
  const journal = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(checkpoint.journal, "base64")
  );
  const { createdAtEpochMs: _created, journal: _journal, ...body } = checkpoint;
  const { digest: _digest, ownership, ...journalBody } = journal;
  return sha256(
    canonicalJson({
      ...body,
      journal: {
        ...journalBody,
        ownership: ownership.filter((row) => row.scope !== productionScope),
      },
    })
  );
}
function sign(
  payload: unknown,
  recoveryKey: Buffer,
  signatureDomain: string
): Buffer {
  return Buffer.from(
    canonicalJson({
      payload,
      signature: createHmac("sha256", recoveryKey)
        .update(signatureDomain)
        .update(canonicalJson(payload))
        .digest("hex"),
    }) + "\n"
  );
}
function metadataFor(
  chain: Buffer,
  recoveryKey: Buffer,
  suppliedContext: RecoveryResultPlanContext
) {
  const value = context(suppliedContext),
    proof = decryptRecoveryResultChain(chain, recoveryKey),
    cert = proof.certificate,
    admission = JSON.parse(proof.members.admissionReceipt.toString("utf8"))
      .payload as Record<string, unknown>;
  same(value.root, admission.root);
  same(value.operator, cert.intermediateOperatorDirectory);
  same(value.repositoryRoot, admission.repositoryRoot);
  same(value.npmCli, admission.physicalNpmCli);
  same(value.runId, cert.runId);
  same(value.admissionSha256, cert.members.admissionReceipt.sha256);
  same(value.resultSha256, cert.members.resultReceipt.sha256);
  same(value.preparedReceiptSha256, cert.members.preparedReceipt.sha256);
  const portablePayload = {
    kind: "zivv-recovery-result-portable-receipt",
    version: 1,
    activationAllowed: false,
    chainId: proof.chainId,
    chainSha256: sha256(chain),
    chainSize: chain.length,
    successorRetirementSha256: cert.members.successorRetirementReceipt.sha256,
    runId: cert.runId,
    candidateId: cert.candidateId,
  };
  const payload = {
    kind,
    version: 1,
    activationAllowed: false,
    physicalValidationRequired: true,
    freshRemoteValidationRequired: true,
    context: value,
    chainId: proof.chainId,
    chainSha256: sha256(chain),
    chainSize: chain.length,
    successorCheckpointSha256: cert.successorCheckpointSha256,
    successorRetirementSha256: cert.members.successorRetirementReceipt.sha256,
    sourceFingerprint: recoveryResultSourceFingerprint(
      proof.successorCheckpoint
    ),
    runId: cert.runId,
    candidateId: cert.candidateId,
  };
  return {
    payload,
    portableReceipt: sign(portablePayload, recoveryKey, receiptDomain),
  };
}

/** Deterministic private bytes only; no source capture, retirement or activation permit. */
export function createRecoveryResultPlan(
  input: RecoveryResultPlanInput & { chain: Buffer }
): Buffer {
  const recoveryKey = key(input.recoveryKey);
  paths(input.context);
  if (
    !Buffer.isBuffer(input.chain) ||
    !input.chain.length ||
    input.chain.length > maxChain
  )
    fail("LIMIT");
  const chain = Buffer.from(input.chain),
    { payload } = metadataFor(chain, recoveryKey, input.context),
    metadata = sign(payload, recoveryKey, domain);
  if (metadata.length > maxMetadata) fail("LIMIT");
  const header = Buffer.alloc(headerBytes);
  magic.copy(header);
  header[magic.length] = 1;
  header.writeUInt32BE(metadata.length, magic.length + 1);
  header.writeUInt32BE(chain.length, magic.length + 5);
  return Buffer.concat([header, metadata, chain]);
}
function decode(bytes: Buffer, suppliedKey: Buffer) {
  const recoveryKey = key(suppliedKey);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < headerBytes ||
    bytes.length > maxPlan ||
    !bytes.subarray(0, magic.length).equals(magic) ||
    bytes[magic.length] !== 1
  )
    fail("INVALID_FORMAT");
  const metadataLength = bytes.readUInt32BE(magic.length + 1),
    chainLength = bytes.readUInt32BE(magic.length + 5);
  if (
    !metadataLength ||
    metadataLength > maxMetadata ||
    !chainLength ||
    chainLength > maxChain ||
    bytes.length !== headerBytes + metadataLength + chainLength
  )
    fail("INVALID_LENGTH");
  const metadataBytes = bytes.subarray(
      headerBytes,
      headerBytes + metadataLength
    ),
    metadata = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes)
      ),
      ["payload", "signature"]
    );
  if (
    typeof metadata.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.signature)
  )
    fail("INVALID_SIGNATURE");
  const expected = createHmac("sha256", recoveryKey)
    .update(domain)
    .update(canonicalJson(metadata.payload))
    .digest();
  if (!timingSafeEqual(Buffer.from(metadata.signature, "hex"), expected))
    fail("INVALID_SIGNATURE");
  if (!metadataBytes.equals(Buffer.from(canonicalJson(metadata) + "\n")))
    fail("NONCANONICAL_METADATA");
  const payload = object(metadata.payload, [
      "kind",
      "version",
      "activationAllowed",
      "physicalValidationRequired",
      "freshRemoteValidationRequired",
      "context",
      "chainId",
      "chainSha256",
      "chainSize",
      "successorCheckpointSha256",
      "successorRetirementSha256",
      "sourceFingerprint",
      "runId",
      "candidateId",
    ]),
    chain = bytes.subarray(headerBytes + metadataLength),
    derived = metadataFor(
      chain,
      recoveryKey,
      context(payload.context as RecoveryResultPlanContext)
    );
  same(payload, derived.payload, "PROVENANCE_MISMATCH");
  return {
    metadata: derived.payload,
    chain: Buffer.from(chain),
    portableReceipt: derived.portableReceipt,
    sourceFingerprint: derived.payload.sourceFingerprint,
    planId: sha256(canonicalJson(derived.payload)),
  };
}
export function authenticateRecoveryResultPlan(
  input: RecoveryResultPlanInput & { bytes: Buffer }
): ReturnType<typeof decode> {
  const decoded = decode(input.bytes, input.recoveryKey);
  same(decoded.metadata.context, context(input.context));
  return decoded;
}

function flushDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function stableFile(
  path: string,
  limit: number,
  maxLinks = 1,
  durable = false
): { bytes: Buffer; stat: NonNullable<ReturnType<typeof lstatSync>> } {
  directory(dirname(path), true);
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink < 1 ||
    before.nlink > maxLinks ||
    before.size > limit
  )
    fail("UNSAFE_FILE");
  const fd = openSync(
    path,
    (durable ? constants.O_RDWR : constants.O_RDONLY) |
      (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const opened = fstatSync(fd);
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size ||
      opened.nlink !== before.nlink
    )
      fail("UNSAFE_FILE");
    // Bound the allocation/read to the checked size even if the file grows.
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail("FILE_CHANGED");
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) fail("FILE_CHANGED");
    // A complete orphan may have survived a process crash before its first fsync.
    // Windows requires a writable handle even when flushing unchanged file bytes.
    if (durable) fsyncSync(fd);
    const after = fstatSync(fd),
      current = lstatSync(path);
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.nlink !== before.nlink ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.nlink !== before.nlink ||
      current.isSymbolicLink()
    )
      fail("FILE_CHANGED");
    return { bytes, stat: before };
  } finally {
    closeSync(fd);
  }
}
function temporaryFiles(target: string, stage: string): string[] {
  if (!existsSync(stage)) return [];
  directory(stage, true);
  const entries = readdirSync(stage);
  if (entries.length > 1000) fail("STAGING_LIMIT");
  const prefix = basename(target) + ".";
  return entries
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        /^\d+\.[a-f0-9]{16}\.tmp$/.test(name.slice(prefix.length))
    )
    .map((name) => join(stage, name));
}
function installed(
  target: string,
  stage: string,
  limit: number,
  validate: (bytes: Buffer) => void
): Buffer {
  const current = stableFile(target, limit, 64);
  validate(current.bytes);
  const linked = temporaryFiles(target, stage).filter((path) => {
    const candidate = stableFile(path, limit, 64);
    return (
      candidate.stat.ino === current.stat.ino &&
      candidate.stat.dev === current.stat.dev
    );
  });
  if (current.stat.nlink !== linked.length + 1) fail("UNCLASSIFIED_LINK");
  // Authenticate and classify every link before opening a writable flush handle.
  const durable = stableFile(target, limit, 64, true);
  if (
    durable.stat.ino !== current.stat.ino ||
    durable.stat.dev !== current.stat.dev ||
    !durable.bytes.equals(current.bytes)
  )
    fail("FILE_CHANGED");
  for (const path of linked) {
    const checked = stableFile(path, limit, 64),
      targetNow = lstatSync(target);
    if (
      !checked.bytes.equals(current.bytes) ||
      checked.stat.ino !== current.stat.ino ||
      checked.stat.dev !== current.stat.dev ||
      targetNow.ino !== current.stat.ino ||
      targetNow.dev !== current.stat.dev
    )
      fail("FILE_CHANGED");
    unlinkSync(path);
    flushDirectory(stage);
  }
  const final = stableFile(target, limit);
  if (
    final.stat.ino !== current.stat.ino ||
    final.stat.dev !== current.stat.dev ||
    !final.bytes.equals(current.bytes)
  )
    fail("FILE_CHANGED");
  flushDirectory(dirname(target));
  return final.bytes;
}
function exclusive(
  target: string,
  bytes: Buffer,
  stage: string,
  limit: number,
  validate: (bytes: Buffer) => void,
  assertFenced: () => void = () => {}
): Buffer {
  if (!existsSync(target)) {
    const temporary = join(
      stage,
      basename(target) +
        "." +
        process.pid +
        "." +
        randomBytes(8).toString("hex") +
        ".tmp"
    );
    assertFenced();
    const fd = openSync(temporary, "wx", 0o600);
    try {
      assertFenced();
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      assertFenced();
    } finally {
      closeSync(fd);
    }
    flushDirectory(stage);
    try {
      assertFenced();
      linkSync(temporary, target);
      flushDirectory(dirname(target));
      assertFenced();
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    // Authentication/readback owns cleanup; interrupted writes/links remain evidence.
  }
  return installed(target, stage, limit, validate);
}

/** Adopt only a unique complete authenticated orphan; preserve incomplete evidence. */
export function readRecoveryResultPlan(
  input: RecoveryResultPlanInput
): ReturnType<typeof decode> {
  const bound = paths(input.context),
    candidates: { path: string; bytes: Buffer }[] = [];
  for (const path of temporaryFiles(bound.plan, bound.stage)) {
    const current = stableFile(path, maxPlan, 64);
    let valid: ReturnType<typeof decode>;
    try {
      valid = decode(current.bytes, input.recoveryKey);
    } catch {
      continue;
    }
    same(valid.metadata.context, bound.context);
    candidates.push({ path, bytes: current.bytes });
  }
  const existing = existsSync(bound.plan)
    ? stableFile(bound.plan, maxPlan, 64).bytes
    : undefined;
  if (existing) authenticateRecoveryResultPlan({ ...input, bytes: existing });
  const identities = new Set([
    ...candidates.map((item) => sha256(item.bytes)),
    ...(existing ? [sha256(existing)] : []),
  ]);
  if (identities.size > 1) fail("AMBIGUOUS_PLAN");
  if (!existing) {
    if (!candidates.length) fail("PLAN_MISSING");
    const selected = candidates[0],
      before = stableFile(selected.path, maxPlan, 1, true);
    if (!before.bytes.equals(selected.bytes)) fail("FILE_CHANGED");
    try {
      linkSync(selected.path, bound.plan);
      flushDirectory(dirname(bound.plan));
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
  }
  const bytes = installed(bound.plan, bound.stage, maxPlan, (value) => {
    authenticateRecoveryResultPlan({ ...input, bytes: value });
  });
  return authenticateRecoveryResultPlan({ ...input, bytes });
}
/** Persist the complete flushed plan before a separate coordinator may fence a writer. */
export function installRecoveryResultPlan(
  input: RecoveryResultPlanInput & { bytes: Buffer }
): ReturnType<typeof decode> {
  authenticateRecoveryResultPlan(input);
  const bound = paths(input.context);
  secureOperatorDirectory(bound.stage);
  directory(bound.stage, true);
  try {
    const existing = readRecoveryResultPlan(input);
    same(
      existing.planId,
      decode(input.bytes, input.recoveryKey).planId,
      "PLAN_CONFLICT"
    );
    if (!stableFile(bound.plan, maxPlan).bytes.equals(input.bytes))
      fail("PLAN_CONFLICT");
    return existing;
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        error.message === "RECOVERY_RESULT_PLAN_PLAN_MISSING"
      )
    )
      throw error;
  }
  const bytes = exclusive(
    bound.plan,
    input.bytes,
    bound.stage,
    maxPlan,
    (value) => {
      if (!value.equals(input.bytes)) fail("PLAN_CONFLICT");
      authenticateRecoveryResultPlan({ ...input, bytes: value });
    }
  );
  return authenticateRecoveryResultPlan({ ...input, bytes });
}
/** Publish exact private bytes only. The caller supplies and retains fence authority. */
export function publishRecoveryResultPlan(
  input: RecoveryResultPlanInput & { bytes: Buffer; assertFenced: () => void }
): ReturnType<typeof decode> {
  if (typeof input.assertFenced !== "function") fail("FENCE_REQUIRED");
  const bound = paths(input.context),
    plan = authenticateRecoveryResultPlan(input),
    retained = readRecoveryResultPlan(input);
  same(plan.planId, retained.planId, "PLAN_CONFLICT");
  if (!stableFile(bound.plan, maxPlan).bytes.equals(input.bytes))
    fail("PLAN_CONFLICT");
  for (const [path, bytes, limit] of [
    [bound.context.out, plan.chain, maxChain],
    [bound.receipt, plan.portableReceipt, maxMetadata],
  ] as const) {
    const guard = () => {
      input.assertFenced();
      paths(input.context);
    };
    guard();
    exclusive(
      path,
      bytes,
      bound.stage,
      limit,
      (current) => {
        if (!current.equals(bytes)) fail("OUTPUT_CONFLICT");
      },
      guard
    );
    guard();
  }
  return plan;
}
