#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLedger } from "../dist/lib/ingestion/ledger.js";
import {
  withStoreTransaction,
  ledgerDigest,
} from "../dist/lib/ingestion/sqlite-store.js";
import { projectLedgerLocation } from "../dist/lib/ingestion/store-location.js";
import {
  decryptLedgerSnapshot,
  loadBackupKey,
} from "../dist/lib/ingestion/encrypted-backup.js";
import { parseWeeklyEditionLedger } from "../dist/lib/ingestion/weekly.js";
import {
  buildReviewedWeeklyCandidate,
  readPublishableCandidate,
} from "../dist/lib/ingestion/reviewed-candidate.js";

const [command, ...args] = process.argv.slice(2);
const options = {};
if (!["build", "verify"].includes(command))
  throw new Error(
    "Usage: build-weekly-candidate.js build|verify --source-commit SHA --purpose preview|release --base /path/ ..."
  );
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]?.slice(2),
    value = args[index + 1];
  if (
    !args[index]?.startsWith("--") ||
    ![
      "root",
      "source-commit",
      "purpose",
      "base",
      "npm-cli",
      "edition-id",
      "output-dir",
      "directory",
      "candidate-id",
    ].includes(key) ||
    Object.hasOwn(options, key) ||
    !value ||
    value.startsWith("--")
  )
    throw new Error("Invalid candidate command arguments");
  options[key] = value;
}
for (const key of ["source-commit", "purpose", "base"])
  if (!options[key]) throw new Error("Missing --" + key);
if (
  !/^[a-f0-9]{40}$/.test(options["source-commit"]) ||
  !["preview", "release"].includes(options.purpose)
)
  throw new Error("Invalid source/purpose identity");
const root = resolve(
  options.root ?? join(dirname(fileURLToPath(import.meta.url)), "..")
);
const location = projectLedgerLocation(root);
if (location.backend !== "sqlite")
  throw new Error(
    "Candidate command requires the configured authoritative shared SQLite store"
  );
const recoveryKey = loadBackupKey(location.directory);
if (command === "build") {
  for (const key of ["npm-cli", "edition-id", "output-dir"])
    if (!options[key]) throw new Error("Missing --" + key);
  const captured = await withStoreTransaction(location.path, async () => {
    const ledger = await loadLedger(join(root, "data/ingestion/ledger.json"));
    const snapshot = readFileSync(
      join(root, "data/ingestion/backups/ledger.snapshot.enc")
    );
    if (
      ledgerDigest(decryptLedgerSnapshot(snapshot, recoveryKey)) !==
      ledgerDigest(ledger)
    )
      throw new Error(
        "Snapshot is stale; run ledger:backup and ledger:verify before building"
      );
    const weeklyEditionBytes = readFileSync(
      join(root, "data/ingestion/weekly-editions.json")
    );
    const weekly = parseWeeklyEditionLedger(
      JSON.parse(weeklyEditionBytes.toString("utf8"))
    );
    if (
      !weekly.editions.some(
        (edition) => edition.editionId === options["edition-id"]
      )
    )
      throw new Error("Requested frozen edition does not exist");
    return { ledger, snapshot, weeklyEditionBytes };
  });
  const result = await buildReviewedWeeklyCandidate({
    ...captured,
    repositoryRoot: root,
    privateDirectory: resolve(options["output-dir"]),
    sourceCommit: options["source-commit"],
    purpose: options.purpose,
    basePath: options.base,
    npmCli: resolve(options["npm-cli"]),
    editionId: options["edition-id"],
    recoveryKey,
    onProgress: (line) => process.stderr.write(line),
  });
  console.log(
    JSON.stringify({
      directory: result.directory,
      candidateId: result.candidate.candidateId,
      sourceCommit: result.candidate.sourceCommit,
      ledgerRevision: result.candidate.ledgerRevision,
      datasetVersion: result.candidate.datasetVersion,
      editionId: result.candidate.editionId,
      publicFiles: result.candidate.files.length,
    })
  );
} else {
  for (const key of ["directory", "candidate-id"])
    if (!options[key]) throw new Error("Missing --" + key);
  const result = await readPublishableCandidate({
    directory: resolve(options.directory),
    recoveryKey,
    expectedCandidateId: options["candidate-id"],
    expectedSourceCommit: options["source-commit"],
    purpose: options.purpose,
    basePath: options.base,
  });
  console.log(
    JSON.stringify({
      verified: true,
      candidateId: result.candidate.candidateId,
      sourceCommit: result.candidate.sourceCommit,
      ledgerRevision: result.candidate.ledgerRevision,
      datasetVersion: result.candidate.datasetVersion,
      publicFiles: result.publicFiles.size,
    })
  );
}
