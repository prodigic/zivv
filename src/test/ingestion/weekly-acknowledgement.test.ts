import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { acknowledgeVerifiedWeeklyRelease } from "../../lib/ingestion/weekly-acknowledgement.js";
import { inspectFridayVerifiedRelease } from "../../lib/ingestion/friday-verified-release.js";
import { FridayNoticeOutbox } from "../../lib/ingestion/friday-notice-outbox.js";
import { dispatchFridayPublicationNotice } from "../../lib/ingestion/friday-notice-dispatch.js";
import { createFridayGmailPublicationNoticeProvider } from "../../lib/ingestion/friday-gmail-notice-provider.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
  type StageEvidence,
  type WeeklyRunStage,
} from "../../lib/ingestion/weekly-run-state.js";
import { CANDIDATE_CONFIG_FILES } from "../../lib/ingestion/export-configuration.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  decryptLedgerSnapshot,
  loadBackupKey,
} from "../../lib/ingestion/encrypted-backup.js";
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
const coverageFiles = new Map<string, Buffer>([
  [
    "data/events-2026-10.json",
    Buffer.from(
      canonicalJson({
        chunkId: "2026-10",
        events: [
          { id: 101, artistIds: [1, 2], headlinerArtistId: 1, venueId: 7 },
          { id: 999, artistIds: [3], headlinerArtistId: 3, venueId: 8 },
        ],
      })
    ),
  ],
  [
    "data/artists.json",
    Buffer.from(
      canonicalJson([
        {
          id: 1,
          links: [{ kind: "website", url: "https://artist.example/" }],
          vibe: {
            summary: "A synthetic review summary",
            reviews: [{ url: "https://review.example/" }],
          },
        },
        {
          id: 2,
          links: [{ kind: "website", url: "javascript:alert(1)" }],
          vibe: { reviews: [{ url: "javascript:alert(1)" }] },
        },
        { id: 3, links: [], vibe: { reviews: [] } },
      ])
    ),
  ],
  [
    "data/venues.json",
    Buffer.from(
      canonicalJson([
        { id: 7 },
        {
          id: 8,
          mapLocation: {
            latitude: 37.8,
            longitude: -122.3,
            precision: "address",
            sourceUrl: "https://maps.example/",
          },
        },
      ])
    ),
  ],
]);
const coverageFileInfo = (path: string) => {
  const bytes = coverageFiles.get("data/" + path)!;
  return {
    filename: path,
    size: bytes.length,
    checksum: "sha256-" + hash(bytes),
  };
};
const siteDatasetVersion = "2026-10-10T01:00:00.000Z";
function fixtureManifest(weekly: WeeklyEditionLedger): Buffer {
  const { status: _status, ...edition } = weekly.editions[0]!;
  return Buffer.from(
    canonicalJson({
      datasetVersion: siteDatasetVersion,
      weeklyEdition: edition,
      chunks: {
        events: [
          {
            ...coverageFileInfo("events-2026-10.json"),
            chunkId: "2026-10",
            eventCount: 2,
          },
        ],
        artists: coverageFileInfo("artists.json"),
        venues: coverageFileInfo("venues.json"),
      },
    })
  );
}
function candidateFor(weekly: Buffer): ReleaseCandidate {
  const manifest = fixtureManifest(
    parseWeeklyEditionLedger(JSON.parse(weekly.toString("utf8")))
  );
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
    datasetVersion: siteDatasetVersion,
    manifestSha256: hash(manifest),
    applicationBuildSha256: "4".repeat(64),
    applicationProvenanceSha256: "6".repeat(64),
    files: [
      ...[...coverageFiles]
        .filter(([path]) => path < "data/manifest.json")
        .map(([path, bytes]) => ({
          path,
          size: bytes.length,
          sha256: hash(bytes),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      {
        path: "data/manifest.json",
        size: manifest.length,
        sha256: hash(manifest),
      },
      ...[...coverageFiles]
        .filter(([path]) => path > "data/manifest.json")
        .map(([path, bytes]) => ({
          path,
          size: bytes.length,
          sha256: hash(bytes),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
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
  const build = {
    sourceCommit: candidate.sourceCommit,
    purpose: "release",
    basePath: candidate.basePath,
    npmCli: join(root, "synthetic-npm-cli.js"),
  };
  const enrichment = Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      build,
      configuration: Object.fromEntries(
        CANDIDATE_CONFIG_FILES.map((path) => [
          path,
          path === "ingestion/weekly-editions.json"
            ? readFileSync(join(root, "data", path)).toString("base64")
            : null,
        ])
      ),
      configSha256: candidate.configSha256,
    }) + "\n"
  );
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
    enrich: {
      configSha256: candidate.configSha256,
      buildSha256: hash(canonicalJson(build)),
    },
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
      if (stage === "enrich" && transition.status === "running")
        journal.writeArtifact(state.runId, "enrich", enrichment, lease);
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
  const staleCapsule = () => {
    const db = new DatabaseSync(journal.path);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        "DELETE FROM stage_artifact WHERE run_id=? AND stage='acknowledge'"
      ).run(state.runId);
      db.prepare("UPDATE run_state SET revision=?,payload=? WHERE id=?").run(
        state.revision,
        canonicalJson(state),
        state.runId
      );
      db.exec("COMMIT");
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
  };
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
    staleCapsule,
    deployedHead: template.deployedHead,
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
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
  it("inspects only the exact current acknowledged release without changing state", async () => {
    const f = fixture();
    const candidate = Buffer.from(canonicalJson(f.candidate));
    const weekly = () =>
      parseWeeklyEditionLedger(JSON.parse(readFileSync(f.weeklyPath, "utf8")));
    expect(
      inspectFridayVerifiedRelease({
        state: f.state,
        candidate,
        manifest: fixtureManifest(weekly()),
        weeklyLedger: weekly(),
        store: f.store,
      })
    ).toBeNull();
    const completed = await f.run();
    const current = f.readControl();
    if (current.lastVerified.kind !== "candidateRelease")
      throw new Error("Expected verified fixture release");
    const ack = completed.stages.find(
      (stage) => stage.stage === "acknowledge"
    )!.evidence!;
    expect(current.lastVerified.request.requestId).not.toBe(completed.runId);
    const beforeHead = f.store.read().head;
    const beforeWeekly = readFileSync(f.weeklyPath);
    const beforeState = f.journal.loadOwned(completed.runId, f.lease);
    const append = vi.fn(f.store.compareAndAppend);
    const store = { ...f.store, compareAndAppend: append };
    const args = {
      state: completed,
      candidate,
      manifest: fixtureManifest(weekly()),
      weeklyLedger: weekly(),
      store,
    };
    expect(args.weeklyLedger.editions[0]!.datasetVersion).not.toBe(
      f.candidate.datasetVersion
    );
    const observed = inspectFridayVerifiedRelease(args);
    expect(observed).toEqual({
      status: "verified-release",
      editionId: "2026-10-09",
      liveUrl: "https://www.prodigic.com/zivv/",
      addedEventCount: 1,
      candidateId: f.candidate.candidateId,
      verificationReceiptId: current.lastVerified.verification.receiptId,
      acknowledgementId: ack.acknowledgementId,
      releaseId: current.lastVerified.releaseId,
      deduplicationKey: "friday/2026-10-09/published",
    });
    expect(inspectFridayVerifiedRelease(args)).toEqual(observed);

    const coverageArgs = {
      ...args,
      publicFiles: new Map([
        ...coverageFiles,
        ["data/manifest.json", args.manifest],
      ]),
    };
    const coveragePath = join(dirname(f.root), "coverage-outbox.sqlite");
    const coverageDb = new DatabaseSync(coveragePath);
    try {
      const outbox = FridayNoticeOutbox.initialize(coverageDb);
      outbox.enablePublicationNotices();
      expect(() =>
        outbox.recordVerifiedPublicationWithCoverage(coverageArgs)
      ).toThrow("INVALID_FRIDAY_NOTICE_OUTBOX");
      outbox.enablePublicationCoverage();
      outbox.enablePublicationCoverage();
      const pending =
        outbox.recordVerifiedPublicationWithCoverage(coverageArgs)!;
      expect(pending).toEqual({
        notice: {
          ...observed,
          coverage: {
            missingShowArtwork: 1,
            distinctArtists: 2,
            artistsWithoutLinks: 1,
            artistsWithoutReviews: 1,
            distinctVenues: 1,
            venuesWithoutMapLocation: 1,
          },
        },
        status: "pending",
        attemptId: null,
        receiptSha256: null,
      });
      expect(
        outbox.recordVerifiedPublicationWithCoverage(coverageArgs)
      ).toEqual(pending);
      const key = observed!.deduplicationKey;
      const altered = new Map(coverageArgs.publicFiles);
      altered.set("data/venues.json", Buffer.from("[]"));
      expect(() =>
        outbox.claimPublicationWithCoverage(key, () => ({
          ...coverageArgs,
          publicFiles: altered,
        }))
      ).toThrow();
      expect(outbox.inspectPublication(key)).toEqual(pending);
      const readEvidence = vi.fn(() => coverageArgs);
      const claimed = outbox.claimPublicationWithCoverage(key, readEvidence)!;
      expect(claimed).toMatchObject({
        ...pending,
        status: "delivery-unknown",
        attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      expect(readEvidence).toHaveBeenCalledTimes(1);
      expect(outbox.claimPublicationWithCoverage(key, readEvidence)).toBeNull();
      expect(readEvidence).toHaveBeenCalledTimes(1);
      const reopenedDb = new DatabaseSync(coveragePath);
      try {
        const reopened = new FridayNoticeOutbox(reopenedDb);
        expect(reopened.inspectPublication(key)).toEqual(claimed);
        const sent = reopened.confirmPublicationSent(
          key,
          claimed.attemptId!,
          "a".repeat(64)
        );
        expect(sent).toEqual({
          ...claimed,
          status: "sent",
          receiptSha256: "a".repeat(64),
        });
        expect(
          outbox.recordVerifiedPublicationWithCoverage(coverageArgs)
        ).toEqual(sent);
      } finally {
        reopenedDb.close();
      }
    } finally {
      coverageDb.close();
    }
    const gmailPath = join(dirname(f.root), "coverage-gmail-outbox.sqlite");
    let gmailDb = new DatabaseSync(gmailPath);
    let rawText = "";
    let posts = 0;
    let changedSentBody = true;
    const response = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== "https://gmail.googleapis.com")
        throw Error("UNEXPECTED_SYNTHETIC_ENDPOINT");
      if (url.pathname.endsWith("/profile")) {
        expect(init?.method).toBe("GET");
        return response({ emailAddress: "synthetic-sender@example.invalid" });
      }
      if (url.pathname.endsWith("/messages/send")) {
        expect(init?.method).toBe("POST");
        posts++;
        const body = JSON.parse(String(init?.body)) as { raw: string };
        rawText = Buffer.from(body.raw, "base64url").toString("utf8");
        throw Error("SYNTHETIC_LOST_RESPONSE");
      }
      if (url.pathname.endsWith("/messages/a1")) {
        const headers = rawText
          .split(/\r?\n/)
          .filter((line) =>
            /^(from|to|subject|message-id|x-zivv-notice):/i.test(line)
          )
          .map((line) => {
            const index = line.indexOf(":");
            return {
              name: line.slice(0, index),
              value: line.slice(index + 1).trim(),
            };
          });
        expect(init?.method).toBe("GET");
        expect(url.searchParams.get("format")).toBe("full");
        expect(url.searchParams.has("metadataHeaders")).toBe(false);
        const separator = rawText.indexOf("\r\n\r\n");
        expect(separator).toBeGreaterThan(0);
        const body = Buffer.from(
          rawText.slice(separator + 4) +
            (changedSentBody ? "unexpected replacement" : "")
        );
        return response({
          id: "a1",
          labelIds: ["SENT"],
          payload: {
            headers,
            mimeType: "text/plain",
            body: { size: body.length, data: body.toString("base64url") },
          },
        });
      }
      if (url.pathname.endsWith("/messages")) {
        expect(init?.method).toBe("GET");
        expect(url.searchParams.get("labelIds")).toBe("SENT");
        expect(url.searchParams.get("maxResults")).toBe("2");
        const marker = /^Message-ID: (.+)\r?$/m.exec(rawText)?.[1]?.trim();
        expect(marker).toBeTruthy();
        expect(url.searchParams.get("q")).toBe("rfc822msgid:" + marker);
        return response({ messages: [{ id: "a1" }] });
      }
      throw Error("UNEXPECTED_SYNTHETIC_ENDPOINT");
    };
    const provider = createFridayGmailPublicationNoticeProvider({
      expectedAccountId: "synthetic-sender@example.invalid",
      recipient: "synthetic-recipient@example.invalid",
      getAccessToken: async () => "synthetic-token",
      fetcher,
    });
    try {
      const outbox = FridayNoticeOutbox.initialize(gmailDb);
      outbox.enablePublicationCoverage();
      const queued =
        outbox.recordVerifiedPublicationWithCoverage(coverageArgs)!;
      const key = queued.notice.deduplicationKey;
      await expect(
        dispatchFridayPublicationNotice(
          outbox,
          key,
          () => coverageArgs,
          provider
        )
      ).rejects.toThrow("FRIDAY_NOTICE_DELIVERY_UNKNOWN");
      const held = outbox.inspectPublication(key)!;
      expect(held.status).toBe("delivery-unknown");
      for (const line of [
        "Live release https://www.prodigic.com/zivv/",
        "Added shows 1",
        "Shows without artwork 1 of 1",
        "Artists without a link 1 of 2",
        "Artists without a cited review 1 of 2",
        "Venues without a map location 1 of 1",
      ])
        expect(rawText).toContain(line);
      expect(posts).toBe(1);
      gmailDb.close();
      gmailDb = new DatabaseSync(gmailPath);
      const reopened = new FridayNoticeOutbox(gmailDb);
      const noReleaseReads = vi.fn(() => {
        throw Error("RECONCILIATION_MUST_USE_SAVED_CLAIM");
      });
      await expect(
        dispatchFridayPublicationNotice(reopened, key, noReleaseReads, provider)
      ).rejects.toThrow("FRIDAY_NOTICE_RECONCILIATION_UNAVAILABLE");
      expect(reopened.inspectPublication(key)).toEqual(held);
      changedSentBody = false;
      const sent = await dispatchFridayPublicationNotice(
        reopened,
        key,
        noReleaseReads,
        provider
      );
      expect(noReleaseReads).not.toHaveBeenCalled();
      expect(sent).toMatchObject({
        notice: queued.notice,
        status: "sent",
        attemptId: held.attemptId,
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(posts).toBe(1);
    } finally {
      gmailDb.close();
    }

    const staleDb = new DatabaseSync(
      join(dirname(f.root), "coverage-stale-outbox.sqlite")
    );
    try {
      const outbox = FridayNoticeOutbox.initialize(staleDb);
      outbox.enablePublicationCoverage();
      const queued =
        outbox.recordVerifiedPublicationWithCoverage(coverageArgs)!;
      let reads = 0;
      await expect(
        dispatchFridayPublicationNotice(
          outbox,
          queued.notice.deduplicationKey,
          () => {
            reads++;
            return reads === 1
              ? coverageArgs
              : {
                  ...coverageArgs,
                  store: {
                    ...store,
                    read: () => f.store.readAt(f.deployedHead),
                  },
                };
          },
          provider
        )
      ).rejects.toThrow("FRIDAY_PUBLICATION_NOTICE_EVIDENCE_CHANGED");
      expect(reads).toBe(2);
      expect(posts).toBe(1);
      expect(
        outbox.inspectPublication(queued.notice.deduplicationKey)?.status
      ).toBe("delivery-unknown");
    } finally {
      staleDb.close();
    }
    const outboxPath = join(dirname(f.root), "publication-outbox.sqlite");
    const outboxDb = new DatabaseSync(outboxPath);
    const peerDb = new DatabaseSync(outboxPath);
    try {
      const outbox = FridayNoticeOutbox.initialize(outboxDb);
      outbox.enablePublicationNotices();
      const preAck = { ...args, state: f.state };
      expect(outbox.recordVerifiedPublication(preAck)).toBeNull();
      const pending = outbox.recordVerifiedPublication(args)!;
      expect(pending).toEqual({
        notice: observed,
        status: "pending",
        attemptId: null,
        receiptSha256: null,
      });
      expect(outbox.recordVerifiedPublication(args)).toEqual(pending);
      const key = observed!.deduplicationKey;
      expect(() =>
        outbox.claimPublication(key, () => ({
          ...args,
          manifest: Buffer.from("{}"),
        }))
      ).toThrow("INVALID_FRIDAY_VERIFIED_RELEASE");
      expect(outbox.inspectPublication(key)).toEqual(pending);
      expect(() =>
        outbox.claimPublication(key, () => ({
          ...args,
          store: { ...store, read: () => f.store.readAt(f.deployedHead) },
        }))
      ).toThrow("INVALID_FRIDAY_VERIFIED_RELEASE");
      expect(outbox.inspectPublication(key)).toEqual(pending);
      const peer = new FridayNoticeOutbox(peerDb);
      const readEvidence = vi.fn(() => args);
      const claimed = outbox.claimPublication(key, readEvidence)!;
      expect(claimed).toMatchObject({
        notice: observed,
        status: "delivery-unknown",
        attemptId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
        receiptSha256: null,
      });
      expect(readEvidence).toHaveBeenCalledTimes(1);
      const shouldNotRead = vi.fn(() => args);
      expect(peer.claimPublication(key, shouldNotRead)).toBeNull();
      expect(shouldNotRead).not.toHaveBeenCalled();
      expect(peer.inspectPublication(key)).toEqual(claimed);
      const receiptSha256 = "a".repeat(64);
      expect(() =>
        peer.confirmPublicationSent(key, "bad-attempt", receiptSha256)
      ).toThrow("INVALID_FRIDAY_NOTICE_OUTBOX");
      const sent = peer.confirmPublicationSent(
        key,
        claimed.attemptId!,
        receiptSha256
      );
      expect(sent).toEqual({ ...claimed, status: "sent", receiptSha256 });
      expect(
        outbox.confirmPublicationSent(key, claimed.attemptId!, receiptSha256)
      ).toEqual(sent);
      expect(() =>
        outbox.confirmPublicationSent(key, claimed.attemptId!, "b".repeat(64))
      ).toThrow("INVALID_FRIDAY_NOTICE_OUTBOX");
      const reopenedDb = new DatabaseSync(outboxPath);
      try {
        const reopened = new FridayNoticeOutbox(reopenedDb);
        expect(reopened.inspectPublication(key)).toEqual(sent);
        expect(
          reopened.confirmPublicationSent(
            key,
            claimed.attemptId!,
            receiptSha256
          )
        ).toEqual(sent);
      } finally {
        reopenedDb.close();
      }
      outbox.enablePublicationCoverage();
      expect(outbox.inspectPublication(key)).toEqual(sent);
      expect(() =>
        outbox.recordVerifiedPublicationWithCoverage(coverageArgs)
      ).toThrow("FRIDAY_PUBLICATION_NOTICE_CONFLICT");
      expect(outbox.inspectPublication(key)).toEqual(sent);
      expect(outbox.recordVerifiedPublication(args)).toEqual(sent);
      expect(outbox.claimPublication(key, shouldNotRead)).toBeNull();
      expect(shouldNotRead).not.toHaveBeenCalled();
    } finally {
      peerDb.close();
      outboxDb.close();
    }

    expect(() =>
      inspectFridayVerifiedRelease({ ...args, manifest: Buffer.from("{}") })
    ).toThrow("INVALID_FRIDAY_VERIFIED_RELEASE");
    const membership = structuredClone(args.weeklyLedger);
    membership.editions[0]!.eventIds = [102];
    expect(() =>
      inspectFridayVerifiedRelease({ ...args, weeklyLedger: membership })
    ).toThrow("INVALID_FRIDAY_VERIFIED_RELEASE");
    const changedCutoff = structuredClone(args.weeklyLedger);
    changedCutoff.publishedCutoffEpochMs = cutoff - 1;
    expect(() =>
      inspectFridayVerifiedRelease({ ...args, weeklyLedger: changedCutoff })
    ).toThrow("INVALID_FRIDAY_VERIFIED_RELEASE");
    expect(() =>
      inspectFridayVerifiedRelease({ ...args, candidate: Buffer.from("{}") })
    ).toThrow("INVALID_FRIDAY_VERIFIED_RELEASE");
    expect(() =>
      inspectFridayVerifiedRelease({
        ...args,
        store: { ...store, ref: "refs/heads/not-production" },
      })
    ).toThrow("INVALID_FRIDAY_VERIFIED_RELEASE");
    expect(() =>
      inspectFridayVerifiedRelease({
        ...args,
        store: {
          ...store,
          readAt: () => {
            throw new Error("synthetic missing ancestor");
          },
        },
      })
    ).toThrow("INVALID_FRIDAY_VERIFIED_RELEASE");
    expect(() =>
      inspectFridayVerifiedRelease({
        ...args,
        store: { ...store, read: () => f.store.readAt(f.deployedHead) },
      })
    ).toThrow("INVALID_FRIDAY_VERIFIED_RELEASE");
    expect(append).not.toHaveBeenCalled();
    expect(f.store.read().head).toBe(beforeHead);
    expect(readFileSync(f.weeklyPath)).toEqual(beforeWeekly);
    expect(f.journal.loadOwned(completed.runId, f.lease)).toEqual(beforeState);
  }, 90_000);
  it("reconstructs an accepted acknowledgement intent from canonical history with its original bytes, digest and timestamp", async () => {
    const f = fixture(),
      before = readFileSync(f.weeklyPath);
    await expect(
      f.run({
        onProgress: async (phase) => {
          if (phase === "intent-bound")
            throw new Error("Synthetic bound interruption");
        },
      })
    ).rejects.toThrow("Synthetic bound interruption");
    const original = f.journal.readArtifact(f.state.runId, "acknowledge", 1)!;
    const binding = f.readControl().active!.acknowledgementIntent!;
    const boundHead = f.store.read().head!;
    expect(readFileSync(f.weeklyPath)).toEqual(before);
    f.staleCapsule();
    const append = vi.fn(f.store.compareAndAppend);
    const result = await f.run({
      store: { ...f.store, compareAndAppend: append },
    });
    expect(result.stages.at(-1)!.status).toBe("succeeded");
    expect(result.stages.at(-1)!.evidence!.acknowledgementId).toBe(
      binding.acknowledgementId
    );
    expect(f.journal.readArtifact(f.state.runId, "acknowledge", 1)).toEqual(
      original
    );
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0].expectedHead).toBe(boundHead);
    expect(f.readControl().completedCount).toBe(1);
  }, 90_000);

  it.each([false, true])(
    "repairs a stale draft after remote completion and private artifact loss (later owner %s) without another native append",
    async (laterOwner) => {
      const f = fixture(),
        before = readFileSync(f.weeklyPath);
      await expect(
        f.run({
          onProgress: async (phase) => {
            if (phase === "remote-completed")
              throw new Error("Synthetic completed interruption");
          },
        })
      ).rejects.toThrow("Synthetic completed interruption");
      const original = f.journal.readArtifact(f.state.runId, "acknowledge", 1)!;
      const after = readFileSync(f.weeklyPath),
        completedHead = f.store.read().head!;
      if (laterOwner) {
        const read = f.store.read(),
          control = parsePromotionControl(read.bytes!);
        if (control.lastVerified.kind !== "candidateRelease")
          throw new Error("Expected completed candidate");
        const request = {
          ...control.lastVerified.request,
          requestId: "later-recovery-owner",
          expectedVerifiedReleaseId: control.lastVerified.releaseId,
        };
        const next = claimPromotion(
          control,
          request,
          createCompletionProof(
            control.completionRoot,
            request.requestId,
            (id, type) => f.store.readCompletionObject(read.head!, id, type)
          )
        );
        expect(
          f.store.compareAndAppend({
            expectedHead: read.head,
            bytes: serializePromotionControl(next),
            createdAt,
          }).status
        ).toBe("appended");
      }
      const authoritativeHead = f.store.read().head;
      writeFileSync(f.weeklyPath, before);
      f.staleCapsule();
      const append = vi.fn(f.store.compareAndAppend);
      let locked = false;
      const result = await f.run({
        store: { ...f.store, compareAndAppend: append },
        verifyContext: () => {
          f.journal.checkOwnership(f.lease);
          const path = join(f.root, "data/ingestion/.writer.lock");
          if (existsSync(path)) {
            locked = true;
            expect(() => {
              const fd = openSync(path, "wx");
              closeSync(fd);
            }).toThrow(/EEXIST/);
          }
        },
      });
      expect(locked).toBe(true);
      expect(readFileSync(f.weeklyPath)).toEqual(after);
      expect(f.journal.readArtifact(f.state.runId, "acknowledge", 1)).toEqual(
        original
      );
      expect(result.stages.at(-1)!.status).toBe("succeeded");
      expect(result.stages.at(-1)!.evidence!.controlHead).toBe(completedHead);
      expect(append).not.toHaveBeenCalled();
      expect(f.store.read().head).toBe(authoritativeHead);
      if (laterOwner)
        expect(f.readControl().active!.request.requestId).toBe(
          "later-recovery-owner"
        );
    },
    // Real completion-trie validation and canonical history reconstruction
    // measured 62–65 seconds on Windows; assertions completed without failure.
    90_000
  );

  it.each([
    "missing-preimage",
    "wrong-preimage",
    "incomplete-history",
    "ambiguous-history",
  ])(
    "refuses canonical recovery with %s before weekly writes or native appends",
    async (problem) => {
      const f = fixture();
      await expect(
        f.run({
          onProgress: async (phase) => {
            if (phase === "intent-bound")
              throw new Error("Synthetic bound interruption");
          },
        })
      ).rejects.toThrow("Synthetic bound interruption");
      f.staleCapsule();
      if (problem.endsWith("preimage")) {
        const db = new DatabaseSync(f.journal.path);
        try {
          if (problem === "missing-preimage")
            db.prepare(
              "DELETE FROM stage_artifact WHERE run_id=? AND stage='enrich'"
            ).run(f.state.runId);
          else {
            const original = f.journal.readArtifact(
              f.state.runId,
              "enrich",
              1
            )!;
            const artifact: { configuration: Record<string, string | null> } =
              JSON.parse(original.toString());
            artifact.configuration["ingestion/weekly-editions.json"] =
              Buffer.concat([
                readFileSync(f.weeklyPath),
                Buffer.from("\n"),
              ]).toString("base64");
            const changed = Buffer.from(canonicalJson(artifact) + "\n");
            db.prepare(
              "UPDATE stage_artifact SET identity=?,bytes=? WHERE run_id=? AND stage='enrich'"
            ).run(hash(changed), changed, f.state.runId);
          }
        } finally {
          db.close();
        }
      }
      const append = vi.fn(f.store.compareAndAppend);
      const store: PromotionControlStore = {
        ...f.store,
        compareAndAppend: append,
        readCanonicalHistory(options) {
          const history = f.store.readCanonicalHistory!(options);
          if (problem === "incomplete-history") history.complete = false;
          if (problem === "ambiguous-history") {
            const entry = history.commits.find(
              (item) =>
                parsePromotionControl(item.bytes).lastTransition.event.type ===
                "acknowledgement-intent"
            );
            if (!entry)
              throw new Error("Missing fixture acknowledgement event");
            history.commits.unshift({
              ...entry,
              bytes: Buffer.from(entry.bytes),
              parentBytes:
                entry.parentBytes === null
                  ? null
                  : Buffer.from(entry.parentBytes),
            });
          }
          return history;
        },
      };
      const head = f.store.read().head,
        weekly = readFileSync(f.weeklyPath);
      await expect(f.run({ store })).rejects.toThrow();
      expect(readFileSync(f.weeklyPath)).toEqual(weekly);
      expect(f.store.read().head).toBe(head);
      expect(append).not.toHaveBeenCalled();
      expect(
        f.journal.readArtifact(f.state.runId, "acknowledge", 1)
      ).toBeNull();
    }
  );

  it("keeps a missing already-succeeded acknowledgement artifact as corruption instead of implicit recovery", async () => {
    const f = fixture();
    await f.run();
    const db = new DatabaseSync(f.journal.path);
    try {
      db.prepare(
        "DELETE FROM stage_artifact WHERE run_id=? AND stage='acknowledge'"
      ).run(f.state.runId);
    } finally {
      db.close();
    }
    const head = f.store.read().head,
      weekly = readFileSync(f.weeklyPath);
    const append = vi.fn(f.store.compareAndAppend);
    await expect(
      f.run({ store: { ...f.store, compareAndAppend: append } })
    ).rejects.toThrow("Missing completed acknowledgement intent");
    expect(readFileSync(f.weeklyPath)).toEqual(weekly);
    expect(f.store.read().head).toBe(head);
    expect(append).not.toHaveBeenCalled();
  });

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
    },
    // Remote-completed replay now rechecks its native proof under both locks;
    // this measured 70 seconds on Windows with all assertions completing.
    90_000
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

  it("rechecks journal ownership at the native compare-and-append boundary", async () => {
    const f = fixture(),
      weekly = readFileSync(f.weeklyPath),
      head = f.store.read().head;
    let injectDrift = true,
      lateCheckRan = false,
      contextFresh = true;
    const store: PromotionControlStore = {
      ...f.store,
      compareAndAppend(input) {
        expect(input.checkContext).toBeTypeOf("function");
        if (!injectDrift) return f.store.compareAndAppend(input);
        injectDrift = false;
        let checks = 0;
        return f.store.compareAndAppend({
          ...input,
          checkContext: () => {
            checks++;
            if (checks === 2) {
              lateCheckRan = true;
              try {
                contextFresh = false;
                input.checkContext!();
              } finally {
                contextFresh = true;
              }
            } else {
              input.checkContext!();
            }
          },
        });
      },
    };

    await expect(
      f.run({
        store,
        verifyContext: () => {
          f.journal.checkOwnership(f.lease);
          if (!contextFresh) throw new Error("Synthetic context drift");
        },
      })
    ).rejects.toThrow("Synthetic context drift");
    expect(lateCheckRan).toBe(true);
    expect(readFileSync(f.weeklyPath)).toEqual(weekly);
    expect(f.store.read().head).toBe(head);
    expect(f.readControl().active!.acknowledgementIntent).toBeUndefined();

    const result = await f.run({ store });
    expect(result.stages.at(-1)!.status).toBe("succeeded");
    expect(
      parseWeeklyEditionLedger(JSON.parse(readFileSync(f.weeklyPath, "utf8")))
        .publishedCutoffEpochMs
    ).toBe(cutoff);
    expect(f.readControl().completedCount).toBe(1);
  }, 90_000);

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

  it("refuses completed recovery when the stale draft contains an unrelated byte change", async () => {
    const f = fixture(),
      before = readFileSync(f.weeklyPath);
    await expect(
      f.run({
        onProgress: async (phase) => {
          if (phase === "remote-completed")
            throw new Error("Synthetic completed interruption");
        },
      })
    ).rejects.toThrow("Synthetic completed interruption");
    f.staleCapsule();
    const changed = Buffer.concat([before, Buffer.from("\n")]);
    writeFileSync(f.weeklyPath, changed);
    const head = f.store.read().head,
      append = vi.fn(f.store.compareAndAppend);
    await expect(
      f.run({ store: { ...f.store, compareAndAppend: append } })
    ).rejects.toThrow("Completed weekly edition changed");
    expect(readFileSync(f.weeklyPath)).toEqual(changed);
    expect(f.store.read().head).toBe(head);
    expect(append).not.toHaveBeenCalled();
  }, 90_000);

  it("repairs a completed stale draft through the shared SQLite lock and refreshes an exact unchanged catalog snapshot", async () => {
    const f = fixture(),
      before = readFileSync(f.weeklyPath);
    const completed = await f.run();
    const after = readFileSync(f.weeklyPath),
      head = f.store.read().head;
    const originalArtifact = f.journal.readArtifact(
      f.state.runId,
      "acknowledge",
      1
    );
    const home = dirname(f.journal.path),
      sqlitePath = join(home, "ledger.sqlite");
    vi.stubEnv("ZIVV_LEDGER_HOME", home);
    writeFileSync(
      join(f.root, "data/ingestion/store.json"),
      canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    const key = loadBackupKey(home, true);
    await writeSqliteLedger(
      sqlitePath,
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
      true
    );
    const digest = ledgerDigest(readSqliteLedger(sqlitePath));
    const snapshotPath = join(
      f.root,
      "data/ingestion/backups/ledger.snapshot.enc"
    );
    expect(existsSync(snapshotPath)).toBe(false);
    writeFileSync(f.weeklyPath, before);
    const append = vi.fn(f.store.compareAndAppend);
    expect(
      await f.run({ store: { ...f.store, compareAndAppend: append } })
    ).toEqual(completed);
    expect(readFileSync(f.weeklyPath)).toEqual(after);
    expect(f.journal.readArtifact(f.state.runId, "acknowledge", 1)).toEqual(
      originalArtifact
    );
    expect(ledgerDigest(readSqliteLedger(sqlitePath))).toBe(digest);
    expect(
      ledgerDigest(decryptLedgerSnapshot(readFileSync(snapshotPath), key))
    ).toBe(digest);
    expect(f.store.read().head).toBe(head);
    expect(append).not.toHaveBeenCalled();
  }, 90_000);
});
