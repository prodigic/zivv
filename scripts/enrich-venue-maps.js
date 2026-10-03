#!/usr/bin/env node
import { join, resolve } from "node:path";
import { loadLedger, saveLedgerAtomic } from "../dist/lib/ingestion/ledger.js";
import { withIngestionLock } from "../dist/lib/ingestion/lock.js";
import { applyProjectVenueMaps } from "../dist/lib/ingestion/venue-maps.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply"))
  throw new Error("Usage: node scripts/enrich-venue-maps.js [--apply]");
const root = resolve(".");
async function enrich() {
  const path = join(root, "data/ingestion/ledger.json");
  const ledger = await loadLedger(path);
  const changed = applyProjectVenueMaps(root, ledger.venues);
  if (args.includes("--apply") && changed.length) {
    const timestamp = Date.now();
    const ids = new Set(changed);
    for (const venue of ledger.venues)
      if (ids.has(venue.id)) venue.updatedAtEpochMs = timestamp;
    await saveLedgerAtomic(path, ledger);
  }
  console.log(
    JSON.stringify({
      applied: args.includes("--apply"),
      changedCount: changed.length,
    })
  );
}
if (args.includes("--apply")) await withIngestionLock(root, enrich);
else await enrich();
