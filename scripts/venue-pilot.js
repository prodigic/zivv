#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runVenuePilot } from "../dist/lib/ingestion/venue-pilot.js";

const args = process.argv.slice(2);
const sourceIds = [];
let offline = false;
let strict = false;
let root = fileURLToPath(new URL("../", import.meta.url));
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--source" && args[i + 1]) sourceIds.push(args[++i]);
  else if (args[i] === "--offline") offline = true;
  else if (args[i] === "--strict") strict = true;
  else if (args[i] === "--root" && args[i + 1]) root = resolve(args[++i]);
  else
    throw new Error(
      "Usage: node scripts/venue-pilot.js [--source SOURCE_ID] [--offline] [--strict] [--root PATH]"
    );
}
const modules = {
  "bottom-of-the-hill-sf": ["bottom", "fetchBottomOfTheHill"],
  "rickshaw-stop-sf": ["rickshaw", "fetchRickshawStop"],
  "fillmore-sf": ["fillmore", "fetchFillmore"],
};
const adapters = {};
for (const source of sourceIds.length ? sourceIds : Object.keys(modules)) {
  if (!modules[source]) throw new Error(`Unknown pilot source ${source}`);
  const [module, fn] = modules[source];
  adapters[source] = (
    await import(`../dist/lib/ingestion/venues/${module}.js`)
  )[fn];
}
const result = await runVenuePilot(root, adapters, {
  sourceIds: sourceIds.length ? sourceIds : undefined,
  offline,
  ticketmasterApiKey: process.env.TICKETMASTER_API_KEY,
});
console.log(
  JSON.stringify(
    {
      mode: result.mode,
      ledgerRevision: result.ledgerRevision,
      modelCalls: result.modelCalls,
      directory: result.directory,
      summary: result.summary,
    },
    null,
    2
  )
);
if (strict && result.summary.some((source) => !source.importEligible))
  process.exitCode = 1;
