#!/usr/bin/env node

/**
 * Prepare or explicitly publish a durable weekly additions edition.
 *
 * This command only changes data/ingestion/weekly-editions.json.  ETL remains
 * the operation that exports a selected snapshot to public/data; no newsletter
 * is sent and no generated public file is written here.
 */

import {
  createEmptyWeeklyEditionLedger,
  markWeeklyEditionPublished,
  parseWeeklyEditionLedger,
  prepareWeeklyEdition,
  serializeWeeklyEditionLedger,
} from "../dist/lib/ingestion/weekly.js";
import { loadLedger } from "../dist/lib/ingestion/ledger.js";
import { withIngestionLock } from "../dist/lib/ingestion/lock.js";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const weeklyStateRelativePath = ["data", "ingestion", "weekly-editions.json"];
const sourceLedgerRelativePath = ["data", "ingestion", "ledger.json"];

function usage() {
  return [
    "Usage:",
    "  node scripts/weekly-edition.js prepare --id <edition-id> --cutoff <ISO> [--root <project-root>]",
    "  node scripts/weekly-edition.js mark-published --id <edition-id> [--root <project-root>]",
  ].join("\n");
}

function cliError(message) {
  throw new Error(`${message}\n\n${usage()}`);
}

function parseArguments(argv) {
  const command = argv[0];
  if (command !== "prepare" && command !== "mark-published") {
    cliError(`Unknown command ${String(command)}`);
  }

  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) cliError(`Unexpected argument ${argument}`);
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      cliError(`Missing value for --${name}`);
    if (name !== "id" && name !== "cutoff" && name !== "root")
      cliError(`Unknown option --${name}`);
    options[name] = value;
    index += 1;
  }

  if (!options.id) cliError("--id is required");
  if (command === "prepare" && !options.cutoff)
    cliError("--cutoff is required for prepare");
  options.root = resolve(options.root || scriptRoot);
  return options;
}

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse ${label} at ${path}: ${error.message}`);
  }
}

function loadWeeklyState(root) {
  const statePath = resolve(root, ...weeklyStateRelativePath);
  if (!existsSync(statePath)) {
    return {
      path: statePath,
      ledger: createEmptyWeeklyEditionLedger(),
      existed: false,
    };
  }
  let ledger;
  try {
    ledger = parseWeeklyEditionLedger(
      readJson(statePath, "weekly edition state")
    );
  } catch (error) {
    throw new Error(
      `Weekly edition state is corrupt at ${statePath}: ${error.message}`
    );
  }
  return { path: statePath, ledger, existed: true };
}

function writeAtomically(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "w");
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write/rename failure.
    }
    throw new Error(
      `Could not atomically write weekly edition state at ${path}: ${error.message}`
    );
  }
}

async function loadCanonicalLedger(root) {
  const ledgerPath = resolve(root, ...sourceLedgerRelativePath);
  if (!existsSync(ledgerPath)) {
    throw new Error(`Canonical ingestion ledger is missing at ${ledgerPath}`);
  }

  const loaded = await loadLedger(ledgerPath);
  if (!loaded || typeof loaded.version !== "string" || !loaded.version.trim()) {
    throw new Error(
      `Validated canonical ingestion ledger at ${ledgerPath} has no revision`
    );
  }
  return loaded;
}

function printResult(command, root, result, statePath) {
  const output = {
    command,
    root,
    statePath,
    reused: result.reused,
    edition: result.edition,
  };
  console.log(JSON.stringify(output, null, 2));
  console.log(
    `Run npm run etl to export the ${result.edition.status} edition through ETL.`
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  return withIngestionLock(options.root, async () => {
    const state = loadWeeklyState(options.root);
    let result;

    if (options.command === "prepare") {
      const ledger = await loadCanonicalLedger(options.root);
      result = prepareWeeklyEdition(state.ledger, ledger.events, {
        editionId: options.id,
        cutoffIso: options.cutoff,
        datasetVersion: `ingestion-v${ledger.version}`,
      });
    } else {
      result = markWeeklyEditionPublished(state.ledger, options.id);
    }

    if (!result.reused)
      writeAtomically(state.path, serializeWeeklyEditionLedger(result.ledger));
    printResult(options.command, options.root, result, state.path);
    return result;
  });
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : "";
const thisScript = resolve(fileURLToPath(import.meta.url));
if (invokedScript === thisScript) {
  main().catch((error) => {
    console.error(`weekly-edition: ${error.message}`);
    process.exitCode = 1;
  });
}
