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
import { compiledEtlDigest } from "../../../lib/ingestion/source-build.js";
import {
  createEmptyWeeklyEditionLedger,
  prepareWeeklyEdition,
  serializeWeeklyEditionLedger,
} from "../../../lib/ingestion/weekly.js";
import { installRecoveredBackupKey } from "../../../lib/ingestion/encrypted-backup.js";
import { WeeklyRunJournal } from "../../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
  type StageEvidence,
  type WeeklyRunStage,
} from "../../../lib/ingestion/weekly-run-state.js";
import { captureOperatorRecoveryCheckpoint } from "../../../lib/ingestion/operator-recovery.js";
function write(path: string, bytes: string | Buffer) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
}
/** Actual imported catalog/freeze transitions, before any candidate context exists. */
export async function createRecoveryFrozenRemoteFixture(directory: string) {
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
    deliveryId: "frozen-candidate-recovery",
    rawSha256: sha256(raw),
    rulesSha256,
    importObservedAtEpochMs: observed,
  });
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
  return {
    ...authority,
    key,
    checkpoint,
    state,
    sourceCommit: workflowCommit,
    checkout,
    operator,
    npmCli,
    baseline,
    ledger,
  };
}
