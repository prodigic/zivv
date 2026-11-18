import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { encodeRecoveryGmailSelectedLoadFrame } from "../../lib/ingestion/recovery-gmail-selected-load-framing.js";
import { resumeOperatorRecoveryGmailSelectedLoadEvidence } from "../../lib/ingestion/recovery-gmail-selected-load-launcher.js";
import { verifySelectedLoadCompletionIntent } from "../../lib/ingestion/recovery-gmail-selected-load-completion-intent.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { readCanonicalSqliteLedgerReadOnly } from "../../lib/ingestion/sqlite-store.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 900000 });
it("settles an interrupted successor completion prefix without another fence", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    loadableSource: true,
    seedAuthorityControls: true,
    additionalReadyEdition: true,
  });
  let preserve = true;
  try {
    const root = fixture.input.destination;
    const ready = fixture.nextReady!;
    const original = fixture.sourceReceipts.find(
      ({ receipt }) => receipt.messageId === "a1"
    )!.receipt;
    const input = {
      ...fixture.input,
      selector: {
        batchId: ready.originalBatchId,
        messageId: original.messageId,
        rawSha256: original.rawSha256,
        receiptId: original.receiptId,
      },
    };
    const selector = {
      batchId: ready.nextBatchId,
      messageId: ready.receipt.messageId,
      rawSha256: ready.receipt.rawSha256,
      receiptId: ready.receipt.receiptId,
    };
    const installed =
      await resumeOperatorRecoveryGmailSelectedLoadEvidence(input);
    const moduleUrl = (name: string) =>
      pathToFileURL(join(root, `checkout/dist/lib/ingestion/${name}.js`)).href;
    const bootstrap = pathToFileURL(
      join(root, "bootstrap/module-boundary.mjs")
    ).href;
    const env = { ...process.env, ZIVV_LEDGER_HOME: join(root, "operator") };
    const script = (expression: string) =>
      `try { const e=await import(${JSON.stringify(moduleUrl("recovery-gmail-selected-load-executor"))}), a=await import(${JSON.stringify(moduleUrl("recovery-gmail-selected-load-next-admission"))}), r=await import(${JSON.stringify(moduleUrl("recovery-gmail-selected-load-next-replay"))}), f=await import(${JSON.stringify(moduleUrl("recovery-gmail-selected-load-framing"))}); const chunks=[]; for await (const c of process.stdin) chunks.push(c); const input=f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks)); const selector=${JSON.stringify(selector)}; console.log(JSON.stringify(await ${expression})); } catch(error) { console.error(error instanceof Error ? error.message : "NATIVE_ERROR"); process.exitCode=1; }`;
    const args = (expression: string) => [
      "--import",
      bootstrap,
      "--input-type=module",
      "--eval",
      script(expression),
    ];
    const run = (expression: string) =>
      spawnSync(process.execPath, args(expression), {
        cwd: join(root, "checkout"),
        env,
        input: encodeRecoveryGmailSelectedLoadFrame(input),
        encoding: "utf8",
        windowsHide: true,
        timeout: 180000,
      });
    const first = run("e.executeRecoveredGmailSelectedLoad(input)");
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      runId: installed.runId,
      generation: 2,
    });
    const setup = run(
      `(async()=>{const bytes=a.createRecoveryGmailNextSelectedLoadAdmission(input,selector,Date.now()); return await e.installRecoveredGmailNextSelectedLoadAdmission(input,selector,bytes)})()`
    );
    expect(setup.status, setup.stderr).toBe(0);
    const nextRunId = (JSON.parse(setup.stdout) as { runId: string }).runId;
    const directory = join(root, "recovery-gmail-load", nextRunId);
    const admission = `(await import('node:fs')).readFileSync(${JSON.stringify(join(directory, "admission.json"))})`;
    const child = spawn(
      process.execPath,
      args(
        `e.executeRecoveredGmailNextSelectedLoadForTest(input,selector,${admission},"history-first-chunk")`
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
      stdout += bytes.toString();
      if (
        !killed &&
        stdout.split(/\r?\n/).includes("SELECTED_LOAD_TEST_HISTORY_FIRST_CHUNK")
      )
        killed = child.kill("SIGKILL");
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderr += bytes.toString().slice(0, 2048);
    });
    const ended = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(encodeRecoveryGmailSelectedLoadFrame(input));
    let exit;
    try {
      exit = await ended;
    } finally {
      clearTimeout(timer);
    }
    expect(timedOut, stderr).toBe(false);
    expect(killed, stderr).toBe(true);
    expect(exit.code).not.toBe(0);
    expect(exit.code).not.toBe(134);
    expect(exit.signal).not.toBe("SIGABRT");
    const intentBytes = readFileSync(join(directory, "completion-intent.json"));
    const intent = JSON.parse(intentBytes.toString()) as {
      fields: {
        identity: { runId: string; generation: number };
        resultSha256: string;
      };
    };
    expect(
      verifySelectedLoadCompletionIntent(
        intentBytes,
        fixture.input.recoveryKey,
        intent.fields.identity
      )
    ).toMatchObject({
      fields: { identity: { runId: nextRunId, generation: 3 } },
      loadAllowed: false,
    });
    const chunkPath = join(directory, "history-catalog-000.bin");
    const chunk = readFileSync(chunkPath);
    expect(existsSync(join(directory, "load-result.json"))).toBe(false);
    const catalogPath = join(root, "operator/ledger.sqlite"),
      journalPath = join(root, "operator/weekly-runs.sqlite");
    const catalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
    expect(catalog.generation).toBe(3);
    const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    const state = validateWeeklyJournalRecoverySnapshot(journal);
    const row = state.runState.find((item) => item.id === nextRunId);
    expect(row).toBeDefined();
    expect(
      (
        JSON.parse(row!.payload) as {
          stages: { stage: string; status: string }[];
        }
      ).stages.find((stage) => stage.stage === "load")?.status
    ).toBe("succeeded");
    expect(
      state.stageArtifacts.some(
        (item) => item.runId === nextRunId && item.stage === "load"
      )
    ).toBe(true);
    const inventory = () =>
      openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution();
    const prefix = inventory();
    const inspect = () =>
      run(`r.inspectNextSelectedLoadCompletion(input,selector,${admission})`);
    const activeInspection = inspect();
    expect(activeInspection.status, activeInspection.stderr).toBe(0);
    expect(JSON.parse(activeInspection.stdout)).toMatchObject({
      status: "completion-pending",
      lease: { status: "active" },
      loadAllowed: false,
    });
    const replay = () =>
      run(
        `r.replayRecoveredGmailNextSelectedLoad(input,selector,${admission})`
      );
    expect(replay().status).toBe(1);
    const resume = () =>
      run(
        `e.resumeRecoveredGmailNextSelectedLoad(input,selector,${admission})`
      );
    const active = resume();
    expect(active.status).toBe(1);
    expect(active.stderr).toContain(
      "RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE"
    );
    expect(inventory()).toEqual(prefix);
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
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
    const inspected = inspect();
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      status: "completion-pending",
      generation: 3,
      lease: {
        status: "expired",
        expiresAtEpochMs: owner!.expiresAtEpochMs,
        loadAllowed: false,
      },
      loadAllowed: false,
      captureAllowed: false,
      activationAllowed: false,
    });
    expect(inventory()).toEqual(prefix);
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    const foreignPath = join(directory, "history-foreign-fixture.bin"),
      foreignBytes = Buffer.from("synthetic foreign prefix");
    writeFileSync(foreignPath, foreignBytes, { flag: "wx" });
    try {
      expect(inspect().status).toBe(1);
      expect(resume().status).toBe(1);
      expect(readFileSync(foreignPath)).toEqual(foreignBytes);
      expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
      expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
        journal
      );
    } finally {
      unlinkSync(foreignPath);
    }
    expect(inventory()).toEqual(prefix);
    const settled = resume();
    expect(settled.status, settled.stderr).toBe(0);
    const result = JSON.parse(settled.stdout) as { resultSha256: string };
    expect(result).toMatchObject({
      runId: nextRunId,
      generation: 3,
      resultSha256: intent.fields.resultSha256,
      loadAllowed: false,
      captureAllowed: false,
      activationAllowed: false,
    });
    expect(readFileSync(join(directory, "completion-intent.json"))).toEqual(
      intentBytes
    );
    expect(readFileSync(chunkPath)).toEqual(chunk);
    expect(existsSync(join(directory, "load-result.json"))).toBe(true);
    const after = inventory();
    for (const entry of prefix) expect(after).toContainEqual(entry);
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    const replayed = replay();
    expect(replayed.status, replayed.stderr).toBe(0);
    expect(JSON.parse(replayed.stdout)).toEqual(result);
    expect(inventory()).toEqual(after);
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    preserve = false;
  } finally {
    if (preserve)
      console.error("NEXT_COMPLETION_PREFIX_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
