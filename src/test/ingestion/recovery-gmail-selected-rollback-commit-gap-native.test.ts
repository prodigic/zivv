import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { decryptLedgerSnapshot } from "../../lib/ingestion/encrypted-backup.js";
import { readRecoveryGmailHostForLoadInstallation } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { encodeRecoveryGmailSelectedLoadFrame } from "../../lib/ingestion/recovery-gmail-selected-load-framing.js";
import { inspectSelectedLoadInterruption } from "../../lib/ingestion/recovery-gmail-selected-load-interruption-inspection.js";
import { verifySelectedLoadResumeIntent } from "../../lib/ingestion/recovery-gmail-selected-resume-intent.js";
import { resumeOperatorRecoveryGmailSelectedLoadEvidence } from "../../lib/ingestion/recovery-gmail-selected-load-launcher.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { readCanonicalSqliteLedgerReadOnly } from "../../lib/ingestion/sqlite-store.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 900000 });

it("recovers a second death after rollback replay commits the catalog", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    loadableSource: true,
    seedAuthorityControls: true,
  });
  let preserve = true;
  try {
    const root = fixture.input.destination;
    const receipt = fixture.sourceReceipts[0]!.receipt;
    const input = {
      ...fixture.input,
      selector: {
        batchId: fixture.batchIds[0]!,
        messageId: receipt.messageId,
        rawSha256: receipt.rawSha256,
        receiptId: receipt.receiptId,
      },
    };
    const installed =
      await resumeOperatorRecoveryGmailSelectedLoadEvidence(input);
    const host = readRecoveryGmailHostForLoadInstallation(fixture.input);
    const module = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-executor.js"
      )
    ).href;
    const framing = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-framing.js"
      )
    ).href;
    const bootstrap = pathToFileURL(
      join(root, "bootstrap/module-boundary.mjs")
    ).href;
    const catalogPath = join(root, "operator/ledger.sqlite");
    const journalPath = join(root, "operator/weekly-runs.sqlite");
    const snapshotPath = join(
      root,
      "checkout/data/ingestion/backups/ledger.snapshot.enc"
    );
    const loadDirectory = join(root, "recovery-gmail-load", installed.runId);
    const resultPath = join(loadDirectory, "load-result.json");
    const env = { ...process.env, ZIVV_LEDGER_HOME: join(root, "operator") };
    const script = (call: string) =>
      `try{const m=await import(${JSON.stringify(module)}),f=await import(${JSON.stringify(framing)});const chunks=[];for await(const c of process.stdin)chunks.push(c);const input=f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks));const r=await ${call};if(r)console.log(JSON.stringify(r));}catch(e){console.error(e instanceof Error?e.message:"NATIVE_CHILD_ERROR");process.exitCode=1;}`;
    const args = (call: string) => [
      "--import",
      bootstrap,
      "--input-type=module",
      "--eval",
      script(call),
    ];
    const killAt = async (call: string, marker: string) => {
      const child = spawn(process.execPath, args(call), {
        cwd: join(root, "checkout"),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "",
        stderr = "",
        killed = false,
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 180000);
      child.stdout.on("data", (bytes: Buffer) => {
        stdout += bytes.toString("utf8");
        if (!killed && stdout.split(/\r?\n/).includes(marker))
          killed = child.kill("SIGKILL");
      });
      child.stderr.on("data", (bytes: Buffer) => {
        stderr += bytes.toString("utf8").slice(0, 2048);
      });
      const ended = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
      child.stdin.on("error", () => {});
      child.stdin.end(encodeRecoveryGmailSelectedLoadFrame(input));
      try {
        await ended;
      } finally {
        clearTimeout(timer);
      }
      if (!killed || timedOut)
        console.error(
          "ROLLBACK_COMMIT_GAP_CHILD_DIAGNOSTIC",
          stderr.slice(0, 1500)
        );
      expect(timedOut).toBe(false);
      expect(killed).toBe(true);
    };
    const retry = () =>
      spawnSync(
        process.execPath,
        args("m.resumeRecoveredGmailSelectedLoad(input)"),
        {
          cwd: join(root, "checkout"),
          env,
          input: encodeRecoveryGmailSelectedLoadFrame(input),
          encoding: "utf8",
          windowsHide: true,
          timeout: 180000,
        }
      );
    const currentJournal = () =>
      validateWeeklyJournalRecoverySnapshot(
        readWeeklyJournalRecoverySnapshotReadOnly(journalPath)
      );
    const waitForLease = async (signedDeadline = 0) => {
      const owner = currentJournal().ownership.find(
        (item) => item.scope === "prodigic/zivv/production"
      );
      expect(owner).toBeDefined();
      const expiresAt = Math.max(owner!.expiresAtEpochMs, signedDeadline);
      const remaining = expiresAt - Date.now();
      expect(remaining).toBeLessThanOrEqual(180000);
      const deadline = Date.now() + 185000;
      while (Date.now() <= expiresAt) {
        if (Date.now() > deadline) throw Error("LEASE_WAIT_TIMEOUT");
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(1000, Math.max(1, expiresAt - Date.now() + 1))
          )
        );
      }
    };
    const assertRunning = () => {
      const journal = currentJournal();
      const row = journal.runState.find((item) => item.id === installed.runId);
      expect(row).toBeDefined();
      const state = JSON.parse(row!.payload) as {
        stages: { stage: string; status: string }[];
      };
      expect(state.stages.find((stage) => stage.stage === "load")?.status).toBe(
        "running"
      );
      expect(
        journal.stageArtifacts.some(
          (item) => item.runId === installed.runId && item.stage === "load"
        )
      ).toBe(false);
      expect(existsSync(resultPath)).toBe(false);
    };

    await killAt(
      'm.executeRecoveredGmailSelectedLoadForTest(input,"catalog-before-commit")',
      "SELECTED_LOAD_TEST_CATALOG_BEFORE_COMMIT"
    );
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual({
      ledger: host.checkpoint.ledger,
      generation: 1,
    });
    assertRunning();
    await waitForLease();
    await killAt(
      'm.resumeRecoveredGmailSelectedLoadForTest(input,"rollback-catalog-committed")',
      "SELECTED_LOAD_TEST_ROLLBACK_CATALOG_COMMITTED"
    );
    const committedCatalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
    expect(committedCatalog.generation).toBe(2);
    expect(committedCatalog.ledger).not.toEqual(host.checkpoint.ledger);
    expect(
      decryptLedgerSnapshot(readFileSync(snapshotPath), input.recoveryKey)
    ).toEqual(host.checkpoint.ledger);
    assertRunning();
    const intent = verifySelectedLoadResumeIntent(
      readFileSync(join(loadDirectory, "resume-intent.json")),
      input.recoveryKey
    );
    expect(intent.version).toBe(3);
    const beforeJournal =
      readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    const beforeFiles = openPreparedRuntimeForAdmission(
      fixture.input
    ).inventoryGmailSelectedLoadExecution();
    const active = retry();
    expect(active.status).toBe(1);
    expect(active.stderr).toContain(
      "RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE"
    );
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(
      committedCatalog
    );
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      beforeJournal
    );
    expect(
      openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution()
    ).toEqual(beforeFiles);
    await waitForLease(intent.deadlineEpochMs);
    const completed = retry();
    if (completed.status !== 0)
      console.error(
        "ROLLBACK_COMMIT_GAP_RESUME_DIAGNOSTIC",
        completed.stderr.slice(0, 1500)
      );
    expect(completed.status).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({
      status: "selected-load-resumed",
      runId: installed.runId,
      generation: 2,
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
    });
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(
      committedCatalog
    );
    expect(
      decryptLedgerSnapshot(readFileSync(snapshotPath), input.recoveryKey)
    ).toEqual(committedCatalog.ledger);
    const finalJournal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    const finalState = validateWeeklyJournalRecoverySnapshot(finalJournal);
    const row = finalState.runState.find((item) => item.id === installed.runId);
    expect(row).toBeDefined();
    expect(
      (
        JSON.parse(row!.payload) as {
          stages: { stage: string; status: string }[];
        }
      ).stages.find((stage) => stage.stage === "load")?.status
    ).toBe("succeeded");
    expect(
      finalState.stageArtifacts.filter(
        (item) => item.runId === installed.runId && item.stage === "load"
      )
    ).toHaveLength(1);
    expect(existsSync(resultPath)).toBe(true);
    expect(inspectSelectedLoadInterruption(input)).toMatchObject({
      status: "completed",
      runId: installed.runId,
      loadAllowed: false,
      activationAllowed: false,
    });
    const finalFiles = openPreparedRuntimeForAdmission(
      fixture.input
    ).inventoryGmailSelectedLoadExecution();
    const replay = retry();
    expect(replay.status).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual(JSON.parse(completed.stdout));
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(
      committedCatalog
    );
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      finalJournal
    );
    expect(
      openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution()
    ).toEqual(finalFiles);
    preserve = false;
  } finally {
    if (preserve)
      console.error(
        "SELECTED_LOAD_ROLLBACK_COMMIT_GAP_PRESERVED",
        fixture.base
      );
    fixture.cleanup(preserve);
  }
});
