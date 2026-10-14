#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  reviewSteveImport,
  loadReviewedSteveImport,
} from "../dist/lib/ingestion/imports.js";
import { preflightSteveContent } from "../dist/lib/ingestion/steve-preflight.js";
import {
  importConfigurationDigest,
  parseSteveImportReview,
  parseImportObservation,
} from "../dist/lib/ingestion/steve-import-review.js";
import { loadLedger } from "../dist/lib/ingestion/ledger.js";
import {
  canonicalJson,
  ledgerDigest,
} from "../dist/lib/ingestion/sqlite-store.js";
import { projectLedgerLocation } from "../dist/lib/ingestion/store-location.js";
import { resolvePrivateCandidateDirectory } from "../dist/lib/ingestion/private-artifacts.js";
import {
  secureOperatorDirectory,
  writeDurableFile,
} from "../dist/lib/ingestion/encrypted-backup.js";
import { WeeklyRunJournal } from "../dist/lib/ingestion/weekly-run-journal.js";

const [command, ...args] = process.argv.slice(2);
if (!["review", "load"].includes(command))
  throw new Error("Expected review|load");
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]?.slice(2),
    value = args[index + 1];
  if (
    !args[index]?.startsWith("--") ||
    ![
      "root",
      "file",
      "output-dir",
      "edition-id",
      "delivery-id",
      "observed-at",
      "directory",
      "review-id",
    ].includes(key) ||
    Object.hasOwn(options, key) ||
    !value ||
    value.startsWith("--")
  )
    throw new Error("Invalid reviewed-import arguments");
  options[key] = value;
}
const root = resolve(
  options.root ?? fileURLToPath(new URL("../", import.meta.url))
);
const location = projectLedgerLocation(root);
if (location.backend !== "sqlite" || !existsSync(location.path))
  throw new Error(
    "Reviewed weekly commands require the existing shared SQLite store"
  );
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => Buffer.from(canonicalJson(value) + "\n");
function readRegular(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("Review artifact must be an unlinked regular file");
  return readFileSync(path);
}
function preserve(path, bytes) {
  if (existsSync(path)) {
    if (!readRegular(path).equals(bytes))
      throw new Error("Review artifact differs; refusing overwrite");
  } else writeDurableFile(path, bytes);
}
if (command === "review") {
  for (const key of [
    "file",
    "output-dir",
    "edition-id",
    "delivery-id",
    "observed-at",
  ])
    if (!options[key]) throw new Error("Missing --" + key);
  const observedAtEpochMs = parseImportObservation(options["observed-at"]);
  if (
    !Number.isSafeInteger(observedAtEpochMs) ||
    observedAtEpochMs < 0 ||
    observedAtEpochMs > Date.now()
  )
    throw new Error("Invalid original observation time");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(options["edition-id"]) ||
    !options["delivery-id"].trim() ||
    options["delivery-id"].length > 256
  )
    throw new Error("Invalid source edition/delivery identity");
  const raw = readRegular(resolve(options.file));
  const content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const beforeConfiguration = importConfigurationDigest(root);
  const ledger = await loadLedger(join(root, "data/ingestion/ledger.json"));
  const aliases = existsSync(join(root, "data/venue-aliases.json"))
    ? JSON.parse(readRegular(join(root, "data/venue-aliases.json")))
    : {};
  const corrections = existsSync(join(root, "data/line-corrections.json"))
    ? JSON.parse(readRegular(join(root, "data/line-corrections.json")))
    : [];
  const preflight = preflightSteveContent(
    content,
    ledger,
    aliases,
    corrections
  );
  if (preflight.errors.length || preflight.preparedContent === null)
    throw new Error(
      "PREFLIGHT_REVIEW_REQUIRED; use standalone private preflight for diagnostics"
    );
  if (
    new Date(Date.parse(preflight.issueDate + " 12:00:00 GMT"))
      .toISOString()
      .slice(0, 10) !== options["edition-id"]
  )
    throw new Error("Source issue does not match requested edition");
  preflight.rawSha256 = digest(raw);
  const reviewed = await reviewSteveImport(
    root,
    preflight.preparedContent,
    observedAtEpochMs
  );
  if (
    reviewed.receipt.ledgerRevision !== ledgerDigest(ledger) ||
    reviewed.receipt.configurationSha256 !== beforeConfiguration
  )
    throw new Error(
      "Preflight context changed; review again against current catalog/rules"
    );
  const files = new Map([
    ["raw.txt", raw],
    ["prepared.txt", Buffer.from(preflight.preparedContent)],
    ["preflight.json", encode(preflight)],
    ["report.json", encode(reviewed.report)],
    ["receipt.json", encode(reviewed.receipt)],
  ]);
  const inventory = [...files].map(([path, bytes]) => ({
    path,
    size: bytes.length,
    sha256: digest(bytes),
  }));
  const identity = {
    schemaVersion: 1,
    editionId: options["edition-id"],
    deliveryId: options["delivery-id"],
    files: inventory,
  };
  const reviewId = digest(encode(identity));
  const parent = resolvePrivateCandidateDirectory(options["output-dir"]);
  secureOperatorDirectory(parent);
  const directory = resolvePrivateCandidateDirectory(join(parent, reviewId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  secureOperatorDirectory(directory);
  for (const [path, bytes] of files) preserve(join(directory, path), bytes);
  preserve(join(directory, "complete.json"), encode({ ...identity, reviewId }));
  console.log(
    JSON.stringify({
      reviewId,
      directory,
      importRunId: reviewed.receipt.importRunId,
      ledgerRevision: reviewed.receipt.ledgerRevision,
      counts: preflight.counts,
    })
  );
} else {
  for (const key of ["directory", "review-id"])
    if (!options[key]) throw new Error("Missing --" + key);
  if (!/^[a-f0-9]{64}$/.test(options["review-id"]))
    throw new Error("Invalid trusted review identity");
  const directory = resolvePrivateCandidateDirectory(options.directory);
  const { reviewId, ...identity } = JSON.parse(
    readRegular(join(directory, "complete.json"))
  );
  if (
    reviewId !== options["review-id"] ||
    digest(encode(identity)) !== reviewId ||
    identity.schemaVersion !== 1
  )
    throw new Error("Review completion/identity changed");
  const expected = [
    "raw.txt",
    "prepared.txt",
    "preflight.json",
    "report.json",
    "receipt.json",
  ];
  if (
    !Array.isArray(identity.files) ||
    identity.files.length !== expected.length
  )
    throw new Error("Review inventory changed");
  const files = new Map();
  for (const [index, descriptor] of identity.files.entries()) {
    if (descriptor.path !== expected[index])
      throw new Error("Review inventory path changed");
    const bytes = readRegular(join(directory, descriptor.path));
    if (descriptor.size !== bytes.length || descriptor.sha256 !== digest(bytes))
      throw new Error("Review artifact changed");
    files.set(descriptor.path, bytes);
  }
  const receipt = parseSteveImportReview(JSON.parse(files.get("receipt.json")));
  const prepared = new TextDecoder("utf-8", { fatal: true }).decode(
    files.get("prepared.txt")
  );
  // Destination ownership spans reviewed loading. The full runner will retain
  // this same scope through freeze, candidate promotion and acknowledgement.
  const journal = new WeeklyRunJournal(location.directory);
  let lease;
  try {
    lease = journal.acquire("prodigic/zivv/production", 3600000);
    const result = await journal.guardOperation(lease, () =>
      loadReviewedSteveImport(root, prepared, receipt, () =>
        journal.checkOwnership(lease)
      )
    );
    console.log(
      JSON.stringify({
        reviewId,
        replay: result.report.replay,
        importRunId: result.report.runId,
        ledgerRevision: ledgerDigest(result.ledger),
        accepted: result.report.acceptedEventIds.length,
      })
    );
  } finally {
    try {
      if (lease) journal.release(lease);
    } finally {
      journal.close();
    }
  }
}
