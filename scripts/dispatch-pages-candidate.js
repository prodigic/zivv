#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPagesCandidateDispatch } from "../dist/lib/ingestion/pages-dispatch-runner.js";
import {
  createAuthoritativePromotionControlTransport,
  createRemotePromotionControlStore,
} from "../dist/lib/ingestion/promotion-control-git.js";
import {
  parsePromotionControl,
  validatePromotionAppend,
} from "../dist/lib/ingestion/promotion-control.js";

const [command, ...args] = process.argv.slice(2);
const usage =
  "Usage: dispatch-pages-candidate.js dispatch|recover --workflow-commit SHA --mode promote|rollback --intent-dir PRIVATE_PATH (requires GITHUB_TOKEN and activation flags)";
const options = {};
if (!["dispatch", "recover"].includes(command)) throw new Error(usage);
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index],
    value = args[index + 1],
    key = flag?.slice(2);
  if (
    !flag?.startsWith("--") ||
    !["workflow-commit", "mode", "intent-dir"].includes(key) ||
    Object.hasOwn(options, key) ||
    !value ||
    value.startsWith("--")
  )
    throw new Error(usage);
  options[key] = value;
}
if (
  !/^[a-f0-9]{40}$/.test(options["workflow-commit"] ?? "") ||
  !["promote", "rollback"].includes(options.mode) ||
  !options["intent-dir"]
)
  throw new Error(usage);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const githubToken = process.env.GITHUB_TOKEN ?? "";
try {
  if (!githubToken) throw new Error("GITHUB_TOKEN is required");
  const transport = createAuthoritativePromotionControlTransport(
    repositoryRoot,
    { token: githubToken }
  );
  const store = createRemotePromotionControlStore({
    repositoryRoot,
    destination: "production",
    transport,
    validateState: (bytes, destination) => {
      const state = parsePromotionControl(bytes);
      if (state.destination !== destination)
        throw new Error("Wrong control destination");
      return state.completionRoot;
    },
    validateTransition: validatePromotionAppend,
  });
  const result = await runPagesCandidateDispatch({
    command,
    repositoryRoot,
    store,
    githubToken,
    workflowCommit: options["workflow-commit"],
    mode: options.mode,
    intentDirectory: options["intent-dir"],
    controlledPublishing: process.env.ZIVV_CONTROLLED_PUBLISHING,
    manualPublisherJoined: process.env.ZIVV_MANUAL_PUBLISHER_JOINED,
  });
  console.log(JSON.stringify(result));
  if (!["dispatched", "matched"].includes(result.status)) process.exitCode = 1;
} catch {
  // HTTP/Git errors can echo credentials; emit no raw exception or environment.
  console.error(
    "Pages dispatch stopped. Verify activation flags, reviewed main ancestry, private intent storage, credentials, and exact control ownership. A saved intent requires recovery; never redispatch it."
  );
  process.exitCode = 1;
}
