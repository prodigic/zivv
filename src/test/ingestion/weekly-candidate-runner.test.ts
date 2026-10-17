import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import { importSteveContent } from "../../lib/ingestion/imports.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { runWeeklyImport } from "../../lib/ingestion/weekly-import-runner.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import type { WeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";
import type { WeeklyCandidateBuildOptions } from "../../lib/ingestion/weekly-candidate-runner.js";
import {
  buildCandidateBundle,
  readVerifiedCandidateBundle,
} from "../../lib/ingestion/candidate-bundle.js";
import { captureExportConfiguration } from "../../lib/ingestion/export-configuration.js";
import type { ApplicationBuildReceipt } from "../../lib/ingestion/source-build.js";

type Capture =
  typeof import("../../lib/ingestion/source-build.js").captureReviewedSource;
type Build =
  typeof import("../../lib/ingestion/reviewed-candidate.js").buildReviewedWeeklyCandidate;
const doubles = vi.hoisted(() => ({
  capture: vi.fn<Capture>(),
  build: vi.fn<Build>(),
}));
vi.mock("../../lib/ingestion/source-build.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../lib/ingestion/source-build.js")
  >()),
  captureReviewedSource: doubles.capture,
}));
vi.mock(
  "../../lib/ingestion/reviewed-candidate.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../lib/ingestion/reviewed-candidate.js")
    >()),
    buildReviewedWeeklyCandidate: doubles.build,
  })
);

// Source capture and compilation are covered by source-build.test.ts. Here only
// those expensive boundaries are replaced; ETL, sealing, authenticated snapshot,
// bundle loading and publication-purpose verification remain real.
vi.setConfig({ testTimeout: 45_000, hookTimeout: 15_000 });
const observedAt = Date.parse("2026-10-09T20:00:00Z");
const cutoff = Date.parse("2026-10-09T21:00:00Z");
const source = {
  editionId: "2026-10-09",
  deliveryId: "candidate-fixture",
  importObservedAtEpochMs: observedAt,
  raw: Buffer.from(
    "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 9, 2026\noct 23 fri Fixture Band at Test Room, Oakland a/a $20 8pm\n"
  ),
};
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe("weekly candidate stages with real sealed bundles", () => {
  let directory: string, root: string, home: string, sqlitePath: string;
  let build: WeeklyCandidateBuildOptions;
  let receiptPurpose: "preview" | "release" | undefined;
  let delayMs: number;
  let bundles: Awaited<ReturnType<typeof buildCandidateBundle>>[];
  function catalogDigest() {
    return ledgerDigest(readSqliteLedger(sqlitePath));
  }
  function journalState(): WeeklyRunState {
    const db = new DatabaseSync(join(home, "weekly-runs.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db.prepare("SELECT payload FROM run_state").get();
      if (!row) throw new Error("Missing fixture run");
      return JSON.parse(String(row.payload)) as WeeklyRunState;
    } finally {
      db.close();
    }
  }
  function stage(
    state: WeeklyRunState,
    name: "freeze" | "enrich" | "export" | "validate"
  ) {
    const item = state.stages.find((value) => value.stage === name);
    if (!item) throw new Error("Missing fixture stage");
    return item;
  }
  function artifact(state: WeeklyRunState, name: "export") {
    const db = new DatabaseSync(join(home, "weekly-runs.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare(
          "SELECT bytes FROM stage_artifact WHERE run_id=? AND stage=? AND attempt=?"
        )
        .get(state.runId, name, stage(state, name).attempt);
      if (!row) throw new Error("Missing fixture artifact");
      return JSON.parse(Buffer.from(row.bytes as Uint8Array).toString()) as {
        workDirectory: string;
      };
    } finally {
      db.close();
    }
  }
  const frozenRun = () =>
    runWeeklyImport({
      root,
      source,
      stopAfter: "freeze",
      freezeCutoffEpochMs: cutoff,
    });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "zivv-candidate-runner-"));
    root = join(directory, "checkout");
    home = join(directory, "operator");
    sqlitePath = join(home, "ledger.sqlite");
    vi.stubEnv("ZIVV_LEDGER_HOME", home);
    mkdirSync(join(root, "data/ingestion"), { recursive: true });
    writeFileSync(
      join(root, "data/ingestion/store.json"),
      JSON.stringify({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    loadBackupKey(home, true);
    await writeSqliteLedger(
      sqlitePath,
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1_000),
      true
    );
    const npmCli = join(home, "fixture-npm.cjs");
    writeFileSync(npmCli, "process.exit(0);\n");
    build = {
      sourceCommit: "a".repeat(40),
      purpose: "preview",
      basePath: "/zivv/",
      npmCli,
    };
    receiptPurpose = undefined;
    delayMs = 0;
    bundles = [];
    doubles.capture.mockReset();
    doubles.build.mockReset();
    doubles.capture.mockImplementation((input: Parameters<Capture>[0]) => {
      const capturedDirectory = mkdtempSync(
        join(input.privateDirectory, "source-build-")
      );
      const sourceRoot = join(capturedDirectory, "source");
      const contents = new Map([
        ["data/events.txt", ""],
        ["data/venues.txt", ""],
        ["package-lock.json", '{"lockfileVersion":3}\n'],
      ]);
      const files = [...contents].map(([path, text]) => {
        mkdirSync(dirname(join(sourceRoot, path)), { recursive: true });
        writeFileSync(join(sourceRoot, path), text);
        const bytes = Buffer.from(text);
        const blob = createHash("sha1")
          .update(Buffer.from(`blob ${bytes.length}\0`))
          .update(bytes)
          .digest("hex");
        return { path, blob, mode: "100644" as const };
      });
      const envelope = Buffer.from(canonicalJson(files));
      writeFileSync(join(capturedDirectory, "source.blobs"), envelope);
      const captured = {
        directory: capturedDirectory,
        sourceRoot,
        sourceCommit: input.sourceCommit,
        sourceTree: "b".repeat(40),
        files,
        archiveSha256: hash(envelope),
        purpose: input.purpose,
      };
      writeFileSync(
        join(capturedDirectory, "source-capture.json"),
        canonicalJson(captured)
      );
      return captured;
    });
    doubles.build.mockImplementation(async (input: Parameters<Build>[0]) => {
      if (delayMs) await setTimeout(delayMs);
      const captured = doubles.capture({
        repositoryRoot: input.repositoryRoot,
        privateDirectory: input.privateDirectory,
        sourceCommit: input.sourceCommit,
        purpose: input.purpose,
      });
      const configuration = captureExportConfiguration(captured.sourceRoot);
      configuration["ingestion/weekly-editions.json"] = Buffer.from(
        input.weeklyEditionBytes
      );
      const applicationFiles = new Map([
        [
          "index.html",
          Buffer.from(
            `<script type="module" src="${input.basePath}assets/app.js"></script>`
          ),
        ],
        [
          "404.html",
          Buffer.from(
            `<link href="${input.basePath}assets/app.css" rel="stylesheet">`
          ),
        ],
        [
          "manifest.json",
          Buffer.from(
            JSON.stringify({ scope: input.basePath, start_url: input.basePath })
          ),
        ],
        ["vite.svg", Buffer.from("svg")],
        ["assets/app.js", Buffer.from("console.log(1);\n")],
        ["assets/app.css", Buffer.from("body { color: black; }\n")],
      ]);
      const applicationBuildManifest = Buffer.from(
        JSON.stringify({
          "index.html": {
            file: "assets/app.js",
            isEntry: true,
            css: ["assets/app.css"],
          },
        })
      );
      const receipt: ApplicationBuildReceipt = {
        schemaVersion: 1,
        purpose: receiptPurpose ?? input.purpose,
        sourceRepository: "prodigic/zivv",
        sourceCommit: input.sourceCommit,
        sourceTree: captured.sourceTree,
        sourceInventorySha256: hash(canonicalJson(captured.files)),
        archiveSha256: captured.archiveSha256,
        packageLockSha256: hash(
          readFileSync(join(captured.sourceRoot, "package-lock.json"))
        ),
        basePath: input.basePath,
        nodeVersion: process.version,
        npmVersion: "11.6.0",
        buildManifestSha256: hash(applicationBuildManifest),
        etlInventorySha256: hash("fixture-etl"),
        applicationFiles: [...applicationFiles]
          .map(([path, bytes]) => ({
            path,
            size: bytes.length,
            sha256: hash(bytes),
          }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      };
      const bundle = await buildCandidateBundle({
        privateDirectory: input.privateDirectory,
        sourceCommit: input.sourceCommit,
        basePath: input.basePath,
        editionId: input.editionId,
        ledger: input.ledger,
        snapshot: input.snapshot,
        recoveryKey: input.recoveryKey,
        configuration,
        applicationFiles,
        applicationBuildManifest,
        applicationBuildReceipt: Buffer.from(canonicalJson(receipt) + "\n"),
      });
      bundles.push(bundle);
      return { ...bundle, sourceDirectory: captured.directory };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("executes enrich/export/validate with a real verified bundle and resumes without rebuilding", async () => {
    const validated = await runWeeklyImport({
      root,
      source,
      stopAfter: "validate",
      freezeCutoffEpochMs: cutoff,
      candidateBuild: build,
    });
    expect(
      validated.stages.slice(0, 8).every((item) => item.status === "succeeded")
    ).toBe(true);
    expect(
      validated.stages.slice(8).every((item) => item.status === "pending")
    ).toBe(true);
    expect(bundles).toHaveLength(1);
    const verified = await readVerifiedCandidateBundle(
      bundles[0].directory,
      loadBackupKey(home),
      String(stage(validated, "export").evidence?.candidateId)
    );
    expect(verified.candidate.ledgerRevision).toBe(
      stage(validated, "freeze").evidence?.ledgerRevision
    );
    expect(stage(validated, "validate").evidence).toMatchObject({
      candidateId: verified.candidate.candidateId,
      manifestSha256: verified.candidate.manifestSha256,
    });
    const before = catalogDigest();
    expect(
      await runWeeklyImport({
        root,
        runId: validated.runId,
        stopAfter: "validate",
      })
    ).toEqual(validated);
    expect(doubles.build).toHaveBeenCalledTimes(1);
    expect(catalogDigest()).toBe(before);
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
  });

  it("requires initial candidate options and permits an explicit retry with valid options", async () => {
    const frozen = await frozenRun();
    const before = catalogDigest();
    await expect(
      runWeeklyImport({ root, runId: frozen.runId, stopAfter: "enrich" })
    ).rejects.toThrow("CANDIDATE_BUILD_OPTIONS_REQUIRED");
    expect(doubles.capture).not.toHaveBeenCalled();
    const enriched = await runWeeklyImport({
      root,
      runId: frozen.runId,
      stopAfter: "enrich",
      candidateBuild: build,
    });
    expect(stage(enriched, "enrich")).toMatchObject({
      status: "succeeded",
      attempt: 2,
    });
    expect(stage(enriched, "export").status).toBe("pending");
    expect(catalogDigest()).toBe(before);
  });

  it("rejects changed source commit, purpose, base or installer after option capture", async () => {
    const frozen = await frozenRun();
    const enriched = await runWeeklyImport({
      root,
      runId: frozen.runId,
      stopAfter: "enrich",
      candidateBuild: build,
    });
    for (const changes of [
      { sourceCommit: "f".repeat(40) },
      { purpose: "release" as const },
      { basePath: "/different/" },
      { npmCli: build.npmCli + ".changed" },
    ]) {
      await expect(
        runWeeklyImport({
          root,
          runId: enriched.runId,
          stopAfter: "export",
          candidateBuild: { ...build, ...changes },
        })
      ).rejects.toThrow("CANDIDATE_BUILD_CONTEXT_CHANGED");
    }
    expect(journalState()).toEqual(enriched);
    expect(doubles.build).not.toHaveBeenCalled();
  }, 90_000);

  it("rejects rewritten captured source identity even when the artifact checksum is refreshed", async () => {
    const frozen = await frozenRun();
    const enriched = await runWeeklyImport({
      root,
      runId: frozen.runId,
      stopAfter: "enrich",
      candidateBuild: build,
    });
    const before = catalogDigest();
    const db = new DatabaseSync(join(home, "weekly-runs.sqlite"));
    try {
      const row = db
        .prepare(
          "SELECT bytes FROM stage_artifact WHERE run_id=? AND stage='enrich' AND attempt=1"
        )
        .get(enriched.runId);
      if (!row) throw new Error("Missing enrichment fixture artifact");
      const value: { build: { sourceCommit: string } } = JSON.parse(
        Buffer.from(row.bytes as Uint8Array).toString()
      );
      value.build.sourceCommit = "f".repeat(40);
      const bytes = Buffer.from(canonicalJson(value) + "\n");
      db.prepare(
        "UPDATE stage_artifact SET identity=?,bytes=? WHERE run_id=? AND stage='enrich' AND attempt=1"
      ).run(hash(bytes), bytes, enriched.runId);
    } finally {
      db.close();
    }
    await expect(
      runWeeklyImport({ root, runId: enriched.runId, stopAfter: "export" })
    ).rejects.toThrow("CANDIDATE_BUILD_CONTEXT_CHANGED");
    expect(catalogDigest()).toBe(before);
    expect(doubles.build).not.toHaveBeenCalled();
    expect(journalState()).toEqual(enriched);
  });

  it("exports the captured frozen ledger rather than later catalog additions", async () => {
    const frozen = await frozenRun();
    const frozenRevision = stage(frozen, "freeze").evidence?.ledgerRevision;
    await importSteveContent(
      root,
      "oct 24 2026 Later Band at Other Room, Oakland a/a 8pm\n",
      { observedAtEpochMs: cutoff + 60_000 }
    );
    const before = catalogDigest();
    const validated = await runWeeklyImport({
      root,
      runId: frozen.runId,
      stopAfter: "validate",
      candidateBuild: build,
    });
    expect(stage(validated, "export").evidence?.ledgerRevision).toBe(
      frozenRevision
    );
    expect(stage(validated, "export").evidence?.ledgerRevision).not.toBe(
      before
    );
    const verified = await readVerifiedCandidateBundle(
      bundles[0].directory,
      loadBackupKey(home),
      String(stage(validated, "export").evidence?.candidateId)
    );
    expect(
      JSON.parse(verified.publicFiles.get("data/manifest.json")!.toString())
    ).toMatchObject({ totalEvents: 1 });
    expect(readSqliteLedger(sqlitePath).events).toHaveLength(2);
    expect(catalogDigest()).toBe(before);
  });

  it.each(["artifact-saved", "effect-committed"] as const)(
    "refuses to adopt an interrupted export at %s and builds a new attempt",
    async (phase: "artifact-saved" | "effect-committed") => {
      const frozen = await frozenRun();
      const interruption = new Error("fixture unacknowledged candidate build");
      await expect(
        runWeeklyImport({
          root,
          runId: frozen.runId,
          stopAfter: "export",
          candidateBuild: build,
          onProgress: async (event) => {
            if (event.stage === "export" && event.phase === phase)
              throw interruption;
          },
        })
      ).rejects.toBe(interruption);
      const interrupted = journalState();
      expect(stage(interrupted, "export")).toMatchObject({
        status: "running",
        attempt: 1,
      });
      const abandoned = artifact(interrupted, "export").workDirectory;
      const before = catalogDigest();
      await expect(
        runWeeklyImport({ root, runId: frozen.runId, stopAfter: "export" })
      ).rejects.toThrow("INTERRUPTED_CANDIDATE_BUILD");
      expect(stage(journalState(), "export")).toMatchObject({
        status: "failed",
        attempt: 1,
      });
      const retried = await runWeeklyImport({
        root,
        runId: frozen.runId,
        stopAfter: "validate",
      });
      expect(stage(retried, "export")).toMatchObject({
        status: "succeeded",
        attempt: 2,
      });
      expect(artifact(retried, "export").workDirectory).not.toBe(abandoned);
      expect(catalogDigest()).toBe(before);
      expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
      expect(doubles.build).toHaveBeenCalledTimes(
        phase === "effect-committed" ? 2 : 1
      );
    }
  );

  it("rejects changed public application bytes on fresh candidate validation", async () => {
    const frozen = await frozenRun();
    const exported = await runWeeklyImport({
      root,
      runId: frozen.runId,
      stopAfter: "export",
      candidateBuild: build,
    });
    const before = catalogDigest();
    writeFileSync(
      join(bundles[0].directory, "workspace/public/assets/app.js"),
      "tampered application\n"
    );
    await expect(
      runWeeklyImport({ root, runId: exported.runId, stopAfter: "validate" })
    ).rejects.toThrow();
    expect(stage(journalState(), "validate").status).not.toBe("succeeded");
    expect(catalogDigest()).toBe(before);
    expect(doubles.build).toHaveBeenCalledTimes(1);
  });

  it("rejects a preview build receipt on a release candidate path", async () => {
    const frozen = await frozenRun();
    receiptPurpose = "preview";
    const before = catalogDigest();
    await expect(
      runWeeklyImport({
        root,
        runId: frozen.runId,
        stopAfter: "export",
        candidateBuild: { ...build, purpose: "release" },
      })
    ).rejects.toThrow("Build purpose does not authorize this publication");
    expect(stage(journalState(), "export").status).toBe("failed");
    expect(catalogDigest()).toBe(before);
  });

  it("renews the real destination lease while an asynchronous build exceeds its original TTL", async () => {
    const frozen = await frozenRun();
    delayMs = 7_000;
    const renewals = vi.spyOn(WeeklyRunJournal.prototype, "renew");
    const validated = await runWeeklyImport({
      root,
      runId: frozen.runId,
      stopAfter: "validate",
      candidateBuild: build,
      leaseTtlMs: 5_000,
    });
    expect(stage(validated, "validate").status).toBe("succeeded");
    expect(renewals.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
  });
});
