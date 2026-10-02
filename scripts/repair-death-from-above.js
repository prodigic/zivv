#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadLedger, saveLedgerAtomic } from "../dist/lib/ingestion/ledger.js";
import { repairDeathFromAbove } from "../dist/lib/ingestion/repair-death-from-above.js";
import { withIngestionLock } from "../dist/lib/ingestion/lock.js";
import { writeJsonAtomic } from "../dist/lib/ingestion/persistence.js";

// Build ETL first. The default prints a read-only reviewed repair proposal.
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply"))
  throw new Error("Usage: node scripts/repair-death-from-above.js [--apply]");
const root = resolve(".");
await withIngestionLock(root, async () => {
  const ledgerPath = join(root, "data/ingestion/ledger.json");
  const ledger = await loadLedger(ledgerPath);
  const result = repairDeathFromAbove(
    ledger,
    Date.now(),
    readFileSync(join(root, "data/events.txt"), "utf8")
  );
  if (args.includes("--apply") && result.changes.length) {
    mkdirSync(join(root, "data/ingestion/reports"), { recursive: true });
    await writeJsonAtomic(
      join(root, "data/ingestion/reports/death-from-above-repair.json"),
      {
        previousVersion: ledger.version,
        version: result.ledger.version,
        changes: result.changes,
      }
    );
    await saveLedgerAtomic(ledgerPath, result.ledger);
  }
  console.log(
    JSON.stringify(
      {
        applied: args.includes("--apply"),
        changed: result.changes.length,
        keptEventIds: result.changes.map((c) => c.keptEventId),
        retiredEventIds: result.changes.flatMap((c) =>
          c.retiredEvents.map((e) => e.id)
        ),
      },
      null,
      2
    )
  );
});
