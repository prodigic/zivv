import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { decryptLedgerSnapshot } from "../../lib/ingestion/encrypted-backup.js";
import { encodeRecoveryGmailSelectedLoadFrame } from "../../lib/ingestion/recovery-gmail-selected-load-framing.js";
import { inspectSelectedLoadInterruption } from "../../lib/ingestion/recovery-gmail-selected-load-interruption-inspection.js";
import { resumeOperatorRecoveryGmailSelectedLoadEvidence } from "../../lib/ingestion/recovery-gmail-selected-load-launcher.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { readCanonicalSqliteLedgerReadOnly } from "../../lib/ingestion/sqlite-store.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 900000 });
it("settles a worker death after the first completion history chunk", async () => {
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
    const directory = join(root, "recovery-gmail-load", installed.runId);
    const catalogPath = join(root, "operator/ledger.sqlite");
    const journalPath = join(root, "operator/weekly-runs.sqlite");
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
    const env = { ...process.env, ZIVV_LEDGER_HOME: join(root, "operator") };
    const wrap = (call: string) =>
      `try{const m=await import(${JSON.stringify(module)}),f=await import(${JSON.stringify(framing)});const chunks=[];for await(const c of process.stdin)chunks.push(c);const input=f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks));await ${call};}catch(e){console.error(e instanceof Error?e.message:"NATIVE_CHILD_ERROR");process.exitCode=1;}`;
    const args = (call: string) => [
      "--import",
      bootstrap,
      "--input-type=module",
      "--eval",
      wrap(call),
    ];
    const child = spawn(
      process.execPath,
      args(
        'm.executeRecoveredGmailSelectedLoadForTest(input,"history-first-chunk")'
      ),
      {
        cwd: join(root, "checkout"),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    let killed = false,
      timedOut = false,
      stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 180000);
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString("utf8");
      if (
        !killed &&
        stdout.split(/\r?\n/).includes("SELECTED_LOAD_TEST_HISTORY_FIRST_CHUNK")
      )
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
        "COMPLETION_STAGING_CHILD_DIAGNOSTIC",
        stderr.slice(0, 1500)
      );
    expect(timedOut).toBe(false);
    expect(killed).toBe(true);
    expect(existsSync(join(directory, "completion-intent.json"))).toBe(true);
    expect(existsSync(join(directory, "history-catalog-000.bin"))).toBe(true);
    expect(existsSync(join(directory, "load-result.json"))).toBe(false);
    const catalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
    expect(catalog.generation).toBe(2);
    expect(
      decryptLedgerSnapshot(
        readFileSync(
          join(root, "checkout/data/ingestion/backups/ledger.snapshot.enc")
        ),
        input.recoveryKey
      )
    ).toEqual(catalog.ledger);
    const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    const state = validateWeeklyJournalRecoverySnapshot(journal);
    const row = state.runState.find((item) => item.id === installed.runId);
    expect(row).toBeDefined();
    expect(
      (
        JSON.parse(row!.payload) as {
          stages: { stage: string; status: string }[];
        }
      ).stages.find((stage) => stage.stage === "load")?.status
    ).toBe("succeeded");
    const beforeFiles = openPreparedRuntimeForAdmission(
      fixture.input
    ).inventoryGmailSelectedLoadExecution();
    const active = spawnSync(
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
    expect(active.status).toBe(1);
    expect(active.stderr).toContain(
      "RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE"
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
    const owner = state.ownership.find(
      (item) => item.scope === "prodigic/zivv/production"
    );
    expect(owner).toBeDefined();
    expect(owner!.expiresAtEpochMs - Date.now()).toBeLessThanOrEqual(180000);
    const deadline = Date.now() + 185000;
    while (Date.now() <= owner!.expiresAtEpochMs) {
      if (Date.now() > deadline) throw Error("LEASE_WAIT_TIMEOUT");
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(1000, Math.max(1, owner!.expiresAtEpochMs - Date.now() + 1))
        )
      );
    }
    expect(inspectSelectedLoadInterruption(input)).toMatchObject({
      status: "completion-pending",
      runId: installed.runId,
      loadAllowed: false,
      activationAllowed: false,
      physicalValidationRequired: true,
    });
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    expect(
      openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution()
    ).toEqual(beforeFiles);
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
    const recovered = retry();
    if (recovered.status !== 0)
      console.error(
        "COMPLETION_SETTLEMENT_DIAGNOSTIC",
        recovered.stderr.slice(0, 1500)
      );
    expect(recovered.status).toBe(0);
    const result = JSON.parse(recovered.stdout) as { resultSha256: string };
    expect(result).toMatchObject({
      status: "selected-load-resumed",
      runId: installed.runId,
      generation: 2,
      loadAllowed: false,
      captureAllowed: false,
      activationAllowed: false,
    });
    const completion = JSON.parse(
      readFileSync(join(directory, "completion-intent.json"), "utf8")
    ) as {
      fields: { resultSha256: string };
    };
    expect(result.resultSha256).toBe(completion.fields.resultSha256);
    expect(existsSync(join(directory, "load-result.json"))).toBe(true);
    expect(inspectSelectedLoadInterruption(input)).toMatchObject({
      status: "completed",
      runId: installed.runId,
      loadAllowed: false,
    });
    const after = openPreparedRuntimeForAdmission(
      fixture.input
    ).inventoryGmailSelectedLoadExecution();
    const replay = retry();
    expect(replay.status).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual(result);
    expect(
      openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution()
    ).toEqual(after);
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    preserve = false;
  } finally {
    if (preserve)
      console.error("SELECTED_LOAD_COMPLETION_STAGING_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
