import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPagesCandidateRunner,
  createPagesPublicArchive,
  PagesCreationUncertainError,
  readPagesRunnerIdentity,
  requirePagesScratchPaths,
  type PagesRunnerOptions,
} from "../../lib/ingestion/pages-candidate-runner.js";
import {
  applyPromotionTransition,
  claimPromotion,
  createPromotionControl,
  pagesCreationId,
  parsePromotionControl,
  promotionAttemptId,
  promotionDigest,
  serializePromotionControl,
  validatePromotionAppend,
} from "../../lib/ingestion/promotion-control.js";
import {
  createBareTestPromotionControlTransport,
  createRemotePromotionControlStore,
} from "../../lib/ingestion/promotion-control-git.js";
import { writePublicationPayloadGit } from "../../lib/ingestion/publication-git.js";
import { createPromotionControlFixture } from "./fixtures/promotion-control-fixture.js";
import { publicationTransportFixture } from "./fixtures/publication-transport-fixture.js";

describe("actual retained candidate Pages runner", { timeout: 120_000 }, () => {
  let directory: string, root: string, remote: string, scratch: string;
  let options: PagesRunnerOptions;
  let posts: number;
  let gets: string[];
  let postMode: "success" | "lost" | "rejected";
  let statuses: string[];
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  let fixture: ReturnType<typeof publicationTransportFixture>;
  const createdAt = "2026-10-14T23:00:00.000Z";
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "zivv-pages-runner-"));
    root = join(directory, "source");
    remote = join(directory, "remote.git");
    scratch = join(directory, "scratch");
    mkdirSync(root);
    mkdirSync(scratch);
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "Fixture"]);
    git(root, ["config", "user.email", "fixture@example.invalid"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, [
      "remote",
      "add",
      "origin",
      "https://github.com/prodigic/zivv.git",
    ]);
    git(directory, ["init", "--bare", "--quiet", remote]);
    writeFileSync(join(root, "reviewed.txt"), "reviewed fixture\n");
    git(root, ["add", "reviewed.txt"]);
    git(root, ["commit", "--quiet", "-m", "reviewed fixture"]);
    const workflowCommit = git(root, ["rev-parse", "HEAD"]);
    fixture = publicationTransportFixture(workflowCommit);
    git(root, ["push", "--quiet", remote, `${workflowCommit}:refs/heads/main`]);
    git(root, ["tag", `zivv-workflows/${workflowCommit}`]);
    git(root, ["update-ref", "refs/remotes/origin/main", workflowCommit]);
    const payloadCommit = writePublicationPayloadGit({
      repositoryRoot: root,
      files: fixture.payload.files,
      createdAt,
    }).payloadCommit;
    const transport = createBareTestPromotionControlTransport(root, remote);
    transport.append(
      `refs/heads/zivv-candidate-artifacts/${payloadCommit}`,
      payloadCommit,
      null
    );
    const store = createRemotePromotionControlStore({
      repositoryRoot: root,
      destination: "production",
      transport,
      validateState: (bytes) => parsePromotionControl(bytes).completionRoot,
      validateTransition: validatePromotionAppend,
    });
    const base = createPromotionControlFixture();
    const legacyCommit = writePublicationPayloadGit({
      repositoryRoot: root,
      files: fixture.payload.publicFiles,
      createdAt,
    }).payloadCommit;
    transport.append(
      `refs/heads/zivv-candidate-artifacts/${legacyCommit}`,
      legacyCommit,
      null
    );
    const legacyIdentity = {
      kind: "legacyPublicSnapshot" as const,
      destination: "production" as const,
      retainedCommit: legacyCommit,
      files: fixture.payload.receipt.candidate.files,
      inventorySha256: promotionDigest(fixture.payload.receipt.candidate.files),
    };
    const { receiptId: unusedReceiptId, ...legacyVerification } =
      base.snapshot.verification;
    void unusedReceiptId;
    const verificationBody = {
      ...legacyVerification,
      retainedCommit: legacyCommit,
      inventorySha256: legacyIdentity.inventorySha256,
    };
    base.state = createPromotionControl({
      ...legacyIdentity,
      releaseId: promotionDigest(legacyIdentity),
      verification: {
        ...verificationBody,
        receiptId: promotionDigest(verificationBody),
      },
    });
    base.request.expectedVerifiedReleaseId = base.state.lastVerified.releaseId;
    store.compareAndAppend({
      expectedHead: null,
      bytes: serializePromotionControl(base.state),
      createdAt,
    });
    const request = {
      ...base.request,
      payloadCommit,
      candidateId: fixture.expectation.expectedCandidateId,
      sourceCommit: fixture.expectation.expectedSourceCommit,
      publicInventorySha256: promotionDigest(
        fixture.payload.receipt.candidate.files
      ),
    };
    let state = claimPromotion(base.state, request);
    store.compareAndAppend({
      expectedHead: store.read().head,
      bytes: serializePromotionControl(state),
      createdAt,
    });
    const operationId = state.active!.operationId;
    const attemptId = promotionAttemptId(
      operationId,
      "promote",
      1,
      workflowCommit,
      1
    );
    state = applyPromotionTransition(state, {
      type: "dispatch-intent",
      operationId,
      mode: "promote",
      attemptId,
      attemptNumber: 1,
      workflowCommit,
      expectedRunAttempt: 1,
    });
    store.compareAndAppend({
      expectedHead: store.read().head,
      bytes: serializePromotionControl(state),
      createdAt,
    });
    posts = 0;
    gets = [];
    postMode = "success";
    statuses = ["succeed"];
    const admission = { workflowCommit, runId: "101", runAttempt: 1 };
    options = {
      repositoryRoot: root,
      transport,
      store,
      identity: {
        admission,
        inputs: {
          request_id: request.requestId,
          operation_id: operationId,
          attempt_id: attemptId,
          control_head: store.read().head!,
          payload_commit: payloadCommit,
          candidate_id: request.candidateId,
          source_commit: request.sourceCommit,
          mode: "promote",
          destination: "production",
        },
      },
      statePath: join(scratch, "state.json"),
      siteDirectory: join(scratch, "site"),
      archivePath: join(scratch, "artifact.tar"),
      githubToken: "fixture_token",
      artifactId: "501",
      getOidcToken: async () =>
        [
          "eyJmaXh0dXJlIjp0cnVlfQ",
          Buffer.from(
            JSON.stringify({
              iss: "https://token.actions.githubusercontent.com",
              repository: "prodigic/zivv",
              sha: workflowCommit,
              ref: `refs/tags/zivv-workflows/${workflowCommit}`,
              environment: "github-pages",
              run_id: "101",
              run_attempt: "1",
              exp: Date.now() / 1000 + 600,
            })
          ).toString("base64url"),
          "Zml4dHVyZQ",
        ].join("."),
      pollAttempts: 3,
      pollIntervalMs: 0,
      testTransport: {
        kind: "local-test",
        apiBaseUrl: "http://127.0.0.1:1",
        fetch: async (url, init) => {
          if (init?.method === "POST") {
            posts++;
            const current = parsePromotionControl(store.read().bytes!);
            expect(current.active!.phase).toBe(
              options.identity.inputs.mode === "rollback"
                ? "rollback-deployment-requested"
                : "deployment-requested"
            );
            const checkpoint = JSON.parse(
              readFileSync(options.statePath, "utf8")
            );
            expect(checkpoint.state.creationId).toBe(
              (options.identity.inputs.mode === "rollback"
                ? current.active!.rollbackAttempt
                : current.active!.promotionAttempt)!.pagesCreation!.creationId
            );
            if (postMode === "lost") throw new Error("lost response");
            if (postMode === "rejected")
              return new Response('{"message":"forbidden"}', { status: 403 });
            return new Response(
              JSON.stringify({
                id: "1234",
                page_url: "https://www.prodigic.com/zivv/",
                status_url:
                  "https://api.github.com/repos/prodigic/zivv/pages/deployments/1234/status",
              }),
              { status: 200 }
            );
          }
          gets.push(String(url));
          return new Response(
            JSON.stringify({
              id: "1234",
              status: statuses.shift() ?? "succeed",
            }),
            { status: 200 }
          );
        },
      },
    };
  }, 60_000);
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const runner = () => createPagesCandidateRunner(options);

  it("runs actual immutable-tag dispatch checks and rejects altered envelope or activation", () => {
    const eventPath = join(scratch, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        repository: { full_name: "prodigic/zivv", default_branch: "main" },
        inputs: options.identity.inputs,
      })
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ZIVV_CONTROLLED_PUBLISHING: "enabled",
      ZIVV_MANUAL_PUBLISHER_JOINED: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: "prodigic/zivv",
      GITHUB_SHA: options.identity.admission.workflowCommit,
      GITHUB_REF: `refs/tags/zivv-workflows/${options.identity.admission.workflowCommit}`,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_RUN_ID: "101",
      GITHUB_RUN_ATTEMPT: "1",
    };
    for (const [key, value] of Object.entries(options.identity.inputs))
      env[`ZIVV_${key.toUpperCase()}`] = value;
    expect(readPagesRunnerIdentity(env, root)).toEqual(options.identity);
    expect(() =>
      readPagesRunnerIdentity({ ...env, ZIVV_CONTROLLED_PUBLISHING: "" }, root)
    ).toThrow(/activation/);
    expect(() =>
      readPagesRunnerIdentity(
        { ...env, ZIVV_PAYLOAD_COMMIT: "f".repeat(40) },
        root
      )
    ).toThrow(/envelope/);
    expect(() =>
      readPagesRunnerIdentity({ ...env, GITHUB_REF: "refs/heads/main" }, root)
    ).toThrow(/immutable/);
  });
  it("admits, archives exact public bytes, creates once, polls exact ID and emits deployment-only receipt", async () => {
    runner().admit();
    runner().materialize();
    const paths = git(directory, ["-C", root, "rev-parse", "HEAD"]);
    expect(paths).toBe(options.identity.admission.workflowCommit);
    const archive = execFileSync("tar", ["-tf", options.archivePath], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(archive).toContain("index.html");
    expect(archive).toContain("data/manifest.json");
    expect(archive).not.toMatch(/receipt|recovery|snapshot|\.git/);
    await runner().requestDeployment();
    const checkpoint = JSON.parse(readFileSync(options.statePath, "utf8"));
    expect(checkpoint.state.receipt.deploymentId).toBe("1234");
    statuses = ["deployment_in_progress", "succeed"];
    await runner().status();
    expect(posts).toBe(1);
    expect(gets).toHaveLength(2);
    expect(gets.every((url) => url.endsWith("/1234"))).toBe(true);
    expect(runner().receipt()).toMatchObject({
      liveVerified: false,
      cutoffAcknowledged: false,
      classification: "succeeded",
    });
    expect(
      parsePromotionControl(options.store.read().bytes!).active!.phase
    ).toBe("deployed");
  });
  it("does not create again after an uncertain POST, including a fresh process checkpoint", async () => {
    runner().admit();
    runner().materialize();
    postMode = "lost";
    await expect(runner().requestDeployment()).rejects.toThrow(/uncertain/);
    await expect(runner().requestDeployment()).rejects.toThrow(
      /do not POST again/
    );
    expect(posts).toBe(1);
    expect(
      parsePromotionControl(options.store.read().bytes!).active!.phase
    ).toBe("deployment-requested");
  });
  it("rejects invalid OIDC before advancing the creation state", async () => {
    runner().admit();
    runner().materialize();
    options.getOidcToken = async () => "invalid";
    const head = options.store.read().head;
    await expect(runner().requestDeployment()).rejects.toThrow(/OIDC/);
    expect(options.store.read().head).toBe(head);
    expect(
      parsePromotionControl(options.store.read().bytes!).active!
        .promotionAttempt!.pagesCreation
    ).toBeUndefined();
    expect(posts).toBe(0);
  });
  it("allows only one simultaneous fresh caller to create a deployment", async () => {
    runner().admit();
    runner().materialize();
    const results = await Promise.allSettled([
      runner().requestDeployment(),
      runner().requestDeployment(),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
      JSON.stringify(
        results.map((result) =>
          result.status === "rejected" ? String(result.reason) : result.status
        )
      )
    ).toHaveLength(1);
    expect(posts).toBe(1);
    const checkpoint = JSON.parse(readFileSync(options.statePath, "utf8"));
    expect(checkpoint.state.creationId).toBe(
      parsePromotionControl(options.store.read().bytes!).active!
        .promotionAttempt!.pagesCreation!.creationId
    );
  });
  it("exposes the safe known identity when receipt persistence fails", async () => {
    runner().admit();
    runner().materialize();
    const original = options.testTransport!.fetch!;
    options.testTransport!.fetch = async (url, init) => {
      const response = await original(url, init);
      if (init?.method === "POST") {
        rmSync(options.statePath);
        mkdirSync(options.statePath);
      }
      return response;
    };
    try {
      await runner().requestDeployment();
      throw new Error("Expected persistence failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PagesCreationUncertainError);
      if (!(error instanceof PagesCreationUncertainError)) throw error;
      expect(error.recovery.receipt.deploymentId).toBe("1234");
      expect(JSON.stringify(error.recovery)).not.toContain("fixture_token");
    }
    expect(posts).toBe(1);
    expect(
      parsePromotionControl(options.store.read().bytes!).active!.phase
    ).toBe("deployment-requested");
  });
  it("resumes a valid scratch subset and rejects unrelated scratch files", () => {
    runner().admit();
    mkdirSync(options.siteDirectory);
    writeFileSync(
      join(options.siteDirectory, "index.html"),
      fixture.payload.publicFiles.get("index.html")!
    );
    expect(runner().materialize().status).toBe("materialized");
    writeFileSync(join(options.siteDirectory, "private.txt"), "not public");
    expect(() => runner().materialize()).toThrow(/inventory/);
  });
  it("refuses a competing requested intent without making a Pages POST", async () => {
    runner().admit();
    runner().materialize();
    const state = parsePromotionControl(options.store.read().bytes!);
    const { inputs, admission } = options.identity;
    const nonce = "7".repeat(64);
    const changed = applyPromotionTransition(state, {
      type: "pages-create-intent",
      operationId: inputs.operation_id,
      mode: "promote",
      attemptId: inputs.attempt_id,
      creationId: pagesCreationId(
        inputs.operation_id,
        inputs.attempt_id,
        1,
        nonce
      ),
      creationNumber: 1,
      nonce,
      artifactId: "999",
      admission,
    });
    options.store.compareAndAppend({
      expectedHead: options.store.read().head,
      bytes: serializePromotionControl(changed),
      createdAt,
    });
    await expect(runner().requestDeployment()).rejects.toThrow(
      /do not POST again/
    );
    expect(posts).toBe(0);
  });
  it("permits a fresh creation only after a durable definitive rejection", async () => {
    runner().admit();
    runner().materialize();
    postMode = "rejected";
    await expect(runner().requestDeployment()).rejects.toThrow(/rejected/);
    const rejected = parsePromotionControl(options.store.read().bytes!).active!
      .promotionAttempt!.pagesCreation!;
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionHttpStatus).toBe(403);
    postMode = "success";
    await runner().requestDeployment();
    const attached = parsePromotionControl(options.store.read().bytes!).active!
      .promotionAttempt!.pagesCreation!;
    expect(attached.creationNumber).toBe(2);
    expect(attached.nonce).not.toBe(rejected.nonce);
    expect(posts).toBe(2);
  });
  it("recovers an attached exact controller receipt after scratch loss without another POST", async () => {
    runner().admit();
    runner().materialize();
    await runner().requestDeployment();
    rmSync(options.statePath);
    await runner().status();
    expect(posts).toBe(1);
    expect(runner().receipt().deployment.deploymentId).toBe("1234");
  });
  it("retains owner on bounded or uncertain status and denies premature success receipts", async () => {
    runner().admit();
    runner().materialize();
    await runner().requestDeployment();
    statuses = [
      "deployment_in_progress",
      "deployment_in_progress",
      "deployment_in_progress",
    ];
    await expect(runner().status()).rejects.toThrow(/exhausted/);
    expect(() => runner().receipt()).toThrow(/successful/);
    expect(
      parsePromotionControl(options.store.read().bytes!).active
    ).not.toBeNull();
  });
  it("rejects a changed retained reference or modified verified archive before creation", async () => {
    runner().admit();
    runner().materialize();
    writeFileSync(options.archivePath, "tampered");
    await expect(runner().requestDeployment()).rejects.toThrow(/archive/);
    expect(posts).toBe(0);
    git(remote, [
      "update-ref",
      "-d",
      `refs/heads/zivv-candidate-artifacts/${options.identity.inputs.payload_commit}`,
    ]);
    await expect(runner().requestDeployment()).rejects.toThrow(
      /missing or changed/
    );
  });
  it("requires exact control head and safe scratch paths", () => {
    const mismatched = {
      ...options,
      identity: {
        ...options.identity,
        inputs: { ...options.identity.inputs, control_head: "a".repeat(40) },
      },
    };
    expect(() => createPagesCandidateRunner(mismatched).admit()).toThrow(
      /exact dispatched/
    );
    requirePagesScratchPaths(scratch, root, [
      options.statePath,
      options.siteDirectory,
      options.archivePath,
    ]);
    expect(() =>
      requirePagesScratchPaths(scratch, root, [join(root, "artifact.tar")])
    ).toThrow(/scratch/);
  });
  it("persists the prepared control commit before its remote append", () => {
    const append = options.transport.append.bind(options.transport);
    let observed = false;
    options.transport.append = (ref, commit, expectedHead) => {
      const checkpoint = JSON.parse(
        readFileSync(`${options.statePath}.append-${commit}.json`, "utf8")
      );
      expect(checkpoint.state.pendingAppend.attemptedHead).toBe(commit);
      expect(checkpoint.state.pendingAppend.expectedHead).toBe(expectedHead);
      expect(
        parsePromotionControl(
          Buffer.from(checkpoint.state.pendingAppend.bytes, "base64")
        ).lastTransition.event.type
      ).toBe("admit-run");
      observed = true;
      append(ref, commit, expectedHead);
    };
    runner().admit();
    expect(observed).toBe(true);
  });
  it("rejects rehashed private or changed checkpoint fields before output or effects", async () => {
    runner().admit();
    runner().materialize();
    await runner().requestDeployment();
    await runner().status();
    const baseline = JSON.parse(readFileSync(options.statePath, "utf8"));
    for (const change of [
      (value: typeof baseline) => {
        value.state.receipt.githubToken = "private-token";
      },
      (value: typeof baseline) => {
        value.state.receipt.owner.privatePath = "private-ledger";
      },
      (value: typeof baseline) => {
        value.state.receipt.pageUrl = "https://example.invalid/private";
      },
      (value: typeof baseline) => {
        value.state.privatePath = "private-ledger";
      },
      (value: typeof baseline) => {
        value.privatePath = "private-ledger";
      },
      (value: typeof baseline) => {
        value.state.status.receipt.githubToken = "private-token";
      },
      (value: typeof baseline) => {
        value.state.status.privatePath = "private-ledger";
      },
      (value: typeof baseline) => {
        value.state.identity.admission.privatePath = "private-ledger";
      },
    ]) {
      const changed = structuredClone(baseline);
      change(changed);
      changed.checksum = promotionDigest(changed.state);
      writeFileSync(options.statePath, JSON.stringify(changed));
      expect(() => runner()).toThrow();
    }
    writeFileSync(options.statePath, '{"private-ledger-key":');
    expect(() => runner()).toThrow("Invalid Pages checkpoint JSON");
    expect(posts).toBe(1);
  });
  it("recovers a known durable receipt after attachment is interrupted without another POST", async () => {
    runner().admit();
    runner().materialize();
    const append = options.store.compareAndAppend.bind(options.store);
    options.store.compareAndAppend = (input) => {
      if (
        parsePromotionControl(input.bytes).lastTransition.event.type ===
        "deployed"
      )
        throw new Error("interrupted attachment");
      return append(input);
    };
    await expect(runner().requestDeployment()).rejects.toThrow(
      /interrupted attachment/
    );
    expect(
      JSON.parse(readFileSync(options.statePath, "utf8")).state.receipt
        .deploymentId
    ).toBe("1234");
    expect(
      parsePromotionControl(options.store.read().bytes!).active!.phase
    ).toBe("deployment-requested");
    options.store.compareAndAppend = append;
    await runner().requestDeployment();
    await runner().status();
    expect(posts).toBe(1);
  });
  it("deploys exact retained legacy rollback bytes without inventing candidate or source identity", async () => {
    runner().admit();
    const { inputs, admission } = options.identity;
    let state = parsePromotionControl(options.store.read().bytes!);
    state = applyPromotionTransition(state, {
      type: "failed",
      operationId: inputs.operation_id,
      mode: "promote",
      attemptId: inputs.attempt_id,
      failureReceiptId: "a".repeat(64),
    });
    options.store.compareAndAppend({
      expectedHead: options.store.read().head,
      bytes: serializePromotionControl(state),
      createdAt,
    });
    const rollbackAttempt = promotionAttemptId(
      inputs.operation_id,
      "rollback",
      1,
      admission.workflowCommit,
      1
    );
    state = applyPromotionTransition(state, {
      type: "dispatch-intent",
      operationId: inputs.operation_id,
      mode: "rollback",
      attemptId: rollbackAttempt,
      attemptNumber: 1,
      workflowCommit: admission.workflowCommit,
      expectedRunAttempt: 1,
    });
    options.store.compareAndAppend({
      expectedHead: options.store.read().head,
      bytes: serializePromotionControl(state),
      createdAt,
    });
    const prior = state.active!.priorVerified;
    if (prior.kind !== "legacyPublicSnapshot")
      throw new Error("Expected synthetic legacy fixture");
    options.identity = {
      admission,
      inputs: {
        ...inputs,
        mode: "rollback",
        candidate_id: "legacy",
        source_commit: prior.retainedCommit,
        payload_commit: prior.retainedCommit,
        attempt_id: rollbackAttempt,
        control_head: options.store.read().head!,
      },
    };
    options.statePath = join(scratch, "rollback-state.json");
    runner().admit();
    runner().materialize();
    expect(readFileSync(join(options.siteDirectory, "index.html"))).toEqual(
      fixture.payload.publicFiles.get("index.html")
    );
    await runner().requestDeployment();
    await runner().status();
    expect(posts).toBe(1);
    expect(runner().receipt().liveVerified).toBe(false);
    expect(
      parsePromotionControl(options.store.read().bytes!).active!.phase
    ).toBe("rollback-deployed");
  });
});

it("round-trips long Unicode tar paths and binary zeros through the actual tar implementation", () => {
  const directory = mkdtempSync(join(tmpdir(), "zivv-pages-archive-"));
  try {
    const files = new Map([
      ["index.html", Buffer.from("<html>retained</html>\n")],
      [
        `assets/${"long-".repeat(30)}café-音.bin`,
        Buffer.from([0, 255, 1, 0, 10, 0]),
      ],
    ]);
    const archive = join(directory, "artifact.tar");
    // The Windows inbox bsdtar cannot decode UTF-8 PAX filenames. Git's POSIX
    // tar exercises the same format reader as the Linux publication runtime.
    const tar =
      process.platform === "win32"
        ? resolve(
            execFileSync("git", ["--exec-path"], {
              encoding: "utf8",
              windowsHide: true,
            }).trim(),
            "../../../usr/bin/tar.exe"
          )
        : "tar";
    writeFileSync(archive, createPagesPublicArchive(files));
    const extracted = join(directory, "extracted");
    mkdirSync(extracted);
    execFileSync(tar, ["-xf", "artifact.tar", "-C", "extracted"], {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    for (const [path, bytes] of files)
      expect(readFileSync(join(extracted, path))).toEqual(bytes);
    const listing = execFileSync(tar, ["-tf", "artifact.tar"], {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(listing).not.toContain("PaxHeaders");
    expect(listing.split("\n").filter(Boolean)).toHaveLength(files.size);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
