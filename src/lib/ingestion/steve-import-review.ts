import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./sqlite-store.js";
import type { ReconciliationReport } from "../../types/ingestion.js";

export interface SteveImportReview {
  schemaVersion: 1;
  importer: "steveslist-v4";
  inputSha256: string;
  configurationSha256: string;
  ledgerRevision: string;
  reportSha256: string;
  importRunId: string;
  observedAtEpochMs: number;
  reviewId: string;
}
export class SteveImportReviewError extends Error {
  readonly code: string;
  readonly diagnostic?: Record<string, unknown>;
  constructor(code: string, diagnostic?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.name = "SteveImportReviewError";
    if (diagnostic)
      Object.defineProperty(this, "diagnostic", {
        value: structuredClone(diagnostic),
        enumerable: false,
      });
  }
}
export const importDigest = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

/** Parse a timezone-qualified ISO observation without calendar rollover. */
export function parseImportObservation(value: unknown): number {
  if (typeof value !== "string")
    throw new SteveImportReviewError("INVALID_IMPORT_OBSERVATION");
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );
  if (!match) throw new SteveImportReviewError("INVALID_IMPORT_OBSERVATION");
  const calendar = match[1] + "." + (match[2] ?? "").padEnd(3, "0") + "Z";
  const calendarTime = Date.parse(calendar);
  const instant = Date.parse(value);
  if (
    !Number.isFinite(calendarTime) ||
    new Date(calendarTime).toISOString() !== calendar ||
    !Number.isSafeInteger(instant) ||
    instant < 0
  )
    throw new SteveImportReviewError("INVALID_IMPORT_OBSERVATION");
  return instant;
}

/** Exact import policy inputs, including absent historical/migration evidence. */
export function importConfigurationDigest(root: string): string {
  const files = [
    "venue-aliases.json",
    "line-corrections.json",
    "venue-location-corrections.json",
    "ingestion/historical-batches.json",
    "ingestion/migration.json",
  ];
  return importDigest(
    canonicalJson(
      files.map((path) => {
        const file = join(root, "data", path);
        let stat;
        try {
          stat = lstatSync(file);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return { path, sha256: null };
          throw error;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new SteveImportReviewError("IMPORT_CONFIGURATION_CHANGED");
        return { path, sha256: importDigest(readFileSync(file)) };
      })
    )
  );
}
/** Replay changes transport state, not the reviewed reconciliation decision. */
export function importReportDigest(report: ReconciliationReport): string {
  return importDigest(canonicalJson({ ...report, replay: false }));
}
export function createSteveImportReview(
  input: Omit<SteveImportReview, "reviewId">
): SteveImportReview {
  return parseSteveImportReview({
    ...input,
    reviewId: importDigest(canonicalJson(input)),
  });
}
/** Parse persisted receipts without accepting extra fields or invalid timestamps. */
export function parseSteveImportReview(input: unknown): SteveImportReview {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new SteveImportReviewError("INVALID_IMPORT_REVIEW");
  const value = input as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "importer",
    "inputSha256",
    "configurationSha256",
    "ledgerRevision",
    "reportSha256",
    "importRunId",
    "observedAtEpochMs",
    "reviewId",
  ];
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort()) ||
    value.schemaVersion !== 1 ||
    value.importer !== "steveslist-v4" ||
    typeof value.importRunId !== "string" ||
    !/^steveslist-v4-[a-f0-9]{64}$/.test(value.importRunId) ||
    typeof value.observedAtEpochMs !== "number" ||
    !Number.isSafeInteger(value.observedAtEpochMs) ||
    value.observedAtEpochMs < 0
  )
    throw new SteveImportReviewError("INVALID_IMPORT_REVIEW");
  for (const key of [
    "inputSha256",
    "configurationSha256",
    "ledgerRevision",
    "reportSha256",
    "reviewId",
  ])
    if (
      typeof value[key] !== "string" ||
      !/^[a-f0-9]{64}$/.test(value[key] as string)
    )
      throw new SteveImportReviewError("INVALID_IMPORT_REVIEW");
  const { reviewId, ...identity } = value;
  if (reviewId !== importDigest(canonicalJson(identity)))
    throw new SteveImportReviewError("INVALID_IMPORT_REVIEW");
  return structuredClone(value) as unknown as SteveImportReview;
}
