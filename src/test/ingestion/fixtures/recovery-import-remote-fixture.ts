import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createBareTestPromotionControlTransport,
  createRemotePromotionControlStore,
} from "../../../lib/ingestion/promotion-control-git.js";
import {
  applyPromotionTransition,
  claimPromotion,
  parsePromotionControl,
  serializePromotionControl,
  validatePromotionAppend,
  promotionDigest,
  candidatePublicReleaseId,
  promotionAttemptId,
  PROMOTION_DESTINATIONS,
  type PromotionEvent,
} from "../../../lib/ingestion/promotion-control.js";
import {
  createPromotionControlFixture,
  PROMOTION_FIXTURE_CHECKS,
} from "./promotion-control-fixture.js";
import {
  canonicalJson,
  ledgerDigest,
} from "../../../lib/ingestion/sqlite-store.js";
import { encryptLedgerSnapshot } from "../../../lib/ingestion/encrypted-backup.js";
import { buildCandidateBundle } from "../../../lib/ingestion/candidate-bundle.js";
import {
  CANDIDATE_CONFIG_FILES,
  type CandidateConfiguration,
} from "../../../lib/ingestion/export-configuration.js";
import {
  createEmptyWeeklyEditionLedger,
  prepareWeeklyEdition,
  serializeWeeklyLedger,
} from "../../../lib/ingestion/weekly.js";
import { createPublicationPayload } from "../../../lib/ingestion/publication-payload.js";
import { writePublicationPayloadGit } from "../../../lib/ingestion/publication-git.js";
import type { ApplicationBuildReceipt } from "../../../lib/ingestion/source-build.js";
import type { IngestionLedger } from "../../../types/ingestion.js";
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, args: string[], input?: string) {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("GIT_")) delete env[name];
  return execFileSync("git", args, {
    cwd,
    env,
    input,
    windowsHide: true,
    stdio: "pipe",
  })
    .toString()
    .trim();
}

/** Real isolated Git/payload authority only; never provisions a worker or operator installation. */
export async function createAcknowledgedRecoveryRemoteFixture(input: {
  directory: string;
  ledger: IngestionLedger;
  recoveryKey: Buffer;
}) {
  mkdirSync(input.directory, { recursive: true });
  const root = join(input.directory, "repository"),
    bare = join(input.directory, "remote.git"),
    ledger = input.ledger,
    key = Buffer.from(input.recoveryKey);
  mkdirSync(root);
  git(root, ["init", "--quiet", "--object-format=sha1"]);
  git(root, [
    "remote",
    "add",
    "origin",
    "https://github.com/prodigic/zivv.git",
  ]);
  git(root, ["init", "--quiet", "--bare", bare]);
  const tree = git(root, ["mktree"], ""),
    sourceCommit = git(root, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      tree,
      "-m",
      "source",
    ]);
  git(root, ["push", "--quiet", bare, `${sourceCommit}:refs/heads/main`]);
  const weekly = prepareWeeklyEdition(createEmptyWeeklyEditionLedger(), [], {
    editionId: "2026-10-16",
    cutoff: "2026-10-16T19:00:00Z",
    datasetVersion: "recovery-fixture",
  });
  const configuration = Object.fromEntries(
    CANDIDATE_CONFIG_FILES.map((path) => [path, null])
  ) as CandidateConfiguration;
  configuration["venue-sources.json"] = Buffer.from('{"sources":[]}\n');
  configuration["ingestion/weekly-editions.json"] = Buffer.from(
    serializeWeeklyLedger(weekly.ledger)
  );
  const applicationFiles = new Map([
    [
      "index.html",
      Buffer.from('<script src="/zivv/assets/app.js"></script>\n'),
    ],
    ["404.html", Buffer.from('<script src="/zivv/assets/app.js"></script>\n')],
    ["assets/app.js", Buffer.from("console.log('fixture');\n")],
    ["manifest.json", Buffer.from('{"scope":"/zivv/","start_url":"/zivv/"}\n')],
    [".nojekyll", Buffer.alloc(0)],
  ]);
  const applicationBuildManifest = Buffer.from(
    '{"index.html":{"file":"assets/app.js","isEntry":true}}\n'
  );
  const receipt: ApplicationBuildReceipt = {
    schemaVersion: 1,
    purpose: "release",
    sourceRepository: "prodigic/zivv",
    sourceCommit,
    sourceTree: tree,
    sourceInventorySha256: "c".repeat(64),
    archiveSha256: "d".repeat(64),
    packageLockSha256: "e".repeat(64),
    etlInventorySha256: "f".repeat(64),
    basePath: "/zivv/",
    nodeVersion: process.version,
    npmVersion: "11.6.0",
    buildManifestSha256: hash(applicationBuildManifest),
    applicationFiles: [...applicationFiles]
      .map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: hash(bytes),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const built = await buildCandidateBundle({
    privateDirectory: join(input.directory, "bundles"),
    sourceCommit,
    basePath: "/zivv/",
    editionId: weekly.edition.editionId,
    ledger,
    snapshot: encryptLedgerSnapshot(ledger, key),
    recoveryKey: key,
    configuration,
    applicationFiles,
    applicationBuildManifest,
    applicationBuildReceipt: Buffer.from(canonicalJson(receipt) + "\n"),
  });
  const payload = await createPublicationPayload({
    directory: built.directory,
    recoveryKey: key,
    expectedCandidateId: built.candidate.candidateId,
    expectedSourceCommit: sourceCommit,
    purpose: "release",
    basePath: "/zivv/",
  });
  const nativePayload = writePublicationPayloadGit({
    repositoryRoot: root,
    files: payload.files,
    createdAt: "2026-10-16T12:00:00.000Z",
  });
  const transport = createBareTestPromotionControlTransport(root, bare),
    store = createRemotePromotionControlStore({
      repositoryRoot: root,
      destination: "production",
      transport,
      validateState(bytes) {
        return parsePromotionControl(bytes).completionRoot;
      },
      validateTransition: validatePromotionAppend,
    });
  let control = createPromotionControlFixture().state;
  let head: string | null = null;
  const persist = () => {
    const result = store.compareAndAppend({
      expectedHead: head,
      bytes: serializePromotionControl(control),
      createdAt: "2026-10-16T12:00:00.000Z",
    });
    if (result.status !== "appended")
      throw new Error("Fixture native append failed");
    head = result.attemptedHead;
  };
  persist();
  const bootstrapHead = head!;
  const request = {
    requestId: "acknowledged-baseline",
    payloadCommit: nativePayload.payloadCommit,
    candidateId: built.candidate.candidateId,
    sourceCommit,
    basePath: "/zivv/",
    purpose: "release" as const,
    publicInventorySha256: promotionDigest(built.candidate.files),
    expectedVerifiedReleaseId: control.lastVerified.releaseId,
  };
  const step = (event: PromotionEvent) => {
    control = applyPromotionTransition(control, event);
    persist();
  };
  control = claimPromotion(control, request);
  persist();
  const claimHead = head!;
  const operationId = control.active!.operationId;
  // The reducer derives the exact attempt ID from the operation and ordinal.
  const actualAttemptId = promotionAttemptId(
    operationId,
    "promote",
    1,
    sourceCommit,
    1
  );
  step({
    type: "dispatch-intent",
    operationId,
    mode: "promote",
    attemptId: actualAttemptId,
    attemptNumber: 1,
    workflowCommit: sourceCommit,
    expectedRunAttempt: 1,
  });
  const owner = {
    operationId,
    mode: "promote" as const,
    attemptId: actualAttemptId,
  };
  const admission = {
    workflowCommit: sourceCommit,
    runId: "101",
    runAttempt: 1,
  };
  step({ type: "admit-run", ...owner, admission });
  const deployment = { admission, artifactId: "201", deploymentId: "301" };
  step({ type: "deployed", ...owner, deployment });
  const body = {
    destination: "production" as const,
    liveUrl: PROMOTION_DESTINATIONS.production.liveUrl,
    releaseId: candidatePublicReleaseId("production", request),
    inventorySha256: request.publicInventorySha256,
    deployment,
    verifiedAt: "2026-10-16T12:10:00.000Z",
    checks: PROMOTION_FIXTURE_CHECKS,
  };
  const verification = { ...body, receiptId: promotionDigest(body) };
  step({ type: "verified", ...owner, verification, replayProof: null });
  step({
    type: "acknowledged",
    operationId,
    verificationReceiptId: verification.receiptId,
    acknowledgementId: "9".repeat(64),
    replayProof: null,
  });
  const artifactRef = `refs/heads/zivv-candidate-artifacts/${nativePayload.payloadCommit}`;
  transport.append(artifactRef, nativePayload.payloadCommit, null);
  return {
    repositoryRoot: root,
    bareDirectory: bare,
    transport,
    store,
    sourceCommit,
    payloadCommit: nativePayload.payloadCommit,
    artifactRef,
    bootstrapHead,
    claimHead,
    operationId,
    candidateId: built.candidate.candidateId,
    ledgerRevision: ledgerDigest(ledger),
    refs: () => git(bare, ["show-ref"]),
    setControl: (value: string) => git(bare, ["update-ref", store.ref, value]),
    main: (value: string) =>
      git(bare, ["update-ref", "refs/heads/main", value]),
    git: (args: string[], input?: string) => git(root, args, input),
    step,
  };
}
