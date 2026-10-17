import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAcknowledgedRecoveryRemoteFixture } from "./recovery-import-remote-fixture.js";
import {
  bootstrapLedger,
  reconcileCandidates,
} from "../../../lib/ingestion/ledger.js";
import {
  canonicalJson,
  ledgerDigest,
  writeSqliteLedger,
} from "../../../lib/ingestion/sqlite-store.js";
import {
  preflightSteveContent,
  sha256,
} from "../../../lib/ingestion/steve-preflight.js";
import { prepareSteveBatch } from "../../../lib/ingestion/imports.js";
import {
  importConfigurationDigest,
  createSteveImportReview,
  importReportDigest,
  CURRENT_STEVE_IMPORTER,
} from "../../../lib/ingestion/steve-import-review.js";
import {
  compiledEtlDigest,
  type ApplicationBuildReceipt,
} from "../../../lib/ingestion/source-build.js";
import { captureNpmExecutionTool } from "../../../lib/ingestion/execution-tool-identity.js";
import {
  createEmptyWeeklyEditionLedger,
  prepareWeeklyEdition,
  serializeWeeklyEditionLedger,
} from "../../../lib/ingestion/weekly.js";
import {
  captureExportConfiguration,
  configurationDigest,
} from "../../../lib/ingestion/export-configuration.js";
import {
  encryptLedgerSnapshot,
  installRecoveredBackupKey,
} from "../../../lib/ingestion/encrypted-backup.js";
import { buildCandidateBundle } from "../../../lib/ingestion/candidate-bundle.js";
import { WeeklyRunJournal } from "../../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
  type StageEvidence,
  type WeeklyRunStage,
  type WeeklyRunState,
} from "../../../lib/ingestion/weekly-run-state.js";
import { captureOperatorRecoveryCheckpoint } from "../../../lib/ingestion/operator-recovery.js";
import {
  promotionDigest,
  applyPromotionTransition,
  type PromotionEvent,
} from "../../../lib/ingestion/promotion-control.js";
import { createPublicationPayload } from "../../../lib/ingestion/publication-payload.js";
import { writePublicationPayloadGit } from "../../../lib/ingestion/publication-git.js";

function write(path: string, bytes: string | Buffer) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
}
/** Real sealed candidate, pure import and actual SQLite transitions; synthetic app build receipt only. */
export async function createRecoveryCandidateRemoteFixture(directory: string) {
  const key = Buffer.alloc(32, 47),
    baseline = bootstrapLedger({ events: [], artists: [], venues: [] }, 1000);
  const authority = await createAcknowledgedRecoveryRemoteFixture({
    directory: join(directory, "authority"),
    ledger: baseline,
    recoveryKey: key,
  });
  const blob = authority.git(
    ["hash-object", "-w", "--stdin"],
    "name: Isolated fixture\non: workflow_dispatch\njobs: {}\n"
  );
  const workflows = authority.git(
      ["mktree"],
      `100644 blob ${blob}\tpublish-candidate.yml\n`
    ),
    github = authority.git(["mktree"], `040000 tree ${workflows}\tworkflows\n`),
    sourceTree = authority.git(["mktree"], `040000 tree ${github}\t.github\n`);
  const workflowCommit = authority.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit-tree",
    sourceTree,
    "-p",
    authority.sourceCommit,
    "-m",
    "reviewed fixture workflow",
  ]);
  authority.git([
    "push",
    "--quiet",
    authority.bareDirectory,
    `${workflowCommit}:refs/heads/main`,
  ]);
  const checkout = join(directory, "original-checkout"),
    operator = join(directory, "original-operator"),
    npmCli = join(directory, "original-tool/bin/npm-cli.js");
  write(npmCli, "throw Error('fixture tool must not execute');\n");
  write(
    join(directory, "original-tool/package.json"),
    '{"name":"npm","version":"11.6.0"}\n'
  );
  const identity = Buffer.from(
    canonicalJson(captureNpmExecutionTool(npmCli)) + "\n"
  );
  write(
    join(checkout, "data/ingestion/store.json"),
    '{"schemaVersion":1,"backend":"sqlite","namespace":"zivv"}\n'
  );
  write(join(checkout, "package.json"), "{}\n");
  write(join(checkout, "package-lock.json"), "fixture lock\n");
  write(join(checkout, "data/venue-sources.json"), '{"sources":[]}\n');
  for (const path of [
    "lib/ingestion/weekly-import-runner.js",
    "types/fixture.js",
    "utils/fixture.js",
  ])
    write(join(checkout, "dist", path), "// retained fixture\n");
  const observed = Date.parse("2026-10-16T20:00:00Z"),
    cutoff = Date.parse("2026-10-16T21:00:00Z");
  const raw = Buffer.from(
    "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\noct 23 fri Fixture Band at Test Room, Oakland a/a $20 8pm\nPlease feel free to forward The List on to your friends.\n"
  );
  const preflight = preflightSteveContent(
    raw.toString("utf8"),
    baseline,
    {},
    []
  );
  preflight.rawSha256 = sha256(raw);
  if (
    preflight.errors.length ||
    preflight.preparedContent === null ||
    preflight.preparedSha256 === null
  )
    throw Error("Invalid synthetic fixture source");
  const imported = reconcileCandidates(
    baseline,
    prepareSteveBatch(
      baseline,
      preflight.preparedContent,
      observed,
      {},
      { requireCompleteNormalization: true }
    )
  );
  if (imported.report.review.length || imported.report.conflicts.length)
    throw Error("Unclean fixture import");
  const ledger = structuredClone(imported.ledger),
    importRun = ledger.runs.find((run) => run.runId === imported.report.runId)!;
  importRun.status = "committed";
  importRun.committedAtEpochMs = Date.now();
  await writeSqliteLedger(join(operator, "ledger.sqlite"), ledger, true);
  installRecoveredBackupKey(operator, key);
  const configurationSha256 = importConfigurationDigest(checkout),
    rulesSha256 = sha256(
      canonicalJson({
        runner: "weekly-import-v1",
        runtimeSha256: compiledEtlDigest(checkout, "worker"),
        packageLockSha256: sha256(Buffer.from("fixture lock\n")),
        configurationSha256,
        node: process.version,
        icu: process.versions.icu ?? "",
      })
    );
  const context = {
    schemaVersion: 1,
    configurationSha256,
    ledgerRevision: ledgerDigest(baseline),
    ledger: baseline,
    preflight,
  };
  const receipt = createSteveImportReview({
    schemaVersion: 1,
    importer: CURRENT_STEVE_IMPORTER,
    inputSha256: preflight.preparedSha256,
    configurationSha256,
    ledgerRevision: ledgerDigest(baseline),
    reportSha256: importReportDigest(imported.report),
    importRunId: imported.report.runId,
    observedAtEpochMs: observed,
  });
  const weekly = prepareWeeklyEdition(
    createEmptyWeeklyEditionLedger(),
    ledger.events.map((event) => ({ ...event })),
    {
      editionId: "2026-10-16",
      cutoffEpochMs: cutoff,
      datasetVersion: `ingestion-v${ledger.version}`,
    }
  );
  const weeklyBytes = Buffer.from(serializeWeeklyEditionLedger(weekly.ledger));
  write(join(checkout, "data/ingestion/weekly-editions.json"), weeklyBytes);
  const configuration = captureExportConfiguration(checkout),
    build = {
      sourceCommit: workflowCommit,
      purpose: "release" as const,
      basePath: "/zivv/",
      npmCli,
    };
  const applicationFiles = new Map([
    [
      "index.html",
      Buffer.from('<script src="/zivv/assets/app.js"></script>\n'),
    ],
    ["404.html", Buffer.from('<script src="/zivv/assets/app.js"></script>\n')],
    ["assets/app.js", Buffer.from("console.log('fixture app');\n")],
    ["manifest.json", Buffer.from('{"scope":"/zivv/","start_url":"/zivv/"}\n')],
    [".nojekyll", Buffer.alloc(0)],
  ]);
  const applicationBuildManifest = Buffer.from(
    '{"index.html":{"file":"assets/app.js","isEntry":true}}\n'
  );
  const application: ApplicationBuildReceipt = {
    schemaVersion: 2,
    purpose: "release",
    sourceRepository: "prodigic/zivv",
    sourceCommit: workflowCommit,
    sourceTree,
    sourceInventorySha256: "c".repeat(64),
    archiveSha256: "d".repeat(64),
    packageLockSha256: "e".repeat(64),
    etlInventorySha256: "f".repeat(64),
    basePath: "/zivv/",
    nodeVersion: process.version,
    npmVersion: "11.6.0",
    buildManifestSha256: sha256(applicationBuildManifest),
    executionToolSha256: sha256(identity),
    applicationFiles: [...applicationFiles]
      .map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: sha256(bytes),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const workDirectory = join(
      operator,
      "weekly-candidates/candidate-work-retained"
    ),
    snapshot = encryptLedgerSnapshot(ledger, key);
  const bundle = await buildCandidateBundle({
    privateDirectory: workDirectory,
    sourceCommit: workflowCommit,
    basePath: "/zivv/",
    editionId: weekly.edition.editionId,
    ledger,
    snapshot,
    recoveryKey: key,
    configuration,
    applicationFiles,
    applicationBuildManifest,
    applicationBuildReceipt: Buffer.from(canonicalJson(application) + "\n"),
    executionToolIdentity: identity,
  });
  write(
    join(
      checkout,
      "data/ingestion/reports",
      sha256(receipt.importRunId) + ".json"
    ),
    canonicalJson(imported.report) + "\n"
  );
  const journal = new WeeklyRunJournal(operator),
    lease = journal.acquire("prodigic/zivv/production");
  let state = createWeeklyRunState({
    editionId: "2026-10-16",
    deliveryId: "validated-candidate-recovery",
    rawSha256: sha256(raw),
    rulesSha256,
    importObservedAtEpochMs: observed,
  });
  let validationPendingState: WeeklyRunState | undefined;
  try {
    state = journal.create(state, lease, raw);
    const complete = (
      stage: WeeklyRunStage,
      bytes: Buffer,
      evidence: StageEvidence
    ) => {
      state = journal.save(
        transitionWeeklyRun(
          state,
          state.revision,
          stage,
          { status: "running" },
          Date.now()
        ),
        state.revision,
        lease
      );
      if (stage === "validate") validationPendingState = structuredClone(state);
      journal.writeArtifact(state.runId, stage, bytes, lease);
      state = journal.save(
        transitionWeeklyRun(
          state,
          state.revision,
          stage,
          { status: "succeeded", evidence },
          Date.now()
        ),
        state.revision,
        lease
      );
    };
    complete("acquire", raw, {
      rawSha256: sha256(raw),
      deliveryId: state.source.deliveryId,
    });
    complete("prepare", Buffer.from(canonicalJson(context) + "\n"), {
      preparedSha256: preflight.preparedSha256,
      rulesSha256,
    });
    complete(
      "reconcile",
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          receipt,
          report: imported.report,
          preflightContext: context,
        }) + "\n"
      ),
      {
        ledgerRevision: receipt.ledgerRevision,
        reportSha256: receipt.reportSha256,
        preparedSha256: preflight.preparedSha256,
      }
    );
    const evidence = {
      ledgerRevision: ledgerDigest(ledger),
      importRunId: receipt.importRunId,
      reviewedLedgerRevision: receipt.ledgerRevision,
      reportSha256: receipt.reportSha256,
      preparedSha256: preflight.preparedSha256,
    };
    complete(
      "load",
      Buffer.from(canonicalJson({ schemaVersion: 1, ledger, evidence }) + "\n"),
      evidence
    );
    const frozen = {
      editionId: weekly.edition.editionId,
      cutoffEpochMs: cutoff,
      membershipSha256: sha256(canonicalJson(weekly.edition.eventIds)),
      preCutoffPendingCount: 0,
      mode: "initial",
      ledgerRevision: ledgerDigest(ledger),
    };
    complete(
      "freeze",
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          mode: "initial",
          before: null,
          after: weeklyBytes.toString("base64"),
          ledger,
          ledgerRevision: ledgerDigest(ledger),
          evidence: frozen,
        }) + "\n"
      ),
      frozen
    );
    complete(
      "enrich",
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          build,
          configuration: Object.fromEntries(
            Object.entries(configuration).map(([path, bytes]) => [
              path,
              bytes?.toString("base64") ?? null,
            ])
          ),
          configSha256: configurationDigest(configuration),
        }) + "\n"
      ),
      {
        configSha256: configurationDigest(configuration),
        buildSha256: sha256(canonicalJson(build)),
      }
    );
    const candidate = bundle.candidate;
    complete(
      "export",
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          workDirectory,
          snapshot: snapshot.toString("base64"),
        }) + "\n"
      ),
      {
        ledgerRevision: candidate.ledgerRevision,
        snapshotRevision: candidate.ledgerRevision,
        manifestSha256: candidate.manifestSha256,
        datasetVersion: candidate.datasetVersion,
        candidateId: candidate.candidateId,
        editionId: candidate.editionId,
        cutoffEpochMs: candidate.cutoffEpochMs,
        membershipSha256: candidate.membershipSha256,
        configSha256: candidate.configSha256,
      }
    );
    complete(
      "validate",
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          candidateId: candidate.candidateId,
          manifestSha256: candidate.manifestSha256,
        }) + "\n"
      ),
      {
        candidateId: candidate.candidateId,
        manifestSha256: candidate.manifestSha256,
      }
    );
  } finally {
    journal.release(lease);
    journal.close();
  }
  const previous = process.env.ZIVV_LEDGER_HOME;
  process.env.ZIVV_LEDGER_HOME = operator;
  let checkpoint;
  try {
    checkpoint = await captureOperatorRecoveryCheckpoint(checkout, { npmCli });
  } finally {
    if (previous === undefined) delete process.env.ZIVV_LEDGER_HOME;
    else process.env.ZIVV_LEDGER_HOME = previous;
  }
  const payload = await createPublicationPayload({
    directory: bundle.directory,
    recoveryKey: key,
    expectedCandidateId: bundle.candidate.candidateId,
    expectedSourceCommit: workflowCommit,
    purpose: "release",
    basePath: "/zivv/",
  });
  const retainedPayload = writePublicationPayloadGit({
    repositoryRoot: authority.repositoryRoot,
    files: payload.files,
    createdAt: "2026-10-16T22:00:00.000Z",
  });
  const step = (event: PromotionEvent) => {
    const current = authority.store.read();
    const next = applyPromotionTransition(
      JSON.parse(current.bytes!.toString("utf8")),
      event
    );
    const result = authority.store.compareAndAppend({
      expectedHead: current.head,
      bytes: Buffer.from(canonicalJson(next) + "\n"),
      createdAt: "2026-10-16T22:00:00.000Z",
    });
    if (result.status !== "appended") throw Error("Fixture append failed");
    return { head: result.attemptedHead!, state: next };
  };
  return {
    ...authority,
    key,
    checkpoint,
    state,
    validationPendingState: validationPendingState!,
    candidate: bundle.candidate,
    candidateBytes: Buffer.from(canonicalJson(bundle.candidate) + "\n"),
    workflowCommit,
    checkout,
    operator,
    npmCli,
    baseline,
    ledger,
    bundleDirectory: bundle.directory,
    payloadCommit: retainedPayload.payloadCommit,
    payloadArtifactRef: `refs/heads/zivv-candidate-artifacts/${retainedPayload.payloadCommit}`,
    step,
    claimRequest: {
      requestId: state.runId,
      payloadCommit: retainedPayload.payloadCommit,
      candidateId: bundle.candidate.candidateId,
      sourceCommit: workflowCommit,
      basePath: "/zivv/",
      purpose: "release" as const,
      publicInventorySha256: promotionDigest(bundle.candidate.files),
      expectedVerifiedReleaseId: JSON.parse(
        authority.store.read().bytes!.toString("utf8")
      ).lastVerified.releaseId as string,
    },
  };
}
