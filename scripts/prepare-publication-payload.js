#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBackupKey } from "../dist/lib/ingestion/encrypted-backup.js";
import { resolvePrivateCandidateDirectory } from "../dist/lib/ingestion/private-artifacts.js";
import {
  createPublicationPayload,
  verifyPublicationPayload,
} from "../dist/lib/ingestion/publication-payload.js";
import {
  writePublicationPayloadGit,
  readPublicationPayloadGit,
} from "../dist/lib/ingestion/publication-git.js";

const [command, ...args] = process.argv.slice(2);
if (!["prepare", "verify"].includes(command))
  throw new Error(
    "Usage: prepare-publication-payload.js prepare|verify --candidate-id HASH --source-commit SHA --purpose preview|release --base /path/ ..."
  );
const allowed =
  command === "prepare"
    ? [
        "root",
        "candidate-id",
        "source-commit",
        "purpose",
        "base",
        "directory",
        "operator-dir",
        "created-at",
      ]
    : [
        "root",
        "candidate-id",
        "source-commit",
        "purpose",
        "base",
        "payload-commit",
      ];
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index],
    value = args[index + 1],
    key = flag?.slice(2);
  if (
    !flag?.startsWith("--") ||
    !allowed.includes(key) ||
    Object.hasOwn(options, key) ||
    !value ||
    value.startsWith("--")
  )
    throw new Error("Invalid publication payload arguments");
  options[key] = value;
}
for (const name of allowed.filter((name) => name !== "root"))
  if (!options[name]) throw new Error("Missing --" + name);
const expectation = {
  expectedCandidateId: options["candidate-id"],
  expectedSourceCommit: options["source-commit"],
  purpose: options.purpose,
  basePath: options.base,
};
if (
  !/^[a-f0-9]{64}$/.test(expectation.expectedCandidateId) ||
  !/^[a-f0-9]{40}$/.test(expectation.expectedSourceCommit) ||
  !["preview", "release"].includes(expectation.purpose) ||
  expectation.basePath !==
    (expectation.purpose === "release" ? "/zivv/" : "/zivv-test/")
)
  throw new Error("Invalid trusted publication identity/purpose/base");
const repositoryRoot = resolve(
  options.root ?? join(dirname(fileURLToPath(import.meta.url)), "..")
);
let stored;
if (command === "prepare") {
  const payload = await createPublicationPayload({
    ...expectation,
    directory: resolve(options.directory),
    recoveryKey: loadBackupKey(
      resolvePrivateCandidateDirectory(options["operator-dir"]),
      false
    ),
  });
  stored = writePublicationPayloadGit({
    repositoryRoot,
    files: payload.files,
    createdAt: options["created-at"],
  });
} else {
  stored = { payloadCommit: options["payload-commit"] };
}
const actual = readPublicationPayloadGit({
  repositoryRoot,
  payloadCommit: stored.payloadCommit,
});
const checked = verifyPublicationPayload(actual.files, expectation);
console.log(
  JSON.stringify({
    verified: true,
    payloadCommit: actual.payloadCommit,
    payloadTree: actual.tree,
    candidateId: checked.receipt.candidate.candidateId,
    sourceCommit: checked.receipt.candidate.sourceCommit,
    receiptId: checked.receipt.receiptId,
    publicFiles: checked.publicFiles.size,
    ledgerRevision: checked.receipt.candidate.ledgerRevision,
  })
);
