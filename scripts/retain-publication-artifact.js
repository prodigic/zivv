#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../dist/lib/ingestion/sqlite-store.js";
import {
  writeDurableFile,
  secureOperatorDirectory,
} from "../dist/lib/ingestion/encrypted-backup.js";
import { resolvePrivateCandidateDirectory } from "../dist/lib/ingestion/private-artifacts.js";
import { readPublicationPayloadGit } from "../dist/lib/ingestion/publication-git.js";
import { verifyPublicationPayload } from "../dist/lib/ingestion/publication-payload.js";
import { retainPublicationArtifact } from "../dist/lib/ingestion/publication-artifact.js";
import {
  createAuthoritativePromotionControlTransport,
  createBareTestPromotionControlTransport,
} from "../dist/lib/ingestion/promotion-control-git.js";

const [command, ...args] = process.argv.slice(2);
if (!["retain", "verify"].includes(command))
  throw new Error(
    "Usage: retain-publication-artifact.js retain|verify --transport github|bare-test --payload-commit SHA --candidate-id HASH --source-commit SHA --purpose release|preview --base /path/ ..."
  );
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index],
    value = args[index + 1],
    key = flag?.slice(2);
  if (
    !flag?.startsWith("--") ||
    ![
      "root",
      "transport",
      "bare-path",
      "payload-commit",
      "candidate-id",
      "source-commit",
      "purpose",
      "base",
      "intent-dir",
    ].includes(key) ||
    Object.hasOwn(options, key) ||
    !value ||
    value.startsWith("--")
  )
    throw new Error("Invalid artifact retention arguments");
  options[key] = value;
}
for (const name of [
  "transport",
  "payload-commit",
  "candidate-id",
  "source-commit",
  "purpose",
  "base",
])
  if (!options[name]) throw new Error("Missing --" + name);
if (
  !["github", "bare-test"].includes(options.transport) ||
  (options.transport === "bare-test") !== Boolean(options["bare-path"]) ||
  (command === "retain") !== Boolean(options["intent-dir"]) ||
  !/^[a-f0-9]{40}$/.test(options["payload-commit"]) ||
  !/^[a-f0-9]{40}$/.test(options["source-commit"]) ||
  !/^[a-f0-9]{64}$/.test(options["candidate-id"]) ||
  !["preview", "release"].includes(options.purpose) ||
  options.base !== (options.purpose === "release" ? "/zivv/" : "/zivv-test/")
)
  throw new Error(
    "Invalid artifact transport or trusted identity/purpose/base"
  );
const repositoryRoot = resolve(
  options.root ?? join(dirname(fileURLToPath(import.meta.url)), "..")
);
const expectation = {
  expectedCandidateId: options["candidate-id"],
  expectedSourceCommit: options["source-commit"],
  purpose: options.purpose,
  basePath: options.base,
};
const payloadCommit = options["payload-commit"];
// Validate before creating an intent or touching a remote.
verifyPublicationPayload(
  readPublicationPayloadGit({ repositoryRoot, payloadCommit }).files,
  expectation
);
const transport =
  options.transport === "github"
    ? createAuthoritativePromotionControlTransport(repositoryRoot)
    : createBareTestPromotionControlTransport(
        repositoryRoot,
        resolve(options["bare-path"])
      );
let result;
if (command === "retain") {
  const intent = {
    schemaVersion: 1,
    type: "retain-publication-artifact",
    repository: "prodigic/zivv",
    payloadCommit,
    ...expectation,
  };
  const bytes = Buffer.from(canonicalJson(intent) + "\n");
  const intentId = createHash("sha256").update(bytes).digest("hex");
  const directory = resolvePrivateCandidateDirectory(options["intent-dir"]);
  secureOperatorDirectory(directory);
  const path = join(directory, intentId + ".json");
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("Saved artifact intent must be an unlinked regular file");
  }
  if (existsSync(path) && !readFileSync(path).equals(bytes))
    throw new Error("Saved artifact intent changed");
  if (!existsSync(path)) writeDurableFile(path, bytes);
  result = {
    ...retainPublicationArtifact({
      repositoryRoot,
      payloadCommit,
      transport,
      ...expectation,
    }),
    intentId,
  };
} else {
  const ref = "refs/heads/zivv-candidate-artifacts/" + payloadCommit;
  if (transport.readHead(ref) !== payloadCommit)
    throw new Error("Exact retained artifact reference missing or changed");
  transport.fetchCommit(payloadCommit);
  const checked = verifyPublicationPayload(
    readPublicationPayloadGit({ repositoryRoot, payloadCommit }).files,
    expectation
  );
  result = {
    status: "retained",
    ref,
    payloadCommit,
    observedHead: payloadCommit,
    candidateId: checked.receipt.candidate.candidateId,
    receiptId: checked.receipt.receiptId,
  };
}
console.log(JSON.stringify(result));
if (result.status !== "retained") process.exitCode = 1;
