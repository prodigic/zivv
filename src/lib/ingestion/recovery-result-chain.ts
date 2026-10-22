import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { posix, win32 } from "node:path";
import {
  verifyOperatorRetirementEvidence,
  type OperatorRecoveryCheckpoint,
} from "./operator-recovery.js";
import { proveRecoveryWeeklyLineage } from "./recovery-weekly-lineage.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import {
  CANDIDATE_CONFIG_FILES,
  configurationDigest,
  type CandidateConfiguration,
} from "./export-configuration.js";
import {
  parseReleaseCandidate,
  type ReleaseCandidate,
} from "./release-candidate.js";
import {
  parseApplicationBuildReceipt,
  verifyBuildExecutionToolIdentity,
} from "./source-build.js";
import { validateNpmExecutionToolIdentity } from "./execution-tool-identity.js";

const format = "zivv-recovery-frozen-result-chain";
const certificateDomain = format + "/certificate/v1\0";
const names = [
  "originalArchive",
  "originalRetirementReceipt",
  "preparedReceipt",
  "admissionReceipt",
  "resultReceipt",
  "successorArchive",
  "successorRetirementReceipt",
] as const;
const maxMetadataBytes = 64 * 1024;
const maxArchiveBytes = Math.floor(256 * 1024 * 1024 * 1.4);
const maxCertificateBytes = 64 * 1024;
const outerMagic = Buffer.from("ZIVV-RESULT-CHAIN\0", "ascii");
const memberMagic = Buffer.from("ZIVV-CHAIN-MEMBERS\0", "ascii");
const outerPrefixBytes = outerMagic.length + 4 + 32 + 12 + 4;
const memberHeaderBytes = memberMagic.length + 2 + (names.length + 1) * 4;
/** Exactly two legacy archive limits and five bounded metadata members. */
export const RECOVERY_RESULT_CHAIN_MAX_MEMBER_BYTES =
  2 * maxArchiveBytes + 5 * maxMetadataBytes;
const maxClearBytes =
  memberHeaderBytes +
  RECOVERY_RESULT_CHAIN_MAX_MEMBER_BYTES +
  maxCertificateBytes;
// Conservative zlib compressBound terms plus the gzip wrapper.
const maxCompressedBytes =
  maxClearBytes +
  Math.ceil(maxClearBytes / 4096) +
  Math.ceil(maxClearBytes / 16_384) +
  Math.ceil(maxClearBytes / 33_554_432) +
  64;
const maxEnvelopeBytes = outerPrefixBytes + 16 + maxCompressedBytes;

export interface RecoveryResultChainMembers {
  originalArchive: Buffer;
  originalRetirementReceipt: Buffer;
  preparedReceipt: Buffer;
  admissionReceipt: Buffer;
  resultReceipt: Buffer;
  successorArchive: Buffer;
  successorRetirementReceipt: Buffer;
}
export interface RecoveryResultChainInput {
  members: RecoveryResultChainMembers;
  recoveryKey: Buffer;
}
function fail(code: string): never {
  throw new Error("RECOVERY_RESULT_CHAIN_" + code);
}
function same(a: unknown, b: unknown, code = "MEMBER_MISMATCH"): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail(code);
}
function object(
  value: unknown,
  fields: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_FORMAT");
  same(Object.keys(value).sort(), [...fields].sort(), "INVALID_FIELDS");
  return value as Record<string, unknown>;
}
function hash(value: unknown, length = 64): asserts value is string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[a-f0-9]{${length}}$`).test(value)
  )
    fail("INVALID_IDENTITY");
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail("INVALID_INTEGER");
}
function logicalPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value.includes("\0") ||
    value.startsWith("\\\\") ||
    value.startsWith("//")
  )
    fail("INVALID_PATH");
  const flavor = /^[A-Za-z]:\\/.test(value) ? win32 : posix;
  if (!flavor.isAbsolute(value) || flavor.resolve(value) !== value)
    fail("INVALID_PATH");
  return value;
}
function pathJoin(root: string, ...parts: string[]): string {
  return (/^[A-Za-z]:\\/.test(root) ? win32 : posix).join(root, ...parts);
}
function base64(value: unknown, limit: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4)
    fail("LIMIT");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit || bytes.toString("base64") !== value)
    fail("INVALID_ENCODING");
  return bytes;
}
function key(input: Buffer): Buffer {
  if (!Buffer.isBuffer(input) || input.length !== 32) fail("INVALID_KEY");
  return Buffer.from(input);
}
function copyMembers(
  input: RecoveryResultChainMembers
): RecoveryResultChainMembers {
  const value = object(input, names);
  let total = 0;
  return Object.fromEntries(
    names.map((name) => {
      const bytes = value[name];
      if (!Buffer.isBuffer(bytes)) fail("INVALID_MEMBER");
      const limit =
        name === "originalArchive" || name === "successorArchive"
          ? maxArchiveBytes
          : maxMetadataBytes;
      if (
        !bytes.length ||
        bytes.length > limit ||
        (total += bytes.length) > RECOVERY_RESULT_CHAIN_MAX_MEMBER_BYTES
      )
        fail("LIMIT");
      return [name, Buffer.from(bytes)];
    })
  ) as unknown as RecoveryResultChainMembers;
}
function signedReceipt(
  bytes: Buffer,
  recoveryKey: Buffer,
  fields: readonly string[]
): Record<string, unknown> {
  const value = object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    ["payload", "signature"]
  );
  hash(value.signature);
  const payload = object(value.payload, fields),
    expected = createHmac("sha256", recoveryKey)
      .update(canonicalJson(payload))
      .digest();
  if (!timingSafeEqual(Buffer.from(value.signature, "hex"), expected))
    fail("INVALID_SIGNATURE");
  if (!bytes.equals(Buffer.from(canonicalJson(value) + "\n")))
    fail("NONCANONICAL_RECEIPT");
  return payload;
}
function preparedReceipt(bytes: Buffer, recoveryKey: Buffer) {
  const fields = [
    "kind",
    "version",
    "archiveSha256",
    "retirementSha256",
    "physicalRoot",
    "physicalNpmCli",
    "npmIdentitySha256",
    "status",
    "activationAllowed",
    "checkpointSha256",
    "ledgerRevision",
    "treeSha256",
    "entryCount",
    "workerProbe",
  ];
  const value = object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    [...fields, "signature"]
  );
  const { signature, ...payload } = value;
  hash(signature);
  if (
    !timingSafeEqual(
      Buffer.from(signature, "hex"),
      createHmac("sha256", recoveryKey).update(canonicalJson(payload)).digest()
    )
  )
    fail("INVALID_SIGNATURE");
  if (!bytes.equals(Buffer.from(canonicalJson(value) + "\n")))
    fail("NONCANONICAL_RECEIPT");
  same(payload.kind, "zivv-prepared-recovery-runtime");
  same(payload.version, 1);
  same(payload.status, "prepared");
  same(payload.activationAllowed, false);
  same(payload.workerProbe, "quarantine-enforced");
  for (const field of [
    "archiveSha256",
    "retirementSha256",
    "npmIdentitySha256",
    "checkpointSha256",
    "ledgerRevision",
    "treeSha256",
  ])
    hash(payload[field]);
  integer(payload.entryCount);
  if (payload.entryCount > 50_000) fail("LIMIT");
  logicalPath(payload.physicalRoot);
  logicalPath(payload.physicalNpmCli);
  return payload;
}
function checkpointFiles(checkpoint: OperatorRecoveryCheckpoint) {
  return new Map(
    checkpoint.files.map((file) => [file.area + "/" + file.path, file])
  );
}

/** Reconstruct Git's tree objects from the complete non-linked blob inventory. */
function sourceTreeDigest(
  files: { path: string; blob: string; mode: string }[]
): string {
  interface Tree {
    children: Map<string, Tree | { blob: string; mode: string }>;
  }
  const root: Tree = { children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let tree = root;
    for (const part of parts.slice(0, -1)) {
      const existing = tree.children.get(part);
      if (existing && !("children" in existing))
        fail("INVALID_SOURCE_INVENTORY");
      const child = existing ?? {
        children: new Map<string, Tree | { blob: string; mode: string }>(),
      };
      tree.children.set(part, child);
      tree = child;
    }
    if (tree.children.has(parts[parts.length - 1]))
      fail("INVALID_SOURCE_INVENTORY");
    tree.children.set(parts[parts.length - 1], {
      blob: file.blob,
      mode: file.mode,
    });
  }
  const ordered: Tree[] = [],
    pending = [root],
    digests = new Map<Tree, string>();
  while (pending.length) {
    const tree = pending.pop()!;
    ordered.push(tree);
    for (const child of tree.children.values())
      if ("children" in child) pending.push(child);
  }
  for (const tree of ordered.reverse()) {
    const entries = [...tree.children].sort(([a, av], [b, bv]) =>
      Buffer.compare(
        Buffer.from(a + ("children" in av ? "/" : "")),
        Buffer.from(b + ("children" in bv ? "/" : ""))
      )
    );
    const bytes = Buffer.concat(
      entries.map(([name, entry]) =>
        Buffer.concat([
          Buffer.from(
            ("children" in entry ? "40000" : entry.mode) + " " + name + "\0"
          ),
          Buffer.from(
            "children" in entry ? digests.get(entry)! : entry.blob,
            "hex"
          ),
        ])
      )
    );
    digests.set(
      tree,
      createHash("sha1")
        .update(Buffer.from(`tree ${bytes.length}\0`))
        .update(bytes)
        .digest("hex")
    );
  }
  return digests.get(root)!;
}

/**
 * Prove captured content and signed provenance only. Omitted bootstrap/dependency
 * inventory and fresh remote authority MUST be checked by a later coordinator
 * under its writer locks. This function confers no capture or execution permit.
 */
export function proveRecoveryResultChain(input: RecoveryResultChainInput) {
  object(input, ["members", "recoveryKey"]);
  const recoveryKey = key(input.recoveryKey),
    members = copyMembers(input.members);
  const originalEvidence = verifyOperatorRetirementEvidence({
      archive: members.originalArchive,
      retirementReceipt: members.originalRetirementReceipt,
      recoveryKey,
    }),
    successorEvidence = verifyOperatorRetirementEvidence({
      archive: members.successorArchive,
      retirementReceipt: members.successorRetirementReceipt,
      recoveryKey,
    }),
    original = originalEvidence.checkpoint,
    successor = successorEvidence.checkpoint;
  if (
    original.version !== 2 ||
    successor.version !== 2 ||
    !original.runtime.bootstrapNpm ||
    !successor.runtime.bootstrapNpm
  )
    fail("BOOTSTRAP_REQUIRED");
  if (
    successor.createdAtEpochMs < original.createdAtEpochMs ||
    originalEvidence.receipt.retiredAtEpochMs < original.createdAtEpochMs ||
    successor.createdAtEpochMs < originalEvidence.receipt.retiredAtEpochMs ||
    successorEvidence.receipt.retiredAtEpochMs < successor.createdAtEpochMs ||
    originalEvidence.receipt.installationId ===
      successorEvidence.receipt.installationId
  )
    fail("INVALID_SUCCESSOR");
  const prepared = preparedReceipt(members.preparedReceipt, recoveryKey);
  const admission = signedReceipt(members.admissionReceipt, recoveryKey, [
    "kind",
    "version",
    "scope",
    "activationAllowed",
    "root",
    "operator",
    "repositoryRoot",
    "physicalNpmCli",
    "checkpointSha256",
    "archiveSha256",
    "retirementSha256",
    "preparedReceiptSha256",
    "runId",
    "source",
    "reportPath",
    "sourceCommit",
    "configurationSha256",
    "buildParent",
    "remote",
    "transport",
    "immutableSha256",
  ]);
  const result = signedReceipt(members.resultReceipt, recoveryKey, [
    "status",
    "activationAllowed",
    "runId",
    "ledgerRevision",
    "admissionSha256",
    "candidateId",
  ]);
  same(admission.kind, "zivv-recovery-frozen-admission");
  same(admission.version, 1);
  same(admission.scope, "one-frozen-run-through-validate");
  same(admission.activationAllowed, false);
  same(result.status, "candidate-validated");
  same(result.activationAllowed, false);
  hash(admission.runId);
  hash(admission.sourceCommit, 40);
  hash(admission.configurationSha256);
  hash(admission.immutableSha256);
  hash(result.candidateId);
  const root = logicalPath(admission.root),
    operator = logicalPath(admission.operator),
    npmCli = logicalPath(admission.physicalNpmCli);
  logicalPath(admission.repositoryRoot);
  same(operator, pathJoin(root, "operator"));
  same(successor.originalOperatorDirectory, operator);
  same(successor.originalCheckout, pathJoin(root, "checkout"));
  if (
    original.originalOperatorDirectory === operator ||
    original.originalCheckout === successor.originalCheckout
  )
    fail("INVALID_SUCCESSOR");
  same(prepared.physicalRoot, root);
  same(prepared.physicalNpmCli, npmCli);
  same(prepared.archiveSha256, sha256(members.originalArchive));
  same(prepared.retirementSha256, sha256(members.originalRetirementReceipt));
  same(prepared.checkpointSha256, sha256(canonicalJson(original)));
  same(prepared.ledgerRevision, original.ledgerRevision);
  same(
    prepared.npmIdentitySha256,
    original.runtime.bootstrapNpm.identitySha256
  );
  same(admission.archiveSha256, prepared.archiveSha256);
  same(admission.retirementSha256, prepared.retirementSha256);
  same(admission.checkpointSha256, prepared.checkpointSha256);
  same(admission.preparedReceiptSha256, sha256(members.preparedReceipt));
  same(result.admissionSha256, sha256(members.admissionReceipt));
  same(result.runId, admission.runId);
  same(result.ledgerRevision, original.ledgerRevision);
  same(successor.ledger, original.ledger);
  same(successor.ledgerRevision, original.ledgerRevision);
  const originLineage = proveRecoveryWeeklyLineage({
      checkpoint: original,
      runId: admission.runId,
      stage: "frozen",
    }),
    successorLineage = proveRecoveryWeeklyLineage({
      checkpoint: successor,
      runId: admission.runId,
      stage: "validated",
    });
  same(admission.source, originLineage.run.source);
  same(successorLineage.run.source, originLineage.run.source);
  same(
    successorLineage.run.stages.slice(0, 5),
    originLineage.run.stages.slice(0, 5)
  );
  if (
    originLineage.run.stages.slice(5).some((stage) => stage.attempt !== 0) ||
    successorLineage.run.stages
      .slice(5, 8)
      .some((stage) => stage.attempt !== 1) ||
    successorLineage.run.revision !== originLineage.run.revision + 6
  )
    fail("CLEAN_FIRST_BUILD_REQUIRED");
  same(
    admission.reportPath,
    "checkout/data/ingestion/reports/" +
      sha256(String(originLineage.run.stages[3].evidence!.importRunId)) +
      ".json"
  );
  const originJournal = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(original.journal, "base64")
    ),
    successorJournal = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(successor.journal, "base64")
    );
  for (const row of originJournal.runState) {
    const next = successorJournal.runState.find((item) => item.id === row.id);
    if (row.id !== admission.runId) same(next, row, "HISTORICAL_RUN_CHANGED");
    else {
      if (!next) fail("RUN_MISSING");
      same(next.scope, row.scope);
    }
  }
  same(
    successorJournal.runState.map((row) => row.id),
    originJournal.runState.map((row) => row.id),
    "RUN_SET_CHANGED"
  );
  same(
    successorJournal.intakeEvidence,
    originJournal.intakeEvidence,
    "INTAKE_CHANGED"
  );
  for (const row of originJournal.stageArtifacts)
    same(
      successorJournal.stageArtifacts.find(
        (next) =>
          next.runId === row.runId &&
          next.stage === row.stage &&
          next.attempt === row.attempt
      ),
      row,
      "ORIGINAL_ARTIFACT_CHANGED"
    );
  const addedArtifacts = successorJournal.stageArtifacts.filter(
    (row) =>
      !originJournal.stageArtifacts.some(
        (old) =>
          old.runId === row.runId &&
          old.stage === row.stage &&
          old.attempt === row.attempt
      )
  );
  if (
    addedArtifacts.length !== 3 ||
    addedArtifacts.some(
      (row) =>
        row.runId !== admission.runId ||
        !["enrich", "export", "validate"].includes(row.stage) ||
        row.attempt !==
          successorLineage.run.stages.find((item) => item.stage === row.stage)!
            .attempt
    )
  )
    fail("UNEXPECTED_STAGE_ARTIFACT");
  const { bootstrapNpm: _oldNpm, ...oldRuntime } = original.runtime,
    { bootstrapNpm: _newNpm, ...newRuntime } = successor.runtime;
  same(newRuntime, oldRuntime, "RUNTIME_CHANGED");
  // Each full hash includes originalCli. Validate both hashes, then compare
  // the complete package content while binding the replacement path separately.
  const originalTool = validateNpmExecutionToolIdentity(
      original.runtime.bootstrapNpm
    ),
    successorTool = validateNpmExecutionToolIdentity(
      successor.runtime.bootstrapNpm
    ),
    {
      originalCli: _oldCli,
      identitySha256: _oldIdentity,
      ...oldTool
    } = originalTool,
    {
      originalCli: _newCli,
      identitySha256: _newIdentity,
      ...newTool
    } = successorTool;
  same(newTool, oldTool, "BOOTSTRAP_CHANGED");
  same(successorTool.originalCli, npmCli);
  const namespace =
      "weekly-candidates/r-" + sha256(admission.runId).slice(0, 16),
    buildParent = pathJoin(operator, ...namespace.split("/"));
  same(admission.buildParent, buildParent);
  if (
    original.files.some(
      (file) =>
        file.area === "operator" &&
        (file.path === namespace || file.path.startsWith(namespace + "/"))
    ) ||
    original.directories.some(
      (dir) =>
        dir.area === "operator" &&
        (dir.path === namespace || dir.path.startsWith(namespace + "/"))
    )
  )
    fail("PREEXISTING_BUILD_NAMESPACE");
  const successorFiles = checkpointFiles(successor),
    originalFiles = checkpointFiles(original);
  for (const [path, file] of originalFiles)
    same(successorFiles.get(path), file, "ORIGINAL_FILE_CHANGED");
  for (const dir of original.directories)
    if (
      !successor.directories.some(
        (next) => canonicalJson(next) === canonicalJson(dir)
      )
    )
      fail("ORIGINAL_DIRECTORY_CHANGED");
  for (const [path] of successorFiles)
    if (
      !originalFiles.has(path) &&
      !path.startsWith("operator/" + namespace + "/")
    )
      fail("UNEXPECTED_FILE");
  for (const dir of successor.directories)
    if (
      !original.directories.some(
        (old) => canonicalJson(old) === canonicalJson(dir)
      ) &&
      !(
        dir.area === "operator" &&
        (dir.path === "weekly-candidates" ||
          dir.path === namespace ||
          dir.path.startsWith(namespace + "/"))
      )
    )
      fail("UNEXPECTED_DIRECTORY");
  const remote = object(admission.remote, [
    "mainHead",
    "controlHead",
    "controlSha256",
    "acknowledgedOperationId",
    "acknowledgedCandidateId",
    "acknowledgedLedgerRevision",
    "acknowledgedCutoffEpochMs",
    "runId",
    "ledgerRevision",
    "sourceCommit",
    "freezeSha256",
  ]);
  for (const field of ["mainHead", "controlHead", "sourceCommit"])
    hash(remote[field], 40);
  for (const field of [
    "controlSha256",
    "acknowledgedOperationId",
    "acknowledgedCandidateId",
    "acknowledgedLedgerRevision",
    "ledgerRevision",
    "runId",
    "freezeSha256",
  ])
    hash(remote[field]);
  integer(remote.acknowledgedCutoffEpochMs);
  same(remote.runId, admission.runId);
  same(remote.sourceCommit, admission.sourceCommit);
  same(remote.ledgerRevision, original.ledgerRevision);
  same(remote.acknowledgedLedgerRevision, ledgerDigest(originLineage.baseline));
  same(remote.freezeSha256, sha256(originLineage.artifact("freeze")));
  if (
    remote.acknowledgedCutoffEpochMs >
    originLineage.run.source.importObservedAtEpochMs
  )
    fail("INVALID_ACKNOWLEDGED_CUTOFF");
  const transportValue = admission.transport;
  if (
    !transportValue ||
    typeof transportValue !== "object" ||
    Array.isArray(transportValue)
  )
    fail("INVALID_TRANSPORT");
  const transport = transportValue as Record<string, unknown>;
  if (transport.kind === "authoritative-https") object(transport, ["kind"]);
  else if (transport.kind === "temporary-bare-test") {
    object(transport, ["kind", "directory"]);
    logicalPath(transport.directory);
  } else fail("INVALID_TRANSPORT");
  const enriched = object(
      JSON.parse(successorLineage.artifact("enrich").toString("utf8")),
      ["schemaVersion", "build", "configuration", "configSha256"]
    ),
    build = object(enriched.build, [
      "sourceCommit",
      "purpose",
      "basePath",
      "npmCli",
    ]);
  same(enriched.schemaVersion, 1);
  same(build, {
    sourceCommit: admission.sourceCommit,
    purpose: "release",
    basePath: "/zivv/",
    npmCli,
  });
  const encoded = object(enriched.configuration, CANDIDATE_CONFIG_FILES),
    configuration = Object.fromEntries(
      CANDIDATE_CONFIG_FILES.map((path) => [
        path,
        encoded[path] === null
          ? null
          : base64(encoded[path], RECOVERY_RESULT_CHAIN_MAX_MEMBER_BYTES),
      ])
    ) as CandidateConfiguration;
  same(configurationDigest(configuration), enriched.configSha256);
  same(enriched.configSha256, admission.configurationSha256);
  for (const path of CANDIDATE_CONFIG_FILES)
    same(
      configuration[path]?.toString("base64") ?? null,
      originalFiles.get("checkout/data/" + path)?.bytes ?? null,
      "CONFIGURATION_CHANGED"
    );
  same(successorLineage.run.stages[5].evidence, {
    configSha256: enriched.configSha256,
    buildSha256: sha256(canonicalJson(build)),
  });
  const exported = object(
    JSON.parse(successorLineage.artifact("export").toString("utf8")),
    ["schemaVersion", "workDirectory", "snapshot"]
  );
  same(exported.schemaVersion, 1);
  const workDirectory = logicalPath(exported.workDirectory),
    flavor = /^[A-Za-z]:\\/.test(operator) ? win32 : posix,
    workRelative = flavor
      .relative(operator, workDirectory)
      .split(flavor.sep)
      .join("/");
  if (
    !new RegExp("^" + namespace + "/candidate-work-[A-Za-z0-9_-]+$").test(
      workRelative
    )
  )
    fail("INVALID_EXPORT_ROLE");
  const bundles = successor.directories.filter(
    (dir) =>
      dir.area === "operator" &&
      dir.path.startsWith(workRelative + "/") &&
      /^candidate-[^/]+$/.test(dir.path.slice(workRelative.length + 1))
  );
  if (bundles.length !== 1) fail("AMBIGUOUS_CANDIDATE");
  const bundleRelative = bundles[0].path,
    required = (suffix: string) => {
      const file = successorFiles.get(
        "operator/" + bundleRelative + "/" + suffix
      );
      if (!file?.bytes) fail("MISSING_CANDIDATE_FILE");
      return Buffer.from(file.bytes, "base64");
    };
  const candidateBytes = required("candidate.json"),
    candidate: ReleaseCandidate = parseReleaseCandidate(candidateBytes);
  same(candidate.candidateId, result.candidateId);
  same(candidate.sourceCommit, admission.sourceCommit);
  same(candidate.ledgerRevision, original.ledgerRevision);
  same(candidate.editionId, originLineage.run.source.editionId);
  same(candidate.basePath, "/zivv/");
  same(candidate.configSha256, admission.configurationSha256);
  if (!candidate.applicationProvenanceSha256) fail("PROVEN_BUILD_REQUIRED");
  same(
    required("recovery/ledger.snapshot.enc").toString("base64"),
    exported.snapshot
  );
  for (const path of CANDIDATE_CONFIG_FILES)
    same(
      successorFiles.get(
        "operator/" + bundleRelative + "/workspace/data/" + path
      )?.bytes ?? null,
      configuration[path]?.toString("base64") ?? null,
      "CANDIDATE_CONFIGURATION_CHANGED"
    );
  const buildReceipt = required("build/application-build.json"),
    toolBytes = required("build/execution-tools.json"),
    application = parseApplicationBuildReceipt(buildReceipt);
  if (application.schemaVersion !== 2 || application.purpose !== "release")
    fail("PROVEN_BUILD_REQUIRED");
  verifyBuildExecutionToolIdentity(application, toolBytes);
  const tool = validateNpmExecutionToolIdentity(
    JSON.parse(toolBytes.toString("utf8"))
  );
  same(tool.originalCli, npmCli);
  same(tool, successorTool, "BUILD_TOOL_CHANGED");
  // The mutable namespace is a location, not permission to retain arbitrary
  // siblings. Authenticate the one actual source-build recipe as well as seal.
  const allowedNewFiles = new Set<string>(
    [
      "candidate.json",
      "complete.json",
      "recovery/ledger.snapshot.enc",
      "build/application-build.json",
      "build/execution-tools.json",
      "build/vite-manifest.json",
      "workspace/data/ingestion/ledger.json",
      ...CANDIDATE_CONFIG_FILES.filter(
        (path) => configuration[path] !== null
      ).map((path) => "workspace/data/" + path),
      ...candidate.files.map((file) => "workspace/public/" + file.path),
    ].map((path) => "operator/" + bundleRelative + "/" + path)
  );
  const sourceBuilds = successor.directories.filter(
    (dir) =>
      dir.area === "operator" &&
      dir.path.startsWith(workRelative + "/") &&
      /^source-build-[A-Za-z0-9_-]+$/.test(
        dir.path.slice(workRelative.length + 1)
      )
  );
  if (sourceBuilds.length !== 1) fail("CAPTURED_SOURCE_BUILD_REQUIRED");
  const sourceRelative = sourceBuilds[0].path,
    sourcePrefix = "operator/" + sourceRelative + "/",
    sourceRootPrefix = sourcePrefix + "source/";
  const sourceFile = (path: string): Buffer => {
    const file = successorFiles.get(sourcePrefix + path);
    if (!file || file.bytes === null) fail("MISSING_SOURCE_BUILD_FILE");
    allowedNewFiles.add(sourcePrefix + path);
    return Buffer.from(file.bytes, "base64");
  };
  const captureBytes = sourceFile("source-capture.json"),
    capture = object(JSON.parse(captureBytes.toString("utf8")), [
      "directory",
      "sourceRoot",
      "sourceCommit",
      "sourceTree",
      "files",
      "archiveSha256",
      "purpose",
    ]);
  if (!captureBytes.equals(Buffer.from(canonicalJson(capture) + "\n")))
    fail("NONCANONICAL_SOURCE_CAPTURE");
  same(capture.directory, pathJoin(operator, ...sourceRelative.split("/")));
  same(capture.sourceRoot, pathJoin(String(capture.directory), "source"));
  same(capture.sourceCommit, admission.sourceCommit);
  same(capture.sourceTree, application.sourceTree);
  same(capture.archiveSha256, application.archiveSha256);
  same(capture.purpose, "release");
  if (
    !Array.isArray(capture.files) ||
    !capture.files.length ||
    capture.files.length > 50_000
  )
    fail("INVALID_SOURCE_INVENTORY");
  same(sha256(canonicalJson(capture.files)), application.sourceInventorySha256);
  const stream = sourceFile("source.blobs");
  same(sha256(stream), application.archiveSha256);
  const capturedSourcePaths = new Set<string>();
  const capturedSourceEntries: { path: string; blob: string; mode: string }[] =
    [];
  let streamOffset = 0,
    previousSourcePath = "";
  for (const entry of capture.files) {
    const file = object(entry, ["path", "blob", "mode"]);
    if (
      typeof file.path !== "string" ||
      !file.path ||
      file.path.length > 4096 ||
      Buffer.compare(Buffer.from(file.path), Buffer.from(previousSourcePath)) <=
        0 ||
      file.path
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.toLowerCase() === ".git" ||
            /[\\:\0]/.test(part)
        ) ||
      !["100644", "100755"].includes(String(file.mode))
    )
      fail("INVALID_SOURCE_INVENTORY");
    previousSourcePath = file.path;
    capturedSourcePaths.add(file.path);
    hash(file.blob, 40);
    capturedSourceEntries.push({
      path: file.path,
      blob: file.blob,
      mode: String(file.mode),
    });
    const newline = stream.indexOf(10, streamOffset),
      header =
        newline < 0
          ? null
          : /^([a-f0-9]{40}) blob (0|[1-9]\d*)$/.exec(
              stream.subarray(streamOffset, newline).toString("ascii")
            );
    if (!header || header[1] !== file.blob) fail("INVALID_SOURCE_BLOB_STREAM");
    const size = Number(header[2]),
      end = newline + 1 + size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end >= stream.length ||
      stream[end] !== 10
    )
      fail("INVALID_SOURCE_BLOB_STREAM");
    const contents = stream.subarray(newline + 1, end),
      retainedContents = sourceFile("source/" + file.path);
    if (
      !contents.equals(retainedContents) ||
      createHash("sha1")
        .update(Buffer.from(`blob ${contents.length}\0`))
        .update(contents)
        .digest("hex") !== file.blob
    )
      fail("SOURCE_CONTENT_CHANGED");
    streamOffset = end + 1;
  }
  if (streamOffset !== stream.length) fail("INVALID_SOURCE_BLOB_STREAM");
  same(
    sourceTreeDigest(capturedSourceEntries),
    capture.sourceTree,
    "SOURCE_TREE_CHANGED"
  );
  if (!capturedSourcePaths.has("package-lock.json"))
    fail("SOURCE_PACKAGE_LOCK_REQUIRED");
  same(
    sha256(sourceFile("source/package-lock.json")),
    application.packageLockSha256
  );
  if (
    !sourceFile("application-build.json").equals(buildReceipt) ||
    !sourceFile("execution-tools.json").equals(toolBytes) ||
    sourceFile("empty.npmrc").length !== 0
  )
    fail("SOURCE_BUILD_RECEIPT_CHANGED");
  const compiledFiles = [...successorFiles]
    .filter(
      ([path, file]) =>
        path.startsWith(sourceRootPrefix + "dist/") && file.bytes !== null
    )
    .map(([path, file]) => ({
      path: path.slice((sourceRootPrefix + "dist/").length),
      size: Buffer.byteLength(file.bytes!, "base64"),
      sha256: file.sha256!,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!compiledFiles.length) fail("COMPILED_SOURCE_REQUIRED");
  same(sha256(canonicalJson(compiledFiles)), application.etlInventorySha256);
  compiledFiles.forEach((file) =>
    allowedNewFiles.add(sourceRootPrefix + "dist/" + file.path)
  );
  for (const file of application.applicationFiles) {
    const bytes = sourceFile("application/" + file.path);
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
      fail("APPLICATION_OUTPUT_CHANGED");
  }
  if (
    !sourceFile("application/.vite/manifest.json").equals(
      required("build/vite-manifest.json")
    )
  )
    fail("APPLICATION_MANIFEST_CHANGED");
  // Vite copies these public source metadata files but excludes them from the
  // app receipt. Their original Git blobs still provide exact byte authority.
  for (const [path, file] of successorFiles)
    if (
      path.startsWith(sourcePrefix + "application/data/") ||
      path === sourcePrefix + "application/CNAME"
    ) {
      const relative = path.slice((sourcePrefix + "application/").length);
      if (!capturedSourcePaths.has("public/" + relative))
        fail("COPIED_PUBLIC_METADATA_CHANGED");
      const source = sourceFile("source/public/" + relative);
      if (
        file.bytes === null ||
        !source.equals(Buffer.from(file.bytes, "base64"))
      )
        fail("COPIED_PUBLIC_METADATA_CHANGED");
      allowedNewFiles.add(path);
    }
  // A clean enrichment captures reviewed source before export creates its own
  // build workspace. Admit exactly that source-only sibling, with the same
  // authenticated input bytes; it cannot contain a second or partial build.
  const enrichmentWorks = successor.directories.filter(
    (dir) =>
      dir.area === "operator" &&
      dir.path !== workRelative &&
      dir.path.startsWith(namespace + "/") &&
      /^candidate-work-[A-Za-z0-9_-]+$/.test(
        dir.path.slice(namespace.length + 1)
      )
  );
  if (enrichmentWorks.length !== 1) fail("ENRICH_SOURCE_CAPTURE_REQUIRED");
  const enrichmentWork = enrichmentWorks[0].path,
    enrichmentSources = successor.directories.filter(
      (dir) =>
        dir.area === "operator" &&
        dir.path.startsWith(enrichmentWork + "/") &&
        /^source-build-[A-Za-z0-9_-]+$/.test(
          dir.path.slice(enrichmentWork.length + 1)
        )
    );
  if (enrichmentSources.length !== 1) fail("ENRICH_SOURCE_CAPTURE_REQUIRED");
  const enrichmentRelative = enrichmentSources[0].path,
    enrichmentPrefix = "operator/" + enrichmentRelative + "/",
    enrichmentFile = (path: string) => {
      const file = successorFiles.get(enrichmentPrefix + path);
      if (!file || file.bytes === null) fail("ENRICH_SOURCE_CONTENT_CHANGED");
      allowedNewFiles.add(enrichmentPrefix + path);
      return Buffer.from(file.bytes, "base64");
    },
    enrichmentCaptureBytes = enrichmentFile("source-capture.json"),
    expectedEnrichmentCapture = {
      ...capture,
      directory: pathJoin(operator, ...enrichmentRelative.split("/")),
      sourceRoot: pathJoin(
        operator,
        ...enrichmentRelative.split("/"),
        "source"
      ),
    };
  if (
    !enrichmentCaptureBytes.equals(
      Buffer.from(canonicalJson(expectedEnrichmentCapture) + "\n")
    )
  )
    fail("ENRICH_SOURCE_CAPTURE_CHANGED");
  if (!enrichmentFile("source.blobs").equals(stream))
    fail("ENRICH_SOURCE_CONTENT_CHANGED");
  for (const file of capturedSourceEntries)
    if (
      !enrichmentFile("source/" + file.path).equals(
        sourceFile("source/" + file.path)
      )
    )
      fail("ENRICH_SOURCE_CONTENT_CHANGED");
  for (const [path] of successorFiles)
    if (!originalFiles.has(path) && !allowedNewFiles.has(path))
      fail("UNEXPLAINED_BUILD_FILE");
  const allowedNewDirectories = new Set<string>();
  // ETL creates this exact staging parent, then renames its sole output tree
  // into public/data. No residual child is part of a completed clean export.
  allowedNewDirectories.add("operator/" + bundleRelative + "/workspace/.cache");
  for (const path of allowedNewFiles) {
    const parts = path.split("/");
    for (let count = 2; count < parts.length; count++)
      allowedNewDirectories.add(parts.slice(0, count).join("/"));
  }
  for (const dir of successor.directories)
    if (
      !original.directories.some(
        (old) => canonicalJson(old) === canonicalJson(dir)
      ) &&
      !allowedNewDirectories.has(dir.area + "/" + dir.path)
    )
      fail("UNEXPLAINED_BUILD_DIRECTORY");
  same(successorLineage.run.stages[6].evidence, {
    ledgerRevision: candidate.ledgerRevision,
    snapshotRevision: candidate.ledgerRevision,
    manifestSha256: candidate.manifestSha256,
    datasetVersion: candidate.datasetVersion,
    candidateId: candidate.candidateId,
    editionId: candidate.editionId,
    cutoffEpochMs: candidate.cutoffEpochMs,
    membershipSha256: candidate.membershipSha256,
    configSha256: candidate.configSha256,
  });
  const validation = {
    candidateId: candidate.candidateId,
    manifestSha256: candidate.manifestSha256,
  };
  same(successorLineage.run.stages[7].evidence, validation);
  same(
    object(JSON.parse(successorLineage.artifact("validate").toString("utf8")), [
      "schemaVersion",
      "candidateId",
      "manifestSha256",
    ]),
    { schemaVersion: 1, ...validation }
  );
  const certificate = {
    kind: format,
    version: 1,
    depth: 1,
    activationAllowed: false as const,
    physicalValidationRequired: true as const,
    freshRemoteValidationRequired: true as const,
    members: Object.fromEntries(
      names.map((name) => [
        name,
        { sha256: sha256(members[name]), size: members[name].length },
      ])
    ),
    originalCheckpointSha256: sha256(canonicalJson(original)),
    successorCheckpointSha256: sha256(canonicalJson(successor)),
    originalInstallationId: originalEvidence.receipt.installationId,
    successorInstallationId: successorEvidence.receipt.installationId,
    originalOperatorDirectory: original.originalOperatorDirectory,
    originalCheckout: original.originalCheckout,
    intermediateOperatorDirectory: operator,
    intermediateCheckout: successor.originalCheckout,
    runId: admission.runId,
    source: structuredClone(originLineage.run.source),
    ledgerRevision: original.ledgerRevision,
    originalStageSha256: sha256(
      canonicalJson(originLineage.run.stages.slice(0, 5))
    ),
    successorStageSha256: sha256(
      canonicalJson(successorLineage.run.stages.slice(0, 8))
    ),
    originalArtifactSha256: sha256(canonicalJson(originJournal.stageArtifacts)),
    successorArtifactSha256: sha256(
      canonicalJson(successorJournal.stageArtifacts)
    ),
    frozenWeeklySha256: sha256(originLineage.frozenWeeklyBytes),
    configurationSha256: admission.configurationSha256,
    sourceCommit: admission.sourceCommit,
    candidateId: candidate.candidateId,
    candidateSha256: sha256(candidateBytes),
    completeSha256: sha256(required("complete.json")),
    validationSha256: sha256(successorLineage.artifact("validate")),
    applicationBuildSha256: sha256(buildReceipt),
    sourceCaptureSha256: sha256(captureBytes),
    executionToolsSha256: sha256(toolBytes),
    npmIdentitySha256: tool.identitySha256,
    exportRole: { workDirectory, workRelative, bundleRelative },
    preparedTreeSha256: prepared.treeSha256,
    admittedImmutableSha256: admission.immutableSha256,
    remote: structuredClone(remote),
    transport: structuredClone(transport),
  };
  return {
    activationAllowed: false as const,
    physicalValidationRequired: true as const,
    freshRemoteValidationRequired: true as const,
    chainId: sha256(canonicalJson(certificate)),
    certificate,
    originalCheckpoint: structuredClone(original),
    successorCheckpoint: structuredClone(successor),
    candidate: structuredClone(candidate),
    candidateBytes: Buffer.from(candidateBytes),
    members,
  };
}

/** Seal content provenance only; a later locked physical validation is mandatory. */
export function encryptRecoveryResultChain(
  input: RecoveryResultChainInput
): Buffer {
  const proof = proveRecoveryResultChain(input),
    recoveryKey = key(input.recoveryKey),
    certificateSignature = createHmac("sha256", recoveryKey)
      .update(certificateDomain)
      .update(canonicalJson(proof.certificate))
      .digest("hex"),
    certificate = Buffer.from(
      canonicalJson({
        payload: proof.certificate,
        signature: certificateSignature,
      }) + "\n"
    );
  if (certificate.length > maxCertificateBytes) fail("LIMIT");
  const header = Buffer.alloc(memberHeaderBytes);
  memberMagic.copy(header);
  header[memberMagic.length] = 1;
  header[memberMagic.length + 1] = 1;
  names.forEach((name, index) =>
    header.writeUInt32BE(
      proof.members[name].length,
      memberMagic.length + 2 + index * 4
    )
  );
  header.writeUInt32BE(
    certificate.length,
    memberMagic.length + 2 + names.length * 4
  );
  const clear = Buffer.concat([
    header,
    ...names.map((name) => proof.members[name]),
    certificate,
  ]);
  if (clear.length > maxClearBytes) fail("LIMIT");
  const compressed = gzipSync(clear);
  if (compressed.length > maxCompressedBytes) fail("LIMIT");
  const prefix = Buffer.alloc(outerPrefixBytes),
    nonce = randomBytes(12);
  outerMagic.copy(prefix);
  Buffer.from([1, 1, 1, 1]).copy(prefix, outerMagic.length);
  Buffer.from(sha256(recoveryKey), "hex").copy(prefix, outerMagic.length + 4);
  nonce.copy(prefix, outerMagic.length + 4 + 32);
  prefix.writeUInt32BE(compressed.length, outerPrefixBytes - 4);
  const cipher = createCipheriv("aes-256-gcm", recoveryKey, nonce);
  cipher.setAAD(prefix);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([prefix, cipher.getAuthTag(), ciphertext]);
}

/** Authenticate, bound decompression and rederive every certificate field; no effects. */
export function decryptRecoveryResultChain(
  bytes: Buffer,
  suppliedKey: Buffer
): ReturnType<typeof proveRecoveryResultChain> {
  const recoveryKey = key(suppliedKey);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < outerPrefixBytes + 16 ||
    bytes.length > maxEnvelopeBytes
  )
    fail("LIMIT");
  const prefix = bytes.subarray(0, outerPrefixBytes);
  if (
    !prefix.subarray(0, outerMagic.length).equals(outerMagic) ||
    !prefix
      .subarray(outerMagic.length, outerMagic.length + 4)
      .equals(Buffer.from([1, 1, 1, 1]))
  )
    fail("INVALID_ENVELOPE");
  if (
    !prefix
      .subarray(outerMagic.length + 4, outerMagic.length + 4 + 32)
      .equals(Buffer.from(sha256(recoveryKey), "hex"))
  )
    fail("INVALID_KEY");
  const ciphertextLength = prefix.readUInt32BE(outerPrefixBytes - 4);
  if (
    !ciphertextLength ||
    ciphertextLength > maxCompressedBytes ||
    bytes.length !== outerPrefixBytes + 16 + ciphertextLength
  )
    fail("INVALID_LENGTH");
  const nonce = prefix.subarray(
      outerMagic.length + 4 + 32,
      outerMagic.length + 4 + 32 + 12
    ),
    tag = bytes.subarray(outerPrefixBytes, outerPrefixBytes + 16),
    decipher = createDecipheriv("aes-256-gcm", recoveryKey, nonce);
  decipher.setAAD(prefix);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([
      decipher.update(bytes.subarray(outerPrefixBytes + 16)),
      decipher.final(),
    ]),
    clear = gunzipSync(compressed, { maxOutputLength: maxClearBytes });
  if (
    clear.length < memberHeaderBytes ||
    !clear.subarray(0, memberMagic.length).equals(memberMagic) ||
    clear[memberMagic.length] !== 1 ||
    clear[memberMagic.length + 1] !== 1
  )
    fail("INVALID_CONTENT");
  const lengths = names.map((_, index) =>
      clear.readUInt32BE(memberMagic.length + 2 + index * 4)
    ),
    certificateLength = clear.readUInt32BE(
      memberMagic.length + 2 + names.length * 4
    );
  if (
    !certificateLength ||
    certificateLength > maxCertificateBytes ||
    lengths.reduce((sum, length) => sum + length, 0) >
      RECOVERY_RESULT_CHAIN_MAX_MEMBER_BYTES
  )
    fail("LIMIT");
  if (
    memberHeaderBytes +
      lengths.reduce((sum, length) => sum + length, 0) +
      certificateLength !==
    clear.length
  )
    fail("INVALID_LENGTH");
  let offset = memberHeaderBytes;
  const members = Object.fromEntries(
    names.map((name, index) => {
      const length = lengths[index],
        limit =
          name === "originalArchive" || name === "successorArchive"
            ? maxArchiveBytes
            : maxMetadataBytes;
      if (!length || length > limit) fail("LIMIT");
      const member = clear.subarray(offset, offset + length);
      offset += length;
      return [name, member];
    })
  ) as unknown as RecoveryResultChainMembers;
  const certificateBytes = clear.subarray(offset),
    content = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(certificateBytes)
      ),
      ["payload", "signature"]
    );
  if (!certificateBytes.equals(Buffer.from(canonicalJson(content) + "\n")))
    fail("NONCANONICAL_CERTIFICATE");
  hash(content.signature);
  const signature = createHmac("sha256", recoveryKey)
    .update(certificateDomain)
    .update(canonicalJson(content.payload))
    .digest();
  if (!timingSafeEqual(Buffer.from(content.signature, "hex"), signature))
    fail("INVALID_CERTIFICATE_SIGNATURE");
  const proof = proveRecoveryResultChain({ members, recoveryKey });
  same(content.payload, proof.certificate, "CERTIFICATE_MISMATCH");
  return proof;
}
