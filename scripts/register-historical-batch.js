#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { registerHistoricalSteveBatch } from "../dist/lib/ingestion/historical.js";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--commit")
  throw new Error(
    "Usage: node scripts/register-historical-batch.js --commit SHA"
  );
console.log(
  JSON.stringify(
    await registerHistoricalSteveBatch(
      fileURLToPath(new URL("../", import.meta.url)),
      args[1]
    ),
    null,
    2
  )
);
