import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";
import { readRecoveryGmailHostForLoadInstallation } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { resumeOperatorRecoveryGmailSelectedLoadEvidence } from "../../lib/ingestion/recovery-gmail-selected-load-launcher.js";
import { encodeRecoveryGmailSelectedLoadFrame } from "../../lib/ingestion/recovery-gmail-selected-load-framing.js";
import { inspectSelectedLoadInterruption } from "../../lib/ingestion/recovery-gmail-selected-load-interruption-inspection.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { readCanonicalSqliteLedgerReadOnly } from "../../lib/ingestion/sqlite-store.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";

vi.setConfig({ testTimeout: 900000 });
it("rolls back the catalog and refuses unproved precommit replay after worker death", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    loadableSource: true,
    seedAuthorityControls: true,
  });
  let preserve = true;
  try {
    const root = fixture.input.destination,
      receipt = fixture.sourceReceipts[0]!.receipt;
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
    const script = `try{const m=await import(${JSON.stringify(module)}),f=await import(${JSON.stringify(framing)});const chunks=[];for await(const c of process.stdin)chunks.push(c);await m.executeRecoveredGmailSelectedLoadForTest(f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks)),"catalog-before-commit");}catch(e){console.error(e instanceof Error?e.message:"NATIVE_CHILD_ERROR");process.exitCode=1;}`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(root, "bootstrap/module-boundary.mjs")).href,
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd: join(root, "checkout"),
        env: { ...process.env, ZIVV_LEDGER_HOME: join(root, "operator") },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    let killed = false,
      lockStatus: number | null | undefined,
      stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString("utf8");
      if (
        stdout.includes("SELECTED_LOAD_TEST_CATALOG_BEFORE_COMMIT") &&
        !killed
      ) {
        const probe =
          "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{timeout:0});try{db.exec('BEGIN IMMEDIATE');db.exec('ROLLBACK');process.exitCode=0}catch(e){process.exitCode=/locked|busy/i.test(String(e.message))?17:18}finally{db.close()}";
        lockStatus = spawnSync(
          process.execPath,
          ["--no-warnings", "-e", probe, join(root, "operator/ledger.sqlite")],
          { encoding: "utf8", windowsHide: true, timeout: 10000 }
        ).status;
        killed = child.kill("SIGKILL");
      }
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
    await ended;
    if (!killed)
      console.error("PRECOMMIT_CHILD_DIAGNOSTIC", stderr.slice(0, 1500));
    expect(killed).toBe(true);
    expect(lockStatus).toBe(17);
    const catalogPath = join(root, "operator/ledger.sqlite"),
      journalPath = join(root, "operator/weekly-runs.sqlite");
    const catalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
    expect(catalog).toEqual({ ledger: host.checkpoint.ledger, generation: 1 });
    const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    const state = validateWeeklyJournalRecoverySnapshot(journal),
      row = state.runState.find((item) => item.id === installed.runId);
    expect(row).toBeDefined();
    expect(
      (
        JSON.parse(row!.payload) as {
          stages: { stage: string; status: string }[];
        }
      ).stages.find((item) => item.stage === "load")?.status
    ).toBe("running");
    expect(
      existsSync(
        join(root, "recovery-gmail-load", installed.runId, "load-result.json")
      )
    ).toBe(false);
    expect(inspectSelectedLoadInterruption(input)).toMatchObject({
      status: "unchanged",
      loadAllowed: false,
      activationAllowed: false,
    });
    const beforeFiles = openPreparedRuntimeForAdmission(
      fixture.input
    ).inventoryGmailSelectedLoadExecution();
    const resumeScript = `try{const m=await import(${JSON.stringify(module)}),f=await import(${JSON.stringify(framing)});const chunks=[];for await(const c of process.stdin)chunks.push(c);await m.resumeRecoveredGmailSelectedLoad(f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks)));}catch(e){console.error(e instanceof Error?e.message:"NATIVE_RESUME_ERROR");process.exitCode=1;}`;
    const retry = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(root, "bootstrap/module-boundary.mjs")).href,
        "--input-type=module",
        "--eval",
        resumeScript,
      ],
      {
        cwd: join(root, "checkout"),
        env: { ...process.env, ZIVV_LEDGER_HOME: join(root, "operator") },
        input: encodeRecoveryGmailSelectedLoadFrame(input),
        encoding: "utf8",
        windowsHide: true,
        timeout: 180000,
      }
    );
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain(
      "RECOVERY_GMAIL_SELECTED_LOAD_NOT_COMMITTED"
    );
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    expect(
      openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution()
    ).toEqual(beforeFiles);
    preserve = false;
  } finally {
    if (preserve)
      console.error("SELECTED_LOAD_PRECOMMIT_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
