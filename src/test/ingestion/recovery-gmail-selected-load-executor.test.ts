import { verifySelectedLoadResult } from "../../lib/ingestion/recovery-gmail-selected-result-proof.js";
import { createHmac } from "node:crypto";
import { readRecoveryGmailHostForLoadInstallation } from "../../lib/ingestion/recovery-gmail-capture-admission.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
    const installed =
      await resumeOperatorRecoveryGmailSelectedLoadEvidence(input);
    const before = validateWeeklyJournalRecoverySnapshot(
      Buffer.from(
        readRecoveryGmailHostForLoadInstallation(fixture.input).current.journal,
        "base64"
      )
    );
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
    const run = () =>
      spawnSync(
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
          input: encodeRecoveryGmailSelectedLoadFrame(input),
          encoding: "utf8",
          windowsHide: true,
          timeout: 240_000,
          maxBuffer: 128 * 1024,
        }
      );
    console.error("SELECTED_SOURCE_LOAD execute", Date.now());
    const child = run();
    if (child.status !== 0)
      console.error(
        "SELECTED_SOURCE_LOAD diagnostic",
        child.status,
        child.error?.message,
        child.stderr
      );
    expect(child.status).toBe(0);
    const report = JSON.parse(child.stdout.trim()) as {
      runId: string;
      ledgerRevision: string;
      generation: number;
      accepted: number;
      resultSha256: string;
    };
    expect(report).toMatchObject({
      status: "selected-load-complete",
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
      generation: 2,
      accepted: 1,
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
    expect(sha256(readFileSync(join(directory, "load-result.json")))).toBe(
      report.resultSha256
    );
    const resultBytes = readFileSync(join(directory, "load-result.json"));
    const { signature, ...signedResult } = JSON.parse(
      resultBytes.toString("utf8")
    ) as Record<string, unknown>;
    expect(signature).toBe(
      createHmac("sha256", fixture.input.recoveryKey)
        .update("zivv-selected-load-result/v1\0")
        .update(canonicalJson(signedResult))
        .digest("hex")
    );
    expect(signedResult).toMatchObject({
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
    expect(existsSync(join(fixture.base, "original checkout"))).toBe(false);
    preserve = false;
    console.error("SELECTED_SOURCE_LOAD verified", Date.now());
  } finally {
    if (preserve) console.error("SELECTED_SOURCE_LOAD preserved", fixture.base);
    fixture.cleanup(preserve);
  }
});
