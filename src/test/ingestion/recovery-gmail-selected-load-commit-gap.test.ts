import { createHmac } from "node:crypto";
import {
  canonicalJson,
  ledgerDigest,
} from "../../lib/ingestion/sqlite-store.js";
import { verifySelectedLoadResult } from "../../lib/ingestion/recovery-gmail-selected-result-proof.js";
import { inspectSelectedLoadInterruption } from "../../lib/ingestion/recovery-gmail-selected-load-interruption-inspection.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { proveSelectedLoadPhysicalDelta } from "../../lib/ingestion/recovery-gmail-selected-physical-delta.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
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
    const inspected = inspectSelectedLoadInterruption(input);
    expect(inspected).toMatchObject({
      status: "committed",
      runId: installed.runId,
      loadAllowed: false,
      activationAllowed: false,
    });
    expect(inspected.journalSha256).toBe(sha256(journal));
    expect(inspected.lease).toMatchObject({
      status: "active",
      loadAllowed: false,
    });
    const unexpected = join(root, "unexpected-recovery-fixture-file");
    writeFileSync(unexpected, "unexpected", { flag: "wx" });
    try {
      expect(() => inspectSelectedLoadInterruption(input)).toThrow();
    } finally {
      unlinkSync(unexpected);
    }

    const resumedScript = `try{const m=await import(${JSON.stringify(module)}),f=await import(${JSON.stringify(framing)});const chunks=[];for await(const c of process.stdin)chunks.push(c);const result=await m.resumeRecoveredGmailSelectedLoad(f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks)));console.log(JSON.stringify(result));}catch(e){const code=e instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(e.message)?e.message:"NATIVE_RESUME_ERROR";console.error(code);process.exitCode=1;}`;
    const resume = async () => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          pathToFileURL(join(root, "bootstrap/module-boundary.mjs")).href,
          "--input-type=module",
          "--eval",
          resumedScript,
        ],
        {
          cwd: join(root, "checkout"),
          env: { ...process.env, ZIVV_LEDGER_HOME: join(root, "operator") },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes: Buffer) => {
        stdout += bytes.toString("utf8").slice(0, 65536);
      });
      child.stderr.on("data", (bytes: Buffer) => {
        stderr += bytes.toString("utf8").slice(0, 4096);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(encodeRecoveryGmailSelectedLoadFrame(input));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { code, stdout, stderr };
    };
    const activeAttempt = await resume();
    expect(activeAttempt.code).toBe(1);
    expect(activeAttempt.stderr).toContain(
      "RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE"
    );
    expect(existsSync(join(directory, "resume-intent.json"))).toBe(false);
    while (Date.now() <= inspected.lease.expiresAtEpochMs)
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            1000,
            Math.max(1, inspected.lease.expiresAtEpochMs - Date.now() + 1)
          )
        )
      );
    const resumed = await resume();
    if (resumed.code !== 0)
      console.error(
        "SELECTED_LOAD_RESUME_DIAGNOSTIC",
        resumed.stderr.slice(0, 1500)
      );
    expect(resumed.code).toBe(0);
    const resumedReport = JSON.parse(resumed.stdout) as {
      status: string;
      generation: number;
      runId: string;
    };
    expect(resumedReport).toMatchObject({
      status: "selected-load-resumed",
      generation: 2,
      runId: installed.runId,
    });
    const finalCatalog = readCanonicalSqliteLedgerReadOnly(
      join(root, "operator/ledger.sqlite")
    );
    expect(finalCatalog.generation).toBe(2);
    expect(finalCatalog.ledger).toEqual(ledger);
    const finalJournal = validateWeeklyJournalRecoverySnapshot(
      readWeeklyJournalRecoverySnapshotReadOnly(
        join(root, "operator/weekly-runs.sqlite")
      )
    );
    const finalState = JSON.parse(
      finalJournal.runState.find((item) => item.id === installed.runId)!.payload
    ) as { stages: { stage: string; status: string }[] };
    expect(
      finalState.stages.find((stage) => stage.stage === "load")?.status
    ).toBe("succeeded");
    expect(existsSync(join(directory, "resume-intent.json"))).toBe(true);
    expect(existsSync(join(directory, "load-result.json"))).toBe(true);
    const intentBytes = readFileSync(join(directory, "resume-intent.json"));
    const { signature, ...intent } = JSON.parse(
      intentBytes.toString("utf8")
    ) as Record<string, unknown>;
    expect(signature).toBe(
      createHmac("sha256", fixture.input.recoveryKey)
        .update("zivv-selected-load-resume-intent/v1\0")
        .update(canonicalJson(intent))
        .digest("hex")
    );
    const oldOwner = state.ownership.find(
      (item) => item.scope === "prodigic/zivv/production"
    )!;
    const newOwner = finalJournal.ownership.find(
      (item) => item.scope === "prodigic/zivv/production"
    )!;
    expect(intent.previousOwner).toEqual(oldOwner);
    expect(intent.fence).toBe(oldOwner.fence + 1);
    expect(newOwner.fence).toBe(oldOwner.fence + 1);
    expect(newOwner.expiresAtEpochMs).toBe(0);
    expect(Number(intent.startedAtEpochMs)).toBeGreaterThanOrEqual(
      oldOwner.expiresAtEpochMs
    );
    const resultBytes = readFileSync(join(directory, "load-result.json"));
    const resultValue = JSON.parse(resultBytes.toString("utf8")) as {
      reportSha256: string;
    };
    const finalJournalBytes = readWeeklyJournalRecoverySnapshotReadOnly(
      join(root, "operator/weekly-runs.sqlite")
    );
    expect(
      verifySelectedLoadResult(resultBytes, fixture.input.recoveryKey, {
        admissionSha256: installed.admissionSha256,
        executionBaselineSha256: sha256(
          readFileSync(join(directory, "execution-baseline.json"))
        ),
        runId: installed.runId,
        ledgerRevision: ledgerDigest(ledger),
        generation: 2,
        journalSha256: sha256(finalJournalBytes),
        runStateSha256: sha256(canonicalJson(finalState)),
        reportSha256: resultValue.reportSha256,
      })
    ).toMatchObject({ status: "authenticated", loadAllowed: false });
    const retry = await resume();
    expect(retry.code).toBe(1);
    expect(
      readCanonicalSqliteLedgerReadOnly(join(root, "operator/ledger.sqlite"))
    ).toEqual(finalCatalog);

    preserve = false;
  } finally {
    if (preserve)
      console.error("SELECTED_LOAD_COMMIT_GAP_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
