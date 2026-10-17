import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, relative, resolve } from "node:path";
import {
  captureOperatorRecoveryCheckpoint,
  decryptOperatorRecovery,
  encryptOperatorRecovery,
  stageOperatorRecovery,
} from "../../lib/ingestion/operator-recovery.js";
import {
  buildCandidateBundle,
  readVerifiedCandidateBundle,
} from "../../lib/ingestion/candidate-bundle.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import { encryptLedgerSnapshot } from "../../lib/ingestion/encrypted-backup.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { captureExportConfiguration } from "../../lib/ingestion/export-configuration.js";
import {
  createEmptyWeeklyEditionLedger,
  prepareWeeklyEdition,
  serializeWeeklyEditionLedger,
} from "../../lib/ingestion/weekly.js";
import {
  WeeklyRunJournal,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
  type StageEvidence,
  type WeeklyRunStage,
} from "../../lib/ingestion/weekly-run-state.js";
import { importReportDigest } from "../../lib/ingestion/steve-import-review.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import type { ReconciliationReport } from "../../types/ingestion.js";
import { captureNpmExecutionTool } from "../../lib/ingestion/execution-tool-identity.js";
import { inspectOperatorRecoveryLocations } from "../../lib/ingestion/operator-recovery-location.js";

const roots: string[] = [];
const scope = "prodigic/zivv/production";
const observedAt = Date.parse("2026-10-16T19:00:00Z");
const cutoff = observedAt + 60_000;
const key = Buffer.alloc(32, 39);

function write(path: string, bytes: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** A real isolated legacy seal; this fixture does not authorize production delivery. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zivv-recovery-candidate-test-"));
  roots.push(root);
  const checkout = join(root, "checkout"),
    operator = join(root, "operator");
  vi.stubEnv("ZIVV_LEDGER_HOME", operator);
  write(
    join(checkout, "data/ingestion/store.json"),
    canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
  );
  write(join(checkout, "package.json"), "{}\n");
  write(join(checkout, "package-lock.json"), "synthetic recovery lockfile\n");
  for (const path of [
    "lib/ingestion/weekly-import-runner.js",
    "types/fixture.js",
    "utils/fixture.js",
  ])
    write(join(checkout, "dist", path), "// synthetic retained runtime\n");
  const ledger = bootstrapLedger({ events: [], artists: [], venues: [] }, 1000);
  await writeSqliteLedger(join(operator, "ledger.sqlite"), ledger, true);
  const weekly = prepareWeeklyEdition(createEmptyWeeklyEditionLedger(), [], {
    editionId: "2026-10-16",
    cutoffEpochMs: cutoff,
    datasetVersion: "synthetic-frozen-dataset",
  });
  const weeklyBytes = Buffer.from(serializeWeeklyEditionLedger(weekly.ledger));
  write(join(checkout, "data/ingestion/weekly-editions.json"), weeklyBytes);
  write(
    join(checkout, "data/venue-sources.json"),
    canonicalJson({ sources: [] })
  );
  const snapshot = encryptLedgerSnapshot(ledger, key);
  const workDirectory = join(
    operator,
    "weekly-candidates/candidate-work-fixture"
  );
  const bundle = await buildCandidateBundle({
    privateDirectory: workDirectory,
    sourceCommit: "a".repeat(40),
    basePath: "/zivv/",
    editionId: "2026-10-16",
    ledger,
    snapshot,
    recoveryKey: key,
    configuration: captureExportConfiguration(checkout),
    applicationFiles: new Map([
      [
        "index.html",
        Buffer.from(
          '<script type="module" src="/zivv/assets/app.js"></script>'
        ),
      ],
      [
        "404.html",
        Buffer.from('<link href="/zivv/assets/app.css" rel="stylesheet">'),
      ],
      [
        "manifest.json",
        Buffer.from(canonicalJson({ scope: "/zivv/", start_url: "/zivv/" })),
      ],
      ["vite.svg", Buffer.from("synthetic svg")],
      [
        "assets/app.js",
        Buffer.from("console.log('synthetic retained app');\n"),
      ],
      ["assets/app.css", Buffer.from("body { color: black; }\n")],
    ]),
    applicationBuildManifest: Buffer.from(
      canonicalJson({
        "index.html": {
          file: "assets/app.js",
          isEntry: true,
          css: ["assets/app.css"],
        },
      })
    ),
  });
  const report: ReconciliationReport = {
    runId: "synthetic-recovery-import",
    replay: false,
    acceptedEventIds: [],
    newEventIds: [],
    updatedEventIds: [],
    linkedEventIds: [],
    review: [],
    conflicts: [],
  };
  const reportPath = join(
    checkout,
    "data/ingestion/reports",
    sha256(report.runId) + ".json"
  );
  write(reportPath, canonicalJson(report) + "\n");
  const journal = new WeeklyRunJournal(operator);
  const lease = journal.acquire(scope);
  let state = createWeeklyRunState({
    editionId: "2026-10-16",
    deliveryId: "synthetic-candidate",
    rawSha256: sha256("retained source\n"),
    rulesSha256: "b".repeat(64),
    importObservedAtEpochMs: observedAt,
  });
  try {
    state = journal.create(state, lease, Buffer.from("retained source\n"));
    const candidate = bundle.candidate,
      revision = ledgerDigest(ledger),
      preparedSha256 = sha256("synthetic prepared bytes"),
      reportSha256 = importReportDigest(report);
    const steps: Array<[WeeklyRunStage, StageEvidence, Buffer | undefined]> = [
      [
        "acquire",
        {
          rawSha256: state.source.rawSha256,
          deliveryId: state.source.deliveryId,
        },
        Buffer.from("retained source\n"),
      ],
      [
        "prepare",
        { preparedSha256, rulesSha256: state.source.rulesSha256 },
        undefined,
      ],
      [
        "reconcile",
        { ledgerRevision: revision, reportSha256, preparedSha256 },
        undefined,
      ],
      [
        "load",
        {
          ledgerRevision: revision,
          reviewedLedgerRevision: revision,
          reportSha256,
          preparedSha256,
          importRunId: report.runId,
        },
        undefined,
      ],
      [
        "freeze",
        {
          editionId: candidate.editionId,
          cutoffEpochMs: candidate.cutoffEpochMs,
          membershipSha256: candidate.membershipSha256,
          preCutoffPendingCount: 0,
          mode: "initial",
          ledgerRevision: revision,
        },
        undefined,
      ],
      ["enrich", { configSha256: candidate.configSha256 }, undefined],
      [
        "export",
        {
          ledgerRevision: revision,
          snapshotRevision: revision,
          manifestSha256: candidate.manifestSha256,
          datasetVersion: candidate.datasetVersion,
          candidateId: candidate.candidateId,
          editionId: candidate.editionId,
          cutoffEpochMs: candidate.cutoffEpochMs,
          membershipSha256: candidate.membershipSha256,
          configSha256: candidate.configSha256,
        },
        Buffer.from(
          canonicalJson({
            schemaVersion: 1,
            workDirectory,
            snapshot: snapshot.toString("base64"),
          }) + "\n"
        ),
      ],
      [
        "validate",
        {
          candidateId: candidate.candidateId,
          manifestSha256: candidate.manifestSha256,
        },
        undefined,
      ],
    ];
    for (const [stage, evidence, artifact] of steps) {
      state = journal.save(
        transitionWeeklyRun(
          state,
          state.revision,
          stage,
          { status: "running" },
          cutoff + 1
        ),
        state.revision,
        lease
      );
      journal.writeArtifact(
        state.runId,
        stage,
        artifact ??
          Buffer.from(canonicalJson({ schemaVersion: 1, evidence }) + "\n"),
        lease
      );
      state = journal.save(
        transitionWeeklyRun(
          state,
          state.revision,
          stage,
          { status: "succeeded", evidence },
          cutoff + 1
        ),
        state.revision,
        lease
      );
    }
  } finally {
    journal.release(lease);
    journal.close();
  }
  const checkpoint = await captureOperatorRecoveryCheckpoint(checkout);
  return {
    root,
    checkout,
    operator,
    bundle,
    checkpoint,
    state,
    reportPath,
    report,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    const within = relative(resolve(tmpdir()), resolve(root));
    if (
      !within.startsWith("zivv-recovery-candidate-test-") ||
      within.startsWith("..")
    )
      throw new Error("Unsafe candidate fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("sealed candidates in offline operator recovery", () => {
  it.each(["retained", "missing", "changed"] as const)(
    "requires exact private npm identity for a new captured build: %s",
    async (mode) => {
      const f = await fixture();
      const npmRoot = join(f.root, "npm-package");
      const cli = join(npmRoot, "bin/npm-cli.js");
      write(cli, "// synthetic execution tool\n");
      write(
        join(npmRoot, "package.json"),
        '{"name":"npm","version":"11.6.0"}\n'
      );
      const manifest = Buffer.from(
        canonicalJson(captureNpmExecutionTool(cli)) + "\n"
      );
      const capture = join(
        f.operator,
        "weekly-candidates/candidate-work-fixture/source-build-retained"
      );
      write(join(capture, "execution-tools.json"), manifest);
      write(
        join(capture, "application-build.json"),
        canonicalJson({
          schemaVersion: 2,
          npmVersion: "11.6.0",
          executionToolSha256: sha256(manifest),
          purpose: "release",
          sourceRepository: "prodigic/zivv",
          sourceCommit: "a".repeat(40),
          sourceTree: "b".repeat(40),
          sourceInventorySha256: "c".repeat(64),
          archiveSha256: "d".repeat(64),
          packageLockSha256: "e".repeat(64),
          basePath: "/zivv/",
          nodeVersion: process.version,
          buildManifestSha256: "f".repeat(64),
          etlInventorySha256: "1".repeat(64),
          applicationFiles: [
            { path: "index.html", size: 1, sha256: "2".repeat(64) },
          ],
        }) + "\n"
      );
      const within = relative(f.root, npmRoot);
      if (within !== "npm-package")
        throw new Error("Unsafe tool fixture cleanup");
      rmSync(npmRoot, { recursive: true });
      if (mode === "missing") unlinkSync(join(capture, "execution-tools.json"));
      if (mode === "changed")
        write(join(capture, "execution-tools.json"), "{}\n");
      if (mode !== "retained") {
        await expect(
          captureOperatorRecoveryCheckpoint(f.checkout)
        ).rejects.toThrow();
        return;
      }
      const checkpoint = await captureOperatorRecoveryCheckpoint(f.checkout);
      const archive = encryptOperatorRecovery(checkpoint, key);
      const stagingRoot = join(f.root, "retained-tool-staging");
      await stageOperatorRecovery(
        decryptOperatorRecovery(archive, key),
        stagingRoot,
        key
      );
      expect(
        inspectOperatorRecoveryLocations({
          archive,
          recoveryKey: key,
          stagingRoot,
        }).report.runtime.npmIdentity
      ).toBe("retained-build-identities");
      const broken = structuredClone(checkpoint);
      broken.files = broken.files.filter(
        (file) =>
          !file.path.endsWith("source-build-retained/execution-tools.json")
      );
      expect(() => encryptOperatorRecovery(broken, key)).toThrow();
    }
  );

  it("retains, encrypts and stages a real sealed candidate and exact successful journal history", async () => {
    const f = await fixture();
    expect(f.bundle.candidate.applicationProvenanceSha256).toBeNull();
    const archive = encryptOperatorRecovery(f.checkpoint, key);
    const decoded = decryptOperatorRecovery(archive, key);
    const target = join(f.root, "offline-staging");
    await stageOperatorRecovery(decoded, target, key);
    const stagedBundle = join(
      target,
      "operator",
      relative(f.operator, f.bundle.directory)
    );
    const verified = await readVerifiedCandidateBundle(
      stagedBundle,
      key,
      f.bundle.candidate.candidateId
    );
    expect(verified.candidate).toEqual(f.bundle.candidate);
    expect(
      verified.snapshot.equals(
        readFileSync(join(f.bundle.directory, "recovery/ledger.snapshot.enc"))
      )
    ).toBe(true);
    expect(verified.publicFiles.get("assets/app.js")?.toString()).toBe(
      "console.log('synthetic retained app');\n"
    );
    expect(
      ledgerDigest(readSqliteLedger(join(target, "operator/ledger.sqlite")))
    ).toBe(f.checkpoint.ledgerRevision);
    const journal = new WeeklyRunJournal(join(target, "operator"));
    try {
      expect(journal.load(f.state.runId)).toEqual(f.state);
    } finally {
      journal.close();
    }
    expect(
      JSON.parse(readFileSync(join(target, "recovery-state.json"), "utf8"))
    ).toMatchObject({ status: "staged", activationAllowed: false });
  });

  it.each([
    "entire-bundle",
    "completion-marker",
    "public-file",
    "paired-snapshot",
    "build-manifest",
    "load-report",
    "changed-report-digest",
    "completed-stage-artifact",
  ] as const)(
    "refuses capture after successful validation loses %s while preserving the valid journal history",
    async (missing) => {
      const f = await fixture();
      const trustedJournal = validateWeeklyJournalRecoverySnapshot(
        Buffer.from(f.checkpoint.journal, "base64")
      );
      expect(
        trustedJournal.runState.find((row) => row.id === f.state.runId)?.payload
      ).toBe(canonicalJson(f.state));
      expect(
        f.state.stages
          .slice(0, 8)
          .every((stage) => stage.status === "succeeded")
      ).toBe(true);
      if (missing === "entire-bundle") {
        const within = relative(f.root, f.bundle.directory);
        if (
          !within ||
          within.startsWith("..") ||
          resolve(f.root, within) !== resolve(f.bundle.directory)
        )
          throw new Error("Unsafe bundle removal");
        rmSync(f.bundle.directory, { recursive: true });
        expect(existsSync(dirname(f.bundle.directory))).toBe(true);
      }
      if (missing === "completion-marker")
        unlinkSync(join(f.bundle.directory, "complete.json"));
      if (missing === "public-file")
        unlinkSync(join(f.bundle.directory, "workspace/public/assets/app.js"));
      if (missing === "paired-snapshot")
        unlinkSync(join(f.bundle.directory, "recovery/ledger.snapshot.enc"));
      if (missing === "build-manifest")
        unlinkSync(join(f.bundle.directory, "build/vite-manifest.json"));
      if (missing === "load-report") unlinkSync(f.reportPath);
      if (missing === "completed-stage-artifact") {
        const db = new DatabaseSync(join(f.operator, "weekly-runs.sqlite"));
        try {
          db.prepare(
            "DELETE FROM stage_artifact WHERE run_id=? AND stage='prepare'"
          ).run(f.state.runId);
        } finally {
          db.close();
        }
      }
      if (missing === "changed-report-digest")
        write(
          f.reportPath,
          canonicalJson({
            ...f.report,
            historicalBatch: {
              sourceCommit: "a".repeat(40),
              datasetVersion: "changed-history",
              processedAtEpochMs: 1000,
            },
          }) + "\n"
        );
      await expect(
        captureOperatorRecoveryCheckpoint(f.checkout)
      ).rejects.toThrow();
      const journal = new WeeklyRunJournal(f.operator);
      try {
        expect(journal.load(f.state.runId)).toEqual(f.state);
      } finally {
        journal.close();
      }
    }
  );

  it("authenticates the candidate's paired snapshot before encryption or staging any files", async () => {
    const f = await fixture();
    const wrongKey = Buffer.alloc(32, 73);
    expect(() => encryptOperatorRecovery(f.checkpoint, wrongKey)).toThrow();
    const target = join(f.root, "wrong-key-staging");
    await expect(
      stageOperatorRecovery(f.checkpoint, target, wrongKey)
    ).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });
});
