#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  importSteveContent,
  importVenueBatch,
} from "../dist/lib/ingestion/imports.js";

const args = process.argv.slice(2);
const kind = args.shift();
let root = fileURLToPath(new URL("../", import.meta.url));
let input;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) root = resolve(args[++i]);
  else if (args[i] === "--file" && args[i + 1]) input = resolve(args[++i]);
  else if (args[i] === "--dry-run") dryRun = true;
  else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}
if (!["steveslist", "venue"].includes(kind) || (kind === "venue" && !input))
  throw new Error(
    "Usage: node scripts/import-events.js steveslist|venue [--file PATH] [--root PATH] [--dry-run]"
  );
input ??= resolve(root, "data/latest.txt");
const text = readFileSync(input, "utf8");
const result =
  kind === "steveslist"
    ? await importSteveContent(root, text, { dryRun })
    : await importVenueBatch(root, JSON.parse(text), dryRun);
console.log(JSON.stringify({ dryRun, ...result.report }, null, 2));
if (result.report.replay)
  console.log(
    "Previously processed batch recognized. No events or added dates changed."
  );
else if (!dryRun)
  console.log("Ledger saved. Run npm run etl to regenerate the local site.");
