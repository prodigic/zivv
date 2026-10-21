import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  listRetainedSteveEmailSources,
  type SteveEmailReceipt,
} from "./steve-email-intake.js";
import { sha256 } from "./steve-preflight.js";
import { projectLedgerLocation } from "./store-location.js";
import {
  runWeeklyImport,
  type WeeklyImportProgress,
} from "./weekly-import-runner.js";
import type { WeeklyRunState } from "./weekly-run-state.js";

export type SteveEmailLoadDisposition =
  | "loaded"
  | "review-required"
  | "blocked"
  | "failed"
  | "not-processed";

export interface SteveEmailLoadEntry {
  receiptId: string;
  disposition: SteveEmailLoadDisposition;
  runId?: string;
  errorCode?: string;
}

export interface SteveEmailLoadResult {
  editionId: string;
  counts: {
    ready: number;
    reviewRequired: number;
    loaded: number;
    blocked: number;
    failed: number;
    notProcessed: number;
  };
  entries: SteveEmailLoadEntry[];
}

export interface LoadRetainedSteveEmailSourcesInput {
  root: string;
  operatorDirectory: string;
  accountId: string;
  expectedEditionId: string;
  onProgress?: (event: WeeklyImportProgress) => void | Promise<void>;
}

export class SteveEmailLoadError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SteveEmailLoadError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new SteveEmailLoadError(code);
}

function runnerErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,64}$/.test(error.code)
  )
    return error.code;
  return "STEVE_EMAIL_LOAD_FAILED";
}

function loadStage(state: WeeklyRunState) {
  return state.stages.find((stage) => stage.stage === "load");
}

function assertSameSource(
  state: WeeklyRunState,
  receipt: SteveEmailReceipt,
  source: Buffer
): void {
  if (
    state.source.editionId !== receipt.editionId ||
    state.source.deliveryId !== receipt.deliveryId ||
    state.source.rawSha256 !== sha256(source) ||
    state.source.importObservedAtEpochMs !== receipt.firstObservedAtEpochMs
  )
    fail("STEVE_EMAIL_RUN_IDENTITY_MISMATCH");
}

function errorDisposition(errorCode: string): "blocked" | "failed" {
  return [
    "PREFLIGHT_REVIEW_REQUIRED",
    "CORE_RECONCILIATION_REQUIRED",
    "PREFLIGHT_CONTEXT_CHANGED",
    "LATE_IMPORT_REQUIRES_REVIEW",
  ].includes(errorCode)
    ? "blocked"
    : "failed";
}

/** Load retained ready receipts in receipt order through the normal weekly worker. */
export async function loadRetainedSteveEmailSources(
  input: LoadRetainedSteveEmailSourcesInput
): Promise<SteveEmailLoadResult> {
  let location: ReturnType<typeof projectLedgerLocation>;
  try {
    location = projectLedgerLocation(input.root);
  } catch {
    return fail("INVALID_PROJECT_LEDGER_CONFIGURATION");
  }
  if (location.backend !== "sqlite") fail("SHARED_SQLITE_REQUIRED");

  let configuredOperator: string;
  let suppliedOperator: string;
  try {
    configuredOperator = realpathSync(location.directory);
    suppliedOperator = realpathSync(resolve(input.operatorDirectory));
  } catch {
    return fail("OPERATOR_STORE_MISMATCH");
  }
  if (configuredOperator !== suppliedOperator) fail("OPERATOR_STORE_MISMATCH");
  if (!existsSync(location.path)) fail("SHARED_SQLITE_REQUIRED");

  let retained: Array<{ receipt: SteveEmailReceipt; source: Buffer }>;
  try {
    retained = listRetainedSteveEmailSources({
      operatorDirectory: suppliedOperator,
      accountId: input.accountId,
      expectedEditionId: input.expectedEditionId,
    });
  } catch (error) {
    return fail(runnerErrorCode(error));
  }

  const entries: SteveEmailLoadEntry[] = retained.map(({ receipt }) => ({
    receiptId: receipt.receiptId,
    disposition:
      receipt.disposition === "ready" ? "not-processed" : "review-required",
  }));
  let stoppedAtFailure = false;

  for (const [index, { receipt, source }] of retained.entries()) {
    if (receipt.disposition !== "ready") continue;
    if (stoppedAtFailure) continue;

    try {
      const state = await runWeeklyImport({
        root: input.root,
        source: {
          editionId: receipt.editionId,
          deliveryId: receipt.deliveryId,
          raw: Buffer.from(source),
          importObservedAtEpochMs: receipt.firstObservedAtEpochMs,
        },
        stopAfter: "load",
        onProgress: input.onProgress,
      });
      assertSameSource(state, receipt, source);
      const stage = loadStage(state);
      if (stage?.status === "succeeded") {
        entries[index] = {
          receiptId: receipt.receiptId,
          runId: state.runId,
          disposition: "loaded",
        };
      } else {
        const errorCode = stage?.errorCode ?? "LOAD_NOT_CONFIRMED";
        entries[index] = {
          receiptId: receipt.receiptId,
          runId: state.runId,
          disposition: errorDisposition(errorCode),
          errorCode,
        };
        stoppedAtFailure = true;
      }
    } catch (error) {
      const errorCode = runnerErrorCode(error);
      entries[index] = {
        receiptId: receipt.receiptId,
        disposition: errorDisposition(errorCode),
        errorCode,
      };
      stoppedAtFailure = true;
    }
  }

  const counts = {
    ready: retained.filter(({ receipt }) => receipt.disposition === "ready")
      .length,
    reviewRequired: retained.filter(
      ({ receipt }) => receipt.disposition === "review-required"
    ).length,
    loaded: entries.filter((entry) => entry.disposition === "loaded").length,
    blocked: entries.filter((entry) => entry.disposition === "blocked").length,
    failed: entries.filter((entry) => entry.disposition === "failed").length,
    notProcessed: entries.filter(
      (entry) => entry.disposition === "not-processed"
    ).length,
  };
  return { editionId: input.expectedEditionId, counts, entries };
}
