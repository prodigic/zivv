import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import type { ReleaseCandidate } from "../../lib/ingestion/release-candidate.js";
import {
  createLocalPromotionControlStore,
  createBareTestPromotionControlTransport,
} from "../../lib/ingestion/promotion-control-git.js";
import {
  applyPromotionTransition,
  candidatePublicReleaseId,
  claimPromotion,
  createPromotionControl,
  parsePromotionControl,
  promotionAttemptId,
  promotionDigest,
  serializePromotionControl,
  validatePromotionAppend,
  type PromotionEvent,
} from "../../lib/ingestion/promotion-control.js";
import {
  PROMOTION_FIXTURE_CHECKS,
  syntheticLegacyPublicSnapshot,
} from "./fixtures/promotion-control-fixture.js";

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
  function initializeControl() {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    execFileSync("git", ["init", "--quiet", "--object-format=sha1"], {
      cwd: root,
      env,
      windowsHide: true,
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/prodigic/zivv.git"],
      { cwd: root, env, windowsHide: true }
    );
    return createLocalPromotionControlStore({
      repositoryRoot: root,
      destination: "production",
      validateState(bytes, destination) {
        const control = parsePromotionControl(bytes);
        if (control.destination !== destination)
          throw new Error("Wrong fixture control destination");
        return control.completionRoot;
      },
      validateTransition: validatePromotionAppend,
    });
  }
  function seedVerifiedControl(
    candidate: ReleaseCandidate,
    wrongCandidate = false
  ) {
    const store = initializeControl();
    const createdAt = "2026-10-14T18:00:00.000Z";
    let control = createPromotionControl(syntheticLegacyPublicSnapshot());
    let head: string | null = null;
    const save = () => {
      const result = store.compareAndAppend({
        expectedHead: head,
        bytes: serializePromotionControl(control),
        createdAt,
      });
      expect(result.status).toBe("appended");
      head = result.attemptedHead;
    };
    const step = (event: PromotionEvent) => {
      control = applyPromotionTransition(control, event);
      save();
    };
    save();
    control = claimPromotion(control, {
      requestId: "sealed-weekly-fixture",
      payloadCommit: "e".repeat(40),
      candidateId: wrongCandidate ? "f".repeat(64) : candidate.candidateId,
      sourceCommit: candidate.sourceCommit,
      basePath: "/zivv/",
      purpose: "release",
      publicInventorySha256: promotionDigest(candidate.files),
      expectedVerifiedReleaseId: control.lastVerified.releaseId,
    });
    save();
    const workflowCommit = "b".repeat(40),
      operationId = control.active!.operationId;
    const owner = {
      operationId,
      mode: "promote" as const,
      attemptId: promotionAttemptId(
        operationId,
        "promote",
        1,
        workflowCommit,
        1
      ),
    };
    step({
      type: "dispatch-intent",
      ...owner,
      attemptNumber: 1,
      workflowCommit,
      expectedRunAttempt: 1,
    });
    const admission = { workflowCommit, runId: "101", runAttempt: 1 };
    step({ type: "admit-run", ...owner, admission });
    const deployment = { admission, artifactId: "201", deploymentId: "301" };
    step({ type: "deployed", ...owner, deployment });
    const deployed = control,
      deployedHead = head!;
    const body = {
      destination: "production" as const,
      liveUrl: "https://www.prodigic.com/zivv/",
      releaseId: candidatePublicReleaseId(
        "production",
        control.active!.request
      ),
      inventorySha256: control.active!.request.publicInventorySha256,
      deployment,
      verifiedAt: createdAt,
      checks: PROMOTION_FIXTURE_CHECKS,
    };
    step({
      type: "verified",
      ...owner,
      verification: { ...body, receiptId: promotionDigest(body) },
      replayProof: null,
    });
    return { store, control, deployed, deployedHead, createdAt, owner };
  }
  async function deliveryFixture(
    wrongCandidate = false,
    purpose: "release" | "preview" = "release"
  ) {
    const validated = await runWeeklyImport({
      root,
      source,
      stopAfter: "validate",
      freezeCutoffEpochMs: cutoff,
      candidateBuild: { ...build, purpose },
    });
    const bundle = await readVerifiedCandidateBundle(
      bundles[0].directory,
      loadBackupKey(home),
      String(stage(validated, "export").evidence!.candidateId)
    );
    const native = seedVerifiedControl(bundle.candidate, wrongCandidate);
    const candidate = Buffer.from(canonicalJson(bundle.candidate) + "\n");
    const run = (
      through: "verify" | "acknowledge",
      onProgress?: Parameters<typeof runWeeklyImport>[0]["onProgress"]
    ) =>
      runWeeklyImport({
        root,
        runId: validated.runId,
        stopAfter: through,
        verifiedDelivery: { store: native.store, candidate },
        controlledPublishing: "enabled",
        manualPublisherJoined: "true",
        onProgress,
      });
    return { ...native, validated, candidate, run };
  }
  async function publicationFixture() {
    const validated = await runWeeklyImport({
      root,
      source,
      stopAfter: "validate",
      freezeCutoffEpochMs: cutoff,
      candidateBuild: { ...build, purpose: "release" },
    });
    const bundle = await readVerifiedCandidateBundle(
      bundles[0].directory,
      loadBackupKey(home),
      String(stage(validated, "export").evidence!.candidateId)
    );
    const store = initializeControl(),
      createdAt = "2026-10-14T18:00:00.000Z";
    const bootstrap = store.compareAndAppend({
      expectedHead: null,
      bytes: serializePromotionControl(
        createPromotionControl(syntheticLegacyPublicSnapshot())
      ),
      createdAt,
    });
    expect(bootstrap.status).toBe("appended");
    const bare = join(directory, "publication.git");
    execFileSync(
      "git",
      ["init", "--bare", "--quiet", "--object-format=sha1", bare],
      { cwd: root, windowsHide: true }
    );
    const nativeTransport = createBareTestPromotionControlTransport(root, bare);
    const publicationDirectory = join(
      home,
      "weekly-publication",
      validated.runId
    );
    const planPath = join(publicationDirectory, "claim-plan.json");
    const dispatchPath = join(
      publicationDirectory,
      "dispatch/pages-dispatch.json"
    );
    const requests: { url: string; method: string }[] = [];
    const workflowCommit = "b".repeat(40),
      githubToken = "ghp_isolated_publication_fixture";
    let lostResponse = false,
      provideRun = true,
      retainWrites = 0;
    const response = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200 });
    const fetcher: typeof fetch = async (url, options) => {
      const method = options?.method ?? "GET";
      requests.push({ url: String(url), method });
      if (String(url).includes("/git/ref/"))
        return response({
          ref: `refs/tags/zivv-workflows/${workflowCommit}`,
          object: { type: "commit", sha: workflowCommit },
        });
      if (method === "POST") {
        expect(existsSync(planPath)).toBe(true);
        expect(existsSync(dispatchPath)).toBe(true);
        const control = parsePromotionControl(store.read().bytes!);
        expect(control.active!.phase).toBe("dispatch-planned");
        const payloadCommit = control.active!.request.payloadCommit;
        expect(
          nativeTransport.readHead(
            `refs/heads/zivv-candidate-artifacts/${payloadCommit}`
          )
        ).toBe(payloadCommit);
        if (lostResponse) throw new Error("Lost accepted dispatch response");
        return response({
          workflow_run_id: 101,
          run_url:
            "https://api.github.com/repos/prodigic/zivv/actions/runs/101",
          html_url: "https://github.com/prodigic/zivv/actions/runs/101",
        });
      }
      const saved = JSON.parse(readFileSync(dispatchPath, "utf8"));
      const run = {
        id: 101,
        event: "workflow_dispatch",
        head_sha: workflowCommit,
        head_branch: saved.intent.ref,
        display_title: saved.intent.runName,
        path: ".github/workflows/publish-candidate.yml",
        run_attempt: 1,
        repository: { full_name: "prodigic/zivv" },
        url: "https://api.github.com/repos/prodigic/zivv/actions/runs/101",
        html_url: "https://github.com/prodigic/zivv/actions/runs/101",
        inputs: {
          ...saved.intent.inputs,
          control_head: saved.pendingAppend.attemptedHead,
        },
      };
      return String(url).includes("/actions/runs/101")
        ? response(run)
        : response({
            total_count: provideRun ? 1 : 0,
            workflow_runs: provideRun ? [run] : [],
          });
    };
    const transport = {
      ...nativeTransport,
      append(ref: string, commit: string, expected: string | null) {
        retainWrites++;
        expect(existsSync(planPath)).toBe(true);
        expect(JSON.parse(readFileSync(planPath, "utf8")).payloadCommit).toBe(
          commit
        );
        nativeTransport.append(ref, commit, expected);
      },
    };
    const compare = store.compareAndAppend.bind(store);
    vi.spyOn(store, "compareAndAppend").mockImplementation((input) => {
      const control = parsePromotionControl(input.bytes);
      if (control.lastTransition.event.type === "claim") {
        const payloadCommit = control.active!.request.payloadCommit;
        expect(
          nativeTransport.readHead(
            `refs/heads/zivv-candidate-artifacts/${payloadCommit}`
          )
        ).toBe(payloadCommit);
        expect(JSON.parse(readFileSync(planPath, "utf8")).claim.bytes).toBe(
          input.bytes.toString("base64")
        );
      }
      return compare(input);
    });
    const publication = {
      store,
      transport,
      candidate: Buffer.from(canonicalJson(bundle.candidate) + "\n"),
      workflowCommit,
      githubToken,
      testTransport: {
        kind: "local-test" as const,
        apiBaseUrl: "http://127.0.0.1:4567",
        fetch: fetcher,
      },
    };
    const run = (
      through: "dispatch" | "verify" | "acknowledge",
      onProgress?: Parameters<typeof runWeeklyImport>[0]["onProgress"]
    ) =>
      runWeeklyImport({
        root,
        runId: validated.runId,
        stopAfter: through,
        publication,
        controlledPublishing: "enabled",
        manualPublisherJoined: "true",
        onProgress,
      });
    const finishNative = () => {
      let current = store.read(),
        control = parsePromotionControl(current.bytes!);
      const operation = control.active!,
        attempt = operation.promotionAttempt!;
      const owner = {
        operationId: operation.operationId,
        mode: "promote" as const,
        attemptId: attempt.attemptId,
      };
      const step = (event: PromotionEvent) => {
        control = applyPromotionTransition(control, event);
        const result = store.compareAndAppend({
          expectedHead: current.head,
          bytes: serializePromotionControl(control),
          createdAt,
        });
        expect(result.status).toBe("appended");
        current = store.read();
      };
      const admission = { workflowCommit, runId: "101", runAttempt: 1 };
      step({ type: "admit-run", ...owner, admission });
      const deployment = { admission, artifactId: "201", deploymentId: "301" };
      step({ type: "deployed", ...owner, deployment });
      const body = {
        destination: "production" as const,
        liveUrl: "https://www.prodigic.com/zivv/",
        releaseId: candidatePublicReleaseId("production", operation.request),
        inventorySha256: operation.request.publicInventorySha256,
        deployment,
        verifiedAt: createdAt,
        checks: PROMOTION_FIXTURE_CHECKS,
      };
      step({
        type: "verified",
        ...owner,
        verification: { ...body, receiptId: promotionDigest(body) },
        replayProof: null,
      });
    };
    const claimAnother = () => {
      const current = store.read(),
        control = parsePromotionControl(current.bytes!);
      const planned = JSON.parse(readFileSync(planPath, "utf8"));
      const claimed = claimPromotion(control, {
        requestId: "other-publication-owner",
        payloadCommit: planned.payloadCommit,
        candidateId: bundle.candidate.candidateId,
        sourceCommit: bundle.candidate.sourceCommit,
        basePath: "/zivv/",
        purpose: "release",
        publicInventorySha256: promotionDigest(bundle.candidate.files),
        expectedVerifiedReleaseId: control.lastVerified.releaseId,
      });
      expect(
        compare({
          expectedHead: current.head,
          bytes: serializePromotionControl(claimed),
          createdAt,
        }).status
      ).toBe("appended");
    };
    return {
      validated,
      store,
      publication,
      run,
      planPath,
      dispatchPath,
      requests,
      nativeTransport,
      finishNative,
      claimAnother,
      retainedWrites: () => retainWrites,
      loseResponse: () => {
        lostResponse = true;
      },
      noRun: () => {
        provideRun = false;
      },
    };
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
    if (
      !resolve(directory).startsWith(
        resolve(tmpdir(), "zivv-candidate-runner-")
      )
    )
      throw new Error(
        "Candidate fixture cleanup escaped its allocated directory"
      );
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

  it("retains the sealed weekly payload, claims and dispatches once, then resumes native verification and acknowledgement", async () => {
    const f = await publicationFixture(),
      before = catalogDigest();
    const pending = await f.run("acknowledge");
    expect(
      pending.stages.find((item) => item.stage === "deploy")
    ).toMatchObject({ status: "running", attempt: 1 });
    expect(pending.stages.find((item) => item.stage === "verify")!.status).toBe(
      "pending"
    );
    const weeklyPath = join(root, "data/ingestion/weekly-editions.json");
    expect(
      JSON.parse(readFileSync(weeklyPath, "utf8")).publishedCutoffEpochMs
    ).toBeNull();
    const plan = readFileSync(f.planPath),
      dispatch = readFileSync(f.dispatchPath);
    expect(
      (await f.run("verify")).stages.find((item) => item.stage === "verify")!
        .status
    ).toBe("pending");
    expect(readFileSync(f.planPath)).toEqual(plan);
    expect(readFileSync(f.dispatchPath)).toEqual(dispatch);
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    expect(f.retainedWrites()).toBe(1);
    f.finishNative();
    const result = await f.run("acknowledge");
    expect(result.stages.every((item) => item.status === "succeeded")).toBe(
      true
    );
    expect(
      JSON.parse(readFileSync(weeklyPath, "utf8")).publishedCutoffEpochMs
    ).toBe(cutoff);
    const head = f.store.read().head;
    expect(await f.run("acknowledge")).toEqual(result);
    expect(f.store.read().head).toBe(head);
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    expect(f.retainedWrites()).toBe(1);
    expect(catalogDigest()).toBe(before);
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
    expect(doubles.build).toHaveBeenCalledTimes(1);
  }, 180_000);

  it("recovers a persisted weekly claim plan before any remote retention or dispatch effect", async () => {
    const f = await publicationFixture(),
      head = f.store.read().head;
    await expect(
      f.run("dispatch", (event) => {
        if (event.stage === "deploy" && event.phase === "artifact-saved")
          throw new Error("Pause durable claim plan");
      })
    ).rejects.toThrow("Pause durable claim plan");
    expect(f.retainedWrites()).toBe(0);
    expect(f.requests).toHaveLength(0);
    expect(f.store.read().head).toBe(head);
    const plan = readFileSync(f.planPath);
    expect(
      (await f.run("dispatch")).stages.find((item) => item.stage === "deploy")
    ).toMatchObject({ status: "running", attempt: 1 });
    expect(readFileSync(f.planPath)).toEqual(plan);
    expect(f.retainedWrites()).toBe(1);
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    const db = new DatabaseSync(join(home, "weekly-runs.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        db
          .prepare(
            "SELECT count(*) AS total FROM stage_artifact WHERE stage='deploy'"
          )
          .get()!.total
      ).toBe(0);
    } finally {
      db.close();
    }
  }, 90_000);

  it("keeps uncertain weekly dispatch pending and never repeats POST when recovery cannot find a run", async () => {
    const f = await publicationFixture();
    f.loseResponse();
    f.noRun();
    const initial = await f.run("dispatch"),
      head = f.store.read().head;
    expect(initial.stages.find((item) => item.stage === "deploy")!.status).toBe(
      "running"
    );
    const plan = readFileSync(f.planPath),
      dispatch = readFileSync(f.dispatchPath);
    expect(await f.run("dispatch")).toEqual(initial);
    expect(f.store.read().head).toBe(head);
    expect(readFileSync(f.planPath)).toEqual(plan);
    expect(readFileSync(f.dispatchPath)).toEqual(dispatch);
    expect(
      f.requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    expect(f.retainedWrites()).toBe(1);
  }, 90_000);

  it("rejects a changed weekly publication plan and a competing native owner without sending POST", async () => {
    const f = await publicationFixture();
    await expect(
      f.run("dispatch", (event) => {
        if (event.stage === "deploy" && event.phase === "artifact-saved")
          throw new Error("Pause publication");
      })
    ).rejects.toThrow("Pause publication");
    const saved = readFileSync(f.planPath),
      plan = JSON.parse(saved.toString("utf8"));
    plan.workflowCommit = "d".repeat(40);
    writeFileSync(f.planPath, canonicalJson(plan) + "\n");
    await expect(f.run("dispatch")).rejects.toThrow(
      "Changed publisher workflow"
    );
    expect(f.retainedWrites()).toBe(0);
    expect(f.requests).toHaveLength(0);
    writeFileSync(f.planPath, saved);
    f.claimAnother();
    const competingHead = f.store.read().head;
    await expect(f.run("dispatch")).rejects.toThrow("requires reconciliation");
    expect(f.store.read().head).toBe(competingHead);
    expect(f.requests).toHaveLength(0);
    expect(
      JSON.parse(
        readFileSync(join(root, "data/ingestion/weekly-editions.json"), "utf8")
      ).publishedCutoffEpochMs
    ).toBeNull();
  }, 90_000);

  it("adopts native sealed delivery through verification and acknowledgement without rebuilding or reimporting", async () => {
    const f = await deliveryFixture(),
      before = catalogDigest();
    const nativeHead = f.store.read().head;
    const verified = await f.run("verify");
    expect(
      verified.stages.slice(0, 10).every((item) => item.status === "succeeded")
    ).toBe(true);
    expect(verified.stages.at(-1)!.status).toBe("pending");
    const weeklyPath = join(root, "data/ingestion/weekly-editions.json");
    expect(
      JSON.parse(readFileSync(weeklyPath, "utf8")).publishedCutoffEpochMs
    ).toBeNull();
    expect(f.store.read().head).toBe(nativeHead);
    const completed = await f.run("acknowledge");
    expect(completed.stages.every((item) => item.status === "succeeded")).toBe(
      true
    );
    expect(
      JSON.parse(readFileSync(weeklyPath, "utf8")).publishedCutoffEpochMs
    ).toBe(cutoff);
    expect(parsePromotionControl(f.store.read().bytes!).active).toBeNull();
    const finalHead = f.store.read().head,
      weekly = readFileSync(weeklyPath);
    expect(await f.run("acknowledge")).toEqual(completed);
    expect(f.store.read().head).toBe(finalHead);
    expect(readFileSync(weeklyPath)).toEqual(weekly);
    expect(catalogDigest()).toBe(before);
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(1);
    expect(doubles.build).toHaveBeenCalledTimes(1);
  }, 120_000);

  it.each(["deploy", "verify"] as const)(
    "resumes interrupted %s authority artifact without another attempt or native effect",
    async (interruptedStage) => {
      const f = await deliveryFixture(),
        head = f.store.read().head,
        before = catalogDigest();
      const interruption = new Error("Synthetic delivery interruption");
      await expect(
        f.run("verify", (event) => {
          if (
            event.stage === interruptedStage &&
            event.phase === "artifact-saved"
          )
            throw interruption;
        })
      ).rejects.toBe(interruption);
      const interrupted = journalState();
      expect(
        interrupted.stages.find((item) => item.stage === interruptedStage)
      ).toMatchObject({ status: "running", attempt: 1 });
      const result = await f.run("verify");
      for (const name of ["deploy", "verify"])
        expect(result.stages.find((item) => item.stage === name)).toMatchObject(
          { status: "succeeded", attempt: 1 }
        );
      expect(result.revision).toBe(f.validated.revision + 4);
      expect(f.store.read().head).toBe(head);
      expect(catalogDigest()).toBe(before);
      expect(doubles.build).toHaveBeenCalledTimes(1);
    },
    90_000
  );

  it.each(["noncanonical", "unpublished-fork"] as const)(
    "rejects a rehashed %s delivery anchor without adopting verification",
    async (variant) => {
      const f = await deliveryFixture(),
        head = f.store.read().head,
        before = catalogDigest();
      await expect(
        f.run("verify", (event) => {
          if (event.stage === "deploy" && event.phase === "artifact-saved")
            throw new Error("Pause delivery artifact");
        })
      ).rejects.toThrow("Pause delivery artifact");
      const db = new DatabaseSync(join(home, "weekly-runs.sqlite"));
      try {
        const row = db
          .prepare("SELECT bytes FROM stage_artifact WHERE stage='deploy'")
          .get()!;
        const anchor = JSON.parse(
          Buffer.from(row.bytes as Uint8Array).toString()
        ) as { controlHead: string; controlSha256: string };
        if (variant === "unpublished-fork") {
          const { receiptId: _receiptId, ...body } =
            f.control.active!.verification!;
          body.verifiedAt = "2026-10-14T18:00:01.000Z";
          const fork = applyPromotionTransition(f.deployed, {
            type: "verified",
            ...f.owner,
            verification: { ...body, receiptId: promotionDigest(body) },
            replayProof: null,
          });
          const prepared = f.store.prepareAppend({
            expectedHead: f.deployedHead,
            bytes: serializePromotionControl(fork),
            createdAt: f.createdAt,
          });
          anchor.controlHead = prepared.attemptedHead;
          anchor.controlSha256 = hash(prepared.bytes);
        }
        const bytes = Buffer.from(
          variant === "noncanonical"
            ? JSON.stringify(anchor, null, 2) + "\n"
            : canonicalJson(anchor) + "\n"
        );
        db.prepare(
          "UPDATE stage_artifact SET bytes=?,identity=? WHERE stage='deploy'"
        ).run(bytes, hash(bytes));
      } finally {
        db.close();
      }
      await expect(f.run("verify")).rejects.toThrow(
        variant === "noncanonical"
          ? "Noncanonical delivery anchor"
          : "canonical ancestor"
      );
      expect(
        journalState().stages.find((item) => item.stage === "verify")!.status
      ).toBe("pending");
      expect(f.store.read().head).toBe(head);
      expect(catalogDigest()).toBe(before);
      expect(
        JSON.parse(
          readFileSync(
            join(root, "data/ingestion/weekly-editions.json"),
            "utf8"
          )
        ).publishedCutoffEpochMs
      ).toBeNull();
    },
    90_000
  );

  it("rejects canonical native verification naming a different sealed candidate", async () => {
    const f = await deliveryFixture(true),
      head = f.store.read().head,
      before = catalogDigest();
    await expect(f.run("verify")).rejects.toThrow("Native candidate mismatch");
    expect(
      journalState().stages.find((item) => item.stage === "verify")!.status
    ).toBe("pending");
    expect(f.store.read().head).toBe(head);
    expect(catalogDigest()).toBe(before);
    expect(doubles.build).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("rejects a preview-purpose sealed candidate before reading native delivery authority", async () => {
    const f = await deliveryFixture(false, "preview"),
      before = catalogDigest();
    const head = f.store.read().head;
    const weeklyPath = join(root, "data/ingestion/weekly-editions.json");
    const weekly = readFileSync(weeklyPath);
    const read = vi.spyOn(f.store, "read"),
      readAt = vi.spyOn(f.store, "readAt");
    await expect(f.run("verify")).rejects.toThrow(
      "CANDIDATE_BUILD_PURPOSE_MISMATCH"
    );
    expect(read).not.toHaveBeenCalled();
    expect(readAt).not.toHaveBeenCalled();
    expect(journalState()).toEqual(f.validated);
    expect(readFileSync(weeklyPath)).toEqual(weekly);
    expect(catalogDigest()).toBe(before);
    read.mockRestore();
    readAt.mockRestore();
    expect(f.store.read().head).toBe(head);
  }, 60_000);

  it("fails closed on delivery activation flags before import, journal, candidate or native effects", async () => {
    const store = initializeControl(),
      before = catalogDigest();
    for (const flags of [
      {},
      { controlledPublishing: "enabled" },
      { controlledPublishing: "true", manualPublisherJoined: "true" },
      { controlledPublishing: "enabled", manualPublisherJoined: "false" },
    ])
      await expect(
        runWeeklyImport({
          root,
          runId: "a".repeat(64),
          stopAfter: "acknowledge",
          verifiedDelivery: { store, candidate: Buffer.from("must not parse") },
          ...flags,
        })
      ).rejects.toThrow("VERIFIED_DELIVERY_NOT_ENABLED");
    await expect(
      runWeeklyImport({
        root,
        source,
        stopAfter: "verify",
        verifiedDelivery: { store, candidate: Buffer.from("must not parse") },
        controlledPublishing: "enabled",
        manualPublisherJoined: "true",
      })
    ).rejects.toThrow("VERIFIED_DELIVERY_NOT_ENABLED");
    expect(existsSync(join(home, "weekly-runs.sqlite"))).toBe(false);
    expect(existsSync(join(root, "data/ingestion/weekly-editions.json"))).toBe(
      false
    );
    expect(store.read()).toEqual({ head: null, bytes: null });
    expect(catalogDigest()).toBe(before);
    expect(readSqliteLedger(sqlitePath).runs).toHaveLength(0);
    expect(doubles.build).not.toHaveBeenCalled();
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
