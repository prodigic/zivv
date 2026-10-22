import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
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
import { resumeOperatorRecoveryVerifiedForTest } from "../../lib/ingestion/recovery-verified-admission.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { captureExportConfiguration } from "../../lib/ingestion/export-configuration.js";
import {
  ledgerDigest,
  readSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import {
  markWeeklyEditionPublished,
  parseWeeklyEditionLedger,
  serializeWeeklyEditionLedger,
} from "../../lib/ingestion/weekly.js";
import type { WeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";
import { createRecoveryVerifiedFixture } from "./fixtures/recovery-verified-fixture.js";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

function changedRefs(before: string, after: string): string[] {
  const parse = (value: string) =>
    new Map(
      value
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split(/\s+/);
          if (!sha || !ref) throw new Error("Invalid remote ref listing");
          return [ref, sha];
        })
    );
  const left = parse(before),
    right = parse(after);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((ref) => left.get(ref) !== right.get(ref))
    .sort();
}

function expectedPublishedWeeklyBytes(path: string, state: WeeklyRunState) {
  const weekly = parseWeeklyEditionLedger(
    JSON.parse(readFileSync(path, "utf8"))
  );
  const editionId = String(
    state.stages.find((stage) => stage.stage === "freeze")?.evidence?.editionId
  );
  return Buffer.from(
    serializeWeeklyEditionLedger(
      markWeeklyEditionPublished(weekly, editionId).ledger
    )
  );
}

function assertSignedCapsule(bytes: Buffer) {
  expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({
    payload: { kind: "zivv-recovery-verified-admission" },
    signature: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
}

describe("verified delivery acknowledgement recovery after retirement", () => {
  let fixture: Awaited<ReturnType<typeof createRecoveryVerifiedFixture>>;
  const invoke = (
    input: Parameters<typeof resumeOperatorRecoveryVerifiedForTest>[0]
  ) => fixture.track(() => resumeOperatorRecoveryVerifiedForTest(input));

  beforeAll(async () => {
    fixture = await createRecoveryVerifiedFixture();
  });
  afterAll(async () => {
    if (fixture) await fixture.close();
  });
  afterEach(() => vi.unstubAllEnvs());

  function assertRetainedAndQuarantined(
    f: Awaited<ReturnType<typeof fixture.prepare>>,
    stateBefore: WeeklyRunState,
    beforeReferences: string,
    expectedWeeklyBytes: Buffer
  ) {
    const state = f.readState();
    expect(state.source).toEqual(stateBefore.source);
    expect(state.stages.slice(0, 10)).toEqual(stateBefore.stages.slice(0, 10));
    expect(state.stages.at(-1)?.status).toBe("succeeded");
    expect(f.saved()).toEqual(fixture.saved);
    expect(f.artifactBytes()).toEqual(fixture.initialArtifactBytes);
    expect(
      ledgerDigest(
        readSqliteLedger(join(f.input.destination, "operator/ledger.sqlite"))
      )
    ).toBe(fixture.ledgerRevision);
    expect(
      captureExportConfiguration(join(f.input.destination, "checkout"))
    ).toEqual({
      ...fixture.configuration,
      "ingestion/weekly-editions.json": expectedWeeklyBytes,
    });
    const weeklyPath = join(
      f.input.destination,
      "checkout/data/ingestion/weekly-editions.json"
    );
    expect(readFileSync(weeklyPath)).toEqual(expectedWeeklyBytes);
    const weekly = parseWeeklyEditionLedger(
      JSON.parse(readFileSync(weeklyPath, "utf8"))
    );
    const editionId = String(
      stateBefore.stages.find((stage) => stage.stage === "freeze")?.evidence
        ?.editionId
    );
    expect(
      weekly.editions.filter((edition) => edition.editionId === editionId)
    ).toHaveLength(1);
    expect(f.requests()).toHaveLength(0);
    expect(fixture.originalPosts).toHaveLength(1);
    expect(changedRefs(beforeReferences, f.refs())).toEqual([
      "refs/heads/zivv-promotion-control/production",
    ]);
    expect(() =>
      assertOperatorNotQuarantined(join(f.input.destination, "operator"))
    ).toThrow();
  }

  it("acknowledges the original verified operation once and replays the same report", async () => {
    const f = await fixture.prepare("positive");
    vi.stubEnv("ZIVV_CONTROLLED_PUBLISHING", "enabled");
    vi.stubEnv("ZIVV_MANUAL_PUBLISHER_JOINED", "true");
    // Use the authenticated fixture snapshot before admission. Opening SQLite
    // read-only here can create WAL/SHM sidecars and invalidate the pristine
    // prepared-runtime tree digest before the first signed admission.
    const initialState = fixture.initial;
    const beforeReferences = f.refs();
    const beforeControl = f.control();
    const weeklyPath = join(
      f.input.destination,
      "checkout/data/ingestion/weekly-editions.json"
    );
    const expectedWeeklyBytes = expectedPublishedWeeklyBytes(
      weeklyPath,
      initialState
    );
    expect(
      initialState.stages
        .slice(0, 10)
        .every((stage) => stage.status === "succeeded")
    ).toBe(true);
    expect(initialState.stages.at(-1)?.status).toBe("pending");
    expect(f.hasCapsule()).toBe(false);

    const input = { ...f.input, probeRestrictedConsumers: true };
    const result = await invoke(input);
    expect(result).toMatchObject({
      status: "acknowledgement-complete",
      activationAllowed: false,
      runId: fixture.initial.runId,
      candidateId: fixture.saved.intent.inputs.candidate_id,
      ledgerRevision: fixture.ledgerRevision,
      operationId: fixture.saved.intent.inputs.operation_id,
    });
    expect(result.admissionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.acknowledgementId).toMatch(/^[a-f0-9]{64}$/);
    expect(f.hasCapsule()).toBe(true);
    const capsule = f.capsuleBytes();
    const acknowledgementArtifact = f.acknowledgementArtifactBytes();
    expect(acknowledgementArtifact).toBeDefined();
    assertSignedCapsule(capsule);
    const weeklyBytes = readFileSync(weeklyPath);
    expect(weeklyBytes).toEqual(expectedWeeklyBytes);

    expect(await invoke(input)).toEqual(result);
    expect(f.capsuleBytes()).toEqual(capsule);
    expect(f.acknowledgementArtifactBytes()).toBe(acknowledgementArtifact);
    expect(readFileSync(weeklyPath)).toEqual(weeklyBytes);
    assertRetainedAndQuarantined(
      f,
      initialState,
      beforeReferences,
      expectedWeeklyBytes
    );

    const control = f.control();
    expect(control.revision).toBe(beforeControl.revision + 2);
    expect(control.completedCount).toBe(beforeControl.completedCount + 1);
    expect(control.active).toBeNull();
    expect(control.lastTransition.event).toMatchObject({
      type: "acknowledged",
      operationId: result.operationId,
      acknowledgementId: result.acknowledgementId,
    });
    const editionId = String(
      initialState.stages.find((stage) => stage.stage === "freeze")?.evidence
        ?.editionId
    );
    const weekly = parseWeeklyEditionLedger(JSON.parse(weeklyBytes.toString()));
    expect(
      weekly.editions.filter((edition) => edition.editionId === editionId)
    ).toHaveLength(1);
  });

  it("refuses a changed retained verify artifact after signed admission before effects", async () => {
    const f = await fixture.prepare("changed-retained-verify-artifact");
    vi.stubEnv("ZIVV_CONTROLLED_PUBLISHING", "enabled");
    vi.stubEnv("ZIVV_MANUAL_PUBLISHER_JOINED", "true");
    const input = { ...f.input, probeRestrictedConsumers: true };
    const beforeReferences = f.refs();
    const beforeRequests = f.requests();
    const weeklyPath = join(
      f.input.destination,
      "checkout/data/ingestion/weekly-editions.json"
    );
    const weeklyBefore = readFileSync(weeklyPath);
    const journalPath = join(
      f.input.destination,
      "operator/weekly-runs.sqlite"
    );
    const verifyStage = fixture.initial.stages.find(
      (stage) => stage.stage === "verify"
    );
    if (!verifyStage) throw new Error("Verified fixture lacks verify stage");
    if (
      !fixture.initialArtifactBytes.some(
        (artifact) => artifact.stage === "verify"
      )
    )
      throw new Error("Verified fixture lacks retained verify artifact");

    await expect(
      invoke({ ...input, crashAfterIntent: true })
    ).rejects.toMatchObject({
      message: "RECOVERY_IMPORT_TEST_AFTER_INTENT",
    });
    expect(f.hasCapsule()).toBe(true);
    assertSignedCapsule(f.capsuleBytes());

    const database = new DatabaseSync(journalPath);
    let originalBytes: Buffer | undefined;
    let originalIdentity = "";
    try {
      const row = database
        .prepare(
          "SELECT identity,bytes FROM stage_artifact WHERE run_id=? AND stage='verify' AND attempt=?"
        )
        .get(f.input.runId, verifyStage.attempt) as
        | { identity: string; bytes: Uint8Array }
        | undefined;
      if (!row) throw new Error("Staged verify artifact is missing");
      originalBytes = Buffer.from(row.bytes);
      originalIdentity = row.identity;
      const text = originalBytes.toString("utf8");
      const digest = /[a-f0-9]{64}/.exec(text);
      if (!digest) throw new Error("Verify artifact has no digest to alter");
      const changedBytes = Buffer.from(originalBytes);
      const changedOffset = digest.index + (digest[0] === "0" ? 1 : 0);
      changedBytes[changedOffset] =
        changedBytes[changedOffset] === 0x30 ? 0x31 : 0x30;
      JSON.parse(changedBytes.toString("utf8"));
      const changedIdentity = createHash("sha256")
        .update(changedBytes)
        .digest("hex");
      database
        .prepare(
          "UPDATE stage_artifact SET identity=?,bytes=? WHERE run_id=? AND stage='verify' AND attempt=?"
        )
        .run(changedIdentity, changedBytes, f.input.runId, verifyStage.attempt);
    } finally {
      database.close();
    }

    try {
      await expect(invoke(input)).rejects.toMatchObject({
        message: "RECOVERY_IMPORT_EXECUTION_FAILED",
        cause: { message: "INVALID_RECOVERY_IMPORT_ADMISSION" },
      });
      expect(f.refs()).toBe(beforeReferences);
      expect(f.requests()).toEqual(beforeRequests);
      expect(readFileSync(weeklyPath)).toEqual(weeklyBefore);
      expect(
        ledgerDigest(
          readSqliteLedger(join(f.input.destination, "operator/ledger.sqlite"))
        )
      ).toBe(fixture.ledgerRevision);
    } finally {
      if (originalBytes) {
        const restore = new DatabaseSync(journalPath);
        try {
          restore
            .prepare(
              "UPDATE stage_artifact SET identity=?,bytes=? WHERE run_id=? AND stage='verify' AND attempt=?"
            )
            .run(
              originalIdentity,
              originalBytes,
              f.input.runId,
              verifyStage.attempt
            );
        } finally {
          restore.close();
        }
      }
    }
    expect(f.artifactBytes()).toEqual(fixture.initialArtifactBytes);
  });

  for (const [interruptAt, transitionsBeforeRecovery, cutoffWritten] of [
    ["acknowledge-intent-saved", 0, false],
    ["acknowledge-intent-bound", 1, false],
    ["acknowledge-cutoff-written", 1, true],
    ["acknowledge-remote-completed", 2, true],
  ] as const) {
    it(`resumes the same acknowledgement after ${interruptAt}`, async () => {
      const progressStartedAt = Date.now();
      const progress = (phase: string) => {
        if (process.env.ZIVV_RECOVERY_TEST_PROGRESS === "1")
          process.stderr.write(
            `RECOVERY_TEST_PROGRESS ${JSON.stringify({ phase, interruptAt, elapsedMs: Date.now() - progressStartedAt })}\n`
          );
      };
      progress("before-prepare");
      const f = await fixture.prepare(`interrupt-${interruptAt}`);
      progress("prepared");
      vi.stubEnv("ZIVV_CONTROLLED_PUBLISHING", "enabled");
      vi.stubEnv("ZIVV_MANUAL_PUBLISHER_JOINED", "true");
      // Keep the staged SQLite tree pristine until the first admission.
      const beforeState = fixture.initial;
      const beforeControl = f.control();
      const beforeReferences = f.refs();
      const weeklyPath = join(
        f.input.destination,
        "checkout/data/ingestion/weekly-editions.json"
      );
      const weeklyBefore = readFileSync(weeklyPath);
      const expectedWeeklyBytes = expectedPublishedWeeklyBytes(
        weeklyPath,
        beforeState
      );
      const destination = f.input.destination;

      await expect(invoke({ ...f.input, interruptAt })).rejects.toMatchObject({
        message: "RECOVERY_IMPORT_EXECUTION_FAILED",
        cause: { message: "RECOVERY_VERIFIED_TEST_INTERRUPTION" },
      });
      progress("interrupted-invoke-complete");
      expect(f.input.destination).toBe(destination);
      expect(f.hasCapsule()).toBe(true);
      expect(f.control().revision).toBe(
        beforeControl.revision + transitionsBeforeRecovery
      );
      if (cutoffWritten)
        expect(readFileSync(weeklyPath)).toEqual(expectedWeeklyBytes);
      else expect(readFileSync(weeklyPath)).toEqual(weeklyBefore);
      const capsule = f.capsuleBytes();
      const acknowledgementArtifact = f.acknowledgementArtifactBytes();
      expect(acknowledgementArtifact).toBeDefined();
      assertSignedCapsule(capsule);

      const result = await invoke(f.input);
      progress("recovery-invoke-complete");
      expect(result).toMatchObject({
        status: "acknowledgement-complete",
        activationAllowed: false,
        runId: fixture.initial.runId,
        candidateId: fixture.saved.intent.inputs.candidate_id,
        operationId: fixture.saved.intent.inputs.operation_id,
      });
      expect(result.acknowledgementId).toMatch(/^[a-f0-9]{64}$/);
      const weeklyAfterRecovery = readFileSync(weeklyPath);
      expect(weeklyAfterRecovery).toEqual(expectedWeeklyBytes);
      expect(f.capsuleBytes()).toEqual(capsule);
      expect(f.acknowledgementArtifactBytes()).toBe(acknowledgementArtifact);
      expect(await invoke(f.input)).toEqual(result);
      progress("replay-complete");
      expect(readFileSync(weeklyPath)).toEqual(weeklyAfterRecovery);
      expect(f.control().revision).toBe(beforeControl.revision + 2);
      expect(f.control().active).toBeNull();
      expect(f.control().lastTransition.event).toMatchObject({
        type: "acknowledged",
        operationId: result.operationId,
        acknowledgementId: result.acknowledgementId,
      });
      assertRetainedAndQuarantined(
        f,
        beforeState,
        beforeReferences,
        expectedWeeklyBytes
      );
      progress("final-assertions-complete");
    });
  }
});
