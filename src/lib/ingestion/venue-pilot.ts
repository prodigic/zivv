import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLedger } from "./ledger.js";
import { assessVenueCoverage } from "./venue-coverage.js";
import { createVenueFetcher } from "./venue-fetch.js";
import { writeJsonAtomic } from "./persistence.js";
import type {
  VenueAdapterResult,
  VenueFetchContext,
  VenueSource,
} from "./venue-types.js";

export type VenueAdapter = (
  context: VenueFetchContext
) => Promise<VenueAdapterResult>;

/** Run an explicit shadow pilot: fetch, account, reconcile, retain review evidence. */
export async function runVenuePilot(
  root: string,
  adapters: Record<string, VenueAdapter>,
  options: {
    sourceIds?: string[];
    offline?: boolean;
    nowEpochMs?: number;
    ticketmasterApiKey?: string;
  } = {}
) {
  const observedAtEpochMs = options.nowEpochMs ?? Date.now();
  const ledger = await loadLedger(join(root, "data/ingestion/ledger.json"));
  const registry = JSON.parse(
    readFileSync(join(root, "data/venue-sources.json"), "utf8")
  );
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.sources))
    throw new Error("Invalid venue source registry");
  const selected = options.sourceIds ?? Object.keys(adapters);
  if (!selected.length || new Set(selected).size !== selected.length)
    throw new Error("Choose distinct pilot source IDs");
  const sources = selected.map((id) => {
    const matches: VenueSource[] = registry.sources.filter(
      (s: VenueSource) => s.sourceId === id
    );
    if (matches.length !== 1 || !adapters[id])
      throw new Error(`Unknown or duplicate pilot source: ${id}`);
    return matches[0];
  });
  const directory = join(
    root,
    ".cache/venue-pilot",
    `${new Date(observedAtEpochMs).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  );
  mkdirSync(directory, { recursive: true });
  const reports: unknown[] = [];
  const summary: {
    sourceId: string;
    sourceStatus: string;
    databaseStatus: string;
    discovered: number;
    matched: number;
    missing: number;
    review: number;
    excluded: number;
    requests: number;
    bytes: number;
    importEligible: boolean;
  }[] = [];
  for (const source of sources) {
    let transport: ReturnType<typeof createVenueFetcher> | undefined;
    const basename = createHash("sha256")
      .update(source.sourceId)
      .digest("hex")
      .slice(0, 16);
    try {
      transport = createVenueFetcher(root, source, {
        offline: options.offline,
      });
      const result = await adapters[source.sourceId]({
        source,
        nowEpochMs: observedAtEpochMs,
        fetchText: transport.fetchText,
        ticketmasterApiKey: options.ticketmasterApiKey,
      });
      if (options.offline) {
        result.complete = false;
        result.warnings.push(
          "Offline replay checks parsing only; current source completeness is not verified."
        );
      }
      const { report, batch, reconciliation } = assessVenueCoverage(
        ledger,
        source,
        result,
        observedAtEpochMs
      );
      writeJsonAtomic(join(directory, `${basename}.source.json`), result);
      writeJsonAtomic(join(directory, `${basename}.report.json`), {
        ...report,
        requests: transport?.observations ?? [],
        reconciliation,
      });
      // Only a fully accounted source without unresolved candidates produces an
      // import-ready batch. A partial result remains review evidence.
      if (report.importEligible)
        writeJsonAtomic(join(directory, `${basename}.batch.json`), batch);
      reports.push({ ...report, requests: transport.observations });
      summary.push({
        sourceId: source.sourceId,
        sourceStatus: report.sourceStatus,
        databaseStatus: report.databaseStatus,
        discovered: report.counts.discovered,
        matched: report.counts.matched,
        missing: report.counts["missing-from-db"],
        review: report.counts.review,
        excluded: report.counts.excluded,
        requests: transport.observations.length,
        bytes: transport.observations.reduce(
          (sum, item) => sum + item.bytes,
          0
        ),
        importEligible: report.importEligible,
      });
    } catch (error) {
      const observations = transport?.observations ?? [];
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = options.ticketmasterApiKey
        ? rawMessage.split(options.ticketmasterApiKey).join("REDACTED")
        : rawMessage;
      const report = {
        sourceId: source.sourceId,
        sourceStatus: "failed",
        databaseStatus: "not-verified",
        message,
        requests: observations,
        importEligible: false,
        modelCalls: 0,
      };
      writeJsonAtomic(join(directory, `${basename}.report.json`), report);
      reports.push(report);
      summary.push({
        sourceId: source.sourceId,
        sourceStatus: "failed",
        databaseStatus: "not-verified",
        discovered: 0,
        matched: 0,
        missing: 0,
        review: 0,
        excluded: 0,
        requests: observations.length,
        bytes: observations.reduce((sum, item) => sum + item.bytes, 0),
        importEligible: false,
      });
    }
  }
  const report = {
    schemaVersion: 1,
    mode: "shadow",
    ledgerRevision: ledger.version,
    observedAtEpochMs,
    offline: options.offline ?? false,
    modelCalls: 0,
    directory,
    summary,
    venues: reports,
  };
  writeJsonAtomic(join(directory, "report.json"), report);
  return report;
}
