import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resumeOperatorRecoveryDispatchForTest } from "../../lib/ingestion/recovery-dispatch-admission.js";
import { captureExportConfiguration } from "../../lib/ingestion/export-configuration.js";
import {
  ledgerDigest,
  readSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { createRecoveryDispatchFixture } from "./fixtures/recovery-dispatch-fixture.js";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

describe("GET-only recovery of an originally accepted lost-response dispatch", () => {
  let fixture: Awaited<ReturnType<typeof createRecoveryDispatchFixture>>;
  beforeAll(async () => {
    fixture = await createRecoveryDispatchFixture();
  });
  afterAll(async () => {
    if (fixture) await fixture.close();
  });
  const invoke = (
    input: Parameters<typeof resumeOperatorRecoveryDispatchForTest>[0]
  ) => fixture.track(() => resumeOperatorRecoveryDispatchForTest(input));
  function unchanged(
    f: Awaited<ReturnType<typeof fixture.prepare>>,
    refs: string
  ) {
    expect(f.refs()).toBe(refs);
    const state = f.readState();
    expect(state.source).toEqual(fixture.initial.source);
    expect(state.stages.slice(0, 8)).toEqual(
      fixture.initial.stages.slice(0, 8)
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
    expect(
      captureExportConfiguration(join(f.input.destination, "checkout"))
    ).toEqual(fixture.configuration);
    expect(f.saved().intent).toEqual(fixture.saved.intent);
    expect(f.saved().pendingAppend).toEqual(fixture.saved.pendingAppend);
    expect(f.requests().every((request) => request.method === "GET")).toBe(
      true
    );
    expect(fixture.originalPosts).toHaveLength(1);
    expect(() =>
      assertOperatorNotQuarantined(join(f.input.destination, "operator"))
    ).toThrow();
  }

  it("observes the unique accepted run and retries with the same identity and no new remote effects", async () => {
    const f = await fixture.prepare("unique");
    expect(fixture.originalPaths.some(existsSync)).toBe(false);
    expect(
      fixture.initial.stages.find((stage) => stage.stage === "deploy")?.status
    ).toBe("running");
    expect(fixture.saved.receipt).toBeUndefined();
    const refs = f.refs();
    const result = await invoke({
      ...f.input,
      probeRestrictedConsumers: true,
    }).catch((error: unknown) => {
      fixture.preserve();
      console.error("Preserved accepted-dispatch fixture:", fixture.base);
      throw error;
    });
    expect(result).toMatchObject({
      status: "dispatch-observed",
      activationAllowed: false,
      runId: fixture.initial.runId,
      operationId: fixture.saved.intent.event.operationId,
      candidateId: fixture.saved.intent.inputs.candidate_id,
      ledgerRevision: fixture.ledgerRevision,
    });
    expect(result.admissionSha256).toMatch(/^[a-f0-9]{64}$/);
    unchanged(f, refs);
    expect(await invoke(f.input)).toEqual(result);
    unchanged(f, refs);
  });

  for (const ids of [[], [101, 102]]) {
    it(`keeps ${ids.length === 0 ? "zero" : "ambiguous"} matching runs pending without creating a new attempt`, async () => {
      const f = await fixture.prepare(
        ids.length === 0 ? "zero" : "ambiguous",
        ids
      );
      const refs = f.refs();
      const result = await invoke(f.input);
      expect(result).toMatchObject({
        status: "dispatch-pending",
        activationAllowed: false,
        runId: fixture.initial.runId,
        operationId: fixture.saved.intent.event.operationId,
        candidateId: fixture.saved.intent.inputs.candidate_id,
      });
      expect(
        f
          .requests()
          .some((request) =>
            /\/actions\/(?:workflows\/[^/]+\/)?runs\?/.test(request.url)
          )
      ).toBe(true);
      unchanged(f, refs);
    });
  }

  it("ignores an injected receipt 999 and keeps two genuine matches pending after list discovery", async () => {
    const f = await fixture.prepare("injected-receipt", [101, 102]);
    const refs = f.refs();
    const admissionPath = join(f.input.destination, "recovery-dispatch.json");
    f.injectReceipt999();
    await expect(invoke(f.input)).rejects.toThrow(
      "INVALID_PREPARED_RECOVERY_RUNTIME"
    );
    expect(f.requests()).toHaveLength(0);
    expect(f.refs()).toBe(refs);
    expect(existsSync(admissionPath)).toBe(false);

    f.restoreOriginalProducerDispatchBytes();
    await expect(
      invoke({ ...f.input, crashAfterIntent: true })
    ).rejects.toThrow("RECOVERY_IMPORT_TEST_AFTER_INTENT");
    expect(existsSync(admissionPath)).toBe(true);
    expect(JSON.parse(readFileSync(admissionPath, "utf8"))).toMatchObject({
      payload: { kind: "zivv-recovery-dispatch-admission" },
      signature: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(f.requests()).toHaveLength(0);
    expect(f.refs()).toBe(refs);

    f.injectReceipt999();
    const result = await invoke(f.input);
    expect(result).toMatchObject({
      status: "dispatch-pending",
      activationAllowed: false,
      operationId: fixture.saved.intent.event.operationId,
      candidateId: fixture.saved.intent.inputs.candidate_id,
    });
    expect(
      f
        .requests()
        .some((request) =>
          /\/actions\/(?:workflows\/[^/]+\/)?runs\?/.test(request.url)
        )
    ).toBe(true);
    expect(
      f
        .requests()
        .some((request) => /\/actions\/runs\/999(?:\?|$)/.test(request.url))
    ).toBe(false);
    unchanged(f, refs);
  });
});
