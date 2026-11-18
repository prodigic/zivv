import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { encodeRecoveryGmailSelectedLoadFrame } from "../../lib/ingestion/recovery-gmail-selected-load-framing.js";
import { resumeOperatorRecoveryGmailSelectedLoadEvidence } from "../../lib/ingestion/recovery-gmail-selected-load-launcher.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { readCanonicalSqliteLedgerReadOnly } from "../../lib/ingestion/sqlite-store.js";
import { readWeeklyJournalRecoverySnapshotReadOnly } from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 600000 });
it("inspects a distinct ready edition after the first selected load without writes", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    loadableSource: true,
    seedAuthorityControls: true,
    additionalReadyEdition: true,
  });
  let preserve = true;
  try {
    const root = fixture.input.destination;
    const ready = fixture.nextReady!;
    expect(ready).toBeDefined();
    const original = fixture.sourceReceipts.find(
      ({ receipt }) => receipt.messageId === "a1"
    )!.receipt;
    expect(ready.receipt.editionId).not.toBe(original.editionId);
    const firstSelector = {
      batchId: ready.originalBatchId,
      messageId: original.messageId,
      rawSha256: original.rawSha256,
      receiptId: original.receiptId,
    };
    const nextSelector = {
      batchId: ready.nextBatchId,
      messageId: ready.receipt.messageId,
      rawSha256: ready.receipt.rawSha256,
      receiptId: ready.receipt.receiptId,
    };
    const input = { ...fixture.input, selector: firstSelector };
    const installed =
      await resumeOperatorRecoveryGmailSelectedLoadEvidence(input);
    const entry = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-executor.js"
      )
    ).href;
    const inspector = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-next-inspection.js"
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
    const run = (expression: string) => {
      const script = `try{const e=await import(${JSON.stringify(entry)}),n=await import(${JSON.stringify(inspector)}),f=await import(${JSON.stringify(framing)});const chunks=[];for await(const c of process.stdin)chunks.push(c);const input=f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks));console.log(JSON.stringify(await ${expression}));}catch(error){console.error(error instanceof Error?error.message:"NATIVE_ERROR");process.exitCode=1;}`;
      return spawnSync(
        process.execPath,
        ["--import", bootstrap, "--input-type=module", "--eval", script],
        {
          cwd: join(root, "checkout"),
          env: { ...process.env, ZIVV_LEDGER_HOME: join(root, "operator") },
          input: encodeRecoveryGmailSelectedLoadFrame(input),
          encoding: "utf8",
          windowsHide: true,
          timeout: 180000,
        }
      );
    };
    const first = run("e.executeRecoveredGmailSelectedLoad(input)");
    if (first.status !== 0)
      console.error("NEXT_LOAD_FIRST_DIAGNOSTIC", first.stderr.slice(0, 1500));
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: "selected-load-complete",
      runId: installed.runId,
      generation: 2,
      activationAllowed: false,
      loadAllowed: false,
    });
    const catalogPath = join(root, "operator/ledger.sqlite"),
      journalPath = join(root, "operator/weekly-runs.sqlite");
    const catalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
    const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    const inventory = openPreparedRuntimeForAdmission(
      fixture.input
    ).inventoryGmailSelectedLoadExecution();
    const inspect = (selector: typeof nextSelector) =>
      run(
        `n.inspectNextRecoveryGmailSelectedLoad(input,${JSON.stringify(selector)})`
      );
    const checked = inspect(nextSelector);
    if (checked.status !== 0)
      console.error(
        "NEXT_LOAD_INSPECTION_DIAGNOSTIC",
        checked.stderr.slice(0, 1500)
      );
    expect(checked.status).toBe(0);
    const summary = JSON.parse(checked.stdout) as {
      runId: string;
      priorLoadFamilySha256: string;
    };
    expect(summary).toMatchObject({
      status: "next-selected-load-inspected",
      previousRunId: installed.runId,
      generation: 2,
      loadAllowed: false,
      activationAllowed: false,
    });
    expect(summary.runId).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.runId).not.toBe(installed.runId);
    expect(summary.priorLoadFamilySha256).toMatch(/^[a-f0-9]{64}$/);
    const repeated = inspect(nextSelector);
    expect(repeated.status).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual(summary);
    for (const selector of [
      firstSelector,
      { ...nextSelector, messageId: "wrong-fixture-message" },
      { ...nextSelector, receiptId: "f".repeat(64) },
    ]) {
      const refused = inspect(selector);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(
        "INVALID_NEXT_RECOVERY_GMAIL_SELECTED_LOAD_INSPECTION"
      );
    }
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    expect(
      openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution()
    ).toEqual(inventory);
    preserve = false;
  } finally {
    if (preserve)
      console.error("SELECTED_LOAD_NEXT_INSPECTION_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
