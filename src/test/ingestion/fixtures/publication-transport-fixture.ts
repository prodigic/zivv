import { createHash } from "node:crypto";
import { canonicalJson } from "../../../lib/ingestion/sqlite-store.js";
import { CANDIDATE_CONFIG_FILES } from "../../../lib/ingestion/export-configuration.js";
import {
  verifyPublicationPayload,
  type PublicationExpectation,
} from "../../../lib/ingestion/publication-payload.js";

const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
/** Synthetic, keyless transport fixture; authenticated private preparation is tested separately. */
export function publicationTransportFixture(sourceCommit = "a".repeat(40)) {
  const basePath = "/zivv/";
  const publicFiles = new Map([
    [
      "index.html",
      Buffer.from('<script src="/zivv/assets/app.js"></script>\n'),
    ],
    ["assets/app.js", Buffer.from("console.log('transport fixture');\n")],
    [
      "data/manifest.json",
      Buffer.from('{"datasetVersion":"transport-fixture"}\n'),
    ],
  ]);
  const inventory = (files: ReadonlyMap<string, Buffer>) =>
    [...files]
      .map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: hash(bytes),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = Buffer.from(
    '{"index.html":{"file":"assets/app.js","isEntry":true}}\n'
  );
  const build = Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      purpose: "release",
      sourceRepository: "prodigic/zivv",
      sourceCommit,
      sourceTree: "b".repeat(40),
      sourceInventorySha256: "c".repeat(64),
      archiveSha256: "d".repeat(64),
      packageLockSha256: "e".repeat(64),
      basePath,
      nodeVersion: "v24.19.0",
      npmVersion: "11.6.0",
      buildManifestSha256: hash(manifest),
      etlInventorySha256: "f".repeat(64),
      applicationFiles: inventory(
        new Map([...publicFiles].filter(([path]) => !path.startsWith("data/")))
      ),
    }) + "\n"
  );
  const snapshot = Buffer.from(
    "synthetic ciphertext; no production key or ledger"
  );
  const configuration = CANDIDATE_CONFIG_FILES.map((path) => ({
    path,
    sha256: null,
  }));
  const candidateIdentity = {
    schemaVersion: 1,
    sourceCommit,
    basePath,
    ledgerRevision: "1".repeat(64),
    snapshotSha256: hash(snapshot),
    configSha256: hash(canonicalJson(configuration)),
    configuration,
    editionId: "2026-10-16",
    cutoffEpochMs: Date.parse("2026-10-16T07:00:00Z"),
    membershipSha256: "2".repeat(64),
    datasetVersion: "transport-fixture",
    manifestSha256: hash(publicFiles.get("data/manifest.json")!),
    applicationBuildSha256: hash(manifest),
    applicationProvenanceSha256: hash(build),
    files: inventory(publicFiles),
  };
  const candidate = {
    ...candidateIdentity,
    candidateId: hash(canonicalJson(candidateIdentity)),
  };
  const files = new Map(
    [...publicFiles].map(([path, bytes]) => ["site/" + path, bytes])
  );
  files.set("recovery/ledger.snapshot.enc", snapshot);
  const receiptIdentity = {
    schemaVersion: 1,
    candidate,
    purpose: "release",
    applicationBuildManifest: manifest.toString("base64"),
    applicationBuildReceipt: build.toString("base64"),
    files: inventory(files),
  };
  const receipt = {
    ...receiptIdentity,
    receiptId: hash(canonicalJson(receiptIdentity)),
  };
  files.set("receipt.json", Buffer.from(canonicalJson(receipt) + "\n"));
  const expectation: PublicationExpectation = {
    expectedCandidateId: candidate.candidateId,
    expectedSourceCommit: sourceCommit,
    basePath,
    purpose: "release",
  };
  return { payload: verifyPublicationPayload(files, expectation), expectation };
}
