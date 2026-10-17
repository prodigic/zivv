import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resumeOperatorRecoveryCandidateForTest } from "../../lib/ingestion/recovery-candidate-admission.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import {
  ledgerDigest,
  readSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { createRecoveryCandidateFixture } from "./fixtures/recovery-candidate-fixture.js";
import { parsePromotionControl } from "../../lib/ingestion/promotion-control.js";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 240_000 });

describe("same validated candidate dispatch after losing the original installation", () => {
  let fixture: Awaited<ReturnType<typeof createRecoveryCandidateFixture>>;
  const invoke = (
    input: Parameters<typeof resumeOperatorRecoveryCandidateForTest>[0]
  ) => fixture.track(() => resumeOperatorRecoveryCandidateForTest(input));
  beforeAll(async () => {
    fixture = await createRecoveryCandidateFixture();
  });
  afterAll(async () => {
    if (fixture) await fixture.close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dispatches the actual retained candidate once with the same run, ledger and canonical operation", async () => {
    const f = await fixture.prepare("positive");
    expect(fixture.originalPaths.some(existsSync)).toBe(false);
    const candidateId = fixture.initial.stages.find(
      (stage) => stage.stage === "validate"
    )!.evidence!.candidateId;
    const enforcedInput = { ...f.input, enforcePublicationFlags: true };
    const originalRefs = f.git(["ls-remote", f.input.bareDirectory]);
    vi.stubEnv("ZIVV_CONTROLLED_PUBLISHING", "disabled");
    vi.stubEnv("ZIVV_MANUAL_PUBLISHER_JOINED", "false");
    await expect(invoke(enforcedInput)).rejects.toThrow(
      "RECOVERY_PUBLICATION_NOT_ENABLED"
    );
    expect(f.requests).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
    expect(f.git(["ls-remote", f.input.bareDirectory])).toBe(originalRefs);
    expect(
      [
        "recovery-candidate.json",
        "operator/backup-key.bin",
        "operator/backup-key.dpapi",
      ].some((path) => existsSync(join(f.input.destination, path)))
    ).toBe(false);
    expect(
      ledgerDigest(
        readSqliteLedger(join(f.input.destination, "operator/ledger.sqlite"))
      )
    ).toBe(fixture.ledgerRevision);
    vi.stubEnv("ZIVV_CONTROLLED_PUBLISHING", "enabled");
    vi.stubEnv("ZIVV_MANUAL_PUBLISHER_JOINED", "true");
    const result = await invoke({
      ...enforcedInput,
      probeRestrictedConsumers: true,
    });
    expect(result).toMatchObject({
      status: "dispatch-observed",
      activationAllowed: false,
      runId: fixture.initial.runId,
      candidateId,
      ledgerRevision: fixture.ledgerRevision,
    });
    expect(result.operationId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.admissionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.dispatches).toHaveLength(1);
    expect(f.dispatches[0].inputs).toMatchObject({
      candidate_id: candidateId,
      operation_id: result.operationId,
      source_commit: fixture.workflowCommit,
    });
    const nativeControl = parsePromotionControl(
      Buffer.from(
        f.git([
          "--git-dir",
          f.input.bareDirectory,
          "show",
          "refs/heads/zivv-promotion-control/production:control.json",
        ])
      )
    );
    expect(nativeControl.active?.operationId).toBe(result.operationId);
    expect(nativeControl.active?.request.candidateId).toBe(candidateId);
    expect(
      f.git([
        "ls-remote",
        f.input.bareDirectory,
        `refs/heads/zivv-candidate-artifacts/${f.dispatches[0].inputs.payload_commit}`,
      ])
    ).toContain(f.dispatches[0].inputs.payload_commit);
    const repeated = await invoke(enforcedInput);
    expect(repeated).toEqual(result);
    expect(f.dispatches).toHaveLength(1);
    const state = f.readState();
    expect(state.runId).toBe(fixture.initial.runId);
    expect(state.source).toEqual(fixture.initial.source);
    expect(
      state.stages.filter((stage) =>
        [
          "acquire",
          "prepare",
          "reconcile",
          "load",
          "freeze",
          "enrich",
          "export",
          "validate",
        ].includes(stage.stage)
      )
    ).toEqual(
      fixture.initial.stages.filter((stage) =>
        [
          "acquire",
          "prepare",
          "reconcile",
          "load",
          "freeze",
          "enrich",
          "export",
          "validate",
        ].includes(stage.stage)
      )
    );
    expect(state.stages.find((stage) => stage.stage === "verify")?.status).toBe(
      "pending"
    );
    expect(
      state.stages.find((stage) => stage.stage === "acknowledge")?.status
    ).toBe("pending");
    expect(
      ledgerDigest(
        readSqliteLedger(join(f.input.destination, "operator/ledger.sqlite"))
      )
    ).toBe(fixture.ledgerRevision);
    expect(() =>
      assertOperatorNotQuarantined(join(f.input.destination, "operator"))
    ).toThrow();
  });

  for (const interruptAt of ["plan", "claim", "dispatch"] as const) {
    it(`recovers interruption after ${interruptAt} without a second dispatch`, async () => {
      const f = await fixture.prepare(`interrupt-${interruptAt}`);
      await expect(invoke({ ...f.input, interruptAt })).rejects.toThrow();
      expect(f.dispatches).toHaveLength(interruptAt === "dispatch" ? 1 : 0);
      const recovered = await invoke(f.input);
      expect(recovered).toMatchObject({
        status: "dispatch-observed",
        activationAllowed: false,
        runId: fixture.initial.runId,
        ledgerRevision: fixture.ledgerRevision,
      });
      expect(f.dispatches).toHaveLength(1);
      const control = parsePromotionControl(
        Buffer.from(
          f.git([
            "--git-dir",
            f.input.bareDirectory,
            "show",
            "refs/heads/zivv-promotion-control/production:control.json",
          ])
        )
      );
      expect(control.active?.operationId).toBe(recovered.operationId);
      expect(control.active?.request.candidateId).toBe(recovered.candidateId);
      expect(f.dispatches[0].inputs.operation_id).toBe(recovered.operationId);
      const state = f.readState();
      expect(
        state.stages.find((stage) => stage.stage === "validate")?.status
      ).toBe("succeeded");
      expect(
        state.stages.find((stage) => stage.stage === "verify")?.status
      ).toBe("pending");
      expect(
        state.stages.find((stage) => stage.stage === "acknowledge")?.status
      ).toBe("pending");
    });
  }

  it("refuses an unreviewed workflow before native claim or API dispatch", async () => {
    const f = await fixture.prepare("wrong-workflow");
    const before = f.git(["ls-remote", f.input.bareDirectory]);
    await expect(
      invoke({
        ...f.input,
        workflowCommit: "f".repeat(40),
      })
    ).rejects.toThrow();
    expect(f.dispatches).toHaveLength(0);
    expect(f.git(["ls-remote", f.input.bareDirectory])).toBe(before);
  });

  it("refuses changed retained configuration before claim or dispatch", async () => {
    const f = await fixture.prepare("changed-config");
    const before = f.git(["ls-remote", f.input.bareDirectory]);
    writeFileSync(
      join(f.input.destination, "checkout/data/venue-sources.json"),
      '{"sources":[],"changed":true}\n'
    );
    await expect(invoke(f.input)).rejects.toThrow();
    expect(f.dispatches).toHaveLength(0);
    expect(f.git(["ls-remote", f.input.bareDirectory])).toBe(before);
  });

  it("refuses changed retained bundle bytes before claim or dispatch", async () => {
    const f = await fixture.prepare("changed-bundle");
    const before = f.git(["ls-remote", f.input.bareDirectory]);
    const parent = join(f.input.destination, "operator/weekly-candidates");
    const candidates = readdirSync(parent, { recursive: true }).filter(
      (path) =>
        typeof path === "string" && /(?:^|[\\/])candidate\.json$/.test(path)
    );
    expect(candidates.length).toBeGreaterThan(0);
    const target = join(parent, String(candidates[0]));
    writeFileSync(
      target,
      Buffer.concat([readFileSync(target), Buffer.from(" ")])
    );
    await expect(invoke(f.input)).rejects.toThrow();
    expect(f.dispatches).toHaveLength(0);
    expect(f.git(["ls-remote", f.input.bareDirectory])).toBe(before);
  });

  it("rechecks installed dependency bytes after saving the plan and before any external effect", async () => {
    const f = await fixture.prepare("dependency-after-plan");
    const before = f.git(["ls-remote", f.input.bareDirectory]);
    await expect(
      invoke({
        ...f.input,
        alterDependencyAfterPlan: true,
      })
    ).rejects.toMatchObject({
      message: "RECOVERY_IMPORT_EXECUTION_FAILED",
      cause: { message: "RECOVERY_IMPORT_IMMUTABLE_EVIDENCE_CHANGED" },
    });
    expect(f.requests).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
    expect(f.git(["ls-remote", f.input.bareDirectory])).toBe(before);
    expect(
      existsSync(join(f.input.destination, "recovery-candidate-result.json"))
    ).toBe(false);
    expect(
      ledgerDigest(
        readSqliteLedger(join(f.input.destination, "operator/ledger.sqlite"))
      )
    ).toBe(fixture.ledgerRevision);
  });
});
