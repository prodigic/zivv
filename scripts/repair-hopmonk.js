#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadLedger, saveLedgerAtomic } from "../dist/lib/ingestion/ledger.js";
import { repairHopmonk } from "../dist/lib/ingestion/repair-hopmonk.js";
import { withIngestionLock } from "../dist/lib/ingestion/lock.js";
import { writeJsonAtomic } from "../dist/lib/ingestion/persistence.js";

// Run from the private operator checkout after npm run build:etl.
// Defaults to a read-only report. --apply saves the ledger with an audit report.
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply"))
  throw new Error("Usage: node scripts/repair-hopmonk.js [--apply]");
const root = resolve(".");
await withIngestionLock(root, async () => {
  const ledgerPath = join(root, "data/ingestion/ledger.json");
  const ledger = await loadLedger(ledgerPath);
  let content = readFileSync(join(root, "data/events.txt"), "utf8");
  for (const correction of JSON.parse(
    readFileSync(join(root, "data/line-corrections.json"), "utf8")
  )) {
    content = content.replace(
      new RegExp(correction.pattern, "gim"),
      correction.replacement
    );
  }
  const result = repairHopmonk(
    ledger,
    content,
    JSON.parse(readFileSync(join(root, "data/venue-aliases.json"), "utf8")),
    Date.now()
  );
  const report = {
    changed: result.changes.length,
    changes: result.changes,
    unresolved: result.unresolved,
  };
  if (args.includes("--apply") && result.changes.length) {
    mkdirSync(join(root, "data/ingestion/reports"), { recursive: true });
    await writeJsonAtomic(
      join(root, "data/ingestion/reports/hopmonk-city-repair.json"),
      report
    );
    await saveLedgerAtomic(ledgerPath, result.ledger);
  }
  console.log(
    JSON.stringify(
      {
        applied: args.includes("--apply"),
        changed: report.changed,
        unresolved: report.unresolved,
      },
      null,
      2
    )
  );
});
