import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { createHash, createHmac } from "node:crypto";
import { decryptLedgerSnapshot } from "../../lib/ingestion/encrypted-backup.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { encodeRecoveryGmailSelectedLoadFrame } from "../../lib/ingestion/recovery-gmail-selected-load-framing.js";
import { resumeOperatorRecoveryGmailSelectedLoadEvidence } from "../../lib/ingestion/recovery-gmail-selected-load-launcher.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import { readCanonicalSqliteLedgerReadOnly } from "../../lib/ingestion/sqlite-store.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 780000 });
it.each([
  {
    label: "precommit",
    retryPoint: null,
    point: "catalog-before-commit",
    marker: "SELECTED_LOAD_TEST_CATALOG_BEFORE_COMMIT",
    status: "unchanged",
    generation: 2,
  },
  {
    label: "postcommit",
    retryPoint: null,
    point: "catalog-committed",
    marker: "SELECTED_LOAD_TEST_CATALOG_COMMITTED",
    status: "committed",
    generation: 3,
  },
  {
    label: "retry-intent-linked",
    retryPoint: "intent-linked",
    point: "catalog-committed",
    marker: "SELECTED_LOAD_TEST_CATALOG_COMMITTED",
    status: "committed",
    generation: 3,
  },
  {
    label: "retry-lease-acquired",
    retryPoint: "lease-acquired",
    point: "catalog-committed",
    marker: "SELECTED_LOAD_TEST_CATALOG_COMMITTED",
    status: "committed",
    generation: 3,
  },
] as const)(
  "inspects B after worker death at $label",
  async ({ point, marker, status, generation, retryPoint }) => {
    const fixture = await createRecoveryGmailCaptureRuntimeFixture({
      loadableSource: true,
      seedAuthorityControls: true,
      additionalReadyEdition: true,
    });
    let preserve = true;
    try {
      const root = fixture.input.destination;
      const ready = fixture.nextReady!;
      const first = fixture.sourceReceipts.find(
        ({ receipt }) => receipt.messageId === "a1"
      )!.receipt;
      const input = {
        ...fixture.input,
        selector: {
          batchId: ready.originalBatchId,
          messageId: first.messageId,
          rawSha256: first.rawSha256,
          receiptId: first.receiptId,
        },
      };
      const next = {
        batchId: ready.nextBatchId,
        messageId: ready.receipt.messageId,
        rawSha256: ready.receipt.rawSha256,
        receiptId: ready.receipt.receiptId,
      };
      const installed =
        await resumeOperatorRecoveryGmailSelectedLoadEvidence(input);
      const module = pathToFileURL(
        join(
          root,
          "checkout/dist/lib/ingestion/recovery-gmail-selected-load-executor.js"
        )
      ).href;
      const admission = pathToFileURL(
        join(
          root,
          "checkout/dist/lib/ingestion/recovery-gmail-selected-load-next-admission.js"
        )
      ).href;
      const gap = pathToFileURL(
        join(
          root,
          "checkout/dist/lib/ingestion/recovery-gmail-selected-load-next-gap.js"
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
      const script = (call: string) =>
        `try{const e=await import(${JSON.stringify(module)}),a=await import(${JSON.stringify(admission)}),g=await import(${JSON.stringify(gap)}),f=await import(${JSON.stringify(framing)});const chunks=[];for await(const c of process.stdin)chunks.push(c);const input=f.decodeRecoveryGmailSelectedLoadFrame(Buffer.concat(chunks));const selector=${JSON.stringify(next)};const r=await ${call};if(r)console.log(JSON.stringify(r));}catch(error){console.error(error instanceof Error?error.message:"NATIVE_ERROR");process.exitCode=1;}`;
      const args = (call: string) => [
        "--import",
        bootstrap,
        "--input-type=module",
        "--eval",
        script(call),
      ];
      const run = (call: string) =>
        spawnSync(process.execPath, args(call), {
          cwd: join(root, "checkout"),
          env,
          input: encodeRecoveryGmailSelectedLoadFrame(input),
          encoding: "utf8",
          windowsHide: true,
          timeout: 180000,
        });
      const completedA = run("e.executeRecoveredGmailSelectedLoad(input)");
      if (completedA.status !== 0)
        console.error(
          "NEXT_GAP_A_DIAGNOSTIC",
          completedA.stderr.slice(0, 1500)
        );
      expect(completedA.status).toBe(0);
      expect(JSON.parse(completedA.stdout)).toMatchObject({
        runId: installed.runId,
        generation: 2,
      });
      const catalogPath = join(root, "operator/ledger.sqlite");
      const journalPath = join(root, "operator/weekly-runs.sqlite");
      const catalogA = readCanonicalSqliteLedgerReadOnly(catalogPath);
      const priorJournal = validateWeeklyJournalRecoverySnapshot(
        readWeeklyJournalRecoverySnapshotReadOnly(journalPath)
      );
      const setup = run(
        "(async()=>{const bytes=a.createRecoveryGmailNextSelectedLoadAdmission(input,selector,Date.now());return await e.installRecoveredGmailNextSelectedLoadAdmission(input,selector,bytes)})()"
      );
      if (setup.status !== 0)
        console.error("NEXT_GAP_SETUP_DIAGNOSTIC", setup.stderr.slice(0, 1500));
      expect(setup.status).toBe(0);
      const b = JSON.parse(setup.stdout) as { runId: string };
      expect(b.runId).toMatch(/^[a-f0-9]{64}$/);
      expect(b.runId).not.toBe(installed.runId);
      const admissionPath = join(
        root,
        "recovery-gmail-load",
        b.runId,
        "admission.json"
      );
      const bytesExpression = `(await import('node:fs')).readFileSync(${JSON.stringify(admissionPath)})`;
      const child = spawn(
        process.execPath,
        args(
          `e.executeRecoveredGmailNextSelectedLoadForTest(input,selector,${bytesExpression},${JSON.stringify(point)})`
        ),
        {
          cwd: join(root, "checkout"),
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }
      );
      let stdout = "",
        stderr = "",
        markerSeen = false,
        killed = false,
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 180000);
      child.stdout.on("data", (bytes: Buffer) => {
        stdout += bytes.toString("utf8");
        if (!markerSeen && stdout.split(/\r?\n/).includes(marker)) {
          markerSeen = true;
          killed = child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (bytes: Buffer) => {
        stderr += bytes.toString("utf8").slice(0, 2048);
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
      let exit: { code: number | null; signal: NodeJS.Signals | null };
      try {
        exit = await ended;
      } finally {
        clearTimeout(timer);
      }
      if (!markerSeen || !killed || timedOut)
        console.error("NEXT_GAP_CHILD_DIAGNOSTIC", stderr.slice(0, 1500));
      expect(timedOut).toBe(false);
      expect(markerSeen).toBe(true);
      expect(killed).toBe(true);
      expect(exit.signal).not.toBe("SIGABRT");
      expect(exit.code).not.toBe(134);
      expect(exit.code).not.toBe(3);
      expect(exit.code === null || exit.code !== 0).toBe(true);
      const catalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
      expect(catalog.generation).toBe(generation);
      const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
      const state = validateWeeklyJournalRecoverySnapshot(journal);
      const row = state.runState.find((item) => item.id === b.runId);
      expect(row).toBeDefined();
      expect(
        (
          JSON.parse(row!.payload) as {
            stages: { stage: string; status: string }[];
          }
        ).stages.find((item) => item.stage === "load")?.status
      ).toBe("running");
      expect(
        state.stageArtifacts.some(
          (item) => item.runId === b.runId && item.stage === "load"
        )
      ).toBe(false);
      for (const oldRow of priorJournal.runState)
        expect(state.runState).toContainEqual(oldRow);
      for (const oldArtifact of priorJournal.stageArtifacts)
        expect(state.stageArtifacts).toContainEqual(oldArtifact);
      expect(state.intakeEvidence).toEqual(priorJournal.intakeEvidence);
      expect(
        existsSync(
          join(root, "recovery-gmail-load", b.runId, "load-result.json")
        )
      ).toBe(false);
      const inventory = openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution();
      const catalogBytes = readFileSync(catalogPath),
        journalBytes = readFileSync(journalPath);
      const inspected = run(
        `g.inspectNextSelectedLoadInterruption(input,selector,${bytesExpression})`
      );
      if (inspected.status !== 0)
        console.error(
          "NEXT_GAP_INSPECTION_DIAGNOSTIC",
          inspected.stderr.slice(0, 1500)
        );
      expect(inspected.status).toBe(0);
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        status,
        generation,
        lease: { status: "active" },
        loadAllowed: false,
        activationAllowed: false,
      });
      expect(readFileSync(catalogPath)).toEqual(catalogBytes);
      expect(readFileSync(journalPath)).toEqual(journalBytes);
      expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
      expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
        journal
      );
      expect(
        openPreparedRuntimeForAdmission(
          fixture.input
        ).inventoryGmailSelectedLoadExecution()
      ).toEqual(inventory);
      const resume = () =>
        run(
          `e.resumeRecoveredGmailNextSelectedLoad(input,selector,${bytesExpression})`
        );
      const active = resume();
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
      ).toEqual(inventory);
      const previousOwner = state.ownership.find(
        (item) => item.scope === "prodigic/zivv/production"
      );
      expect(previousOwner).toBeDefined();
      expect(previousOwner!.expiresAtEpochMs - Date.now()).toBeLessThanOrEqual(
        180000
      );
      const deadline = Date.now() + 185000;
      while (Date.now() <= previousOwner!.expiresAtEpochMs) {
        if (Date.now() > deadline) throw Error("LEASE_WAIT_TIMEOUT");
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              1000,
              Math.max(1, previousOwner!.expiresAtEpochMs - Date.now() + 1)
            )
          )
        );
      }
      if (status === "committed") {
        const added = catalog.ledger.runs.filter(
          (candidate) =>
            !catalogA.ledger.runs.some((old) => old.runId === candidate.runId)
        );
        expect(added).toHaveLength(1);
        const reportPath = join(
          root,
          "checkout/data/ingestion/reports",
          sha256(added[0]!.runId) + ".json"
        );
        const retainedReport = join(fixture.base, "retained-gap-report.json");
        renameSync(reportPath, retainedReport);
        try {
          const withoutReport = openPreparedRuntimeForAdmission(
            fixture.input
          ).inventoryGmailSelectedLoadExecution();
          const refused = resume();
          expect(refused.status).toBe(1);
          expect(refused.stderr).toContain(
            "INVALID_NEXT_SELECTED_LOAD_INTERRUPTION_INSPECTION"
          );
          expect(readFileSync(catalogPath)).toEqual(catalogBytes);
          expect(readFileSync(journalPath)).toEqual(journalBytes);
          expect(
            openPreparedRuntimeForAdmission(
              fixture.input
            ).inventoryGmailSelectedLoadExecution()
          ).toEqual(withoutReport);
        } finally {
          renameSync(retainedReport, reportPath);
        }
      }
      if (retryPoint) {
        const retryMarker =
          retryPoint === "intent-linked"
            ? "SELECTED_LOAD_TEST_INTENT_LINKED"
            : "SELECTED_LOAD_TEST_LEASE_ACQUIRED";
        const retryChild = spawn(
          process.execPath,
          args(
            `e.resumeRecoveredGmailNextSelectedLoadForTest(input,selector,${bytesExpression},${JSON.stringify(retryPoint)})`
          ),
          {
            cwd: join(root, "checkout"),
            env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }
        );
        let retryOutput = "",
          retryError = "",
          retrySeen = false,
          retryKilled = false,
          retryTimedOut = false;
        const retryTimer = setTimeout(() => {
          retryTimedOut = true;
          retryChild.kill("SIGKILL");
        }, 180000);
        retryChild.stdout.on("data", (bytes: Buffer) => {
          retryOutput += bytes.toString("utf8");
          if (!retrySeen && retryOutput.split(/\r?\n/).includes(retryMarker)) {
            retrySeen = true;
            retryKilled = retryChild.kill("SIGKILL");
          }
        });
        retryChild.stderr.on("data", (bytes: Buffer) => {
          retryError += bytes.toString("utf8").slice(0, 2048);
        });
        const retryEnded = new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          retryChild.once("error", reject);
          retryChild.once("exit", (code, signal) => resolve({ code, signal }));
        });
        retryChild.stdin.on("error", () => {});
        retryChild.stdin.end(encodeRecoveryGmailSelectedLoadFrame(input));
        let retryExit: { code: number | null; signal: NodeJS.Signals | null };
        try {
          retryExit = await retryEnded;
        } finally {
          clearTimeout(retryTimer);
        }
        if (!retrySeen || !retryKilled || retryTimedOut)
          console.error(
            "NEXT_GAP_INTERRUPTED_RETRY_DIAGNOSTIC",
            retryError.slice(0, 1500)
          );
        expect(retryTimedOut).toBe(false);
        expect(retrySeen).toBe(true);
        expect(retryKilled).toBe(true);
        expect(retryExit.signal).not.toBe("SIGABRT");
        expect(retryExit.code).not.toBe(134);
        expect(retryExit.code).not.toBe(3);
        expect(retryExit.code === null || retryExit.code !== 0).toBe(true);
        const intentPath = join(
          root,
          "recovery-gmail-load",
          b.runId,
          "resume-intent.json"
        );
        if (retryPoint === "lease-acquired") {
          const retryJournal =
            readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
          const {
            digest: _oldDigest,
            ownership: oldOwnership,
            ...oldState
          } = state;
          const {
            digest: _retryDigest,
            ownership: retryOwnership,
            ...retryState
          } = validateWeeklyJournalRecoverySnapshot(retryJournal);
          expect(retryState).toEqual(oldState);
          const retryOwner = retryOwnership.find(
            (row) => row.scope === previousOwner!.scope
          )!;
          expect(retryOwner).toMatchObject({
            scope: previousOwner!.scope,
            owner: previousOwner!.owner,
            fence: previousOwner!.fence + 1,
          });
          expect(retryOwner.expiresAtEpochMs).toBeGreaterThan(Date.now());
          expect(retryOwnership).toEqual(
            oldOwnership.map((row) =>
              row.scope === retryOwner.scope ? retryOwner : row
            )
          );
          expect(lstatSync(intentPath).nlink).toBe(1);
          expect(readdirSync(intentPath + "-stage")).toEqual([]);
          const intentBytes = readFileSync(intentPath);
          const { intent } = JSON.parse(intentBytes.toString("utf8")) as {
            intent: { deadlineEpochMs: number };
          };
          expect(intent.deadlineEpochMs).toBeGreaterThanOrEqual(
            retryOwner.expiresAtEpochMs
          );
          const retryInventory = openPreparedRuntimeForAdmission(
            fixture.input
          ).inventoryGmailSelectedLoadExecution();
          expect(
            retryInventory.filter(
              (entry) =>
                entry.path !==
                  `recovery-gmail-load/${b.runId}/resume-intent.json` &&
                entry.path !==
                  `recovery-gmail-load/${b.runId}/resume-intent.json-stage`
            )
          ).toEqual(inventory);
          expect(retryInventory).toHaveLength(inventory.length + 2);
          // Opening the guarded writer can checkpoint already committed WAL
          // pages. Compare catalog contents across that open, then pin the
          // main-file bytes for the detached inspection and active refusal.
          expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(
            catalog
          );
          const retryCatalogSha256 = sha256(readFileSync(catalogPath));
          const retryJournalSha256 = sha256(readFileSync(journalPath));
          const inspectRetry = () =>
            run(
              `g.inspectNextSelectedLoadInterruption(input,selector,${bytesExpression})`
            );
          const assertDetachedRetry = (lease: "active" | "expired") => {
            const result = inspectRetry();
            if (result.status !== 0)
              console.error(
                "NEXT_GAP_ACQUIRED_INSPECTION_DIAGNOSTIC",
                result.stderr.slice(0, 1500)
              );
            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout)).toMatchObject({
              status: "committed",
              generation: 3,
              lease: { status: lease },
              loadAllowed: false,
              activationAllowed: false,
            });
          };
          assertDetachedRetry("active");
          const activeRetry = resume();
          expect(activeRetry.status).toBe(1);
          expect(activeRetry.stderr).toContain(
            "RECOVERY_GMAIL_SELECTED_LOAD_LEASE_ACTIVE"
          );
          const expiry = Math.max(
            retryOwner.expiresAtEpochMs,
            intent.deadlineEpochMs
          );
          while (Date.now() <= expiry) {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(1000, expiry - Date.now() + 1))
            );
          }
          assertDetachedRetry("expired");
          expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(
            catalog
          );
          expect(
            readWeeklyJournalRecoverySnapshotReadOnly(journalPath)
          ).toEqual(retryJournal);
          expect(sha256(readFileSync(catalogPath))).toBe(retryCatalogSha256);
          expect(sha256(readFileSync(journalPath))).toBe(retryJournalSha256);
          expect(readFileSync(intentPath)).toEqual(intentBytes);
          expect(
            openPreparedRuntimeForAdmission(
              fixture.input
            ).inventoryGmailSelectedLoadExecution()
          ).toEqual(retryInventory);
        } else {
          const stagePath = intentPath + "-stage";
          const candidates = readdirSync(stagePath);
          expect(candidates).toHaveLength(1);
          const aliasPath = join(stagePath, candidates[0]!);
          const targetStat = lstatSync(intentPath),
            aliasStat = lstatSync(aliasPath);
          expect(targetStat.nlink).toBe(2);
          expect(aliasStat.nlink).toBe(2);
          expect({ dev: aliasStat.dev, ino: aliasStat.ino }).toEqual({
            dev: targetStat.dev,
            ino: targetStat.ino,
          });
          expect(readFileSync(aliasPath)).toEqual(readFileSync(intentPath));
          const linkedInventory = openPreparedRuntimeForAdmission(
            fixture.input
          ).inventoryGmailSelectedLoadExecution();
          expect(readFileSync(catalogPath)).toEqual(catalogBytes);
          expect(readFileSync(journalPath)).toEqual(journalBytes);
          const linkedInspection = run(
            `g.inspectNextSelectedLoadInterruption(input,selector,${bytesExpression})`
          );
          if (linkedInspection.status !== 0)
            console.error(
              "NEXT_GAP_LINKED_INSPECTION_DIAGNOSTIC",
              linkedInspection.stderr.slice(0, 1500)
            );
          expect(linkedInspection.status).toBe(0);
          expect(JSON.parse(linkedInspection.stdout)).toMatchObject({
            status: "committed",
            generation: 3,
            lease: { status: "expired" },
            loadAllowed: false,
            activationAllowed: false,
          });
          expect(readFileSync(catalogPath)).toEqual(catalogBytes);
          expect(readFileSync(journalPath)).toEqual(journalBytes);
          expect(
            openPreparedRuntimeForAdmission(
              fixture.input
            ).inventoryGmailSelectedLoadExecution()
          ).toEqual(linkedInventory);
        }
      }
      const completed = resume();
      if (completed.status !== 0)
        console.error(
          "NEXT_GAP_RESUME_DIAGNOSTIC",
          completed.stderr.slice(0, 1500)
        );
      expect(completed.status).toBe(0);
      if (retryPoint) {
        const intentPath = join(
          root,
          "recovery-gmail-load",
          b.runId,
          "resume-intent.json"
        );
        expect(lstatSync(intentPath).nlink).toBe(1);
        expect(readdirSync(intentPath + "-stage")).toEqual([]);
      }
      const completedSummary = JSON.parse(completed.stdout) as {
        resultSha256: string;
      };
      expect(completedSummary).toMatchObject({
        status: "selected-load-complete",
        runId: b.runId,
        generation: 3,
        activationAllowed: false,
        captureAllowed: false,
        loadAllowed: false,
      });
      const finalCatalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
      expect(finalCatalog.generation).toBe(3);
      if (status === "committed") expect(finalCatalog).toEqual(catalog);
      else {
        const previousRuns = new Set(
          catalogA.ledger.runs.map((item) => item.runId)
        );
        const addedRuns = finalCatalog.ledger.runs.filter(
          (item) => !previousRuns.has(item.runId)
        );
        expect(addedRuns).toHaveLength(1);
        for (const oldRun of catalogA.ledger.runs)
          expect(finalCatalog.ledger.runs).toContainEqual(oldRun);
      }
      const finalJournalBytes =
        readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
      const finalJournal =
        validateWeeklyJournalRecoverySnapshot(finalJournalBytes);
      for (const oldRow of priorJournal.runState)
        expect(finalJournal.runState).toContainEqual(oldRow);
      for (const oldArtifact of priorJournal.stageArtifacts)
        expect(finalJournal.stageArtifacts).toContainEqual(oldArtifact);
      expect(finalJournal.intakeEvidence).toEqual(priorJournal.intakeEvidence);
      expect(
        finalJournal.ownership.find(
          (item) => item.scope === "prodigic/zivv/production"
        )
      ).toMatchObject({
        fence: previousOwner!.fence + (retryPoint === "lease-acquired" ? 2 : 1),
        expiresAtEpochMs: 0,
      });
      const resultPath = join(
        root,
        "recovery-gmail-load",
        b.runId,
        "load-result.json"
      );
      const resultBytes = readFileSync(resultPath);
      const { signature, ...resultBody } = JSON.parse(
        resultBytes.toString("utf8")
      ) as Record<string, unknown>;
      expect(resultBody).toMatchObject({
        kind: "zivv-selected-load-result",
        version: 3,
        runId: b.runId,
        generation: 3,
      });
      if (retryPoint === "lease-acquired") {
        const successor = join(
          root,
          "recovery-gmail-load",
          b.runId,
          "resume-successor-00001.json"
        );
        expect(lstatSync(successor).nlink).toBe(1);
        expect(readdirSync(successor + "-stage")).toEqual([]);
        expect(resultBody.successorSha256).toBe(
          sha256(readFileSync(successor))
        );
      }
      expect(signature).toBe(
        createHmac("sha256", fixture.input.recoveryKey)
          .update("zivv-selected-load-result/v3\0")
          .update(canonicalJson(resultBody))
          .digest("hex")
      );
      expect(completedSummary.resultSha256).toBe(
        createHash("sha256").update(resultBytes).digest("hex")
      );
      expect(
        decryptLedgerSnapshot(
          readFileSync(
            join(root, "checkout/data/ingestion/backups/ledger.snapshot.enc")
          ),
          fixture.input.recoveryKey
        )
      ).toEqual(finalCatalog.ledger);
      const finalInventory = openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution();
      const replayModule = pathToFileURL(
        join(
          root,
          "checkout/dist/lib/ingestion/recovery-gmail-selected-load-next-replay.js"
        )
      ).href;
      const replay = run(
        `(await import(${JSON.stringify(replayModule)})).replayRecoveredGmailNextSelectedLoad(input,selector,${bytesExpression})`
      );
      if (replay.status !== 0)
        console.error(
          "NEXT_GAP_REPLAY_DIAGNOSTIC",
          replay.stderr.slice(0, 1500)
        );
      expect(replay.status).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual(completedSummary);
      const retried = resume();
      expect(retried.status).toBe(0);
      expect(JSON.parse(retried.stdout)).toEqual(completedSummary);
      expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(
        finalCatalog
      );
      expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
        finalJournalBytes
      );
      expect(
        openPreparedRuntimeForAdmission(
          fixture.input
        ).inventoryGmailSelectedLoadExecution()
      ).toEqual(finalInventory);
      preserve = false;
    } finally {
      if (preserve)
        console.error("SELECTED_LOAD_NEXT_GAP_PRESERVED", fixture.base);
      fixture.cleanup(preserve);
    }
  }
);
