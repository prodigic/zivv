import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { runWeeklyImport } from "../../lib/ingestion/weekly-import-runner.js";
import { retireAndCaptureOperatorRecovery } from "../../lib/ingestion/operator-recovery.js";
import {
  prepareOperatorRecoveryRuntime,
  type RecoveryRuntimeInput,
} from "../../lib/ingestion/recovery-runtime.js";
import { resumeOperatorRecoveryImportForTest } from "../../lib/ingestion/recovery-import-admission.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { createAcknowledgedRecoveryRemoteFixture } from "./fixtures/recovery-import-remote-fixture.js";
import type { WeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });
describe("same-run import admission after losing original installation", () => {
  let base: string,
    originalCheckout: string,
    originalOperator: string,
    originalTool: string;
  let portable: Omit<RecoveryRuntimeInput, "destination">,
    initial: WeeklyRunState;
  let remote: Awaited<
    ReturnType<typeof createAcknowledgedRecoveryRemoteFixture>
  >;
  let input: Parameters<typeof resumeOperatorRecoveryImportForTest>[0];
  const observed = Date.parse("2026-10-16T20:00:00Z");
  const raw = Buffer.from(
    "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\noct 23 fri Fixture Band at Test Room, Oakland a/a $20 8pm\nPlease feel free to forward The List on to your friends.\n"
  );
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  function readState(): WeeklyRunState {
    const db = new DatabaseSync(
      join(input.destination, "operator/weekly-runs.sqlite"),
      { readOnly: true }
    );
    try {
      const row = db
        .prepare("SELECT payload FROM run_state WHERE id=?")
        .get(initial.runId);
      return JSON.parse(String(row?.payload)) as WeeklyRunState;
    } finally {
      db.close();
    }
  }
  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "zivv-admit-"));
    originalCheckout = join(base, "original");
    originalOperator = join(base, "operator");
    originalTool = join(base, "tool");
    vi.stubEnv("ZIVV_LEDGER_HOME", originalOperator);
    write(
      join(originalCheckout, "data/ingestion/store.json"),
      canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    for (const path of [
      "package.json",
      "package-lock.json",
      "dist/lib",
      "dist/types",
      "dist/utils",
    ])
      cpSync(resolve(path), join(originalCheckout, path), { recursive: true });
    const npmCli = join(originalTool, "bin/npm-cli.js");
    cpSync(
      resolve("node_modules/postal-mime"),
      join(originalTool, "node_modules/postal-mime"),
      { recursive: true }
    );
    write(
      join(originalTool, "package.json"),
      '{"name":"npm","version":"11.6.0","type":"module"}\n'
    );
    write(
      npmCli,
      `
      import {cpSync,mkdirSync} from 'node:fs';import{dirname,join,resolve}from'node:path';import{fileURLToPath}from'node:url';
      if(process.argv[2]==='--version')console.log('11.6.0');else{mkdirSync('node_modules');cpSync(resolve(dirname(fileURLToPath(import.meta.url)),'../node_modules/postal-mime'),join(process.cwd(),'node_modules/postal-mime'),{recursive:true});}
    `
    );
    const baseline = bootstrapLedger(
      { events: [], artists: [], venues: [] },
      1000
    );
    await writeSqliteLedger(
      join(originalOperator, "ledger.sqlite"),
      baseline,
      true
    );
    const recoveryKey = loadBackupKey(originalOperator, true);
    initial = await runWeeklyImport({
      root: originalCheckout,
      source: {
        editionId: "2026-10-16",
        deliveryId: "actual-recovery-drill",
        raw,
        importObservedAtEpochMs: observed,
      },
      stopAfter: "reconcile",
    });
    expect(initial.stages[3].status).toBe("pending");
    write(
      join(originalCheckout, "data/ingestion/reports/retained-evidence.json"),
      "retained original evidence\n"
    );
    const out = join(base, "final.enc");
    await retireAndCaptureOperatorRecovery({
      root: originalCheckout,
      out,
      npmCli,
    });
    const replacementTool = join(base, "replacement-tool");
    cpSync(originalTool, replacementTool, { recursive: true });
    portable = {
      archive: readFileSync(out),
      retirementReceipt: readFileSync(out + ".retirement.json"),
      recoveryKey,
      npmCli: join(replacementTool, "bin/npm-cli.js"),
    };
    remote = await createAcknowledgedRecoveryRemoteFixture({
      directory: join(base, "authority"),
      ledger: baseline,
      recoveryKey,
    });
    for (const path of [originalCheckout, originalOperator, originalTool]) {
      if (!relative(base, path) || relative(base, path).startsWith(".."))
        throw Error("Unsafe cleanup");
      rmSync(path, { recursive: true });
    }
  });
  beforeEach(async () => {
    input = {
      ...portable,
      destination: join(
        base,
        "restored-" + Math.random().toString(16).slice(2)
      ),
      repositoryRoot: remote.repositoryRoot,
      bareDirectory: remote.bareDirectory,
      runId: initial.runId,
    };
    await prepareOperatorRecoveryRuntime(input);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    const rel = relative(resolve(tmpdir()), resolve(base));
    if (!rel.startsWith("zivv-admit-") || rel.startsWith(".."))
      throw Error("Unsafe cleanup");
    rmSync(base, { recursive: true, force: true });
  });
  it("uses the retained worker to load once with unchanged identities and canonical refs", async () => {
    const refs = remote.refs();
    expect(
      [originalCheckout, originalOperator, originalTool].some(existsSync)
    ).toBe(false);
    const result = await resumeOperatorRecoveryImportForTest({
      ...input,
      probeRestrictedConsumers: true,
    });
    expect(result).toMatchObject({
      status: "load-complete",
      activationAllowed: false,
      runId: initial.runId,
    });
    const state = readState();
    expect(state.source).toEqual(initial.source);
    expect(
      state.stages.slice(0, 4).every((stage) => stage.status === "succeeded")
    ).toBe(true);
    expect(
      state.stages.slice(4).every((stage) => stage.status === "pending")
    ).toBe(true);
    const ledger = readSqliteLedger(
      join(input.destination, "operator/ledger.sqlite")
    );
    expect(ledger.events).toHaveLength(1);
    expect(ledger.runs).toHaveLength(1);
    expect(ledger.events[0].createdAtEpochMs).toBe(observed);
    expect(result.ledgerRevision).toBe(ledgerDigest(ledger));
    expect(loadBackupKey(join(input.destination, "operator"))).toEqual(
      input.recoveryKey
    );
    // A crash during result publication can leave a partial atomic-write file
    // after the load and journal have committed. It must not block same-run retry.
    rmSync(join(input.destination, "recovery-import-result.json"));
    write(
      join(
        input.destination,
        "recovery-import-result.json.123.0123456789abcdef.tmp"
      ),
      "partial result evidence"
    );
    const replay = await resumeOperatorRecoveryImportForTest(input);
    expect(replay).toEqual(result);
    expect(readState()).toEqual(state);
    expect(
      ledgerDigest(
        readSqliteLedger(join(input.destination, "operator/ledger.sqlite"))
      )
    ).toBe(result.ledgerRevision);
    expect(remote.refs()).toEqual(refs);
    expect(
      readFileSync(
        join(
          input.destination,
          "checkout/data/ingestion/reports/retained-evidence.json"
        ),
        "utf8"
      )
    ).toBe("retained original evidence\n");
    expect(() =>
      assertOperatorNotQuarantined(join(input.destination, "operator"))
    ).toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
    vi.stubEnv("ZIVV_LEDGER_HOME", join(input.destination, "operator"));
    await expect(
      runWeeklyImport({
        root: join(input.destination, "checkout"),
        runId: initial.runId,
        stopAfter: "load",
      })
    ).rejects.toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
  });
  it("recovers a committed load whose completion response was interrupted", async () => {
    await expect(
      resumeOperatorRecoveryImportForTest({
        ...input,
        interruptAfterEffect: true,
      })
    ).rejects.toThrow("RECOVERY_IMPORT_EXECUTION_FAILED");
    const before = readSqliteLedger(
      join(input.destination, "operator/ledger.sqlite")
    );
    expect(before.events).toHaveLength(1);
    expect(readState().stages[3].status).toBe("running");
    const result = await resumeOperatorRecoveryImportForTest(input);
    expect(readState().stages[3].status).toBe("succeeded");
    expect(result.ledgerRevision).toBe(ledgerDigest(before));
    expect(
      readSqliteLedger(join(input.destination, "operator/ledger.sqlite")).runs
    ).toHaveLength(1);
  });
  it("refuses changed retained configuration and a different run before admission/key installation", async () => {
    await expect(
      resumeOperatorRecoveryImportForTest({ ...input, runId: "missing" })
    ).rejects.toThrow("RECOVERY_IMPORT_RUN_NOT_RETAINED");
    write(join(input.destination, "checkout/data/venue-aliases.json"), "{}");
    await expect(resumeOperatorRecoveryImportForTest(input)).rejects.toThrow();
    expect(existsSync(join(input.destination, "recovery-import.json"))).toBe(
      false
    );
    expect(
      existsSync(join(input.destination, "operator/backup-key.dpapi"))
    ).toBe(false);
    expect(existsSync(join(input.destination, "operator/backup-key.bin"))).toBe(
      false
    );
    expect(
      readSqliteLedger(join(input.destination, "operator/ledger.sqlite")).events
    ).toHaveLength(0);
  });
  it("resumes after a durable intent without inventing or replacing the working key", async () => {
    await expect(
      resumeOperatorRecoveryImportForTest({ ...input, crashAfterIntent: true })
    ).rejects.toThrow("RECOVERY_IMPORT_TEST_AFTER_INTENT");
    const receipt = readFileSync(
      join(input.destination, "recovery-import.json")
    );
    expect(
      existsSync(join(input.destination, "operator/backup-key.dpapi"))
    ).toBe(false);
    expect(existsSync(join(input.destination, "operator/backup-key.bin"))).toBe(
      false
    );
    await resumeOperatorRecoveryImportForTest(input);
    expect(
      readFileSync(join(input.destination, "recovery-import.json"))
    ).toEqual(receipt);
    expect(loadBackupKey(join(input.destination, "operator"))).toEqual(
      input.recoveryKey
    );
  });
  it.each(["dependency", "retained-report"] as const)(
    "blocks %s drift introduced after admission but before load",
    async (alterBeforeLoad) => {
      await expect(
        resumeOperatorRecoveryImportForTest({ ...input, alterBeforeLoad })
      ).rejects.toMatchObject({
        message: "RECOVERY_IMPORT_EXECUTION_FAILED",
        cause: { message: "RECOVERY_IMPORT_IMMUTABLE_EVIDENCE_CHANGED" },
      });
      expect(
        readSqliteLedger(join(input.destination, "operator/ledger.sqlite"))
          .events
      ).toHaveLength(0);
      expect(
        existsSync(join(input.destination, "recovery-import-result.json"))
      ).toBe(false);
    }
  );
});
