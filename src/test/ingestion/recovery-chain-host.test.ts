import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRecoveryFrozenFixture } from "./fixtures/recovery-frozen-fixture.js";
import { createRecoveryPagesHttpFixture } from "./fixtures/recovery-pages-http-fixture.js";
import { resumeOperatorRecoveryFrozenForTest } from "../../lib/ingestion/recovery-frozen-admission.js";
import { recaptureOperatorRecoveryFrozenResultForTest } from "../../lib/ingestion/recovery-result-recapture.js";
import {
  prepareOperatorRecoveryResultChainForTest,
  resumeOperatorRecoveryResultChainCandidateForTest,
} from "../../lib/ingestion/recovery-chain-admission.js";
import { decryptRecoveryResultChain } from "../../lib/ingestion/recovery-result-chain.js";
import { parseWeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";
import { parsePromotionControl } from "../../lib/ingestion/promotion-control.js";
import {
  ledgerDigest,
  readSqliteLedgerReadOnly,
} from "../../lib/ingestion/sqlite-store.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";

// One real build and a composed retirement/preparation/dispatch/retry drill.
vi.setConfig({ testTimeout: 1_800_000, hookTimeout: 600_000 });

function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("GIT_")) delete env[name];
  return execFileSync("git", args, {
    cwd,
    env,
    windowsHide: true,
    stdio: "pipe",
  })
    .toString()
    .trim();
}

function removeFixtureTree(base: string, target: string): void {
  const absolute = realpathSync(target);
  const suffix = relative(realpathSync(base), absolute);
  if (!suffix || isAbsolute(suffix) || suffix.split(/[\\/]/).includes(".."))
    throw new Error("Unsafe chain-host fixture cleanup");
  rmSync(absolute, { recursive: true, force: true });
}

function retainedState(root: string, runId: string) {
  const db = new DatabaseSync(join(root, "operator/weekly-runs.sqlite"), {
    readOnly: true,
  });
  try {
    const state = db
      .prepare("SELECT payload FROM run_state WHERE id = ?")
      .get(runId);
    if (!state) throw new Error("Missing chain-host run");
    const firstStages = new Set([
      "acquire",
      "prepare",
      "reconcile",
      "load",
      "freeze",
      "enrich",
      "export",
      "validate",
    ]);
    const artifacts = db
      .prepare(
        "SELECT stage, attempt, identity, bytes FROM stage_artifact WHERE run_id = ? ORDER BY stage, attempt"
      )
      .all(runId)
      .filter((row) => firstStages.has(String(row.stage)))
      .map((row) => {
        if (!(row.bytes instanceof Uint8Array))
          throw new Error("Missing retained artifact bytes");
        return {
          stage: row.stage,
          attempt: row.attempt,
          identity: row.identity,
          bytes: Buffer.from(row.bytes).toString("base64"),
        };
      });
    return {
      state: parseWeeklyRunState(JSON.parse(String(state.payload))),
      artifacts,
    };
  } finally {
    db.close();
  }
}

function isFixedInterruption(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current.message === "RECOVERY_CANDIDATE_TEST_INTERRUPTION") return true;
    current = current.cause;
  }
  return false;
}

async function expectFixedInterruption(
  operation: Promise<unknown>
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (isFixedInterruption(error)) return;
    throw error;
  }
  throw new Error("Expected the fixed candidate interruption hook");
}

describe("genuine recaptured candidate on a distinct host", () => {
  let fixture: Awaited<ReturnType<typeof createRecoveryFrozenFixture>>;
  let api:
    | Awaited<ReturnType<typeof createRecoveryPagesHttpFixture>>
    | undefined;
  beforeAll(async () => {
    fixture = await createRecoveryFrozenFixture();
  });
  afterEach(({ task }) => {
    if (task.result?.state === "fail" && fixture) {
      fixture.preserve();
      console.error("Retained failed chain-host fixture:", fixture.base);
    }
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await api?.close();
    fixture?.close();
  });

  it("deletes the intermediate installation and reconciles one accepted dispatch with unchanged candidate and source", async () => {
    const startedAt = Date.now();
    const progress = (phase: string) => {
      if (process.env.ZIVV_RECOVERY_TEST_PROGRESS === "1")
        process.stderr.write(
          `CHAIN_HOST_TEST_PROGRESS ${JSON.stringify({ phase, elapsedMs: Date.now() - startedAt })}\n`
        );
    };
    const hostA = await fixture.prepare("chain-host-a");
    const track = <T>(operation: () => Promise<T>) => fixture.track(operation);
    vi.stubEnv("ZIVV_LEDGER_HOME", join(hostA.input.destination, "operator"));
    await track(() => resumeOperatorRecoveryFrozenForTest(hostA.input));
    const before = retainedState(
      hostA.input.destination,
      fixture.initial.runId
    );
    const handoff = join(fixture.base, "chain-handoff");
    mkdirSync(handoff);
    const out = join(handoff, "result.enc");
    const captured = await track(() =>
      recaptureOperatorRecoveryFrozenResultForTest({ ...hostA.input, out })
    );
    const chain = readFileSync(out);
    const proof = decryptRecoveryResultChain(
      chain,
      fixture.portable.recoveryKey
    );
    expect(captured.chainId).toBe(proof.chainId);
    expect(
      existsSync(
        join(hostA.input.destination, "operator/operator-retired.json")
      )
    ).toBe(true);
    progress("genuine-chain-captured");

    const hostB = join(fixture.base, "chain-host-b");
    mkdirSync(hostB);
    const bareDirectory = join(hostB, "remote.git");
    const repositoryRoot = join(hostB, "repository");
    git(hostB, [
      "clone",
      "--quiet",
      "--bare",
      hostA.input.bareDirectory,
      bareDirectory,
    ]);
    git(hostB, [
      "clone",
      "--quiet",
      "--branch",
      "main",
      bareDirectory,
      repositoryRoot,
    ]);
    git(repositoryRoot, [
      "remote",
      "set-url",
      "origin",
      "https://github.com/prodigic/zivv.git",
    ]);
    git(repositoryRoot, ["config", "core.autocrlf", "false"]);
    const workflowPath = ".github/workflows/publish-candidate.yml";
    mkdirSync(dirname(join(repositoryRoot, workflowPath)), { recursive: true });
    writeFileSync(
      join(repositoryRoot, workflowPath),
      readFileSync(resolve(workflowPath))
    );
    git(repositoryRoot, ["add", workflowPath]);
    git(repositoryRoot, [
      "-c",
      "user.name=Chain host fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "reviewed workflow descendant",
    ]);
    const workflowCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
    git(repositoryRoot, [
      "push",
      "--quiet",
      bareDirectory,
      "HEAD:refs/heads/main",
    ]);
    const finalTool = join(fixture.base, "chain-host-tool");
    cpSync(dirname(dirname(fixture.portable.npmCli)), finalTool, {
      recursive: true,
    });
    const npmCli = join(finalTool, "bin/npm-cli.js");
    const oldTool = dirname(dirname(fixture.portable.npmCli));
    removeFixtureTree(fixture.base, dirname(hostA.input.destination));
    removeFixtureTree(fixture.base, oldTool);
    expect(fixture.originalPaths.some(existsSync)).toBe(false);
    expect(existsSync(hostA.input.destination)).toBe(false);
    expect(existsSync(hostA.input.repositoryRoot)).toBe(false);
    expect(existsSync(fixture.portable.npmCli)).toBe(false);
    const destination = join(hostB, "restored");
    const input = {
      chain,
      recoveryKey: fixture.portable.recoveryKey,
      destination,
      npmCli,
    };
    const prepared = await track(() =>
      prepareOperatorRecoveryResultChainForTest(input)
    );
    expect(prepared).toMatchObject({
      activationAllowed: false,
      chainId: proof.chainId,
    });
    const companion = destination + ".chain-preparation.json";
    const companionBytes = readFileSync(companion);
    const preparationBytes = readFileSync(
      join(destination, "prepared-runtime.json")
    );
    await track(() => prepareOperatorRecoveryResultChainForTest(input));
    expect(readFileSync(companion)).toEqual(companionBytes);
    expect(readFileSync(join(destination, "prepared-runtime.json"))).toEqual(
      preparationBytes
    );
    expect(() =>
      assertOperatorNotQuarantined(join(destination, "operator"))
    ).toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
    progress("intermediate-deleted-new-host-prepared");

    api = await createRecoveryPagesHttpFixture({
      workflowCommit,
      loseFirstAcceptedResponse: true,
    });
    const dispatchInput = {
      ...input,
      repositoryRoot,
      workflowCommit,
      bareDirectory,
      pagesApiBaseUrl: api.pagesApiBaseUrl,
      githubToken: "ghp_isolated_chain_host",
      enforcePublicationFlags: true,
    };
    const invoke = (
      options: Partial<
        Pick<
          Parameters<
            typeof resumeOperatorRecoveryResultChainCandidateForTest
          >[0],
          "interruptAt"
        >
      > = {}
    ) =>
      track(() =>
        resumeOperatorRecoveryResultChainCandidateForTest({
          ...dispatchInput,
          ...options,
        })
      );
    vi.stubEnv("ZIVV_LEDGER_HOME", join(destination, "operator"));
    vi.stubEnv("ZIVV_CONTROLLED_PUBLISHING", "disabled");
    vi.stubEnv("ZIVV_MANUAL_PUBLISHER_JOINED", "false");
    await expect(invoke()).rejects.toThrow("RECOVERY_PUBLICATION_NOT_ENABLED");
    expect(api.dispatches).toHaveLength(0);
    expect(existsSync(join(destination, "recovery-candidate.json"))).toBe(
      false
    );
    vi.stubEnv("ZIVV_CONTROLLED_PUBLISHING", "enabled");
    vi.stubEnv("ZIVV_MANUAL_PUBLISHER_JOINED", "true");
    writeFileSync(companion, Buffer.concat([companionBytes, Buffer.from(" ")]));
    try {
      await expect(invoke()).rejects.toThrow("COMPANION_CHANGED");
    } finally {
      writeFileSync(companion, companionBytes);
    }
    expect(api.dispatches).toHaveLength(0);
    await expectFixedInterruption(invoke({ interruptAt: "plan" }));
    expect(api.dispatches).toHaveLength(0);
    const controlBefore = git(repositoryRoot, [
      "--git-dir",
      bareDirectory,
      "rev-parse",
      "refs/heads/zivv-promotion-control/production",
    ]);
    const child = git(repositoryRoot, [
      "-c",
      "user.name=Chain host fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      git(repositoryRoot, ["rev-parse", `${workflowCommit}^{tree}`]),
      "-p",
      workflowCommit,
      "-m",
      "main drift after admission",
    ]);
    git(repositoryRoot, [
      "push",
      "--quiet",
      bareDirectory,
      `${child}:refs/heads/main`,
    ]);
    try {
      await expect(invoke()).rejects.toThrow();
      expect(api.dispatches).toHaveLength(0);
    } finally {
      git(repositoryRoot, [
        "--git-dir",
        bareDirectory,
        "update-ref",
        "refs/heads/main",
        workflowCommit,
        child,
      ]);
    }
    expect(
      git(repositoryRoot, [
        "--git-dir",
        bareDirectory,
        "rev-parse",
        "refs/heads/zivv-promotion-control/production",
      ])
    ).toBe(controlBefore);
    progress("new-host-plan-and-drift-refusal");

    // A lost POST response can leave a pending report before the fixed
    // post-effect crash hook is reached. Both paths must reconcile that POST.
    try {
      const pending = await invoke({ interruptAt: "dispatch" });
      expect(pending.status).toBe("dispatch-pending");
    } catch (error) {
      if (!isFixedInterruption(error)) throw error;
    }
    expect(api.dispatches).toHaveLength(1);
    const accepted = structuredClone(api.dispatches[0]);
    const result = await invoke();
    expect(result).toMatchObject({
      status: "dispatch-observed",
      activationAllowed: false,
      runId: fixture.initial.runId,
      candidateId: proof.candidate.candidateId,
      ledgerRevision: fixture.ledgerRevision,
      chainId: proof.chainId,
    });
    expect(api.dispatches).toHaveLength(1);
    expect(api.dispatches[0]).toEqual(accepted);
    expect(
      api.requests.some(
        (request) =>
          request.method === "GET" && request.url.includes("/actions/")
      )
    ).toBe(true);
    expect(accepted.inputs.operation_id).toBe(result.operationId);
    expect(accepted.inputs.candidate_id).toBe(proof.candidate.candidateId);
    expect(accepted.inputs.source_commit).toBe(proof.candidate.sourceCommit);
    expect(accepted.ref).toBe(`zivv-workflows/${workflowCommit}`);
    expect(await invoke()).toEqual(result);
    expect(api.dispatches).toHaveLength(1);
    const after = retainedState(destination, fixture.initial.runId);
    expect(after.state.source).toEqual(before.state.source);
    expect(after.state.stages.slice(0, 8)).toEqual(
      before.state.stages.slice(0, 8)
    );
    expect(after.artifacts).toEqual(before.artifacts);
    expect(
      after.state.stages.slice(9).every((stage) => stage.status === "pending")
    ).toBe(true);
    expect(
      ledgerDigest(
        readSqliteLedgerReadOnly(join(destination, "operator/ledger.sqlite"))
      )
    ).toBe(fixture.ledgerRevision);
    const candidates = readdirSync(
      join(destination, "operator/weekly-candidates"),
      { recursive: true }
    ).filter((path) => /(?:^|[\\/])candidate\.json$/.test(String(path)));
    expect(candidates).toHaveLength(1);
    expect(
      readFileSync(
        join(destination, "operator/weekly-candidates", String(candidates[0]))
      )
    ).toEqual(proof.candidateBytes);
    const control = parsePromotionControl(
      Buffer.from(
        git(repositoryRoot, [
          "--git-dir",
          bareDirectory,
          "show",
          "refs/heads/zivv-promotion-control/production:control.json",
        ])
      )
    );
    expect(control.active?.operationId).toBe(result.operationId);
    expect(control.active?.request.candidateId).toBe(
      proof.candidate.candidateId
    );
    expect(control.active?.request.sourceCommit).toBe(
      proof.candidate.sourceCommit
    );
    expect(() =>
      assertOperatorNotQuarantined(join(destination, "operator"))
    ).toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
    expect(readFileSync(companion)).toEqual(companionBytes);
    expect(readFileSync(join(destination, "prepared-runtime.json"))).toEqual(
      preparationBytes
    );
    progress("same-candidate-dispatch-and-retry-complete");
  });
});
