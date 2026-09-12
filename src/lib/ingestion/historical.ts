import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeLatestContent } from "../etl/latest-content.js";
import { loadLedger } from "./ledger.js";
import { withIngestionLock } from "./lock.js";
import { writeJsonAtomic } from "./persistence.js";
import type { Event } from "../../types/events.js";
import type { IngestionLedger } from "../../types/ingestion.js";

export interface HistoricalReceipt {
  source: "steveslist";
  contentSha256: string;
  sourceCommit: string;
  datasetVersion: string;
  processedAtEpochMs: number;
  migrationIdentitySha256: string;
  recordedAtEpochMs: number;
}

interface MigrationEvidence {
  priorDatasetVersion: string;
  preservedIdentityAndAddedDateSha256: string;
  events: number;
}

type JsonRecord = Record<string, unknown>;

export function historicalContentHash(content: string): string {
  return createHash("sha256")
    .update(normalizeLatestContent(content))
    .digest("hex");
}

function readReceipts(root: string): HistoricalReceipt[] {
  const path = join(root, "data/ingestion/historical-batches.json");
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.schemaVersion !== 1 || !Array.isArray(value.batches))
    throw new Error("Invalid historical batch receipts");
  const receipts = value.batches as HistoricalReceipt[];
  const hashes = new Set<string>();
  for (const receipt of receipts) {
    if (
      receipt.source !== "steveslist" ||
      !/^[a-f0-9]{64}$/.test(receipt.contentSha256) ||
      !/^[a-f0-9]{40,64}$/.test(receipt.sourceCommit) ||
      !/^[a-f0-9]{64}$/.test(receipt.migrationIdentitySha256) ||
      typeof receipt.datasetVersion !== "string" ||
      !Number.isFinite(receipt.processedAtEpochMs) ||
      receipt.processedAtEpochMs <= 0 ||
      !Number.isFinite(receipt.recordedAtEpochMs) ||
      hashes.has(receipt.contentSha256)
    )
      throw new Error("Invalid or duplicate historical batch receipt");
    hashes.add(receipt.contentSha256);
  }
  return receipts;
}

function readMigrationEvidence(root: string): MigrationEvidence {
  const value: unknown = JSON.parse(
    readFileSync(join(root, "data/ingestion/migration.json"), "utf8")
  );
  if (
    !isRecord(value) ||
    typeof value.priorDatasetVersion !== "string" ||
    typeof value.preservedIdentityAndAddedDateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.preservedIdentityAndAddedDateSha256) ||
    typeof value.events !== "number" ||
    !Number.isSafeInteger(value.events) ||
    value.events < 0
  )
    throw new Error("Invalid historical migration evidence");
  return {
    priorDatasetVersion: value.priorDatasetVersion,
    preservedIdentityAndAddedDateSha256:
      value.preservedIdentityAndAddedDateSha256,
    events: value.events,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function historicalIdentityHash(ledgerEvents: readonly Event[]): string {
  const identity = ledgerEvents
    .map((event) => [event.id, event.createdAtEpochMs ?? null])
    .sort((left, right) => Number(left[0]) - Number(right[0]));
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/**
 * A historical receipt is valid only while its bootstrap event population is
 * intact. New imports have a non-null firstImportRunId and are intentionally
 * excluded from this immutable baseline audit.
 */
function verifyHistoricalLedgerBaseline(
  ledger: IngestionLedger,
  migration: MigrationEvidence
): void {
  const baseline = ledger.events.filter(
    (event) => event.firstImportRunId === null
  );
  if (baseline.length !== migration.events)
    throw new Error("Migrated historical IDs, dates, or origins have changed");
  if (baseline.some((event) => event.firstImportedBy !== "steveslist"))
    throw new Error("Migrated historical IDs, dates, or origins have changed");
  if (
    historicalIdentityHash(baseline) !==
    migration.preservedIdentityAndAddedDateSha256
  )
    throw new Error("Migrated historical IDs, dates, or origins have changed");
}

/** Exact normalized source content is recognized independently of later parser changes. */
export function findHistoricalSteveReceipt(
  root: string,
  content: string,
  ledger: IngestionLedger
): HistoricalReceipt | undefined {
  const receipt = readReceipts(root).find(
    (item) => item.contentSha256 === historicalContentHash(content)
  );
  if (receipt) {
    const migration = readMigrationEvidence(root);
    if (
      migration.preservedIdentityAndAddedDateSha256 !==
        receipt.migrationIdentitySha256 ||
      migration.priorDatasetVersion !== receipt.datasetVersion
    )
      throw new Error(
        "Historical receipt does not belong to this migrated catalog"
      );
    verifyHistoricalLedgerBaseline(ledger, migration);
  }
  return receipt;
}

/** Register an operator-selected prior import using immutable source and dataset evidence. */
export async function registerHistoricalSteveBatch(
  root: string,
  commit: string
): Promise<HistoricalReceipt> {
  if (!/^[a-f0-9]{7,64}$/i.test(commit))
    throw new Error("Historical import requires a commit SHA");
  return withIngestionLock(root, async () => {
    const ledger = await loadLedger(join(root, "data/ingestion/ledger.json"));
    const currentSource = readFileSync(join(root, "data/latest.txt"), "utf8");
    const existing = findHistoricalSteveReceipt(root, currentSource, ledger);
    if (existing) return existing;
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, maxBuffer: 30_000_000 }).toString(
        "utf8"
      );
    const sourceCommit = git([
      "rev-parse",
      "--verify",
      `${commit}^{commit}`,
    ]).trim();
    const read = (path: string) => git(["show", `${sourceCommit}:${path}`]);
    const source = read("data/latest.txt");
    if (
      historicalContentHash(source) !==
      historicalContentHash(readFileSync(join(root, "data/latest.txt"), "utf8"))
    )
      throw new Error(
        "Current latest.txt differs from the selected historical commit"
      );
    const manifest = JSON.parse(read("public/data/manifest.json"));
    const migration = readMigrationEvidence(root);
    if (
      manifest.datasetVersion !== migration.priorDatasetVersion ||
      !Array.isArray(manifest.chunks?.events)
    )
      throw new Error(
        "Historical dataset does not match the migration baseline"
      );
    const events: Event[] = manifest.chunks.events.flatMap(
      (chunk: { filename: string }) => {
        if (!/^events-\d{4}-\d{2}\.json$/.test(chunk.filename))
          throw new Error("Invalid historical chunk filename");
        return JSON.parse(read(`public/data/${chunk.filename}`)).events;
      }
    );
    const identity = events
      .map((e) => [e.id, e.createdAtEpochMs ?? null])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const identityHash = createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex");
    if (
      identityHash !== migration.preservedIdentityAndAddedDateSha256 ||
      events.length !== migration.events ||
      events.length !== manifest.totalEvents
    )
      throw new Error(
        "Historical event identity/date evidence differs from migration"
      );
    const current = new Map(ledger.events.map((e) => [e.id, e]));
    if (
      events.some(
        (e) =>
          current.get(e.id)?.createdAtEpochMs !== e.createdAtEpochMs ||
          current.get(e.id)?.firstImportedBy !== "steveslist"
      )
    )
      throw new Error(
        "Migrated historical IDs, dates, or origins have changed"
      );
    const receipts = readReceipts(root);
    const existingAfterEvidence = findHistoricalSteveReceipt(
      root,
      source,
      ledger
    );
    if (existingAfterEvidence) return existingAfterEvidence;
    const receipt: HistoricalReceipt = {
      source: "steveslist",
      contentSha256: historicalContentHash(source),
      sourceCommit,
      datasetVersion: manifest.datasetVersion,
      processedAtEpochMs: manifest.lastUpdated,
      migrationIdentitySha256: identityHash,
      recordedAtEpochMs: Date.now(),
    };
    writeJsonAtomic(join(root, "data/ingestion/historical-batches.json"), {
      schemaVersion: 1,
      batches: [...receipts, receipt],
    });
    return receipt;
  });
}
