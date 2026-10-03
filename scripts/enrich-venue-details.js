#!/usr/bin/env node
import { join, resolve } from "node:path";
import { loadLedger, saveLedgerAtomic } from "../dist/lib/ingestion/ledger.js";
import { withIngestionLock } from "../dist/lib/ingestion/lock.js";
import { applyProjectVenueDetails } from "../dist/lib/ingestion/venue-details.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply"))
  throw new Error("Usage: node scripts/enrich-venue-details.js [--apply]");
const root = resolve(".");
const apply = args.includes("--apply");
async function enrich() {
  const path = join(root, "data/ingestion/ledger.json");
  const ledger = await loadLedger(path);
  const changed = applyProjectVenueDetails(root, ledger.venues);
  if (apply && changed.length) {
    const timestamp = Date.now();
    const changedIds = new Set(changed);
    for (const venue of ledger.venues)
      if (changedIds.has(venue.id)) venue.updatedAtEpochMs = timestamp;
    await saveLedgerAtomic(path, ledger);
  }
  console.log(
    JSON.stringify(
      { applied: apply, changedCount: changed.length, venueIds: changed },
      null,
      2
    )
  );
}
if (apply) await withIngestionLock(root, enrich);
else await enrich();
