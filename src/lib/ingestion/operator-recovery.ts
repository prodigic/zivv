import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  join,
  posix,
  win32,
  relative,
  isAbsolute,
  resolve,
} from "node:path";
import {
  createOperatorRetirementReceipt,
  verifyOperatorRetirementReceipt,
  withOperatorRetirementScope,
  type OperatorRetirementReceipt,
} from "./operator-installation.js";
import { validateLedger } from "./ledger.js";
import type {
  IngestionLedger,
  ReconciliationReport,
} from "../../types/ingestion.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  readSqliteLedgerReadOnly,
  withStoreTransaction,
  writeSqliteLedger,
  assertNoActiveStoreTransaction,
} from "./sqlite-store.js";
import {
  CANDIDATE_CONFIG_FILES,
  type CandidateConfiguration,
} from "./export-configuration.js";
import { importReportDigest } from "./steve-import-review.js";
import {
  parseReleaseCandidate,
  verifySealedCandidate,
} from "./release-candidate.js";
import {
  secureOperatorDirectory,
  writeDurableFile,
  loadBackupKey,
} from "./encrypted-backup.js";
import {
  assertOperatorNotQuarantined,
  resolvePrivateCandidateDirectory,
} from "./private-artifacts.js";
import { projectLedgerLocation } from "./store-location.js";
import {
  compiledEtlDigest,
  verifyBuildExecutionToolIdentity,
  parseApplicationBuildReceipt,
} from "./source-build.js";
import { sha256 } from "./steve-preflight.js";
import {
  WeeklyRunJournal,
  validateWeeklyJournalRecoverySnapshot,
  readWeeklyJournalRecoverySnapshotReadOnly,
} from "./weekly-run-journal.js";
import {
  captureNpmExecutionTool,
  validateNpmExecutionToolIdentity,
  verifyNpmExecutionTool,
  type NpmExecutionToolIdentity,
} from "./execution-tool-identity.js";
import {
  assertRecoveryResultCaptureCurrent,
  finalizeRecoveryResultCapture,
} from "./recovery-result-recapture.js";
import { proveRecoveryGmailBatchInventory } from "./recovery-gmail-batch-proof.js";
import { repairSteveGmailBatchStagingForRecovery } from "./steve-gmail-handoff.js";

const scope = "prodigic/zivv/production";
const format = "zivv-operator-recovery";
const maxBytes = 256 * 1024 * 1024;
const maxFiles = 50000;
const operatorTrees = [
  "email-acquisition",
  "email-intake",
  "weekly-candidates",
  "weekly-publication",
  "rollback",
];
const omitted = new Set(["node_modules", "npm-cache"]);
const operatorInfrastructure = new Set([
  "ledger.sqlite",
  "ledger.sqlite-wal",
  "ledger.sqlite-shm",
  "weekly-runs.sqlite",
  "weekly-runs.sqlite-wal",
  "weekly-runs.sqlite-shm",
  "backup-key.bin",
  "backup-key.dpapi",
]);
const checkoutFiles = [
  ...new Set([
    ...CANDIDATE_CONFIG_FILES.map((path) => "data/" + path),
    "data/venue-aliases.json",
    "data/line-corrections.json",
    "data/ingestion/store.json",
    "data/ingestion/historical-batches.json",
    "data/ingestion/migration.json",
    "package.json",
    "package-lock.json",
  ]),
].sort();
const checkoutTrees = [
  "data/ingestion/reports",
  "dist/lib",
  "dist/types",
  "dist/utils",
];

interface RecoveryFile {
  area: "operator" | "checkout";
  path: string;
  sha256: string | null;
  bytes: string | null;
}
export interface OperatorRecoveryCheckpoint {
  format: typeof format;
  version: 1 | 2;
  createdAtEpochMs: number;
  originalOperatorDirectory: string;
  originalCheckout: string;
  runtime: {
    node: string;
    icu: string;
    executableSha256: string;
    workerSha256: string;
    lockfileSha256: string;
    bootstrapNpm?: NpmExecutionToolIdentity;
  };
  ledgerRevision: string;
  ledger: IngestionLedger;
  journal: string;
  files: RecoveryFile[];
  directories: { area: RecoveryFile["area"]; path: string }[];
}
function fail(): never {
  throw new Error("INVALID_OPERATOR_RECOVERY");
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort())
  )
    fail();
  return value as Record<string, unknown>;
}
function base64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > maxBytes * 1.4) fail();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail();
  return bytes;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    value
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_.@+ -]+$/.test(part) &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  );
}
function allowed(area: string, path: string): boolean {
  const components = path.split("/");
  if (components.some((part) => omitted.has(part))) return false;
  if (area === "operator" && components[0] === "email-acquisition")
    return /^email-acquisition\/batches\/[a-f0-9]{64}\.json$/.test(path);
  return area === "operator"
    ? operatorTrees.some((tree) => path.startsWith(tree + "/"))
    : area === "checkout" &&
        (checkoutFiles.includes(path) ||
          checkoutTrees.some((tree) => path.startsWith(tree + "/")));
}
function regular(path: string, limit = maxBytes): Buffer {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (lstatSync(parent).isSymbolicLink()) fail();
    if (dirname(parent) === parent) break;
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit
  )
    fail();
  return readFileSync(path);
}
function inventory(
  operator: string,
  checkout: string,
  retirementReceipt?: Buffer
): Pick<OperatorRecoveryCheckpoint, "files" | "directories"> {
  const files: RecoveryFile[] = [];
  const directories: OperatorRecoveryCheckpoint["directories"] = [];
  let total = 0;
  function add(
    area: RecoveryFile["area"],
    root: string,
    path: string,
    absent = false
  ) {
    if (!safePath(path) || !allowed(area, path)) fail();
    const bytes = absent ? null : regular(join(root, path));
    total += bytes?.length ?? 0;
    if (total > maxBytes || files.length >= maxFiles)
      throw new Error("RECOVERY_CAPSULE_LIMIT");
    files.push({
      area,
      path,
      sha256: bytes === null ? null : sha256(bytes),
      bytes: bytes?.toString("base64") ?? null,
    });
  }
  function tree(area: RecoveryFile["area"], root: string, path: string) {
    const acquisition =
      area === "operator" && path.split("/")[0] === "email-acquisition";
    if (
      acquisition &&
      !["email-acquisition", "email-acquisition/batches"].includes(path)
    )
      fail();
    const absolute = join(root, path);
    if (!existsSync(absolute)) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
    directories.push({ area, path });
    if (directories.length > maxFiles) fail();
    for (const name of readdirSync(absolute).sort()) {
      if (omitted.has(name) && !acquisition) continue;
      const child = path + "/" + name,
        info = lstatSync(join(root, child));
      if (info.isDirectory() && !info.isSymbolicLink()) tree(area, root, child);
      else add(area, root, child);
    }
  }
  for (const name of readdirSync(operator))
    if (name === "recovery") {
      const path = join(operator, name);
      if (
        lstatSync(path).isSymbolicLink() ||
        !lstatSync(path).isDirectory() ||
        readdirSync(path).some((file) => file !== "backup-recovery.key")
      )
        throw new Error("UNCLASSIFIED_OPERATOR_ARTIFACT");
    } else if (name === "operator-retired.json" && retirementReceipt) {
      if (!regular(join(operator, name), 16 * 1024).equals(retirementReceipt))
        throw new Error("RETIREMENT_EVIDENCE_MISMATCH");
    } else if (
      !operatorInfrastructure.has(name) &&
      !operatorTrees.includes(name)
    )
      throw new Error("UNCLASSIFIED_OPERATOR_ARTIFACT");
  for (const path of operatorTrees) tree("operator", operator, path);
  for (const path of checkoutFiles)
    add("checkout", checkout, path, !existsSync(join(checkout, path)));
  for (const path of checkoutTrees) tree("checkout", checkout, path);
  const ordered = <T extends { area: string; path: string }>(entries: T[]) =>
    entries.sort((a, b) =>
      a.area < b.area
        ? -1
        : a.area > b.area
          ? 1
          : a.path < b.path
            ? -1
            : a.path > b.path
              ? 1
              : 0
    );
  return { files: ordered(files), directories: ordered(directories) };
}

/** Validate hashes and references without executing code or installing restored state. */
export function validateOperatorRecoveryCheckpoint(
  value: unknown
): OperatorRecoveryCheckpoint {
  const raw = object(value, [
    "format",
    "version",
    "createdAtEpochMs",
    "originalOperatorDirectory",
    "originalCheckout",
    "runtime",
    "ledgerRevision",
    "ledger",
    "journal",
    "files",
    "directories",
  ]);
  if (
    raw.format !== format ||
    (raw.version !== 1 && raw.version !== 2) ||
    !Number.isSafeInteger(raw.createdAtEpochMs) ||
    Number(raw.createdAtEpochMs) < 0 ||
    typeof raw.originalOperatorDirectory !== "string" ||
    typeof raw.originalCheckout !== "string" ||
    !raw.originalOperatorDirectory ||
    !raw.originalCheckout ||
    !Array.isArray(raw.files) ||
    raw.files.length > maxFiles
  )
    fail();
  const runtimeKeys = [
    "node",
    "icu",
    "executableSha256",
    "workerSha256",
    "lockfileSha256",
  ];
  if (raw.version === 2) runtimeKeys.push("bootstrapNpm");
  const runtime = object(raw.runtime, runtimeKeys);
  if (
    typeof runtime.node !== "string" ||
    typeof runtime.icu !== "string" ||
    !digest(runtime.executableSha256) ||
    !digest(runtime.workerSha256) ||
    !digest(runtime.lockfileSha256)
  )
    fail();
  if (raw.version === 2) validateNpmExecutionToolIdentity(runtime.bootstrapNpm);
  validateLedger(raw.ledger);
  if (ledgerDigest(raw.ledger) !== raw.ledgerRevision) fail();
  const journal = validateWeeklyJournalRecoverySnapshot(base64(raw.journal));
  const files = new Map<string, Buffer | null>();
  let total = 0,
    previous = "";
  const folded = new Set<string>();
  for (const file of raw.files) {
    const entry = object(file, ["area", "path", "sha256", "bytes"]);
    if (
      !safePath(entry.path) ||
      typeof entry.area !== "string" ||
      !allowed(entry.area, entry.path)
    )
      fail();
    const key = entry.area + "/" + entry.path;
    if (key <= previous || folded.has(key.toLowerCase())) fail();
    previous = key;
    folded.add(key.toLowerCase());
    const bytes = entry.bytes === null ? null : base64(entry.bytes);
    if (bytes === null ? entry.sha256 !== null : sha256(bytes) !== entry.sha256)
      fail();
    if (
      bytes === null &&
      !(entry.area === "checkout" && checkoutFiles.includes(entry.path))
    )
      fail();
    total += bytes?.length ?? 0;
    if (total > maxBytes) fail();
    files.set(key, bytes);
  }
  for (const path of checkoutFiles) if (!files.has("checkout/" + path)) fail();
  if (!Array.isArray(raw.directories) || raw.directories.length > maxFiles)
    fail();
  const directories = new Set<string>();
  previous = "";
  for (const item of raw.directories) {
    const dir = object(item, ["area", "path"]);
    if (
      !safePath(dir.path) ||
      (dir.area !== "operator" && dir.area !== "checkout")
    )
      fail();
    const trees = dir.area === "operator" ? operatorTrees : checkoutTrees;
    if (
      (dir.area === "operator" &&
        dir.path.split("/")[0] === "email-acquisition" &&
        !["email-acquisition", "email-acquisition/batches"].includes(
          dir.path
        )) ||
      !trees.some(
        (tree) =>
          dir.path === tree || (dir.path as string).startsWith(tree + "/")
      ) ||
      dir.path.split("/").some((part) => omitted.has(part))
    )
      fail();
    const key = dir.area + "/" + dir.path;
    if (key <= previous || folded.has(key.toLowerCase())) fail();
    previous = key;
    folded.add(key.toLowerCase());
    directories.add(key);
  }
  for (const key of [...files.keys(), ...directories]) {
    const parts = key.split("/");
    for (let count = 2; count < parts.length; count++) {
      const parent = parts.slice(0, count).join("/");
      if (
        files.has(parent) ||
        (folded.has(parent.toLowerCase()) && !directories.has(parent))
      )
        fail();
    }
  }
  if (
    !files.get("checkout/package-lock.json") ||
    sha256(files.get("checkout/package-lock.json")!) !== runtime.lockfileSha256
  )
    fail();
  if (!files.get("checkout/dist/lib/ingestion/weekly-import-runner.js")) fail();
  function retained(path: string, hash?: string): Buffer {
    const bytes = files.get(path);
    if (!bytes || (hash && sha256(bytes) !== hash))
      throw new Error("INCOMPLETE_OPERATOR_RECOVERY");
    return bytes;
  }
  for (const record of journal.intakeEvidence) {
    const evidence = JSON.parse(
      base64(record.bytes).toString("utf8")
    ) as Record<string, unknown>;
    if (record.kind === "source") {
      if (
        evidence.receiptId !== record.id ||
        !digest(evidence.accountSha256) ||
        !digest(evidence.sourceSha256) ||
        !digest(evidence.rawSha256) ||
        typeof evidence.messageId !== "string"
      )
        fail();
      const root = "operator/email-intake/" + evidence.accountSha256;
      const receipt = retained(root + "/bodies/" + record.id + "/receipt.json");
      if (!receipt.equals(base64(record.bytes))) fail();
      retained(
        root + "/bodies/" + record.id + "/source.txt",
        evidence.sourceSha256
      );
      retained(
        root + "/messages/" + sha256(evidence.messageId) + "/message.eml",
        evidence.rawSha256
      );
      retained(
        root + "/messages/" + sha256(evidence.messageId) + "/capture.json"
      );
    } else {
      const source = journal.intakeEvidence.find(
        (row) =>
          row.kind === "source" &&
          row.id === record.id &&
          row.scope === record.scope
      );
      if (!source) fail();
      const receipt = JSON.parse(base64(source.bytes).toString("utf8")) as {
        accountSha256: string;
      };
      if (
        !retained(
          "operator/email-intake/" +
            receipt.accountSha256 +
            "/bodies/" +
            record.id +
            "/correction-approval.json"
        ).equals(base64(record.bytes))
      )
        fail();
    }
  }
  for (const run of journal.runState) {
    const state = JSON.parse(run.payload) as {
      source: { rawSha256: string };
      stages: {
        stage: string;
        status: string;
        attempt: number;
        evidence: Record<string, unknown> | null;
      }[];
    };
    if (
      !journal.stageArtifacts.some(
        (row) =>
          row.runId === run.id &&
          row.stage === "acquire" &&
          row.attempt === 0 &&
          row.identity === state.source.rawSha256
      )
    )
      throw new Error("INCOMPLETE_OPERATOR_RECOVERY");
    for (const stage of state.stages)
      if (
        stage.status === "succeeded" &&
        !journal.stageArtifacts.some(
          (row) =>
            row.runId === run.id &&
            row.stage === stage.stage &&
            row.attempt === stage.attempt
        )
      )
        throw new Error("INCOMPLETE_OPERATOR_RECOVERY");
    const load = state.stages.find((stage) => stage.stage === "load");
    if (load?.status === "succeeded") {
      if (typeof load.evidence?.importRunId !== "string") fail();
      const report = JSON.parse(
        retained(
          "checkout/data/ingestion/reports/" +
            sha256(load.evidence.importRunId) +
            ".json"
        ).toString("utf8")
      ) as ReconciliationReport;
      if (
        report.runId !== load.evidence.importRunId ||
        importReportDigest(report) !== load.evidence.reportSha256
      )
        fail();
    }
  }
  function referencedDirectory(absolute: unknown): void {
    if (typeof absolute !== "string") fail();
    const paths = win32.isAbsolute(raw.originalOperatorDirectory as string)
      ? win32
      : posix;
    const rel = paths
      .relative(raw.originalOperatorDirectory as string, absolute)
      .split(paths.sep)
      .join("/");
    if (!safePath(rel) || !directories.has("operator/" + rel))
      throw new Error("EXTERNAL_OR_MISSING_RECOVERY_ARTIFACT");
  }
  for (const artifact of journal.stageArtifacts) {
    let data: unknown;
    try {
      data = JSON.parse(base64(artifact.bytes).toString("utf8"));
    } catch {
      continue;
    }
    function visit(value: unknown): void {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (["workDirectory", "sourceRoot"].includes(key))
          referencedDirectory(child);
        else visit(child);
      }
    }
    visit(data);
  }
  const checkpoint = value as OperatorRecoveryCheckpoint;
  const buildArtifacts = new Map(
    checkpoint.files
      .filter((file) => file.bytes !== null)
      .map((file) => [file.area + "/" + file.path, base64(file.bytes)])
  );
  for (const [path, bytes] of buildArtifacts) {
    if (
      !path.startsWith("operator/weekly-candidates/") ||
      !/\/(?:source-build-[^/]+|candidate-[^/]+\/build)\/application-build\.json$/.test(
        path
      )
    )
      continue;
    const receipt = parseApplicationBuildReceipt(bytes);
    if (receipt.schemaVersion === 2)
      verifyBuildExecutionToolIdentity(
        receipt,
        buildArtifacts.get(
          path.replace(/application-build\.json$/, "execution-tools.json")
        )
      );
  }
  candidateBundles(checkpoint);
  return checkpoint;
}

function candidateBundles(checkpoint: OperatorRecoveryCheckpoint) {
  const journal = validateWeeklyJournalRecoverySnapshot(
    base64(checkpoint.journal)
  );
  const files = new Map(
    checkpoint.files
      .filter((file) => file.bytes !== null)
      .map((file) => [file.area + "/" + file.path, base64(file.bytes)])
  );
  function required(path: string) {
    const bytes = files.get(path);
    if (!bytes) throw Error("INCOMPLETE_OPERATOR_RECOVERY");
    return bytes;
  }
  return journal.runState.flatMap((run) => {
    const state = JSON.parse(run.payload) as {
      stages: {
        stage: string;
        status: string;
        attempt: number;
        evidence: Record<string, unknown> | null;
      }[];
    };
    const exported = state.stages.find((stage) => stage.stage === "export");
    if (exported?.status !== "succeeded") return [];
    const intent = journal.stageArtifacts.find(
      (row) =>
        row.runId === run.id &&
        row.stage === "export" &&
        row.attempt === exported.attempt
    );
    if (!intent) fail();
    const data = JSON.parse(base64(intent.bytes).toString("utf8")) as {
      workDirectory: string;
    };
    if (typeof data.workDirectory !== "string") fail();
    const paths = win32.isAbsolute(checkpoint.originalOperatorDirectory)
      ? win32
      : posix;
    const relative = paths
      .relative(checkpoint.originalOperatorDirectory, data.workDirectory)
      .split(paths.sep)
      .join("/");
    const prefix = relative + "/";
    const directories = checkpoint.directories.filter(
      (dir) =>
        dir.area === "operator" &&
        dir.path.startsWith(prefix) &&
        /^candidate-[^/]+$/.test(dir.path.slice(prefix.length))
    );
    if (directories.length !== 1) throw Error("INCOMPLETE_OPERATOR_RECOVERY");
    const bundle = "operator/" + directories[0].path + "/";
    const candidate = parseReleaseCandidate(
      required(bundle + "candidate.json")
    );
    if (
      candidate.candidateId !== exported.evidence?.candidateId ||
      canonicalJson(
        JSON.parse(required(bundle + "complete.json").toString("utf8"))
      ) !==
        canonicalJson({ schemaVersion: 1, candidateId: candidate.candidateId })
    )
      fail();
    const ledger: unknown = JSON.parse(
      required(bundle + "workspace/data/ingestion/ledger.json").toString("utf8")
    );
    validateLedger(ledger);
    const snapshot = required(bundle + "recovery/ledger.snapshot.enc");
    if (
      ledgerDigest(ledger) !== candidate.ledgerRevision ||
      sha256(snapshot) !== candidate.snapshotSha256
    )
      fail();
    const configuration = Object.fromEntries(
      CANDIDATE_CONFIG_FILES.map((path) => [
        path,
        files.get(bundle + "workspace/data/" + path) ?? null,
      ])
    ) as CandidateConfiguration;
    const publicPrefix = bundle + "workspace/public/";
    const publicFiles = new Map(
      [...files]
        .filter(([path]) => path.startsWith(publicPrefix))
        .map(([path, bytes]) => [path.slice(publicPrefix.length), bytes])
    );
    if (publicFiles.size !== candidate.files.length) fail();
    for (const file of candidate.files) {
      const bytes = publicFiles.get(file.path);
      if (!bytes || bytes.length !== file.size || sha256(bytes) !== file.sha256)
        fail();
    }
    const applicationBuildManifest = required(
      bundle + "build/vite-manifest.json"
    );
    const applicationBuildReceipt =
      candidate.applicationProvenanceSha256 === null
        ? undefined
        : required(bundle + "build/application-build.json");
    const executionToolIdentity =
      applicationBuildReceipt &&
      JSON.parse(applicationBuildReceipt.toString("utf8")).schemaVersion === 2
        ? required(bundle + "build/execution-tools.json")
        : undefined;
    return [
      {
        candidate,
        inputs: {
          sourceCommit: candidate.sourceCommit,
          basePath: candidate.basePath,
          editionId: candidate.editionId,
          ledger,
          snapshot,
          configuration,
          publicFiles,
          applicationBuildManifest,
          applicationBuildReceipt,
          executionToolIdentity,
        },
      },
    ];
  });
}
function verifyRecoveryCandidates(
  checkpoint: OperatorRecoveryCheckpoint,
  key: Buffer
): void {
  if (key.length !== 32) fail();
  for (const bundle of candidateBundles(checkpoint))
    verifySealedCandidate(bundle.candidate, {
      ...bundle.inputs,
      recoveryKey: key,
    });
}

/** Capture one journal/catalog/filesystem checkpoint under the established lock order. */
export async function captureOperatorRecoveryCheckpoint(
  root: string,
  options?: { npmCli: string }
): Promise<OperatorRecoveryCheckpoint> {
  return captureCheckpoint(root, undefined, options?.npmCli);
}

async function captureCheckpoint(
  root: string,
  finalize?: (checkpoint: OperatorRecoveryCheckpoint) => void,
  npmCli?: string,
  resultRecapture = false
): Promise<OperatorRecoveryCheckpoint> {
  const checkout = realpathSync(root),
    location = projectLedgerLocation(checkout);
  if (location.backend !== "sqlite" || !existsSync(location.path))
    throw new Error("SHARED_SQLITE_REQUIRED");
  assertNoActiveStoreTransaction(location.path);
  const operator = resolvePrivateCandidateDirectory(location.directory);
  const assertCapture = () => {
    if (resultRecapture)
      assertRecoveryResultCaptureCurrent({ checkout, operator, npmCli });
    else assertOperatorNotQuarantined(operator);
  };
  assertCapture();
  // Registration repair owns its own lease; never nest it inside capture's locks.
  await repairSteveGmailBatchStagingForRecovery({
    operatorDirectory: operator,
  });
  const bootstrapNpm =
    npmCli === undefined ? undefined : captureNpmExecutionTool(npmCli);
  const journal = new WeeklyRunJournal(operator);
  let lease: ReturnType<WeeklyRunJournal["acquire"]> | undefined;
  try {
    lease = journal.acquire(scope, 600000);
    const owned = lease;
    return await journal.guardOperation(owned, () =>
      withStoreTransaction(location.path, async () => {
        assertCapture();
        const captured = inventory(operator, checkout);
        const ledger = readSqliteLedger(location.path);
        const checkpoint = validateOperatorRecoveryCheckpoint({
          format,
          version: bootstrapNpm ? 2 : 1,
          createdAtEpochMs: Date.now(),
          originalOperatorDirectory: operator,
          originalCheckout: checkout,
          runtime: {
            node: process.version,
            icu: process.versions.icu ?? "",
            executableSha256: sha256(regular(process.execPath)),
            workerSha256: compiledEtlDigest(checkout, "worker"),
            lockfileSha256: sha256(
              regular(join(checkout, "package-lock.json"))
            ),
            ...(bootstrapNpm ? { bootstrapNpm } : {}),
          },
          ledgerRevision: ledgerDigest(ledger),
          ledger,
          journal: journal.exportRecoverySnapshot(owned).toString("base64"),
          ...captured,
        });
        if (
          canonicalJson(captured) !==
          canonicalJson(inventory(operator, checkout))
        )
          throw new Error("RECOVERY_INPUTS_CHANGED");
        proveRecoveryGmailBatchInventory({
          checkpoint,
          ...(checkpoint.files.some(
            (file) =>
              file.area === "operator" &&
              file.path.startsWith("email-acquisition/")
          )
            ? { recoveryKey: loadBackupKey(operator, false) }
            : {}),
        });
        journal.checkOwnership(owned);
        if (bootstrapNpm && npmCli !== undefined)
          verifyNpmExecutionTool(bootstrapNpm, npmCli);
        assertCapture();
        if (
          canonicalJson(captured) !==
          canonicalJson(inventory(operator, checkout))
        )
          throw new Error("RECOVERY_INPUTS_CHANGED");
        journal.checkOwnership(owned);
        finalize?.(checkpoint);
        return checkpoint;
      })
    );
  } finally {
    try {
      if (lease) journal.release(lease);
    } finally {
      journal.close();
    }
  }
}

/** Private-ALS-gated result capture; it grants no ordinary quarantine exception. */
export function captureRecoveryResultCheckpoint(input: {
  checkout: string;
  operator: string;
  npmCli: string;
}): Promise<OperatorRecoveryCheckpoint> {
  assertRecoveryResultCaptureCurrent(input);
  return captureCheckpoint(
    input.checkout,
    finalizeRecoveryResultCapture,
    input.npmCli,
    true
  );
}

/** Authenticate portable final-capture evidence; this grants no installation activation. */
export function verifyOperatorRetirementEvidence(input: {
  archive: Buffer;
  retirementReceipt: Buffer;
  recoveryKey: Buffer;
}): {
  checkpoint: OperatorRecoveryCheckpoint;
  receipt: OperatorRetirementReceipt;
} {
  const receipt = verifyOperatorRetirementReceipt(
    input.retirementReceipt,
    input.recoveryKey
  );
  const checkpoint = decryptOperatorRecovery(input.archive, input.recoveryKey);
  if (
    receipt.archiveSha256 !== sha256(input.archive) ||
    receipt.checkpointSha256 !== sha256(canonicalJson(checkpoint)) ||
    receipt.originalOperatorDirectory !==
      checkpoint.originalOperatorDirectory ||
    receipt.ledgerRevision !== checkpoint.ledgerRevision
  )
    throw new Error("RETIREMENT_EVIDENCE_MISMATCH");
  return { checkpoint, receipt };
}

/**
 * Recheck a fenced installation's physical catalog, journal, files and runtime.
 * This grants no writer lease, activation or permission to publish a handoff.
 * Read-only SQLite may create WAL/SHM sidecars; logical content remains unchanged.
 */
export function observeRetiredOperatorRecoveryCheckpoint(input: {
  root: string;
  archive: Buffer;
  retirementReceipt: Buffer;
  recoveryKey: Buffer;
  npmCli?: string;
}): OperatorRecoveryCheckpoint {
  const { checkpoint } = verifyOperatorRetirementEvidence(input);
  const checkout = realpathSync(input.root);
  const location = projectLedgerLocation(checkout);
  const operator = resolvePrivateCandidateDirectory(location.directory);
  if (
    location.backend !== "sqlite" ||
    checkout !== checkpoint.originalCheckout ||
    operator !== checkpoint.originalOperatorDirectory
  )
    throw new Error("RETIREMENT_EVIDENCE_MISMATCH");
  assertNoActiveStoreTransaction(location.path);
  const marker = join(operator, "operator-retired.json");
  const assertMarker = () => {
    if (!regular(marker, 16 * 1024).equals(input.retirementReceipt))
      throw new Error("RETIREMENT_EVIDENCE_MISMATCH");
  };
  assertMarker();
  if (!loadBackupKey(operator).equals(input.recoveryKey))
    throw new Error("RETIREMENT_EVIDENCE_MISMATCH");
  if (checkpoint.runtime.bootstrapNpm) {
    if (input.npmCli === undefined)
      throw new Error("RECOVERY_BOOTSTRAP_NPM_REQUIRED");
    verifyNpmExecutionTool(checkpoint.runtime.bootstrapNpm, input.npmCli);
  } else if (input.npmCli !== undefined)
    throw new Error("RECOVERY_BOOTSTRAP_NPM_REQUIRED");
  const journalPath = join(operator, "weekly-runs.sqlite");
  const observe = () => {
    assertMarker();
    const ledger = readSqliteLedgerReadOnly(location.path);
    return validateOperatorRecoveryCheckpoint({
      ...checkpoint,
      runtime: {
        ...checkpoint.runtime,
        node: process.version,
        icu: process.versions.icu ?? "",
        executableSha256: sha256(regular(process.execPath)),
        workerSha256: compiledEtlDigest(checkout, "worker"),
        lockfileSha256: sha256(regular(join(checkout, "package-lock.json"))),
      },
      ledger,
      ledgerRevision: ledgerDigest(ledger),
      journal:
        readWeeklyJournalRecoverySnapshotReadOnly(journalPath).toString(
          "base64"
        ),
      ...inventory(operator, checkout, input.retirementReceipt),
    });
  };
  const actual = observe();
  if (canonicalJson(actual) !== canonicalJson(observe()))
    throw new Error("RECOVERY_INPUTS_CHANGED");
  const comparable = (value: OperatorRecoveryCheckpoint) => {
    const journal = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(value.journal, "base64")
    );
    const { digest: _digest, ownership, ...content } = journal;
    return canonicalJson({
      ...value,
      journal: {
        ...content,
        // Final capture owns the lease; its permitted cleanup changes only this row.
        ownership: ownership.filter((row) => row.scope !== scope),
      },
    });
  };
  if (comparable(actual) !== comparable(checkpoint))
    throw new Error("RECOVERY_INPUTS_CHANGED");
  assertMarker();
  if (checkpoint.runtime.bootstrapNpm && input.npmCli !== undefined)
    verifyNpmExecutionTool(checkpoint.runtime.bootstrapNpm, input.npmCli);
  return actual;
}

/** Persist a final backup and fence this cooperating installation under both writer locks. */
export async function retireAndCaptureOperatorRecovery(input: {
  root: string;
  out: string;
  npmCli?: string;
}): Promise<{
  checkpoint: OperatorRecoveryCheckpoint;
  retirementReceipt: Buffer;
}> {
  const checkout = realpathSync(input.root),
    location = projectLedgerLocation(checkout);
  if (location.backend !== "sqlite" || !existsSync(location.path))
    throw new Error("SHARED_SQLITE_REQUIRED");
  assertNoActiveStoreTransaction(location.path);
  const operator = resolvePrivateCandidateDirectory(location.directory),
    out = resolve(input.out),
    marker = join(operator, "operator-retired.json"),
    portableReceipt = out + ".retirement.json";
  if (resolvePrivateCandidateDirectory(dirname(out)) !== dirname(out))
    throw new Error("UNSAFE_RECOVERY_OUTPUT");
  const within = relative(operator, out);
  if (
    !within ||
    (!isAbsolute(within) &&
      within !== ".." &&
      !within.startsWith(".." + (process.platform === "win32" ? "\\" : "/")))
  )
    throw new Error("UNSAFE_RECOVERY_OUTPUT");
  const key = loadBackupKey(operator);
  const writeExclusive = (path: string, bytes: Buffer) => {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (process.platform !== "win32") {
      const parentFd = openSync(dirname(path), "r");
      try {
        fsyncSync(parentFd);
      } finally {
        closeSync(parentFd);
      }
    }
  };
  const persistReceipt = (bytes: Buffer) => {
    try {
      writeExclusive(portableReceipt, bytes);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      if (!regular(portableReceipt, 16 * 1024).equals(bytes))
        throw new Error("RETIREMENT_RECEIPT_CONFLICT");
    }
  };
  // Lost responses repair only the portable receipt; never recapture or unretire.
  if (existsSync(marker)) {
    const retirementReceipt = regular(marker, 16 * 1024),
      archive = regular(out, Math.ceil(maxBytes * 1.4)),
      { checkpoint, receipt } = verifyOperatorRetirementEvidence({
        archive,
        retirementReceipt,
        recoveryKey: key,
      });
    if (
      receipt.originalOperatorDirectory !== operator ||
      checkpoint.originalCheckout !== checkout
    )
      throw new Error("RETIREMENT_EVIDENCE_MISMATCH");
    if (input.npmCli !== undefined) {
      if (!checkpoint.runtime.bootstrapNpm)
        throw new Error("RECOVERY_BOOTSTRAP_NPM_REQUIRED");
      verifyNpmExecutionTool(checkpoint.runtime.bootstrapNpm, input.npmCli);
    }
    persistReceipt(retirementReceipt);
    return { checkpoint, retirementReceipt };
  }
  if (existsSync(out) || existsSync(portableReceipt))
    throw new Error("RECOVERY_DESTINATION_EXISTS");
  return withOperatorRetirementScope(operator, async (permitOwnRetirement) => {
    let retirementReceipt: Buffer | undefined;
    const checkpoint = await captureCheckpoint(
      checkout,
      (captured) => {
        if (
          existsSync(marker) ||
          existsSync(out) ||
          existsSync(portableReceipt)
        )
          throw new Error("RECOVERY_DESTINATION_EXISTS");
        const archive = encryptOperatorRecovery(captured, key);
        decryptOperatorRecovery(archive, key);
        secureOperatorDirectory(dirname(out));
        writeExclusive(out, archive);
        if (!regular(out, Math.ceil(maxBytes * 1.4)).equals(archive))
          throw new Error("RECOVERY_OUTPUT_CHANGED");
        retirementReceipt = createOperatorRetirementReceipt(
          {
            checkpointSha256: sha256(canonicalJson(captured)),
            archiveSha256: sha256(archive),
            ledgerRevision: captured.ledgerRevision,
            originalOperatorDirectory: operator,
            installationId: randomUUID(),
            retiredAtEpochMs: Date.now(),
          },
          key
        );
        permitOwnRetirement(retirementReceipt);
        writeDurableFile(marker, retirementReceipt);
        if (!regular(marker, 16 * 1024).equals(retirementReceipt))
          throw new Error("RETIREMENT_EVIDENCE_MISMATCH");
      },
      input.npmCli
    );
    if (!retirementReceipt) throw new Error("RETIREMENT_EVIDENCE_MISSING");
    persistReceipt(retirementReceipt);
    return { checkpoint, retirementReceipt };
  });
}

/** Encrypt the entire private checkpoint; the separate recovery key is never embedded. */
export function encryptOperatorRecovery(
  checkpoint: OperatorRecoveryCheckpoint,
  key: Buffer
): Buffer {
  validateOperatorRecoveryCheckpoint(checkpoint);
  if (key.length !== 32) fail();
  verifyRecoveryCandidates(checkpoint, key);
  proveRecoveryGmailBatchInventory({ checkpoint, recoveryKey: key });
  const clear = Buffer.from(canonicalJson(checkpoint));
  if (clear.length > maxBytes) throw new Error("RECOVERY_CAPSULE_LIMIT");
  const header = {
    format,
    version: 1,
    cipher: "aes-256-gcm",
    compression: "gzip",
    keyId: sha256(key),
  };
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonicalJson(header)));
  const ciphertext = Buffer.concat([
    cipher.update(gzipSync(clear)),
    cipher.final(),
  ]);
  return Buffer.from(
    canonicalJson({
      ...header,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }) + "\n"
  );
}

/** Authenticate before bounded decompression and strict inventory/reference validation. */
export function decryptOperatorRecovery(
  bytes: Buffer,
  key: Buffer
): OperatorRecoveryCheckpoint {
  if (key.length !== 32 || bytes.length > maxBytes * 1.4) fail();
  const raw = object(JSON.parse(bytes.toString("utf8")), [
    "format",
    "version",
    "cipher",
    "compression",
    "keyId",
    "nonce",
    "tag",
    "ciphertext",
  ]);
  if (
    raw.format !== format ||
    raw.version !== 1 ||
    raw.cipher !== "aes-256-gcm" ||
    raw.compression !== "gzip" ||
    raw.keyId !== sha256(key)
  )
    fail();
  const nonce = base64(raw.nonce),
    tag = base64(raw.tag);
  if (nonce.length !== 12 || tag.length !== 16) fail();
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(
    Buffer.from(
      canonicalJson({
        format: raw.format,
        version: raw.version,
        cipher: raw.cipher,
        compression: raw.compression,
        keyId: raw.keyId,
      })
    )
  );
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([
    decipher.update(base64(raw.ciphertext)),
    decipher.final(),
  ]);
  const checkpoint = validateOperatorRecoveryCheckpoint(
    JSON.parse(
      gunzipSync(compressed, { maxOutputLength: maxBytes }).toString("utf8")
    )
  );
  verifyRecoveryCandidates(checkpoint, key);
  proveRecoveryGmailBatchInventory({ checkpoint, recoveryKey: key });
  return checkpoint;
}

/** Restore into a new offline staging root. Never replaces an installed store or enables effects. */
export async function stageOperatorRecovery(
  checkpoint: OperatorRecoveryCheckpoint,
  destination: string,
  recoveryKey: Buffer
): Promise<void> {
  checkpoint = structuredClone(checkpoint);
  validateOperatorRecoveryCheckpoint(checkpoint);
  verifyRecoveryCandidates(checkpoint, recoveryKey);
  proveRecoveryGmailBatchInventory({ checkpoint, recoveryKey });
  const root = resolvePrivateCandidateDirectory(destination);
  if (existsSync(root)) throw new Error("RECOVERY_DESTINATION_EXISTS");
  mkdirSync(root, { recursive: false, mode: 0o700 });
  secureOperatorDirectory(root);
  writeDurableFile(
    join(root, "recovery-state.json"),
    Buffer.from(
      canonicalJson({
        version: 1,
        status: "incomplete",
        activationAllowed: false,
      }) + "\n"
    )
  );
  const operator = join(root, "operator");
  secureOperatorDirectory(operator);
  for (const directory of checkpoint.directories)
    mkdirSync(join(root, directory.area, directory.path), {
      recursive: true,
      mode: 0o700,
    });
  for (const file of checkpoint.files)
    if (file.bytes !== null)
      writeDurableFile(join(root, file.area, file.path), base64(file.bytes));
  await writeSqliteLedger(
    join(operator, "ledger.sqlite"),
    checkpoint.ledger,
    true
  );
  const journal = new WeeklyRunJournal(operator);
  try {
    journal.restoreRecoverySnapshot(base64(checkpoint.journal));
  } finally {
    journal.close();
  }
  if (
    ledgerDigest(readSqliteLedger(join(operator, "ledger.sqlite"))) !==
    checkpoint.ledgerRevision
  )
    fail();
  for (const file of checkpoint.files) {
    const path = join(root, file.area, file.path);
    if (
      file.bytes === null
        ? existsSync(path)
        : sha256(regular(path)) !== file.sha256
    )
      fail();
  }
  if (
    compiledEtlDigest(join(root, "checkout"), "worker") !==
    checkpoint.runtime.workerSha256
  )
    fail();
  writeDurableFile(
    join(root, "recovery-state.json"),
    Buffer.from(
      canonicalJson({
        version: 1,
        status: "staged",
        activationAllowed: false,
        ledgerRevision: checkpoint.ledgerRevision,
        originalOperatorDirectory: checkpoint.originalOperatorDirectory,
        originalCheckout: checkpoint.originalCheckout,
        runtime: checkpoint.runtime,
        checkpointSha256: sha256(canonicalJson(checkpoint)),
        requiredBeforeActivation: [
          "validate original path bindings and exact runtime",
          "reconcile canonical remote state and dispatch intents",
          "fence the old installation",
          "import the separately stored portable key",
          "complete candidate and browser recovery rehearsals",
        ],
      }) + "\n"
    )
  );
}
