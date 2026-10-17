import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertNoPendingSteveEmail } from "./steve-email-intake.js";
import { loadLedger, validateLedger } from "./ledger.js";
import { withIngestionLock } from "./lock.js";
import { canonicalJson, ledgerDigest } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import {
  createEmptyWeeklyEditionLedger,
  parseWeeklyEditionLedger,
  prepareWeeklyEdition,
  serializeWeeklyEditionLedger,
  type WeeklyEditionSnapshot,
} from "./weekly.js";
import { writeDurableFile } from "./encrypted-backup.js";
import {
  transitionWeeklyRun,
  type StageEvidence,
  type WeeklyRunState,
} from "./weekly-run-state.js";
import type { WeeklyRunJournal, WeeklyRunLease } from "./weekly-run-journal.js";
import type { IngestionLedger } from "../../types/ingestion.js";

class FreezeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "WeeklyFreezeError";
  }
}
function fail(code: string): never {
  throw new FreezeError(code);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("INVALID_FREEZE_INTENT");
  return value as Record<string, unknown>;
}
function readWeekly(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    fail("WEEKLY_STATE_CHANGED");
  return readFileSync(path);
}
function frozenIdentity(edition: WeeklyEditionSnapshot) {
  return {
    editionId: edition.editionId,
    startEpochMs: edition.startEpochMs,
    endEpochMs: edition.endEpochMs,
    eventIds: edition.eventIds,
    datasetVersion: edition.datasetVersion,
  };
}
interface FreezeIntent {
  schemaVersion: 1;
  mode: "initial" | "correction";
  before: string | null;
  after: string;
  ledger: IngestionLedger;
  ledgerRevision: string;
  evidence: StageEvidence;
}

/** Freeze one edition with an immutable intent and recovery of its file side effect. */
export async function freezeWeeklyImport(input: {
  root: string;
  state: WeeklyRunState;
  journal: WeeklyRunJournal;
  lease: WeeklyRunLease;
  cutoffEpochMs?: number;
  reuseFrozen?: boolean;
  verifyContext: () => void;
  onProgress: (
    phase: "started" | "artifact-saved" | "effect-committed" | "completed"
  ) => Promise<void>;
}): Promise<WeeklyRunState> {
  let state = input.state;
  const path = join(input.root, "data/ingestion/weekly-editions.json");
  const transition = (change: Parameters<typeof transitionWeeklyRun>[3]) => {
    state = input.journal.save(
      transitionWeeklyRun(state, state.revision, "freeze", change, Date.now()),
      state.revision,
      input.lease
    );
  };
  const pending = (cutoff: number) => {
    assertNoPendingSteveEmail(
      dirname(input.journal.path),
      input.journal,
      input.lease.scope,
      cutoff
    );
    return input.journal
      .listRuns(input.lease.scope)
      .filter(
        (run) =>
          run.source.importObservedAtEpochMs < cutoff &&
          run.stages.find((stage) => stage.stage === "load")?.status !==
            "succeeded"
      );
  };
  const item = state.stages.find((stage) => stage.stage === "freeze")!;
  if (!["running", "succeeded"].includes(item.status))
    transition({ status: "running" });
  if (item.status !== "succeeded") await input.onProgress("started");
  const attempt = state.stages.find(
    (stage) => stage.stage === "freeze"
  )!.attempt;
  let bytes = input.journal.readArtifact(state.runId, "freeze", attempt);
  if (!bytes) {
    let intent: FreezeIntent;
    try {
      intent = await input.journal.guardOperation(input.lease, () =>
        withIngestionLock(input.root, async () => {
          input.verifyContext();
          const beforeBytes = readWeekly(path);
          const before = beforeBytes
            ? parseWeeklyEditionLedger(JSON.parse(beforeBytes.toString("utf8")))
            : createEmptyWeeklyEditionLedger();
          const existing = before.editions.find(
            (edition) => edition.editionId === state.source.editionId
          );
          const cutoff =
            input.cutoffEpochMs ??
            (input.reuseFrozen ? existing?.endEpochMs : undefined);
          if (cutoff === undefined) fail("FREEZE_CUTOFF_REQUIRED");
          if (
            !Number.isSafeInteger(cutoff) ||
            cutoff < 0 ||
            cutoff > Date.now()
          )
            fail("INVALID_FREEZE_CUTOFF");
          const mode =
            existing &&
            state.source.importObservedAtEpochMs >= existing.endEpochMs
              ? "correction"
              : "initial";
          if (mode === "correction" && !input.reuseFrozen)
            fail("FROZEN_REUSE_REQUIRED");
          if (
            mode === "initial" &&
            cutoff <= state.source.importObservedAtEpochMs
          )
            fail("INVALID_FREEZE_CUTOFF");
          if (pending(cutoff).length) fail("PENDING_PRE_CUTOFF_IMPORTS");
          const ledger = await loadLedger(
            join(input.root, "data/ingestion/ledger.json")
          );
          const result = prepareWeeklyEdition(
            before,
            ledger.events.map((event) => ({ ...event })),
            {
              editionId: state.source.editionId,
              cutoffEpochMs: cutoff,
              datasetVersion: `ingestion-v${ledger.version}`,
            }
          );
          input.verifyContext();
          return {
            schemaVersion: 1,
            mode,
            before: beforeBytes?.toString("base64") ?? null,
            after: Buffer.from(
              serializeWeeklyEditionLedger(result.ledger)
            ).toString("base64"),
            ledger,
            ledgerRevision: ledgerDigest(ledger),
            evidence: {
              editionId: result.edition.editionId,
              cutoffEpochMs: result.edition.endEpochMs,
              membershipSha256: sha256(canonicalJson(result.edition.eventIds)),
              preCutoffPendingCount: 0,
              mode,
              ledgerRevision: ledgerDigest(ledger),
            },
          };
        })
      );
    } catch (error) {
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Z0-9_]{1,64}$/.test(error.code)
          ? error.code
          : "FREEZE_PLANNING_FAILED";
      transition({
        status: [
          "PENDING_PRE_CUTOFF_IMPORTS",
          "PENDING_STEVE_EMAIL_INTAKE",
          "FROZEN_REUSE_REQUIRED",
        ].includes(code)
          ? "blocked"
          : "failed",
        errorCode: code,
      });
      throw error;
    }
    bytes = Buffer.from(canonicalJson(intent) + "\n");
    input.verifyContext();
    input.journal.writeArtifact(state.runId, "freeze", bytes, input.lease);
    await input.onProgress("artifact-saved");
  }
  const value = record(JSON.parse(bytes.toString("utf8")));
  if (
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(
        [
          "schemaVersion",
          "mode",
          "before",
          "after",
          "ledger",
          "ledgerRevision",
          "evidence",
        ].sort()
      ) ||
    value.schemaVersion !== 1 ||
    !["initial", "correction"].includes(String(value.mode)) ||
    (value.before !== null && typeof value.before !== "string") ||
    typeof value.after !== "string"
  )
    fail("INVALID_FREEZE_INTENT");
  const intent = value as unknown as FreezeIntent;
  validateLedger(intent.ledger);
  if (ledgerDigest(intent.ledger) !== intent.ledgerRevision)
    fail("INVALID_FREEZE_INTENT");
  const beforeBytes =
      intent.before === null ? null : Buffer.from(intent.before, "base64"),
    afterBytes = Buffer.from(intent.after, "base64");
  if (
    (beforeBytes && beforeBytes.toString("base64") !== intent.before) ||
    afterBytes.toString("base64") !== intent.after
  )
    fail("INVALID_FREEZE_INTENT");
  const before = beforeBytes
    ? parseWeeklyEditionLedger(JSON.parse(beforeBytes.toString("utf8")))
    : createEmptyWeeklyEditionLedger();
  const after = parseWeeklyEditionLedger(
    JSON.parse(afterBytes.toString("utf8"))
  );
  const target = after.editions.find(
    (edition) => edition.editionId === state.source.editionId
  );
  if (
    !target ||
    (input.cutoffEpochMs !== undefined &&
      input.cutoffEpochMs !== target.endEpochMs)
  )
    fail("FREEZE_CUTOFF_CHANGED");
  const expected = prepareWeeklyEdition(
    before,
    intent.ledger.events.map((event) => ({ ...event })),
    {
      editionId: state.source.editionId,
      cutoffEpochMs: target.endEpochMs,
      datasetVersion: `ingestion-v${intent.ledger.version}`,
    }
  );
  const expectedMode =
    before.editions.some((edition) => edition.editionId === target.editionId) &&
    state.source.importObservedAtEpochMs >= target.endEpochMs
      ? "correction"
      : "initial";
  const checked: StageEvidence = {
    editionId: target.editionId,
    cutoffEpochMs: target.endEpochMs,
    membershipSha256: sha256(canonicalJson(target.eventIds)),
    preCutoffPendingCount: 0,
    mode: expectedMode,
    ledgerRevision: intent.ledgerRevision,
  };
  if (
    target.endEpochMs > Date.now() ||
    (expectedMode === "initial" &&
      target.endEpochMs <= state.source.importObservedAtEpochMs)
  )
    fail("INVALID_FREEZE_CUTOFF");
  if (
    canonicalJson(expected.ledger) !== canonicalJson(after) ||
    intent.mode !== expectedMode ||
    canonicalJson(intent.evidence) !== canonicalJson(checked)
  )
    fail("INVALID_FREEZE_INTENT");
  let effectCommitted = false;
  try {
    await input.journal.guardOperation(input.lease, () =>
      withIngestionLock(input.root, async () => {
        input.verifyContext();
        const currentBytes = readWeekly(path);
        if (currentBytes?.equals(afterBytes)) {
          effectCommitted = true;
          return;
        }
        // Publication may legitimately update only status/cutoff after freezing.
        if (currentBytes) {
          const current = parseWeeklyEditionLedger(
            JSON.parse(currentBytes.toString("utf8"))
          );
          const currentTarget = current.editions.find(
            (edition) => edition.editionId === target.editionId
          );
          if (
            currentTarget &&
            canonicalJson(frozenIdentity(currentTarget)) ===
              canonicalJson(frozenIdentity(target))
          ) {
            effectCommitted = true;
            return;
          }
        }
        if (item.status === "succeeded") fail("FROZEN_EDITION_MISSING");
        if (
          currentBytes === null
            ? beforeBytes !== null
            : beforeBytes === null || !currentBytes.equals(beforeBytes)
        )
          fail("WEEKLY_STATE_CHANGED");
        if (pending(target.endEpochMs).length)
          fail("PENDING_PRE_CUTOFF_IMPORTS");
        const currentLedger = await loadLedger(
          join(input.root, "data/ingestion/ledger.json")
        );
        if (ledgerDigest(currentLedger) !== intent.ledgerRevision)
          fail("FREEZE_CONTEXT_CHANGED");
        input.verifyContext();
        writeDurableFile(path, afterBytes);
        effectCommitted = true;
        if (!readWeekly(path)?.equals(afterBytes)) fail("WEEKLY_STATE_CHANGED");
        input.verifyContext();
      })
    );
  } catch (error) {
    if (item.status !== "succeeded") {
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Z0-9_]{1,64}$/.test(error.code)
          ? error.code
          : "FREEZE_EFFECT_FAILED";
      transition({
        status: [
          "PENDING_PRE_CUTOFF_IMPORTS",
          "PENDING_STEVE_EMAIL_INTAKE",
        ].includes(code)
          ? "blocked"
          : "failed",
        errorCode: code,
      });
    }
    throw error;
  }
  if (effectCommitted && item.status !== "succeeded")
    await input.onProgress("effect-committed");
  input.verifyContext();
  if (item.status !== "succeeded") {
    transition({ status: "succeeded", evidence: checked });
    await input.onProgress("completed");
  } else if (canonicalJson(item.evidence) !== canonicalJson(checked))
    fail("INVALID_FREEZE_INTENT");
  return state;
}
