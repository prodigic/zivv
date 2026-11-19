import {
  executeRecoveredGmailSelectedLoad,
  resumeRecoveredGmailSelectedLoad,
} from "../../lib/ingestion/recovery-gmail-selected-load-executor.js";
import { proveSelectedLoadJournalDelta } from "../../lib/ingestion/recovery-gmail-selected-journal-delta.js";
import { readSelectedLoadHistoryFiles } from "../../lib/ingestion/recovery-gmail-selected-load-history.js";
import { inspectSelectedLoadInterruption } from "../../lib/ingestion/recovery-gmail-selected-load-interruption-inspection.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { verifySelectedLoadResult } from "../../lib/ingestion/recovery-gmail-selected-result-proof.js";
import { createHmac } from "node:crypto";
import { readRecoveryGmailHostForLoadInstallation } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";
import { resumeOperatorRecoveryGmailSelectedLoadEvidence } from "../../lib/ingestion/recovery-gmail-selected-load-launcher.js";
import { encodeRecoveryGmailSelectedLoadFrame } from "../../lib/ingestion/recovery-gmail-selected-load-framing.js";
import {
  readSqliteLedgerReadOnly,
  withCanonicalStoreTransaction,
  ledgerDigest,
  canonicalJson,
} from "../../lib/ingestion/sqlite-store.js";
import {
  validateWeeklyJournalRecoverySnapshot,
  readWeeklyJournalRecoverySnapshotReadOnly,
} from "../../lib/ingestion/weekly-run-journal.js";
import { decryptLedgerSnapshot } from "../../lib/ingestion/encrypted-backup.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
vi.setConfig({ testTimeout: 600_000 });
it("loads the exact ready source through the normal runner in a genuine retained worker while leaving quarantine and other captures intact", async () => {
  console.error("SELECTED_SOURCE_LOAD fixture", Date.now());
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    loadableSource: true,
    seedAuthorityControls: true,
  });
  let preserve = true;
  try {
    const receipt = fixture.sourceReceipts[0]!.receipt,
      root = fixture.input.destination;
    const input = {
      ...fixture.input,
      selector: {
        batchId: fixture.batchIds[0]!,
        messageId: receipt.messageId,
        rawSha256: receipt.rawSha256,
        receiptId: receipt.receiptId,
      },
    };
    // The fixture already retains its synthetic capsule, receipt and private key
    // under a secured base. Exercise the actual operator CLI against that same host.
    const selectorFile = join(fixture.base, "selected-receipt.json");
    const foreignSelectorFile = join(
      fixture.base,
      "foreign-selected-receipt.json"
    );
    writeFileSync(selectorFile, canonicalJson(input.selector) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(
      foreignSelectorFile,
      canonicalJson({ ...input.selector, receiptId: "f".repeat(64) }) + "\n",
      { flag: "wx", mode: 0o600 }
    );
    const cliArgs = [
      "--file",
      join(fixture.base, "retired-operator.enc"),
      "--key",
      join(fixture.base, "fixture-recovery-key.base64"),
      "--receipt",
      join(fixture.base, "retired-operator.enc.retirement.json"),
      "--destination",
      root,
      "--npm-cli",
      fixture.input.npmCli,
      "--selector-file",
      selectorFile,
    ];
    const cli = (command: string, args = cliArgs) => {
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/operator-recovery.js"), command, ...args],
        {
          cwd: resolve("."),
          encoding: "utf8",
          windowsHide: true,
          timeout: 600_000,
          maxBuffer: 128 * 1024,
        }
      );
      expect(result.error).toBeUndefined();
      const output = result.stdout + result.stderr;
      for (const privateValue of [
        fixture.base,
        root,
        fixture.input.recoveryKey.toString("base64"),
      ])
        expect(output).not.toContain(privateValue);
      return result;
    };
    const beforeCliLedger = readFileSync(join(root, "operator/ledger.sqlite"));
    const operator = join(root, "operator");
    const journalFiles = () =>
      readdirSync(operator)
        .filter((name) => /^weekly-runs\.sqlite(?:-(?:wal|shm))?$/.test(name))
        .sort()
        .map((name) => [name, readFileSync(join(operator, name))]);
    const beforeCliJournal = journalFiles();
    const duplicate = cli("inspect-selected-load", [
      ...cliArgs,
      "--selector-file",
      selectorFile,
    ]);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stdout).toBe("");
    const duplicateKeyFile = join(
      fixture.base,
      "duplicate-selected-receipt.json"
    );
    writeFileSync(
      duplicateKeyFile,
      '{"batchId":"' +
        input.selector.batchId +
        '",' +
        canonicalJson(input.selector).slice(1),
      { flag: "wx", mode: 0o600 }
    );
    const duplicateKey = cli(
      "install-selected-load",
      cliArgs.map((value) =>
        value === selectorFile ? duplicateKeyFile : value
      )
    );
    expect(duplicateKey.status).toBe(1);
    expect(JSON.parse(duplicateKey.stderr.trim()).error).toBe(
      "INVALID_RECOVERY_GMAIL_SELECTED_LOAD_SELECTOR"
    );
    const foreign = cli(
      "install-selected-load",
      cliArgs.map((value) =>
        value === selectorFile ? foreignSelectorFile : value
      )
    );
    expect(foreign.status).not.toBe(0);
    expect(foreign.stdout).toBe("");
    expect(readFileSync(join(root, "operator/ledger.sqlite"))).toEqual(
      beforeCliLedger
    );
    expect(journalFiles()).toEqual(beforeCliJournal);
    expect(existsSync(join(root, "recovery-gmail-load"))).toBe(false);
    const beforeInstall = cli("inspect-selected-load");
    expect(beforeInstall.status).toBe(1);
    expect(JSON.parse(beforeInstall.stderr.trim()).error).toBe(
      "RECOVERY_GMAIL_SELECTED_LOAD_NOT_INSTALLED"
    );
    const executeBeforeInstall = cli("execute-selected-load");
    expect(executeBeforeInstall.status).toBe(1);
    expect(executeBeforeInstall.stdout).toBe("");
    expect(readFileSync(join(root, "operator/ledger.sqlite"))).toEqual(
      beforeCliLedger
    );
    expect(journalFiles()).toEqual(beforeCliJournal);
    expect(existsSync(join(root, "recovery-gmail-load"))).toBe(false);
    const firstInstall = cli("install-selected-load");
    expect(firstInstall.status).toBe(0);
    const firstInstallReport = JSON.parse(firstInstall.stdout.trim()) as Record<
      string,
      unknown
    >;
    expect(firstInstallReport.command).toBe("install-selected-load");
    const inspection = cli("inspect-selected-load");
    expect(inspection.status).toBe(0);
    expect(JSON.parse(inspection.stdout.trim())).toEqual({
      ...firstInstallReport,
      command: "inspect-selected-load",
    });
    const replayInstall = cli("install-selected-load");
    expect(replayInstall.status).toBe(0);
    expect(JSON.parse(replayInstall.stdout.trim())).toEqual(firstInstallReport);
    const installed =
      await resumeOperatorRecoveryGmailSelectedLoadEvidence(input);
    const { command: _command, ...cliInstalled } = firstInstallReport;
    expect(cliInstalled).toEqual(installed);
    vi.stubEnv("ZIVV_LEDGER_HOME", join(root, "operator"));
    try {
      await expect(executeRecoveredGmailSelectedLoad(input)).rejects.toThrow(
        "RECOVERY_GMAIL_SELECTED_LOAD_RETAINED_EXECUTOR_REQUIRED"
      );
      await expect(resumeRecoveredGmailSelectedLoad(input)).rejects.toThrow(
        "RECOVERY_GMAIL_SELECTED_LOAD_RETAINED_EXECUTOR_REQUIRED"
      );
    } finally {
      vi.unstubAllEnvs();
    }
    const host = readRecoveryGmailHostForLoadInstallation(fixture.input);
    const before = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(host.current.journal, "base64")
    );
    const baseline = {
      checkpoint: host.checkpoint,
      recoveryKey: fixture.input.recoveryKey,
      completed: host.completed,
      unfinishedAdmissions: host.unfinishedAdmissions,
      current: host.current,
      currentLedger: host.checkpoint.ledger,
      currentRuntime: host.currentRuntime,
      priorLoads: [],
      selector: input.selector,
      ...(host.ownProductionOwnership
        ? { ownProductionOwnership: host.ownProductionOwnership }
        : {}),
    };

    const entry = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-executor.js"
      )
    ).href;
    const frame = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-framing.js"
      )
    ).href;
    const script = `try {const m=await import(${JSON.stringify(entry)}),f=await import(${JSON.stringify(frame)});const chunks=[];for await(const c of process.stdin)chunks.push(c);const input=f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks));console.log(JSON.stringify(await m.executeRecoveredGmailSelectedLoad(input)));input.recoveryKey.fill(0);}catch(e){console.error(JSON.stringify({code:e instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(e.message)?e.message:'SELECTED_LOAD_NATIVE_ERROR',frames:(e.stack??'').split('\\n').slice(1,7).flatMap(line=>{const m=/([A-Za-z0-9-]+\\.js):(\\d+):(\\d+)/.exec(line);return m?[m[1]+':'+m[2]+':'+m[3]]:[]})}));process.exitCode=1;}`;
    const run = (additionalNodeArguments: string[] = [], resume = false) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(join(root, "bootstrap/module-boundary.mjs")).href,
          ...additionalNodeArguments,
          "--input-type=module",
          "--eval",
          resume
            ? script.replace(
                "m.executeRecoveredGmailSelectedLoad(input)",
                "m.resumeRecoveredGmailSelectedLoad(input)"
              )
            : script,
        ],
        {
          cwd: join(root, "checkout"),
          env: { ...process.env, ZIVV_LEDGER_HOME: join(root, "operator") },
          input: encodeRecoveryGmailSelectedLoadFrame(input),
          encoding: "utf8",
          windowsHide: true,
          timeout: 240_000,
          maxBuffer: 128 * 1024,
        }
      );
    const withPreload = run(["--require", "node:path"]);
    expect(withPreload.status).toBe(1);
    expect(JSON.parse(withPreload.stderr.trim())).toMatchObject({
      code: "RECOVERY_GMAIL_SELECTED_LOAD_RETAINED_EXECUTOR_REQUIRED",
    });
    expect(
      existsSync(
        join(
          root,
          "recovery-gmail-load",
          installed.runId,
          "execution-baseline.json"
        )
      )
    ).toBe(false);
    console.error("SELECTED_SOURCE_LOAD execute", Date.now());
    const child = cli("execute-selected-load");
    expect(child.status).toBe(0);
    const report = JSON.parse(child.stdout.trim()) as {
      command: string;
      status: string;
      activationAllowed: boolean;
      captureAllowed: boolean;
      loadAllowed: boolean;
      runId: string;
      ledgerRevision: string;
      generation: number;
      resultSha256: string;
      admissionSha256: string;
    };
    expect(report).toEqual({
      command: "execute-selected-load",
      status: "selected-load-complete",
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
      runId: installed.runId,
      ledgerRevision: expect.any(String),
      generation: 2,
      resultSha256: expect.any(String),
      admissionSha256: installed.admissionSha256,
    });
    expect(report.runId).toBe(installed.runId);
    const ledger = readSqliteLedgerReadOnly(
      join(root, "operator/ledger.sqlite")
    );
    expect(ledger.events).toHaveLength(1);
    expect(ledger.artists).toHaveLength(1);
    expect(ledger.venues).toHaveLength(1);
    expect(ledger.runs).toHaveLength(1);
    expect(ledger.events[0]!.firstObservedAtEpochMs).toBe(
      receipt.firstObservedAtEpochMs
    );
    expect(ledgerDigest(ledger)).toBe(report.ledgerRevision);
    await withCanonicalStoreTransaction(
      join(root, "operator/ledger.sqlite"),
      { ledger, generation: 2 },
      async () => {}
    );
    const after = validateWeeklyJournalRecoverySnapshot(
      readWeeklyJournalRecoverySnapshotReadOnly(
        join(root, "operator/weekly-runs.sqlite")
      )
    );
    expect(after.intakeEvidence).toEqual(before.intakeEvidence);
    for (const row of before.runState)
      expect(after.runState).toContainEqual(row);
    const state = JSON.parse(
      after.runState.find((row) => row.id === report.runId)!.payload
    ) as {
      source: { rawSha256: string; importObservedAtEpochMs: number };
      stages: { stage: string; status: string }[];
    };
    expect(state.source.rawSha256).toBe(receipt.sourceSha256);
    expect(state.source.importObservedAtEpochMs).toBe(
      receipt.firstObservedAtEpochMs
    );
    expect(
      state.stages.slice(0, 4).every((item) => item.status === "succeeded")
    ).toBe(true);
    expect(
      state.stages.slice(4).every((item) => item.status === "pending")
    ).toBe(true);
    const directory = join(root, "recovery-gmail-load", report.runId);
    const rawArtifact = after.stageArtifacts.find(
      (row) =>
        row.runId === report.runId &&
        row.stage === "acquire" &&
        row.attempt === 0
    )!;
    expect(
      proveSelectedLoadJournalDelta({
        baseline,
        executionBaseline: readFileSync(
          join(directory, "execution-baseline.json")
        ),
        admissionSha256: installed.admissionSha256,
        evidenceSha256: installed.evidenceSha256,
        physicalSnapshotSha256: installed.physicalSnapshotSha256,
        raw: Buffer.from(rawArtifact.bytes, "base64"),
        observedGeneration: 2,
        observedLedger: ledger,
        observedJournal: readWeeklyJournalRecoverySnapshotReadOnly(
          join(root, "operator/weekly-runs.sqlite")
        ),
      })
    ).toMatchObject({
      status: "committed",
      runId: report.runId,
      loadAllowed: false,
    });

    expect(sha256(readFileSync(join(directory, "load-result.json")))).toBe(
      report.resultSha256
    );
    const resultBytes = readFileSync(join(directory, "load-result.json"));
    const { signature, ...signedResult } = JSON.parse(
      resultBytes.toString("utf8")
    ) as Record<string, unknown>;
    expect(signature).toBe(
      createHmac("sha256", fixture.input.recoveryKey)
        .update("zivv-selected-load-result/v3\0")
        .update(canonicalJson(signedResult))
        .digest("hex")
    );
    expect(signedResult).toMatchObject({
      version: 3,
      runId: report.runId,
      generation: 2,
      ledgerRevision: report.ledgerRevision,
    });
    expect(signedResult.journalSha256).toBe(
      sha256(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(root, "operator/weekly-runs.sqlite")
        )
      )
    );
    expect(signedResult.runStateSha256).toBe(sha256(canonicalJson(state)));
    expect(existsSync(join(directory, "resume-intent.json"))).toBe(false);
    const observed = openPreparedRuntimeForAdmission(
      fixture.input
    ).inventoryGmailSelectedLoadExecution();
    const history = readSelectedLoadHistoryFiles({
      loadPath: "recovery-gmail-load/" + report.runId,
      entries: observed,
      key: fixture.input.recoveryKey,
      read: (path) => readFileSync(join(root, path)),
      identity: {
        runId: report.runId,
        admissionSha256: installed.admissionSha256,
        executionBaselineSha256: sha256(
          readFileSync(join(directory, "execution-baseline.json"))
        ),
        priorFamilySha256: sha256(canonicalJson([])),
        ledgerRevision: report.ledgerRevision,
        generation: 2,
      },
    });
    expect(
      verifySelectedLoadResult(resultBytes, fixture.input.recoveryKey, {
        admissionSha256: installed.admissionSha256,
        executionBaselineSha256: sha256(
          readFileSync(join(directory, "execution-baseline.json"))
        ),
        runId: report.runId,
        ledgerRevision: report.ledgerRevision,
        generation: 2,
        journalSha256: sha256(
          readWeeklyJournalRecoverySnapshotReadOnly(
            join(root, "operator/weekly-runs.sqlite")
          )
        ),
        runStateSha256: sha256(canonicalJson(state)),
        reportSha256: signedResult.reportSha256 as string,
        historyManifestSha256: history.manifestSha256,
        guardedJournalSha256: sha256(history.parts.guardedJournal),
      })
    ).toMatchObject({
      status: "authenticated",
      resultSha256: report.resultSha256,
      loadAllowed: false,
    });

    expect(
      decryptLedgerSnapshot(
        readFileSync(
          join(root, "checkout/data/ingestion/backups/ledger.snapshot.enc")
        ),
        fixture.input.recoveryKey
      )
    ).toEqual(ledger);
    expect(() => assertOperatorNotQuarantined(join(root, "operator"))).toThrow(
      "RECOVERY_INSTALLATION_NOT_ACTIVATED"
    );
    const retry = run();
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain(
      "RECOVERY_GMAIL_SELECTED_LOAD_REPLAY_REQUIRES_DELTA_PROOF"
    );
    expect(
      readSqliteLedgerReadOnly(join(root, "operator/ledger.sqlite"))
    ).toEqual(ledger);
    const directInterruption = inspectSelectedLoadInterruption(input);
    expect(directInterruption).toMatchObject({
      status: "completed",
      runId: report.runId,
      loadAllowed: false,
      activationAllowed: false,
    });
    const cliInterruption = cli("inspect-selected-load-interruption");
    expect(cliInterruption.status).toBe(0);
    expect(JSON.parse(cliInterruption.stdout.trim())).toEqual({
      command: "inspect-selected-load-interruption",
      ...directInterruption,
      lease: {
        ...directInterruption.lease,
        observedAtEpochMs: expect.any(Number),
      },
    });
    const sealedReplay = cli("resume-selected-load");
    expect(sealedReplay.status).toBe(0);
    expect(JSON.parse(sealedReplay.stdout)).toEqual({
      ...report,
      command: "resume-selected-load",
      status: "selected-load-resumed",
    });
    expect(
      openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution()
    ).toEqual(observed);
    expect(existsSync(join(fixture.base, "original checkout"))).toBe(false);
    preserve = false;
    console.error("SELECTED_SOURCE_LOAD verified", Date.now());
  } finally {
    if (preserve) console.error("SELECTED_SOURCE_LOAD preserved", fixture.base);
    fixture.cleanup(preserve);
  }
});
