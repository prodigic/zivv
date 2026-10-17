#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWeeklyImport } from "../dist/lib/ingestion/weekly-import-runner.js";
import { parseImportObservation } from "../dist/lib/ingestion/steve-import-review.js";
import {
  createAuthoritativePromotionControlTransport,
  createRemotePromotionControlStore,
} from "../dist/lib/ingestion/promotion-control-git.js";
import {
  parsePromotionControl,
  validatePromotionAppend,
} from "../dist/lib/ingestion/promotion-control.js";
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
      "candidate",
      "workflow-commit",
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
    "dispatch",
    "verify",
    "acknowledge",
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
  ![
    "freeze",
    "enrich",
    "export",
    "validate",
    "dispatch",
    "verify",
    "acknowledge",
  ].includes(options.through)
)
  throw new Error(
    "Freeze options require --through freeze or a later candidate stage"
  );
const buildKeys = ["source-commit", "purpose", "base", "npm-cli"];
if (
  buildKeys.some((key) => options[key]) &&
  (!buildKeys.every((key) => options[key]) ||
    ![
      "enrich",
      "export",
      "validate",
      "dispatch",
      "verify",
      "acknowledge",
    ].includes(options.through))
)
  throw new Error("Candidate stages require all four build options together");
const delivering = ["dispatch", "verify", "acknowledge"].includes(
  options.through
);
if (options.candidate && !delivering)
  throw new Error(
    "--candidate requires --through dispatch, verify or acknowledge"
  );
if (
  options["workflow-commit"] &&
  (!delivering || !/^[a-f0-9]{40}$/.test(options["workflow-commit"]))
)
  throw new Error(
    "Reviewed workflow commit requires a delivery stage and full SHA"
  );
if (options.through === "dispatch" && !options["workflow-commit"])
  throw new Error("Dispatch requires --workflow-commit");
async function execute() {
  const root = resolve(
    options.root ?? fileURLToPath(new URL("../", import.meta.url))
  );
  let verifiedDelivery;
  let publication;
  if (delivering) {
    if (
      !options["run-id"] ||
      !options.candidate ||
      process.env.ZIVV_CONTROLLED_PUBLISHING !== "enabled" ||
      process.env.ZIVV_MANUAL_PUBLISHER_JOINED !== "true" ||
      !process.env.GITHUB_TOKEN
    )
      throw new Error("Verified delivery is not enabled");
    const path = resolve(options.candidate),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("Unsafe candidate identity file");
    const transport = createAuthoritativePromotionControlTransport(root, {
      token: process.env.GITHUB_TOKEN,
    });
    const store = createRemotePromotionControlStore({
      repositoryRoot: root,
      destination: "production",
      transport,
      validateState: (bytes, destination) => {
        const control = parsePromotionControl(bytes);
        if (control.destination !== destination)
          throw new Error("Wrong control destination");
        return control.completionRoot;
      },
      validateTransition: validatePromotionAppend,
    });
    const candidate = readFileSync(path);
    if (options["workflow-commit"])
      publication = {
        store,
        transport,
        candidate,
        workflowCommit: options["workflow-commit"],
        githubToken: process.env.GITHUB_TOKEN,
      };
    else verifiedDelivery = { store, candidate };
  }
  return runWeeklyImport({
    root,
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
    verifiedDelivery,
    publication,
    controlledPublishing: process.env.ZIVV_CONTROLLED_PUBLISHING,
    manualPublisherJoined: process.env.ZIVV_MANUAL_PUBLISHER_JOINED,
    onProgress: ({ runId, stage, phase }) =>
      process.stderr.write(JSON.stringify({ runId, stage, phase }) + "\n"),
  });
}
let state;
try {
  state = await execute();
} catch (error) {
  if (!delivering) throw error;
  console.error(
    "Verified weekly delivery stopped. Check activation prerequisites, exact candidate/native evidence, private run context and saved intents. Resume the same run; do not reimport or redeploy blindly."
  );
  process.exitCode = 1;
}
if (state)
  console.log(
    JSON.stringify({
      runId: state.runId,
      revision: state.revision,
      source: state.source,
      deliveryStatus: delivering
        ? state.stages.find((item) => item.stage === "acknowledge")?.status ===
          "succeeded"
          ? "acknowledged"
          : state.stages.find((item) => item.stage === "verify")?.status ===
              "succeeded"
            ? "verified"
            : "pending"
        : undefined,
      stages: state.stages.map(({ stage, status, attempt, errorCode }) => ({
        stage,
        status,
        attempt,
        errorCode,
      })),
    })
  );
