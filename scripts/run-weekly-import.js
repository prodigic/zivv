#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWeeklyImport } from "../dist/lib/ingestion/weekly-import-runner.js";
import { parseImportObservation } from "../dist/lib/ingestion/steve-import-review.js";
const options = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]?.slice(2),
    value = args[index + 1];
  if (
    !args[index]?.startsWith("--") ||
    ![
      "root",
      "file",
      "edition-id",
      "delivery-id",
      "observed-at",
      "run-id",
      "through",
      "freeze-cutoff",
      "reuse-frozen",
      "source-commit",
      "purpose",
      "base",
      "npm-cli",
    ].includes(key) ||
    Object.hasOwn(options, key) ||
    !value ||
    value.startsWith("--")
  )
    throw new Error("Invalid weekly-run arguments");
  options[key] = value;
}
let source;
if (options["run-id"]) {
  if (
    !/^[a-f0-9]{64}$/.test(options["run-id"]) ||
    ["file", "edition-id", "delivery-id", "observed-at"].some(
      (key) => options[key]
    )
  )
    throw new Error("Resume requires --run-id without source arguments");
} else {
  for (const key of ["file", "edition-id", "delivery-id", "observed-at"])
    if (!options[key]) throw new Error("Missing --" + key);
  const file = resolve(options.file),
    stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("Source must be an unlinked regular file");
  source = {
    editionId: options["edition-id"],
    deliveryId: options["delivery-id"],
    raw: readFileSync(file),
    importObservedAtEpochMs: parseImportObservation(options["observed-at"]),
  };
}
if (
  options.through &&
  ![
    "acquire",
    "prepare",
    "reconcile",
    "load",
    "freeze",
    "enrich",
    "export",
    "validate",
  ].includes(options.through)
)
  throw new Error("Unsupported --through stage");
if (
  options["reuse-frozen"] &&
  !["true", "false"].includes(options["reuse-frozen"])
)
  throw new Error("--reuse-frozen must be true or false");
if (
  (options["freeze-cutoff"] || options["reuse-frozen"]) &&
  !["freeze", "enrich", "export", "validate"].includes(options.through)
)
  throw new Error(
    "Freeze options require --through freeze or a later candidate stage"
  );
const buildKeys = ["source-commit", "purpose", "base", "npm-cli"];
if (
  buildKeys.some((key) => options[key]) &&
  (!buildKeys.every((key) => options[key]) ||
    !["enrich", "export", "validate"].includes(options.through))
)
  throw new Error("Candidate stages require all four build options together");
const state = await runWeeklyImport({
  root: resolve(options.root ?? fileURLToPath(new URL("../", import.meta.url))),
  source,
  runId: options["run-id"],
  stopAfter: options.through ?? "load",
  freezeCutoffEpochMs: options["freeze-cutoff"]
    ? parseImportObservation(options["freeze-cutoff"])
    : undefined,
  reuseFrozen: options["reuse-frozen"] === "true",
  candidateBuild: options["source-commit"]
    ? {
        sourceCommit: options["source-commit"],
        purpose: options.purpose,
        basePath: options.base,
        npmCli: resolve(options["npm-cli"]),
      }
    : undefined,
  onProgress: ({ runId, stage, phase }) =>
    process.stderr.write(JSON.stringify({ runId, stage, phase }) + "\n"),
});
console.log(
  JSON.stringify({
    runId: state.runId,
    revision: state.revision,
    source: state.source,
    stages: state.stages.map(({ stage, status, attempt, errorCode }) => ({
      stage,
      status,
      attempt,
      errorCode,
    })),
  })
);
