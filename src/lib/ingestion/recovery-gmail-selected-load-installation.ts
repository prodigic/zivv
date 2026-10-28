import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import {
  inspectRecoveryInstalledFile,
  installRecoveryIntent,
  secureOperatorDirectory,
} from "./encrypted-backup.js";
import {
  assertNoRecoveredGmailCapture,
  readRecoveryGmailHostForLoadInstallation,
} from "./recovery-gmail-capture-admission.js";
import {
  openPreparedRuntimeForAdmission,
  type RecoveryRuntimeInput,
  type RecoveryRuntimeEntry,
} from "./recovery-runtime.js";
import {
  copyRecoveryGmailSelectedReceiptSelector,
  type RecoveryGmailSelectedReceiptSelector,
} from "./recovery-gmail-capture-admission-proof.js";
import {
  createRecoveryGmailSelectedLoadAdmission,
  authenticateRecoveryGmailSelectedLoadAdmission,
} from "./recovery-gmail-selected-load-admission-proof.js";
import {
  createRecoveryGmailSelectedLoadEvidence,
  restoreRecoveryGmailSelectedLoadEvidence,
} from "./recovery-gmail-selected-load-evidence.js";
import { proveRecoveryGmailSelectedLoadBaseline } from "./recovery-gmail-selected-load-proof.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

export const recoveryGmailSelectedLoadInstallationVersion = 1;
export interface RecoveryGmailSelectedLoadInstallationInput extends RecoveryRuntimeInput {
  selector: RecoveryGmailSelectedReceiptSelector;
}
type Interruption =
  | "manifest-installed"
  | "chunks-installed"
  | "intent-installed"
  | "manifest-stage-flushed"
  | "intent-linked";
interface Scope {
  active: boolean;
  deadline: number;
  files: Map<string, { bytes: Buffer; stage: string }>;
  directories: Set<string>;
  transients: Set<string>;
  assertCurrent: () => void;
  interruption?: Interruption;
}
const scopes = new AsyncLocalStorage<Scope>();
const interruptions = new WeakSet<Error>();
function fail(): never {
  throw Error("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_INSTALLATION");
}
function active(): Scope | undefined {
  const scope = scopes.getStore();
  if (scope && (!scope.active || Date.now() >= scope.deadline)) fail();
  return scope;
}
/** Presence includes revoked descendants. Never grants catalog/journal/key authority. */
export function assertNoSelectedLoadInstallation(): void {
  if (scopes.getStore()) fail();
}
export function isSelectedLoadInstallationInterruption(
  error: unknown
): boolean {
  return error instanceof Error && interruptions.has(error);
}
function stop(scope: Scope, point: Interruption): void {
  if (scope.interruption === point) {
    const error = Error(
      "RECOVERY_GMAIL_SELECTED_LOAD_INSTALLATION_INTERRUPTED"
    );
    interruptions.add(error);
    throw error;
  }
}
export function observeSelectedLoadInstallationFile(
  path: string,
  point: "flushed" | "linked" | "published"
): boolean {
  const scope = active();
  if (!scope) return false;
  scope.assertCurrent();
  if (point === "flushed" && path.includes("baseline.json."))
    stop(scope, "manifest-stage-flushed");
  if (point === "linked" && path.endsWith("admission.json"))
    stop(scope, "intent-linked");
  return true;
}
/** Fixed exact files and at most two installer-generated aliases; no callback entry. */
export function guardSelectedLoadInstallationFile(
  path: string,
  bytes: Buffer | undefined,
  effect: "write" | "directory" | "unlink" | "install"
): boolean {
  const scope = active();
  if (!scope) return false;
  scope.assertCurrent();
  const absolute = resolve(path);
  if (effect === "directory") {
    if (!scope.directories.has(absolute)) fail();
    return true;
  }
  for (const [target, entry] of scope.files) {
    const prefix = join(entry.stage, target.slice(dirname(target).length + 1));
    if (
      absolute !== target &&
      !new RegExp(
        "^" +
          prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "(?:\\.\\d+\\.[a-f0-9]{16}\\.tmp){1,2}$"
      ).test(absolute)
    )
      continue;
    if (
      !bytes ||
      !bytes.equals(entry.bytes) ||
      (effect === "unlink" && absolute === target)
    )
      fail();
    if (absolute !== target) scope.transients.add(absolute);
    return true;
  }
  return fail();
}
function namespace(
  entries: RecoveryRuntimeEntry[],
  root: string,
  files: Scope["files"],
  directories: Set<string>,
  transients: Set<string>
) {
  for (const entry of entries) {
    if (
      entry.path !== "recovery-gmail-load" &&
      !entry.path.startsWith("recovery-gmail-load/")
    )
      continue;
    const path = join(root, entry.path);
    if (entry.kind === "directory") {
      if (!directories.has(path)) fail();
      continue;
    }
    if (entry.kind !== "file") fail();
    let expected = files.get(path)?.bytes;
    if (!expected) {
      for (const [target, value] of files) {
        const prefix = join(
          value.stage,
          target.slice(dirname(target).length + 1)
        );
        if (
          new RegExp(
            "^" +
              prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "(?:\\.\\d+\\.[a-f0-9]{16}\\.tmp){1,2}$"
          ).test(path)
        )
          expected = value.bytes;
      }
    }
    if (
      !expected ||
      (entry.size === 0 && transients.has(path)
        ? false
        : entry.size !== expected.length || entry.sha256 !== sha256(expected))
    )
      fail();
  }
}
function copy(input: RecoveryGmailSelectedLoadInstallationInput) {
  const fields = [
    "archive",
    "retirementReceipt",
    "recoveryKey",
    "destination",
    "npmCli",
    "selector",
  ];
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(input) as object | null
    ) ||
    Reflect.ownKeys(input).length !== fields.length ||
    Reflect.ownKeys(input).some(
      (name) =>
        typeof name !== "string" ||
        !fields.includes(name) ||
        !Object.hasOwn(
          Object.getOwnPropertyDescriptor(input, name) ?? {},
          "value"
        )
    )
  )
    fail();
  if (!Buffer.isBuffer(input.recoveryKey) || input.recoveryKey.length !== 32)
    fail();
  const selector = copyRecoveryGmailSelectedReceiptSelector(input.selector);
  return {
    runtime: {
      archive: input.archive,
      retirementReceipt: input.retirementReceipt,
      recoveryKey: Buffer.from(input.recoveryKey),
      destination: input.destination,
      npmCli: input.npmCli,
    },
    selector,
  };
}
function execute(
  input: RecoveryGmailSelectedLoadInstallationInput,
  interruption?: Interruption
) {
  assertNoSelectedLoadInstallation();
  assertNoRecoveredGmailCapture();
  const { runtime, selector } = copy(input);
  let scope: Scope | undefined;
  try {
    const host = readRecoveryGmailHostForLoadInstallation(runtime);
    const baseline = {
      checkpoint: host.checkpoint,
      recoveryKey: runtime.recoveryKey,
      completed: host.completed,
      unfinishedAdmissions: host.unfinishedAdmissions,
      current: host.current,
      currentLedger: host.checkpoint.ledger,
      currentRuntime: host.currentRuntime,
      priorLoads: [],
      selector,
      ...(host.ownProductionOwnership
        ? { ownProductionOwnership: host.ownProductionOwnership }
        : {}),
    };
    const proof = proveRecoveryGmailSelectedLoadBaseline(baseline);
    const root = resolve(runtime.destination),
      directory = join(root, "recovery-gmail-load", proof.runState.runId);
    const manifestPath = join(directory, "baseline.json"),
      intentPath = join(directory, "admission.json");
    const manifestStage = join(directory, "stages", "baseline");
    const retained = existsSync(directory)
      ? inspectRecoveryInstalledFile(manifestPath, manifestStage)
      : { target: null, candidate: null };
    const saved = retained.target?.bytes ?? retained.candidate?.bytes;
    let admittedAtEpochMs = Date.now();
    let existingIntent: Buffer | undefined;
    if (saved) {
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(saved)
      );
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("admission" in parsed) ||
        typeof parsed.admission !== "string" ||
        parsed.admission.length > 90_000
      )
        fail();
      existingIntent = Buffer.from(parsed.admission, "base64");
      const record = authenticateRecoveryGmailSelectedLoadAdmission({
        baseline,
        binding: host.binding,
        physicalSnapshotSha256: host.physicalSnapshotSha256,
        admission: existingIntent,
      });
      admittedAtEpochMs = record.admittedAtEpochMs;
    }
    const context = {
      baseline,
      binding: host.binding,
      physicalSnapshotSha256: host.physicalSnapshotSha256,
    };
    const admission = createRecoveryGmailSelectedLoadAdmission({
      ...context,
      admittedAtEpochMs,
      unfinishedAdmissions: existingIntent ? [existingIntent] : [],
    });
    const evidence = createRecoveryGmailSelectedLoadEvidence({
      ...context,
      admission,
    });
    if (saved && !saved.equals(evidence.manifest)) fail();
    const files: Scope["files"] = new Map();
    files.set(manifestPath, { bytes: evidence.manifest, stage: manifestStage });
    for (const chunk of evidence.chunks)
      files.set(join(directory, "chunks", chunk.id + ".bin"), {
        bytes: chunk.bytes,
        stage: join(directory, "stages", chunk.id),
      });
    files.set(intentPath, {
      bytes: admission,
      stage: join(directory, "stages", "admission"),
    });
    const directories = new Set<string>();
    for (const [target, value] of files)
      for (const path of [dirname(target), value.stage])
        for (let parent = path; parent !== root; parent = dirname(parent)) {
          if (
            relative(root, parent).startsWith("..") ||
            parent === dirname(parent)
          )
            fail();
          directories.add(parent);
        }
    const opened = openPreparedRuntimeForAdmission(runtime);
    scope = {
      active: true,
      deadline: Date.now() + 180_000,
      files,
      directories,
      transients: new Set(),
      interruption,
      assertCurrent: () => {
        scopes.exit(() => {
          const fresh = readRecoveryGmailHostForLoadInstallation(runtime);
          if (
            fresh.physicalSnapshotSha256 !== host.physicalSnapshotSha256 ||
            canonicalJson(fresh.current) !== canonicalJson(host.current) ||
            canonicalJson(fresh.binding) !== canonicalJson(host.binding)
          )
            fail();
          namespace(
            opened.inventoryGmailLoadInstallation(),
            root,
            files,
            directories,
            scope!.transients
          );
        });
      },
    };
    scope.assertCurrent();
    const result = scopes.run(scope, () => {
      for (const [target, value] of files) {
        scope!.assertCurrent();
        secureOperatorDirectory(dirname(target));
        installRecoveryIntent(target, value.bytes, value.stage);
        scope!.assertCurrent();
        if (target === manifestPath) stop(scope!, "manifest-installed");
        if (target !== manifestPath && target !== intentPath)
          stop(scope!, "chunks-installed");
        if (target === intentPath) stop(scope!, "intent-installed");
      }
      return restoreRecoveryGmailSelectedLoadEvidence({
        checkpoint: host.checkpoint,
        recoveryKey: runtime.recoveryKey,
        binding: host.binding,
        completed: host.completed,
        unfinishedAdmissions: host.unfinishedAdmissions,
        manifest: evidence.manifest,
        chunks: evidence.chunks,
        observedAdmission: admission,
      });
    });
    return {
      status: "load-evidence-installed" as const,
      activationAllowed: false as const,
      captureAllowed: false as const,
      loadAllowed: false as const,
      physicalValidationRequired: true as const,
      runId: proof.runState.runId,
      admissionSha256: sha256(admission),
      evidenceSha256: result.evidenceSha256,
      physicalSnapshotSha256: host.physicalSnapshotSha256,
      chunks: evidence.chunks.length,
    };
  } finally {
    if (scope) scope.active = false;
    runtime.recoveryKey.fill(0);
  }
}
/** Closed file-only entry. No key installer, writer, callback or source override. */
export function installRecoveryGmailSelectedLoadEvidence(
  input: RecoveryGmailSelectedLoadInstallationInput
) {
  return execute(input);
}
/** Fixed test interruption points only; production checks and namespace are unchanged. */
export function installRecoveryGmailSelectedLoadEvidenceForTest(
  input: RecoveryGmailSelectedLoadInstallationInput,
  interruption: Interruption
) {
  if (
    ![
      "manifest-installed",
      "chunks-installed",
      "intent-installed",
      "manifest-stage-flushed",
      "intent-linked",
    ].includes(interruption)
  )
    fail();
  return execute(input, interruption);
}
