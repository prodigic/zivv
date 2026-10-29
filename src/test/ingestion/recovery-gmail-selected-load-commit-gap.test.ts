import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { proveSelectedLoadPhysicalDelta } from "../../lib/ingestion/recovery-gmail-selected-physical-delta.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";
import { readRecoveryGmailHostForLoadInstallation } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { resumeOperatorRecoveryGmailSelectedLoadEvidence } from "../../lib/ingestion/recovery-gmail-selected-load-launcher.js";
import { encodeRecoveryGmailSelectedLoadFrame } from "../../lib/ingestion/recovery-gmail-selected-load-framing.js";
import {
  readSqliteLedgerReadOnly,
  readCanonicalSqliteLedgerReadOnly,
} from "../../lib/ingestion/sqlite-store.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { proveSelectedLoadJournalDelta } from "../../lib/ingestion/recovery-gmail-selected-journal-delta.js";
vi.setConfig({ testTimeout: 600000 });
it("proves a real retained worker stopped after its catalog commit", async () => {
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
    const installed =
        await resumeOperatorRecoveryGmailSelectedLoadEvidence(input),
      host = readRecoveryGmailHostForLoadInstallation(fixture.input);
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
    const module = pathToFileURL(
        join(
          root,
          "checkout/dist/lib/ingestion/recovery-gmail-selected-load-executor.js"
        )
      ).href,
      framing = pathToFileURL(
        join(
          root,
          "checkout/dist/lib/ingestion/recovery-gmail-selected-load-framing.js"
        )
      ).href;
    const script = `try{const m=await import(${JSON.stringify(module)}),f=await import(${JSON.stringify(framing)});const chunks=[];for await(const c of process.stdin)chunks.push(c);await m.executeRecoveredGmailSelectedLoad(f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks)));}catch(e){const code=e instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(e.message)?e.message:"NATIVE_CHILD_ERROR";console.error(code);process.exitCode=1;}`;
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
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      }
    );
    let exited = false,
      killedAfterCommit = false;
    const ended = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => {
        exited = true;
        resolve();
      });
    });
    let diagnostic = "";
    child.stderr.on("data", (data: Buffer) => {
      diagnostic += data.toString("utf8").slice(0, 1024);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(encodeRecoveryGmailSelectedLoadFrame(input));
    while (!exited) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (
        !existsSync(
          join(
            root,
            "recovery-gmail-load",
            installed.runId,
            "execution-baseline.json"
          )
        )
      )
        continue;
      try {
        const ledger = readSqliteLedgerReadOnly(
          join(root, "operator/ledger.sqlite")
        );
        if (ledger.runs.some((run) => run.status === "committed") && !exited) {
          killedAfterCommit = child.kill("SIGKILL");
          break;
        }
      } catch {
        /* The catalog may be locked while the worker commits. */
      }
    }
    await ended;
    if (!killedAfterCommit)
      console.error(
        "SELECTED_LOAD_CHILD_DIAGNOSTIC",
        diagnostic.slice(0, 1500)
      );
    expect(killedAfterCommit).toBe(true);
    const { ledger, generation } = readCanonicalSqliteLedgerReadOnly(
        join(root, "operator/ledger.sqlite")
      ),
      journal = readWeeklyJournalRecoverySnapshotReadOnly(
        join(root, "operator/weekly-runs.sqlite")
      ),
      state = validateWeeklyJournalRecoverySnapshot(journal),
      entry = state.runState.find((row) => row.id === installed.runId)!;
    expect(generation).toBe(2);
    const parsed = JSON.parse(entry.payload) as {
      stages: { stage: string; status: string }[];
    };
    expect(parsed.stages.find((stage) => stage.stage === "load")?.status).toBe(
      "running"
    );
    const raw = state.stageArtifacts.find(
      (row) =>
        row.runId === installed.runId &&
        row.stage === "acquire" &&
        row.attempt === 0
    )!;
    const directory = join(root, "recovery-gmail-load", installed.runId);
    expect(existsSync(join(directory, "load-result.json"))).toBe(false);
    const keyPath = join(
      root,
      "operator",
      process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
    );
    const snapshotPath = join(
      root,
      "checkout/data/ingestion/backups/ledger.snapshot.enc"
    );
    const reportPath = join(
      root,
      "checkout/data/ingestion/reports",
      sha256(ledger.runs[0]!.runId) + ".json"
    );
    const changedFiles = {
      ...(existsSync(keyPath) ? { key: readFileSync(keyPath) } : {}),
      ...(existsSync(snapshotPath)
        ? { snapshot: readFileSync(snapshotPath) }
        : {}),
      ...(existsSync(reportPath) ? { report: readFileSync(reportPath) } : {}),
    };
    const observedEntries = openPreparedRuntimeForAdmission(
      fixture.input
    ).inventoryGmailSelectedLoadExecution();
    expect(
      proveSelectedLoadPhysicalDelta({
        baseline,
        executionBaseline: readFileSync(
          join(directory, "execution-baseline.json")
        ),
        admissionSha256: installed.admissionSha256,
        evidenceSha256: installed.evidenceSha256,
        physicalSnapshotSha256: installed.physicalSnapshotSha256,
        raw: Buffer.from(raw.bytes, "base64"),
        observedGeneration: generation,
        observedLedger: ledger,
        observedEntries,
        changedFiles,
      })
    ).toMatchObject({ status: "committed", loadAllowed: false });

    expect(
      proveSelectedLoadJournalDelta({
        baseline,
        executionBaseline: readFileSync(
          join(directory, "execution-baseline.json")
        ),
        admissionSha256: installed.admissionSha256,
        evidenceSha256: installed.evidenceSha256,
        physicalSnapshotSha256: installed.physicalSnapshotSha256,
        raw: Buffer.from(raw.bytes, "base64"),
        observedGeneration: generation,
        observedLedger: ledger,
        observedJournal: journal,
      })
    ).toMatchObject({
      status: "committed",
      runId: installed.runId,
      loadAllowed: false,
    });
    preserve = false;
  } finally {
    if (preserve)
      console.error("SELECTED_LOAD_COMMIT_GAP_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
