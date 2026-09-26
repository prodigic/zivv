#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectUnverifiedWeeklyArtists,
  emptyLocalArtistVerificationLedger,
  namesForVerificationStatus,
  normalizeVerifiedArtistName,
  seedLocalArtistVerificationLedger,
  upsertLocalArtistVerification,
} from "../dist/lib/ingestion/local-artist-verification.js";

const args = process.argv.slice(2);
let root = fileURLToPath(new URL("../", import.meta.url));
let editionId;
let method = "manual-weekly-review";
let evidence;
const records = [];

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--root" && args[index + 1]) root = resolve(args[++index]);
  else if (arg === "--edition" && args[index + 1]) editionId = args[++index];
  else if (arg === "--method" && args[index + 1]) method = args[++index];
  else if (arg === "--evidence" && args[index + 1]) evidence = args[++index];
  else if (arg === "--record" && args[index + 1]) records.push(args[++index]);
  else {
    throw new Error(
      `Unknown or incomplete argument: ${arg}\nUsage: node scripts/check-weekly-local-acts.js [--root PATH] [--edition ID] [--record "Artist=local|non-local"] [--method NAME] [--evidence TEXT]`
    );
  }
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const dataDir = resolve(root, "data");
const ledger = readJson(
  resolve(dataDir, "ingestion/ledger.json"),
  "ingestion ledger"
);
const weekly = readJson(
  resolve(dataDir, "ingestion/weekly-editions.json"),
  "weekly edition ledger"
);
const editions = [...(weekly.editions ?? [])].sort(
  (a, b) => b.endEpochMs - a.endEpochMs
);
const edition = editionId
  ? editions.find((item) => item.editionId === editionId)
  : editions[0];
if (!edition) throw new Error(`Unknown weekly edition: ${editionId ?? "latest"}`);

const verificationPath = resolve(dataDir, "local-artist-verification.json");
let verification;
if (existsSync(verificationPath)) {
  verification = readJson(verificationPath, "local artist verification ledger");
} else {
  const local = readJson(resolve(dataDir, "local-artists.json"), "local artist list");
  const nonLocal = readJson(
    resolve(dataDir, "local-artist-exclude.json"),
    "local artist exclude list"
  );
  verification = seedLocalArtistVerificationLedger(
    local,
    nonLocal,
    edition.endEpochMs
  );
  writeJson(verificationPath, verification);
}

const candidates = collectUnverifiedWeeklyArtists(
  ledger.events,
  ledger.artists,
  edition.eventIds,
  verification
);
const candidateByName = new Map(
  candidates.map((candidate) => [candidate.normalizedName, candidate])
);

for (const record of records) {
  const separator = record.lastIndexOf("=");
  if (separator <= 0) throw new Error(`Invalid --record value: ${record}`);
  const name = record.slice(0, separator).trim();
  const status = record.slice(separator + 1).trim();
  if (status !== "local" && status !== "non-local")
    throw new Error(`Invalid status for ${name}: ${status}`);
  const normalizedName = normalizeVerifiedArtistName(name);
  const candidate = candidateByName.get(normalizedName);
  upsertLocalArtistVerification(verification, {
    name: candidate?.name ?? name,
    normalizedName,
    status,
    verifiedAtEpochMs: Date.now(),
    method,
    ...(evidence ? { evidence } : {}),
    lastSeenEditionId: edition.editionId,
  });
}

if (records.length > 0) {
  writeJson(verificationPath, verification);
  writeJson(
    resolve(dataDir, "local-artists.json"),
    namesForVerificationStatus(verification, "local")
  );
  writeJson(
    resolve(dataDir, "local-artist-exclude.json"),
    namesForVerificationStatus(verification, "non-local")
  );
}

console.log(
  JSON.stringify(
    {
      editionId: edition.editionId,
      weeklyEventCount: edition.eventIds.length,
      unverifiedCount: candidates.length,
      unverified: candidates,
      recordedCount: records.length,
      verificationPath,
    },
    null,
    2
  )
);
