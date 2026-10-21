import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
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
import { resumeOperatorRecoveryFrozenForTest } from "../../lib/ingestion/recovery-frozen-admission.js";
import { recaptureOperatorRecoveryFrozenResultForTest } from "../../lib/ingestion/recovery-result-recapture.js";
import { decryptRecoveryResultChain } from "../../lib/ingestion/recovery-result-chain.js";
import {
  readRecoveryResultPlan,
  type RecoveryResultPlanContext,
} from "../../lib/ingestion/recovery-result-plan.js";
import { captureOperatorRecoveryCheckpoint } from "../../lib/ingestion/operator-recovery.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";

// One genuine build shared by serial publication and replay/repair cases.
vi.setConfig({ testTimeout: 1_200_000, hookTimeout: 600_000 });

async function expectInterruption(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
      if (current.message === "RECOVERY_RESULT_RECAPTURE_TEST_INTERRUPTION")
        return;
      current = current.cause;
    }
    throw error;
  }
  throw new Error("Expected the exact recapture interruption hook");
}

describe("genuine frozen-result recapture and cooperative fencing", () => {
  let fixture: Awaited<ReturnType<typeof createRecoveryFrozenFixture>>;
  let finishRetainedHandoff: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    fixture = await createRecoveryFrozenFixture();
  });
  afterEach(({ task }) => {
    if (task.result?.state === "fail" && fixture) {
      fixture.preserve();
      console.error("Retained failed recapture fixture:", fixture.base);
    }
    vi.unstubAllEnvs();
  });
  afterAll(() => fixture?.close());

  it("retains one exact plan through source checks, fencing and publication", async () => {
    const startedAt = Date.now();
    const progress = (phase: string) => {
      if (process.env.ZIVV_RECOVERY_TEST_PROGRESS === "1")
        process.stderr.write(
          `RECAPTURE_TEST_PROGRESS ${JSON.stringify({ phase, elapsedMs: Date.now() - startedAt })}\n`
        );
    };
    const f = await fixture.prepare("result-recapture");
    const root = f.input.destination;
    const operator = join(root, "operator");
    vi.stubEnv("ZIVV_LEDGER_HOME", operator);
    const track = <T>(operation: () => Promise<T>) => fixture.track(operation);
    const validated = await track(() =>
      resumeOperatorRecoveryFrozenForTest(f.input)
    );
    progress("genuine-result-validated");
    const originalRun = f.readState();
    const originalRefs = f.refs();
    const originalDirectories = f.candidateDirectories();
    const originalAdmission = readFileSync(join(root, "recovery-frozen.json"));
    const originalResult = readFileSync(
      join(root, "recovery-frozen-result.json")
    );
    expect(fixture.originalPaths.some(existsSync)).toBe(false);
    expect(originalDirectories).toHaveLength(1);
    await expect(
      captureOperatorRecoveryCheckpoint(join(root, "checkout"))
    ).rejects.toThrow();

    const outputDirectory = join(fixture.base, "handoff");
    mkdirSync(outputDirectory);
    const input = { ...f.input, out: join(outputDirectory, "result.enc") };
    const invoke = (
      interruptAt?: "plan-saved" | "fence-written" | "handoff-published"
    ) =>
      track(() =>
        recaptureOperatorRecoveryFrozenResultForTest({
          ...input,
          ...(interruptAt ? { interruptAt } : {}),
        })
      );
    const context: RecoveryResultPlanContext = {
      root,
      operator,
      repositoryRoot: resolve(input.repositoryRoot),
      npmCli: resolve(input.npmCli),
      out: input.out,
      runId: input.runId,
      admissionSha256: sha256(originalAdmission),
      resultSha256: sha256(originalResult),
      preparedReceiptSha256: sha256(
        readFileSync(join(root, "prepared-runtime.json"))
      ),
    };
    const planInput = { context, recoveryKey: input.recoveryKey };
    const marker = join(operator, "operator-retired.json");

    await expectInterruption(invoke("plan-saved"));
    progress("plan-saved");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(input.out)).toBe(false);
    const planBytes = readFileSync(input.out + ".plan");
    const planned = readRecoveryResultPlan(planInput);
    const proof = decryptRecoveryResultChain(planned.chain, input.recoveryKey);
    expect(proof.members.originalArchive).toEqual(input.archive);
    expect(proof.members.originalRetirementReceipt).toEqual(
      input.retirementReceipt
    );
    expect(proof.members.admissionReceipt).toEqual(originalAdmission);
    expect(proof.members.resultReceipt).toEqual(originalResult);
    expect(proof.certificate.runId).toBe(input.runId);
    expect(proof.certificate.candidateId).toBe(validated.candidateId);

    await expect(
      track(() =>
        recaptureOperatorRecoveryFrozenResultForTest({
          ...input,
          out: join(outputDirectory, "different.enc"),
        })
      )
    ).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    const weeklyPath = join(
      root,
      "checkout/data/ingestion/weekly-editions.json"
    );
    const weeklyBytes = readFileSync(weeklyPath);
    try {
      writeFileSync(
        weeklyPath,
        Buffer.concat([weeklyBytes, Buffer.from("\n")])
      );
      await expect(invoke()).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(input.out)).toBe(false);
    } finally {
      writeFileSync(weeklyPath, weeklyBytes);
    }
    expect(readFileSync(input.out + ".plan")).toEqual(planBytes);

    // Change only this fixture's canonical bare remote, then restore with CAS.
    const bareOffset = relative(fixture.base, input.bareDirectory);
    if (!bareOffset || bareOffset.startsWith(".."))
      throw new Error("Unsafe recapture fixture remote");
    const git = (args: string[]) =>
      execFileSync("git", ["--git-dir", input.bareDirectory, ...args], {
        cwd: input.repositoryRoot,
        windowsHide: true,
        stdio: "pipe",
      })
        .toString()
        .trim();
    const originalMain = git(["rev-parse", "refs/heads/main"]);
    const previousMain = git(["rev-parse", "refs/heads/main^"]);
    git(["update-ref", "refs/heads/main", previousMain, originalMain]);
    try {
      await expect(invoke()).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(input.out)).toBe(false);
    } finally {
      git(["update-ref", "refs/heads/main", originalMain, previousMain]);
    }
    expect(f.refs()).toBe(originalRefs);
    progress("pre-fence-drift-refusals-complete");

    await expectInterruption(invoke("fence-written"));
    progress("fence-written");
    expect(readFileSync(marker)).toEqual(
      proof.members.successorRetirementReceipt
    );
    expect(readFileSync(marker)).not.toEqual(input.retirementReceipt);
    expect(existsSync(input.out)).toBe(false);
    expect(() => new WeeklyRunJournal(operator)).toThrow();
    await expect(
      track(() => resumeOperatorRecoveryFrozenForTest(f.input))
    ).rejects.toThrow();
    await expect(
      captureOperatorRecoveryCheckpoint(join(root, "checkout"))
    ).rejects.toThrow();

    try {
      writeFileSync(
        weeklyPath,
        Buffer.concat([weeklyBytes, Buffer.from("\n")])
      );
      await expect(invoke()).rejects.toThrow();
      expect(existsSync(input.out)).toBe(false);
    } finally {
      writeFileSync(weeklyPath, weeklyBytes);
    }
    for (const path of [
      join(root, "prepared-runtime.json"),
      join(root, "checkout/node_modules/postal-mime/package.json"),
    ]) {
      const bytes = readFileSync(path);
      try {
        writeFileSync(path, Buffer.concat([bytes, Buffer.from("\n")]));
        await expect(invoke()).rejects.toThrow();
        expect(existsSync(input.out)).toBe(false);
        expect(readFileSync(marker)).toEqual(
          proof.members.successorRetirementReceipt
        );
      } finally {
        writeFileSync(path, bytes);
      }
    }
    progress("post-fence-drift-refusals-complete");
    await expectInterruption(invoke("handoff-published"));
    progress("handoff-published");
    expect(readFileSync(input.out)).toEqual(planned.chain);
    expect(readFileSync(input.out + ".receipt.json")).toEqual(
      planned.portableReceipt
    );

    // Keep this same actual fixture/plan for the serial replay case. The prior
    // single case reached publication but exceeded its total 20-minute budget.
    finishRetainedHandoff = async () => {
      vi.stubEnv("ZIVV_LEDGER_HOME", join(root, "operator"));
      const result = await invoke();
      expect(result).toMatchObject({
        status: "result-handoff-complete",
        activationAllowed: false,
        runId: input.runId,
        candidateId: validated.candidateId,
        chainId: proof.chainId,
        chainSha256: sha256(planned.chain),
        receiptSha256: sha256(planned.portableReceipt),
      });
      unlinkSync(input.out + ".receipt.json");
      expect(await invoke()).toEqual(result);
      expect(readFileSync(input.out + ".receipt.json")).toEqual(
        planned.portableReceipt
      );
      try {
        writeFileSync(input.out, "conflicting output");
        await expect(invoke()).rejects.toThrow();
      } finally {
        writeFileSync(input.out, planned.chain);
      }
      expect(await invoke()).toEqual(result);
      expect(readFileSync(input.out + ".plan")).toEqual(planBytes);
      expect(readFileSync(marker)).toEqual(
        proof.members.successorRetirementReceipt
      );
      expect(readFileSync(join(root, "recovery-frozen.json"))).toEqual(
        originalAdmission
      );
      expect(readFileSync(join(root, "recovery-frozen-result.json"))).toEqual(
        originalResult
      );
      expect(f.readState()).toEqual(originalRun);
      expect(f.candidateDirectories()).toEqual(originalDirectories);
      expect(f.refs()).toBe(originalRefs);
      expect(fixture.originalPaths.some(existsSync)).toBe(false);
      expect(proof.activationAllowed).toBe(false);
      progress("final-repair-and-retention-assertions-complete");
    };
  });

  it("repairs lost responses from the same fenced plan without changing retained source", async () => {
    if (!finishRetainedHandoff)
      throw new Error(
        "The real recapture publication prerequisite did not complete"
      );
    await finishRetainedHandoff();
  });
});
