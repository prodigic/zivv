import { readRecoveryInstalledFile } from "../../lib/ingestion/encrypted-backup.js";
import { observeSelectedLoadCompletedJournal } from "../../lib/ingestion/recovery-gmail-selected-completed-journal.js";
import { createHmac } from "node:crypto";
import {
  canonicalJson,
  ledgerDigest,
} from "../../lib/ingestion/sqlite-store.js";
import { reconstructSelectedLoadResumeInventory } from "../../lib/ingestion/recovery-gmail-selected-resume-inventory.js";
import { verifySelectedLoadExecutionBaseline } from "../../lib/ingestion/recovery-gmail-execution-baseline.js";
import { reconstructSelectedLoadResumeJournal } from "../../lib/ingestion/recovery-gmail-selected-resume-journal.js";
import { verifySelectedLoadResumeIntent } from "../../lib/ingestion/recovery-gmail-selected-resume-intent.js";
import { verifySelectedLoadResult } from "../../lib/ingestion/recovery-gmail-selected-result-proof.js";
import { inspectSelectedLoadInterruption } from "../../lib/ingestion/recovery-gmail-selected-load-interruption-inspection.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { proveSelectedLoadPhysicalDelta } from "../../lib/ingestion/recovery-gmail-selected-physical-delta.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  linkSync,
} from "node:fs";
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
vi.setConfig({ testTimeout: 900000 });
it.each(["intent-linked", "lease-acquired"] as const)(
  "observes retry worker death at %s",
  async (point) => {
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
          if (
            ledger.runs.some((run) => run.status === "committed") &&
            !exited
          ) {
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
      expect(
        parsed.stages.find((stage) => stage.stage === "load")?.status
      ).toBe("running");
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
      writeFileSync(
        join(fixture.base, "pre-resume-inventory.json"),
        JSON.stringify(observedEntries)
      );
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
      const resume = async (killAtResult = false, killAtChunk = false) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            pathToFileURL(join(root, "bootstrap/module-boundary.mjs")).href,
            "--input-type=module",
            "--eval",
            killAtChunk
              ? resumedScript
                  .replace(
                    "m.resumeRecoveredGmailSelectedLoad(",
                    "m.resumeRecoveredGmailSelectedLoadForTest("
                  )
                  .replace(
                    "f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks)))",
                    `f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks)), '${point}')`
                  )
              : resumedScript,
          ],
          {
            cwd: join(root, "checkout"),
            env: { ...process.env, ZIVV_LEDGER_HOME: join(root, "operator") },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }
        );
        let stdout = "",
          stderr = "",
          killed = false;
        const contention: (number | null)[] = [];
        child.stdout.on("data", (bytes: Buffer) => {
          stdout += bytes.toString("utf8").slice(0, 65536);
          if (
            killAtChunk &&
            stdout.includes(
              point === "intent-linked"
                ? "SELECTED_LOAD_TEST_INTENT_LINKED"
                : "SELECTED_LOAD_TEST_LEASE_ACQUIRED"
            ) &&
            !killed
          ) {
            const probe =
              "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{timeout:0});try{db.exec('BEGIN IMMEDIATE');db.exec('ROLLBACK');process.exitCode=0}catch(e){process.exitCode=/locked|busy/i.test(String(e.message))?17:18}finally{db.close()}";
            for (const file of ["weekly-runs.sqlite", "ledger.sqlite"]) {
              const result = spawnSync(
                process.execPath,
                ["--no-warnings", "-e", probe, join(root, "operator", file)],
                { encoding: "utf8", windowsHide: true, timeout: 10000 }
              );
              contention.push(result.status);
            }
            killed = child.kill();
          }
        });
        child.stderr.on("data", (bytes: Buffer) => {
          stderr += bytes.toString("utf8").slice(0, 4096);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(encodeRecoveryGmailSelectedLoadFrame(input));
        const watcher = killAtResult
          ? setInterval(() => {
              const target = join(directory, "load-result.json"),
                stage = join(directory, "load-result.json-stage");
              if (
                !killed &&
                existsSync(target) &&
                existsSync(stage) &&
                readdirSync(stage).length === 0
              )
                killed = child.kill();
            }, 1)
          : undefined;
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (watcher) clearInterval(watcher);
        return { code, stdout, stderr, killed, contention };
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
      if (!changedFiles.snapshot)
        throw Error("Expected prior encrypted snapshot");
      const intentDeath = await resume(false, true);
      expect(intentDeath.killed).toBe(true);
      if (point === "lease-acquired") {
        expect(intentDeath.contention).toEqual([17, 0]);
        expect(intentDeath.stdout).toContain(
          "SELECTED_LOAD_TEST_LEASE_ACQUIRED"
        );
        const intentPath = join(directory, "resume-intent.json");
        expect(lstatSync(intentPath).nlink).toBe(1);
        expect(readdirSync(intentPath + "-stage")).toHaveLength(0);
        const journal = readWeeklyJournalRecoverySnapshotReadOnly(
          join(root, "operator/weekly-runs.sqlite")
        );
        const ownership = validateWeeklyJournalRecoverySnapshot(
          journal
        ).ownership.find(
          (entry) => entry.scope === "prodigic/zivv/production"
        )!;
        const intent = verifySelectedLoadResumeIntent(
          readFileSync(intentPath),
          fixture.input.recoveryKey
        );
        expect(ownership.fence).toBe(intent.fence);
        expect(ownership.owner).toBe(intent.owner);
        expect(inspectSelectedLoadInterruption(input)).toMatchObject({
          status: "pending-intent",
          journalSha256: sha256(journal),
          loadAllowed: false,
          activationAllowed: false,
        });
        const files = openPreparedRuntimeForAdmission(
          fixture.input
        ).inventoryGmailSelectedLoadExecution();
        const catalog = readCanonicalSqliteLedgerReadOnly(
          join(root, "operator/ledger.sqlite")
        );
        const retry = await resume();
        expect(retry.code).toBe(1);
        expect(retry.stderr).toContain(
          "RECOVERY_GMAIL_SELECTED_LOAD_NOT_COMMITTED"
        );
        expect(
          readWeeklyJournalRecoverySnapshotReadOnly(
            join(root, "operator/weekly-runs.sqlite")
          )
        ).toEqual(journal);
        expect(
          readCanonicalSqliteLedgerReadOnly(
            join(root, "operator/ledger.sqlite")
          )
        ).toEqual(catalog);
        expect(
          openPreparedRuntimeForAdmission(
            fixture.input
          ).inventoryGmailSelectedLoadExecution()
        ).toEqual(files);
        preserve = false;
        return;
      }
      expect(intentDeath.contention).toEqual([17, 17]);
      expect(intentDeath.stdout).toContain("SELECTED_LOAD_TEST_INTENT_LINKED");
      const intentPath = join(directory, "resume-intent.json");
      expect(lstatSync(intentPath).nlink).toBe(2);
      expect(readdirSync(intentPath + "-stage")).toHaveLength(1);
      const pending = inspectSelectedLoadInterruption(input);
      expect(pending).toMatchObject({
        status: "pending-intent",
        loadAllowed: false,
        activationAllowed: false,
      });
      const beforeJournal = readWeeklyJournalRecoverySnapshotReadOnly(
        join(root, "operator/weekly-runs.sqlite")
      );
      const beforeCatalog = readCanonicalSqliteLedgerReadOnly(
        join(root, "operator/ledger.sqlite")
      );
      const beforeFiles = openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution();
      const retry = await resume();
      expect(retry.code).toBe(1);
      expect(retry.stderr).toContain(
        "RECOVERY_GMAIL_SELECTED_LOAD_NOT_COMMITTED"
      );
      expect(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(root, "operator/weekly-runs.sqlite")
        )
      ).toEqual(beforeJournal);
      expect(
        readCanonicalSqliteLedgerReadOnly(join(root, "operator/ledger.sqlite"))
      ).toEqual(beforeCatalog);
      expect(
        openPreparedRuntimeForAdmission(
          fixture.input
        ).inventoryGmailSelectedLoadExecution()
      ).toEqual(beforeFiles);
      expect(lstatSync(intentPath).nlink).toBe(2);
      // Synthetic successor is deliberately created only inside this private test.
      // This exercises detached observation, not a production signer or retry.
      const settledIntent = readRecoveryInstalledFile(
        intentPath,
        intentPath + "-stage",
        (bytes) => {
          verifySelectedLoadResumeIntent(bytes, fixture.input.recoveryKey);
        }
      );
      const parent = verifySelectedLoadResumeIntent(
        settledIntent,
        fixture.input.recoveryKey
      );
      const successor = {
        kind: "zivv-selected-load-intent-successor",
        version: 1,
        initialSha256: sha256(settledIntent),
        parentSha256: sha256(settledIntent),
        sequence: 1,
        startedAtEpochMs: parent.deadlineEpochMs,
        deadlineEpochMs: parent.deadlineEpochMs + 180000,
      };
      const signature = createHmac("sha256", fixture.input.recoveryKey)
        .update("zivv-selected-load-intent-successor/v1\0")
        .update(canonicalJson(successor))
        .digest("hex");
      const successorPath = join(directory, "resume-successor-00001.json");
      mkdirSync(successorPath + "-stage");
      const successorStage = join(
        successorPath + "-stage",
        "resume-successor-00001.json.123.0123456789abcdef.tmp"
      );
      writeFileSync(
        successorStage,
        canonicalJson({ ...successor, signature }) + "\n"
      );
      linkSync(successorStage, successorPath);
      expect(lstatSync(successorPath).nlink).toBe(2);
      expect(inspectSelectedLoadInterruption(input)).toMatchObject({
        status: "pending-intent",
        pendingSuccessorCount: 1,
        loadAllowed: false,
      });
      const successorFiles = openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution();
      expect((await resume()).code).toBe(1);
      expect(
        openPreparedRuntimeForAdmission(
          fixture.input
        ).inventoryGmailSelectedLoadExecution()
      ).toEqual(successorFiles);
      expect(lstatSync(successorPath).nlink).toBe(2);
      expect(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(root, "operator/weekly-runs.sqlite")
        )
      ).toEqual(beforeJournal);
      expect(
        readCanonicalSqliteLedgerReadOnly(join(root, "operator/ledger.sqlite"))
      ).toEqual(beforeCatalog);
      preserve = false;
    } finally {
      if (preserve)
        console.error("SELECTED_LOAD_PENDING_INTENT_PRESERVED", fixture.base);
      fixture.cleanup(preserve);
    }
  }
);
