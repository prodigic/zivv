import type { OperatorRecoveryCheckpoint } from "./operator-recovery.js";
import {
  proveRecoveryGmailSelectedReceipt,
  type RecoveryGmailCaptureFamilyInput,
  type RecoveryGmailSelectedReceiptSelector,
} from "./recovery-gmail-capture-admission-proof.js";
import { validateLedger } from "./ledger.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import {
  IMPORT_CONFIGURATION_FILES,
  compiledWorkerInventoryDigest,
  importConfigurationInventoryDigest,
  weeklyRunRulesDigest,
} from "./weekly-run-context.js";
import {
  createWeeklyRunState,
  parseWeeklyRunState,
  type WeeklyRunSource,
} from "./weekly-run-state.js";
import { validateWeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";

type Runtime = Pick<
  OperatorRecoveryCheckpoint["runtime"],
  "node" | "icu" | "executableSha256" | "workerSha256" | "lockfileSha256"
>;
export interface RecoveryGmailSelectedLoadBaselineInput extends RecoveryGmailCaptureFamilyInput {
  checkpoint: RecoveryGmailCaptureFamilyInput["checkpoint"] &
    Pick<OperatorRecoveryCheckpoint, "ledger" | "ledgerRevision" | "runtime">;
  selector: RecoveryGmailSelectedReceiptSelector;
  currentLedger: unknown;
  currentRuntime: Runtime;
  /** Must be the complete physically observed load family. Nonempty families
   * require the later load-delta composer, never an adopted changed baseline. */
  priorLoads: readonly { admission: Buffer; result: Buffer }[];
}
function fail(): never {
  throw new Error("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_BASELINE");
}
function same(a: unknown, b: unknown): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail();
}

/** Detached first-load baseline and exact normal run identity. The closed
 * physical adapter must independently authenticate the original archive, full
 * family enumeration, canonical SQLite snapshot and observed runtime identities.
 * No database, writer scope, new run or permission is created here.
 */
export function proveRecoveryGmailSelectedLoadBaseline(
  input: RecoveryGmailSelectedLoadBaselineInput
) {
  try {
    return prove(input);
  } catch {
    return fail();
  }
}
function prove(input: RecoveryGmailSelectedLoadBaselineInput) {
  const required = [
    "checkpoint",
    "recoveryKey",
    "completed",
    "unfinishedAdmissions",
    "current",
    "selector",
    "currentLedger",
    "currentRuntime",
    "priorLoads",
  ];
  const allowed = new Set([...required, "ownProductionOwnership"]);
  if (
    Reflect.ownKeys(input).some(
      (key) => typeof key !== "string" || !allowed.has(key)
    )
  )
    fail();
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) fail();
  }
  if (!Array.isArray(input.priorLoads) || input.priorLoads.length !== 0) fail();
  const selected = proveRecoveryGmailSelectedReceipt(input);
  validateLedger(input.checkpoint.ledger);
  validateLedger(input.currentLedger);
  const catalogSha256 = ledgerDigest(input.currentLedger);
  if (
    ledgerDigest(input.checkpoint.ledger) !== input.checkpoint.ledgerRevision ||
    catalogSha256 !== input.checkpoint.ledgerRevision
  )
    fail();
  same(input.currentLedger, input.checkpoint.ledger);
  const expectedRuntime: Runtime = {
    node: input.checkpoint.runtime.node,
    icu: input.checkpoint.runtime.icu,
    executableSha256: input.checkpoint.runtime.executableSha256,
    workerSha256: input.checkpoint.runtime.workerSha256,
    lockfileSha256: input.checkpoint.runtime.lockfileSha256,
  };
  same(input.currentRuntime, expectedRuntime);
  for (const value of [
    expectedRuntime.executableSha256,
    expectedRuntime.workerSha256,
    expectedRuntime.lockfileSha256,
  ])
    if (!/^[a-f0-9]{64}$/.test(value)) fail();
  const files = input.checkpoint.files.filter(
    (file) => file.area === "checkout"
  );
  const worker = files
    .filter((file) => /^dist\/(lib|types|utils)\//.test(file.path))
    .map((file) => {
      if (file.bytes === null || file.sha256 === null) fail();
      return {
        path: file.path.slice(5),
        size: Buffer.from(file.bytes, "base64").length,
        sha256: file.sha256,
      };
    });
  const runtimeSha256 = compiledWorkerInventoryDigest(worker);
  const lockfile = files.find((file) => file.path === "package-lock.json");
  if (
    runtimeSha256 !== expectedRuntime.workerSha256 ||
    !lockfile?.bytes ||
    lockfile.sha256 !== expectedRuntime.lockfileSha256
  )
    fail();
  const configurationSha256 = importConfigurationInventoryDigest(
    IMPORT_CONFIGURATION_FILES.map((path) => {
      const actualPath = "data/" + path;
      if (
        input.checkpoint.directories.some(
          (entry) => entry.area === "checkout" && entry.path === actualPath
        )
      )
        fail();
      return {
        path,
        sha256: files.find((file) => file.path === actualPath)?.sha256 ?? null,
      };
    })
  );
  const rulesContext = {
    runtimeSha256,
    packageLockSha256: lockfile.sha256,
    configurationSha256,
    node: expectedRuntime.node,
    icu: expectedRuntime.icu,
  };
  const rulesSha256 = weeklyRunRulesDigest(rulesContext);
  const source: WeeklyRunSource = {
    editionId: selected.source.editionId,
    deliveryId: selected.source.deliveryId,
    rawSha256: selected.source.sourceSha256,
    rulesSha256,
    importObservedAtEpochMs: selected.source.importObservedAtEpochMs,
  };
  const initialState = createWeeklyRunState(source);
  const journal = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(input.current.journal, "base64")
  );
  const existing = journal.runState.find(
    (row) =>
      row.scope === "prodigic/zivv/production" && row.id === initialState.runId
  );
  let runState = initialState;
  if (existing) {
    runState = parseWeeklyRunState(JSON.parse(existing.payload) as unknown);
    same(runState.source, source);
    if (
      runState.runId !== existing.id ||
      runState.revision !== existing.revision
    )
      fail();
    const acquired = journal.stageArtifacts.find(
      (row) =>
        row.runId === runState.runId &&
        row.stage === "acquire" &&
        row.attempt === 0
    );
    if (
      !acquired ||
      acquired.identity !== source.rawSha256 ||
      sha256(Buffer.from(acquired.bytes, "base64")) !== source.rawSha256
    )
      fail();
  }
  const runtimeIdentitySha256 = sha256(
    canonicalJson({
      runtime: input.currentRuntime,
      bootstrapNpm: input.checkpoint.runtime.bootstrapNpm ?? null,
    })
  );
  return {
    activationAllowed: false as const,
    captureAllowed: false as const,
    loadAllowed: false as const,
    physicalValidationRequired: true as const,
    selection: selected,
    catalogSha256,
    journalSha256: journal.digest,
    runtimeIdentitySha256,
    rulesContext,
    source,
    initialState,
    runState: structuredClone(runState),
    runDisposition: existing ? ("retained" as const) : ("new" as const),
    baselineSha256: sha256(
      canonicalJson({
        domain: "zivv-recovery-gmail-selected-load-baseline/v1",
        selectionSha256: selected.selectionSha256,
        catalogSha256,
        journalSha256: journal.digest,
        runtimeIdentitySha256,
        rulesContext,
        source,
        runState,
        priorLoads: [],
      })
    ),
  };
}
