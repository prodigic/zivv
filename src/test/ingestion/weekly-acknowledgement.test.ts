import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { acknowledgeVerifiedWeeklyRelease } from "../../lib/ingestion/weekly-acknowledgement.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
  type StageEvidence,
  type WeeklyRunStage,
} from "../../lib/ingestion/weekly-run-state.js";
import { CANDIDATE_CONFIG_FILES } from "../../lib/ingestion/export-configuration.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import {
  parseReleaseCandidate,
  type ReleaseCandidate,
} from "../../lib/ingestion/release-candidate.js";
import {
  parseWeeklyEditionLedger,
  serializeWeeklyEditionLedger,
  type WeeklyEditionLedger,
} from "../../lib/ingestion/weekly.js";
import {
  applyPromotionTransition,
  candidatePublicReleaseId,
  claimPromotion,
  createCompletionProof,
  createPromotionControl,
  parsePromotionControl,
  promotionAttemptId,
  promotionDigest,
  serializePromotionControl,
  validatePromotionAppend,
  verifyCompletionProof,
  type PromotionEvent,
} from "../../lib/ingestion/promotion-control.js";
import {
  createLocalPromotionControlStore,
  type PromotionControlStore,
} from "../../lib/ingestion/promotion-control-git.js";
import {
  PROMOTION_FIXTURE_CHECKS,
  syntheticLegacyPublicSnapshot,
} from "./fixtures/promotion-control-fixture.js";

// Native Git control objects, private SQLite ownership/artifacts and candidate
// parsing are real. The disposable checkout uses the JSON writer lock because
// this stage mutates only the separately versioned weekly file, never a catalog.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 15_000 });
const scope = "prodigic/zivv/production";
const ref = "refs/heads/zivv-promotion-control/production";
const cutoff = Date.parse("2026-10-09T21:00:00Z");
const createdAt = "2026-10-14T18:00:00.000Z";
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const base = mkdtempSync(join(tmpdir(), "zivv-weekly-acknowledgement-"));
const opened: WeeklyRunJournal[] = [];
const disposable: string[] = [];
const templates = new Map<
  boolean,
  { root: string; candidate: ReleaseCandidate; deployedHead: string }
>();

function git(root: string, args: string[]) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  return execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}
function controlStore(root: string) {
  return createLocalPromotionControlStore({
    repositoryRoot: root,
    destination: "production",
    validateState(bytes, destination) {
      const state = parsePromotionControl(bytes);
      if (state.destination !== destination)
        throw new Error("Wrong fixture destination");
      return state.completionRoot;
    },
    validateTransition: validatePromotionAppend,
  });
}
function candidateFor(weekly: Buffer): ReleaseCandidate {
  const configuration = CANDIDATE_CONFIG_FILES.map((path) => ({
    path,
    sha256: path === "ingestion/weekly-editions.json" ? hash(weekly) : null,
  }));
  const body: Omit<ReleaseCandidate, "candidateId"> = {
    schemaVersion: 1,
    sourceCommit: "a".repeat(40),
    basePath: "/zivv/",
    ledgerRevision: "1".repeat(64),
    snapshotSha256: "2".repeat(64),
    configSha256: hash(canonicalJson(configuration)),
    configuration,
    editionId: "2026-10-09",
    cutoffEpochMs: cutoff,
    membershipSha256: hash(canonicalJson([101])),
    datasetVersion: "2026-10-09T21:00:00.000Z",
    manifestSha256: "3".repeat(64),
    applicationBuildSha256: "4".repeat(64),
    applicationProvenanceSha256: "6".repeat(64),
    files: [
      { path: "data/manifest.json", size: 5, sha256: "3".repeat(64) },
      { path: "index.html", size: 10, sha256: "5".repeat(64) },
    ],
  };
  return parseReleaseCandidate(
    Buffer.from(
      canonicalJson({ ...body, candidateId: hash(canonicalJson(body)) })
    )
  );
}
function seedNative(
  root: string,
  candidate: ReleaseCandidate,
  changedInventory = false
) {
  const store = controlStore(root);
  let head: string | null = null;
  let state = createPromotionControl(syntheticLegacyPublicSnapshot());
  const persist = () => {
    const result = store.compareAndAppend({
      expectedHead: head,
      bytes: serializePromotionControl(state),
      createdAt,
    });
    expect(result.status).toBe("appended");
    head = result.attemptedHead;
  };
  const step = (event: PromotionEvent) => {
    state = applyPromotionTransition(state, event);
    persist();
  };
  persist();
  state = claimPromotion(state, {
    requestId: "weekly-acknowledgement-fixture",
    payloadCommit: "e".repeat(40),
    candidateId: candidate.candidateId,
    sourceCommit: candidate.sourceCommit,
    basePath: "/zivv/",
    purpose: "release",
    publicInventorySha256: changedInventory
      ? "8".repeat(64)
      : promotionDigest(candidate.files),
    expectedVerifiedReleaseId: state.lastVerified.releaseId,
  });
  persist();
  const operationId = state.active!.operationId,
    workflowCommit = "b".repeat(40);
  const attemptId = promotionAttemptId(
    operationId,
    "promote",
    1,
    workflowCommit,
    1
  );
  const owner = { operationId, attemptId, mode: "promote" as const };
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
  const deployedHead = head!;
  const body = {
    destination: "production" as const,
    liveUrl: "https://www.prodigic.com/zivv/",
    releaseId: candidatePublicReleaseId("production", state.active!.request),
    inventorySha256: state.active!.request.publicInventorySha256,
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
  return { deployedHead };
}
function fixture(correction = false) {
  let template = templates.get(correction);
  if (!template) {
    const root = join(
      base,
      correction ? "template-correction" : "template-initial"
    );
    mkdirSync(join(root, "data/ingestion"), { recursive: true });
    git(root, ["init", "--quiet", "--object-format=sha1"]);
    const weekly: WeeklyEditionLedger = {
      schemaVersion: 1,
      publishedCutoffEpochMs: correction ? cutoff : null,
      editions: [
        {
          editionId: "2026-10-09",
          startEpochMs: cutoff - 604800000,
          endEpochMs: cutoff,
          eventIds: [101],
          datasetVersion: "2026-10-09T21:00:00.000Z",
          status: correction ? "published" : "draft",
        },
      ],
    };
    const bytes = Buffer.from(serializeWeeklyEditionLedger(weekly));
    writeFileSync(join(root, "data/ingestion/weekly-editions.json"), bytes);
    const candidate = candidateFor(bytes);
    template = { root, candidate, ...seedNative(root, candidate) };
    templates.set(correction, template);
  }
  const directory = mkdtempSync(join(base, "case-"));
  disposable.push(directory);
  const root = join(directory, "checkout");
  cpSync(template.root, root, { recursive: true });
  const journal = new WeeklyRunJournal(join(directory, "operator"));
  opened.push(journal);
  const lease = journal.acquire(scope, 3600000);
  const candidate = structuredClone(template.candidate);
  let state = journal.create(
    createWeeklyRunState({
      editionId: candidate.editionId,
      deliveryId: "synthetic-delivery",
      rawSha256: "a".repeat(64),
      rulesSha256: "b".repeat(64),
      importObservedAtEpochMs: cutoff - 10000,
    }),
    lease
  );
  const common = {
    candidateId: candidate.candidateId,
    manifestSha256: candidate.manifestSha256,
  };
  const stageEvidence: Partial<Record<WeeklyRunStage, StageEvidence>> = {
    acquire: {
      rawSha256: state.source.rawSha256,
      deliveryId: state.source.deliveryId,
    },
    prepare: {
      preparedSha256: "c".repeat(64),
      rulesSha256: state.source.rulesSha256,
    },
    reconcile: {
      ledgerRevision: candidate.ledgerRevision,
      reportSha256: "d".repeat(64),
      preparedSha256: "c".repeat(64),
    },
    load: {
      ledgerRevision: candidate.ledgerRevision,
      importRunId: "import-fixture",
      reviewedLedgerRevision: candidate.ledgerRevision,
      reportSha256: "d".repeat(64),
      preparedSha256: "c".repeat(64),
    },
    freeze: {
      editionId: candidate.editionId,
      cutoffEpochMs: cutoff,
      membershipSha256: candidate.membershipSha256,
      preCutoffPendingCount: 0,
      mode: correction ? "correction" : "initial",
      ledgerRevision: candidate.ledgerRevision,
    },
    enrich: { configSha256: candidate.configSha256 },
    export: {
      ...common,
      ledgerRevision: candidate.ledgerRevision,
      snapshotRevision: candidate.ledgerRevision,
      datasetVersion: candidate.datasetVersion,
      editionId: candidate.editionId,
      cutoffEpochMs: cutoff,
      membershipSha256: candidate.membershipSha256,
      configSha256: candidate.configSha256,
    },
    validate: common,
    deploy: { ...common, deploymentId: "301", destination: "production" },
    verify: { ...common, deploymentId: "301", destination: "production" },
  };
  for (const [stage, evidence] of Object.entries(stageEvidence)) {
    for (const transition of [
      { status: "running" as const },
      { status: "succeeded" as const, evidence },
    ]) {
      state = journal.save(
        transitionWeeklyRun(
          state,
          state.revision,
          stage as WeeklyRunStage,
          transition,
          Date.now()
        ),
        state.revision,
        lease
      );
    }
  }
  const store = controlStore(root),
    weeklyPath = join(root, "data/ingestion/weekly-editions.json");
  const current = () => journal.loadOwned(state.runId, lease);
  const readControl = () => parsePromotionControl(store.read().bytes!);
  const run = async (
    options: Partial<
      Parameters<typeof acknowledgeVerifiedWeeklyRelease>[0]
    > = {}
  ) =>
    acknowledgeVerifiedWeeklyRelease({
      root,
      state: current(),
      journal,
      lease,
      store,
      candidate: Buffer.from(canonicalJson(candidate)),
      verifyContext: () => journal.checkOwnership(lease),
      ...options,
    });
  return {
    root,
    journal,
    lease,
    state,
    store,
    candidate,
    weeklyPath,
    current,
    readControl,
    run,
    deployedHead: template.deployedHead,
  };
}
afterEach(() => {
  for (const journal of opened.splice(0)) journal.close();
  for (const path of disposable.splice(0)) {
    if (
      !resolve(path).startsWith(resolve(base) + "/") &&
      !resolve(path).startsWith(resolve(base) + "\\")
    )
      throw new Error("Unsafe fixture cleanup");
    rmSync(path, { recursive: true, force: true });
  }
});
afterAll(() => {
  if (
    !resolve(base).startsWith(resolve(tmpdir(), "zivv-weekly-acknowledgement-"))
  )
    throw new Error("Unsafe template cleanup");
  rmSync(base, { recursive: true, force: true });
});

describe("verified weekly acknowledgement with native control and private journal", () => {
  it("writes the exact cutoff before remote completion, then journals success and replays without another effect", async () => {
    const f = fixture(),
      original = readFileSync(f.weeklyPath),
      initial = f.store.read().head;
    const phases: string[] = [];
    const result = await f.run({
      onProgress: async (phase) => {
        phases.push(phase);
        const weekly = parseWeeklyEditionLedger(
          JSON.parse(readFileSync(f.weeklyPath, "utf8"))
        );
        if (phase === "intent-saved" || phase === "intent-bound")
          expect(readFileSync(f.weeklyPath)).toEqual(original);
        if (phase === "cutoff-written") {
          expect(weekly.publishedCutoffEpochMs).toBe(cutoff);
          expect(f.readControl().active!.acknowledgementIntent).toBeDefined();
        }
        if (phase === "remote-completed") {
          expect(weekly.publishedCutoffEpochMs).toBe(cutoff);
          expect(f.readControl().active).toBeNull();
          expect(f.current().stages.at(-1)!.status).toBe("running");
        }
      },
    });
    expect(phases).toEqual([
      "intent-saved",
      "intent-bound",
      "cutoff-written",
      "remote-completed",
    ]);
    expect(result.revision).toBe(f.state.revision + 2);
    expect(result.stages.at(-1)!.attempt).toBe(1);
    expect(result.stages.at(-1)!.status).toBe("succeeded");
    const completedHead = f.store.read().head!;
    expect(
      git(f.root, ["rev-list", "--count", `${initial}..${completedHead}`])
    ).toBe("2");
    const control = f.readControl();
    const proof = createCompletionProof(
      control.completionRoot,
      "weekly-acknowledgement-fixture",
      (id, type) => f.store.readCompletionObject(completedHead, id, type)
    );
    expect(
      verifyCompletionProof(
        control.completionRoot,
        "weekly-acknowledgement-fixture",
        proof
      )!.acknowledgementId
    ).toBe(result.stages.at(-1)!.evidence!.acknowledgementId);
    expect(await f.run()).toEqual(result);
    expect(f.store.read().head).toBe(completedHead);
    // This first case also builds the shared native Git history. On Windows
    // that measured 62 seconds; later cases copy the immutable template.
  }, 90_000);

  it.each([
    "intent-saved",
    "intent-bound",
    "cutoff-written",
    "remote-completed",
  ] as const)(
    "recovers interruption after %s using the same immutable intent and at most two native appends",
    async (phase) => {
      const f = fixture(),
        initial = f.store.read().head;
      await expect(
        f.run({
          onProgress: async (at) => {
            if (at === phase) throw new Error("Synthetic interruption");
          },
        })
      ).rejects.toThrow("Synthetic interruption");
      const interrupted = f.current(),
        item = interrupted.stages.at(-1)!;
      expect(item.status).toBe("running");
      expect(item.attempt).toBe(1);
      const saved = f.journal.readArtifact(
        interrupted.runId,
        "acknowledge",
        item.attempt
      );
      const result = await f.run();
      expect(result.revision).toBe(f.state.revision + 2);
      expect(result.stages.at(-1)!.attempt).toBe(1);
      expect(f.journal.readArtifact(result.runId, "acknowledge", 1)).toEqual(
        saved
      );
      expect(
        git(f.root, [
          "rev-list",
          "--count",
          `${initial}..${f.store.read().head}`,
        ])
      ).toBe("2");
      expect(f.readControl().completedCount).toBe(1);
      expect(await f.run()).toEqual(result);
    }
  );

  it.each(["missing", "unverified"])(
    "rejects %s native verification without changing weekly state or control",
    async (variant) => {
      const f = fixture();
      git(
        f.root,
        variant === "missing"
          ? ["update-ref", "-d", ref]
          : ["update-ref", ref, f.deployedHead]
      );
      const head = f.store.read().head,
        bytes = readFileSync(f.weeklyPath);
      await expect(f.run()).rejects.toThrow(
        variant === "missing"
          ? "Missing native control"
          : "Current verified release owner required"
      );
      expect(readFileSync(f.weeklyPath)).toEqual(bytes);
      expect(f.store.read().head).toBe(head);
    }
  );

  it("rejects a changed candidate identity and exact weekly configuration before remote effects", async () => {
    const f = fixture(),
      head = f.store.read().head,
      original = readFileSync(f.weeklyPath);
    const changed = { ...f.candidate, sourceCommit: "9".repeat(40) };
    const { candidateId: _candidateId, ...body } = changed;
    const other = Buffer.from(
      canonicalJson({ ...body, candidateId: hash(canonicalJson(body)) })
    );
    await expect(f.run({ candidate: other })).rejects.toThrow(
      "candidate candidateId changed"
    );
    const { candidateId: _oldId, ...unreviewed } = {
      ...f.candidate,
      applicationProvenanceSha256: null,
    };
    await expect(
      f.run({
        candidate: Buffer.from(
          canonicalJson({
            ...unreviewed,
            candidateId: hash(canonicalJson(unreviewed)),
          })
        ),
      })
    ).rejects.toThrow("requires reviewed build provenance");
    expect(readFileSync(f.weeklyPath)).toEqual(original);
    writeFileSync(f.weeklyPath, Buffer.concat([original, Buffer.from("\n")]));
    const altered = readFileSync(f.weeklyPath);
    await expect(f.run()).rejects.toThrow("differs from sealed configuration");
    expect(readFileSync(f.weeklyPath)).toEqual(altered);
    expect(f.store.read().head).toBe(head);
  });

  it("rejects a changed weekly file after native intent binding without clearing the owner", async () => {
    const f = fixture();
    let altered!: Buffer;
    await expect(
      f.run({
        onProgress: async (phase) => {
          if (phase === "intent-bound") {
            altered = Buffer.concat([
              readFileSync(f.weeklyPath),
              Buffer.from("\n"),
            ]);
            writeFileSync(f.weeklyPath, altered);
          }
        },
      })
    ).rejects.toThrow("Weekly state changed before acknowledgement");
    expect(readFileSync(f.weeklyPath)).toEqual(altered);
    expect(f.readControl().active!.acknowledgementIntent).toBeDefined();
    expect(f.readControl().completedCount).toBe(0);
  });

  it("rejects the wrong lease and a superseded fence before effects", async () => {
    const f = fixture(),
      head = f.store.read().head,
      weekly = readFileSync(f.weeklyPath);
    await expect(
      f.run({
        lease: { ...f.lease, owner: "00000000-0000-0000-0000-000000000000" },
      })
    ).rejects.toThrow("fenced weekly run owner");
    f.journal.release(f.lease);
    const next = f.journal.acquire(scope);
    expect(next.fence).toBe(f.lease.fence + 1);
    await expect(f.run()).rejects.toThrow("fenced weekly run owner");
    expect(readFileSync(f.weeklyPath)).toEqual(weekly);
    expect(f.store.read().head).toBe(head);
  });

  it("uses native readback after the final append loses its response", async () => {
    const f = fixture();
    let lost = false,
      readbacks = 0;
    const store: PromotionControlStore = {
      ...f.store,
      compareAndAppend(input) {
        const result = f.store.compareAndAppend(input);
        if (parsePromotionControl(input.bytes).active === null && !lost) {
          lost = true;
          return { ...result, status: "uncertain" };
        }
        return result;
      },
      readback(input) {
        readbacks++;
        return f.store.readback(input);
      },
    };
    const result = await f.run({ store });
    expect(lost).toBe(true);
    expect(readbacks).toBe(1);
    expect(result.stages.at(-1)!.status).toBe("succeeded");
    expect(f.readControl().completedCount).toBe(1);
  });

  it("rejects verified native bytes for a different inventory even when candidate and deployment IDs match", async () => {
    const f = fixture(),
      weekly = readFileSync(f.weeklyPath);
    git(f.root, ["update-ref", "-d", ref]);
    seedNative(f.root, f.candidate, true);
    const head = f.store.read().head;
    await expect(f.run()).rejects.toThrow("Wrong native public inventory");
    expect(readFileSync(f.weeklyPath)).toEqual(weekly);
    expect(f.store.read().head).toBe(head);
  });

  it("holds the physical weekly writer lock through final native completion", async () => {
    const f = fixture();
    let checked = false;
    const store: PromotionControlStore = {
      ...f.store,
      compareAndAppend(input) {
        if (parsePromotionControl(input.bytes).active === null) {
          checked = true;
          // This is the same exclusive-create primitive used by the manual
          // JSON weekly writer. It must remain fenced during the final CAS.
          expect(() => {
            const fd = openSync(
              join(f.root, "data/ingestion/.writer.lock"),
              "wx"
            );
            closeSync(fd);
          }).toThrow(/EEXIST/);
        }
        return f.store.compareAndAppend(input);
      },
    };
    expect((await f.run({ store })).stages.at(-1)!.status).toBe("succeeded");
    expect(checked).toBe(true);
  });

  it("acknowledges an already published correction without advancing its cutoff", async () => {
    const f = fixture(true),
      bytes = readFileSync(f.weeklyPath);
    const result = await f.run();
    expect(readFileSync(f.weeklyPath)).toEqual(bytes);
    expect(
      parseWeeklyEditionLedger(JSON.parse(bytes.toString()))
        .publishedCutoffEpochMs
    ).toBe(cutoff);
    expect(result.stages.at(-1)!.status).toBe("succeeded");
    expect(f.readControl().active).toBeNull();
  });

  it("recovers historical completion after a new native owner and later weekly draft without rewriting either", async () => {
    const f = fixture();
    await expect(
      f.run({
        onProgress: async (phase) => {
          if (phase === "remote-completed")
            throw new Error("Synthetic completion interruption");
        },
      })
    ).rejects.toThrow("Synthetic completion interruption");
    const completed = f.store.read();
    const control = parsePromotionControl(completed.bytes!);
    if (control.lastVerified.kind !== "candidateRelease")
      throw new Error("Expected completed candidate");
    const request = {
      ...control.lastVerified.request,
      requestId: "later-weekly-owner",
      expectedVerifiedReleaseId: control.lastVerified.releaseId,
    };
    const next = claimPromotion(
      control,
      request,
      createCompletionProof(
        control.completionRoot,
        request.requestId,
        (id, type) => f.store.readCompletionObject(completed.head!, id, type)
      )
    );
    const append = f.store.compareAndAppend({
      expectedHead: completed.head,
      bytes: serializePromotionControl(next),
      createdAt,
    });
    expect(append.status).toBe("appended");
    const weekly = parseWeeklyEditionLedger(
      JSON.parse(readFileSync(f.weeklyPath, "utf8"))
    );
    weekly.editions.push({
      editionId: "2026-10-16",
      startEpochMs: cutoff,
      endEpochMs: cutoff + 604800000,
      eventIds: [],
      datasetVersion: "later-draft",
      status: "draft",
    });
    const advancedWeekly = Buffer.from(serializeWeeklyEditionLedger(weekly));
    writeFileSync(f.weeklyPath, advancedWeekly);
    const result = await f.run();
    expect(result.stages.at(-1)!.status).toBe("succeeded");
    expect(result.revision).toBe(f.state.revision + 2);
    expect(result.stages.at(-1)!.evidence!.controlHead).toBe(completed.head);
    expect(f.store.read().head).toBe(append.attemptedHead);
    expect(f.readControl().active!.request.requestId).toBe(request.requestId);
    expect(readFileSync(f.weeklyPath)).toEqual(advancedWeekly);
  }, 90_000);

  it("rejects tampered private intent bytes before native binding or cutoff effects", async () => {
    const f = fixture(),
      head = f.store.read().head,
      weekly = readFileSync(f.weeklyPath);
    await expect(
      f.run({
        onProgress: async (phase) => {
          if (phase === "intent-saved")
            throw new Error("Synthetic interruption");
        },
      })
    ).rejects.toThrow();
    const saved = f.journal.readArtifact(f.state.runId, "acknowledge", 1)!;
    const db = new DatabaseSync(f.journal.path);
    try {
      db.prepare(
        "UPDATE stage_artifact SET bytes=? WHERE stage='acknowledge'"
      ).run(Buffer.from("tampered"));
    } finally {
      db.close();
    }
    await expect(f.run()).rejects.toThrow("Changed stage artifact");
    const artifact = JSON.parse(saved.toString("utf8")) as {
      intent: { before: string; after: string };
    };
    artifact.intent.after = artifact.intent.before;
    const forged = Buffer.from(canonicalJson(artifact) + "\n");
    const alteredDb = new DatabaseSync(f.journal.path);
    try {
      alteredDb
        .prepare(
          "UPDATE stage_artifact SET bytes=?,identity=? WHERE stage='acknowledge'"
        )
        .run(forged, hash(forged));
    } finally {
      alteredDb.close();
    }
    await expect(f.run()).rejects.toThrow("Invalid acknowledgement mutation");
    expect(readFileSync(f.weeklyPath)).toEqual(weekly);
    expect(f.store.read().head).toBe(head);
  });
});
