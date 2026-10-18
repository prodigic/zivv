import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resumeOperatorRecoveryFrozenForTest } from "../../lib/ingestion/recovery-frozen-admission.js";
import { resumeOperatorRecoveryCandidateForTest } from "../../lib/ingestion/recovery-candidate-admission.js";
import { readVerifiedCandidateBundle } from "../../lib/ingestion/candidate-bundle.js";
import { captureExportConfiguration } from "../../lib/ingestion/export-configuration.js";
import {
  ledgerDigest,
  readSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { createRecoveryFrozenFixture } from "./fixtures/recovery-frozen-fixture.js";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 240_000 });

describe("frozen recovery using real npm, TypeScript and Vite", () => {
  let fixture: Awaited<ReturnType<typeof createRecoveryFrozenFixture>>;
  beforeAll(async () => {
    fixture = await createRecoveryFrozenFixture();
  });
  afterAll(() => {
    if (fixture) fixture.close();
  });
  const invoke = (
    input: Parameters<typeof resumeOperatorRecoveryFrozenForTest>[0]
  ) => fixture.track(() => resumeOperatorRecoveryFrozenForTest(input));

  it("builds the original frozen run through validation once, retries identically and refuses dispatch", async () => {
    const f = await fixture.prepare("actual-toolchain");
    expect(fixture.originalPaths.some(existsSync)).toBe(false);
    const refs = f.refs();
    const firstFive = fixture.initial.stages.slice(0, 5);
    const result = await invoke({
      ...f.input,
      probeRestrictedConsumers: true,
    }).catch((error: unknown) => {
      fixture.preserve();
      console.error("Preserved failed real-toolchain fixture:", fixture.base);
      throw error;
    });
    expect(result).toMatchObject({
      status: "candidate-validated",
      activationAllowed: false,
      runId: fixture.initial.runId,
      ledgerRevision: fixture.ledgerRevision,
    });
    expect(result.candidateId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.admissionSha256).toMatch(/^[a-f0-9]{64}$/);
    const state = f.readState();
    expect(state.source).toEqual(fixture.initial.source);
    expect(state.stages.slice(0, 5)).toEqual(firstFive);
    expect(
      state.stages.slice(5, 8).every((stage) => stage.status === "succeeded")
    ).toBe(true);
    expect(
      state.stages.slice(8).every((stage) => stage.status === "pending")
    ).toBe(true);
    expect(
      ledgerDigest(
        readSqliteLedger(join(f.input.destination, "operator/ledger.sqlite"))
      )
    ).toBe(fixture.ledgerRevision);
    expect(
      captureExportConfiguration(join(f.input.destination, "checkout"))
    ).toEqual(fixture.configuration);
    expect(f.refs()).toBe(refs);
    const directories = f.candidateDirectories();
    expect(directories).toHaveLength(1);
    const bundle = await readVerifiedCandidateBundle(
      directories[0],
      fixture.portable.recoveryKey,
      result.candidateId
    );
    const receipt = JSON.parse(bundle.applicationBuildReceipt!.toString()) as {
      schemaVersion: number;
      purpose: string;
      sourceCommit: string;
      nodeVersion: string;
      npmVersion: string;
    };
    const npmPackage = JSON.parse(
      readFileSync(join(f.input.npmCli, "../../package.json"), "utf8")
    ) as { version: string };
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      purpose: "release",
      sourceCommit: fixture.sourceCommit,
      nodeVersion: process.version,
      npmVersion: npmPackage.version,
    });
    const artifact = f.artifact("export") as { workDirectory: string };
    const sourceBuilds = readdirSync(artifact.workDirectory).filter((name) =>
      name.startsWith("source-build-")
    );
    expect(sourceBuilds).toHaveLength(1);
    const source = join(artifact.workDirectory, sourceBuilds[0], "source");
    // These are the actual installed tool entrypoints that the retained worker
    // executed, and the ETL module was emitted from its reviewed TypeScript.
    expect(
      readFileSync(join(source, "node_modules/typescript/bin/tsc"))
    ).toEqual(
      readFileSync(join(process.cwd(), "node_modules/typescript/bin/tsc"))
    );
    expect(readFileSync(join(source, "node_modules/vite/bin/vite.js"))).toEqual(
      readFileSync(join(process.cwd(), "node_modules/vite/bin/vite.js"))
    );
    expect(
      readFileSync(join(source, "src/lib/etl/processor.ts"), "utf8")
    ).toContain("export class ETLProcessor");
    expect(
      readFileSync(join(source, "dist/lib/etl/processor.js"), "utf8")
    ).toContain("export class ETLProcessor");
    const repeated = await invoke(f.input);
    expect(repeated).toEqual(result);
    expect(f.candidateDirectories()).toEqual(directories);
    expect(f.readState()).toEqual(state);
    expect(f.refs()).toBe(refs);
    await expect(
      fixture.track(() =>
        resumeOperatorRecoveryCandidateForTest({
          ...f.input,
          workflowCommit: fixture.sourceCommit,
          githubToken: "ghp_isolated_refusal_fixture",
          pagesApiBaseUrl: "http://127.0.0.1:1",
        })
      )
    ).rejects.toThrow();
    expect(f.refs()).toBe(refs);
    expect(() =>
      assertOperatorNotQuarantined(join(f.input.destination, "operator"))
    ).toThrow();
  });

  for (const alterBuiltModule of [
    "module",
    "manifest",
    "manifest-addition",
  ] as const) {
    it(`refuses ${alterBuiltModule} drift after build authorization and before the actual ETL import`, async () => {
      const f = await fixture.prepare(`tamper-${alterBuiltModule}`);
      const refs = f.refs();
      await expect(
        invoke({ ...f.input, alterBuiltModule })
      ).rejects.toMatchObject({
        message: "RECOVERY_IMPORT_EXECUTION_FAILED",
        cause: {
          message:
            alterBuiltModule === "module"
              ? "RECOVERY_BUILD_MODULE_CHANGED"
              : "RECOVERY_BUILD_MODULE_METADATA_CHANGED",
        },
      });
      const state = f.readState();
      expect(state.source).toEqual(fixture.initial.source);
      expect(state.stages.slice(0, 5)).toEqual(
        fixture.initial.stages.slice(0, 5)
      );
      expect(
        state.stages.find((stage) => stage.stage === "export")?.status
      ).not.toBe("succeeded");
      expect(
        state.stages.find((stage) => stage.stage === "validate")?.status
      ).toBe("pending");
      const intent = f.artifact("export") as {
        schemaVersion: number;
        workDirectory: string;
      };
      expect(intent.schemaVersion).toBe(1);
      expect(existsSync(intent.workDirectory)).toBe(true);
      expect(f.candidateDirectories()).toEqual([]);
      expect(
        ledgerDigest(
          readSqliteLedger(join(f.input.destination, "operator/ledger.sqlite"))
        )
      ).toBe(fixture.ledgerRevision);
      expect(
        captureExportConfiguration(join(f.input.destination, "checkout"))
      ).toEqual(fixture.configuration);
      expect(f.refs()).toBe(refs);
    });
  }
});
