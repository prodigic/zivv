#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { migrateExistingCatalog } from "../dist/lib/ingestion/migrate.js";

const args = process.argv.slice(2);
if (args.length && (args[0] !== "--root" || args.length !== 2))
  throw new Error("Usage: node scripts/migrate-ingestion.js [--root PATH]");
const root = args[1]
  ? resolve(args[1])
  : fileURLToPath(new URL("../", import.meta.url));
console.log(JSON.stringify(await migrateExistingCatalog(root), null, 2));
