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
it("installs only a distinct second admission and settles exact retries", async () => {
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
      catalogSha256: string;
      journalSha256: string;
      inventorySha256: string;
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
    const admissionModule = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-next-admission.js"
      )
    ).href;
    const sqliteModule = pathToFileURL(
      join(root, "checkout/dist/lib/ingestion/sqlite-store.js")
    ).href;
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    expect(
      openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution()
    ).toEqual(inventory);
    const legacyInspector = pathToFileURL(
      join(
        root,
        "checkout/dist/lib/ingestion/recovery-gmail-selected-load-interruption-inspection.js"
      )
    ).href;
    const admissionCheck = run(
      `(
        async () => {
          const admission = await import(${JSON.stringify(admissionModule)});
          const { canonicalJson } = await import(${JSON.stringify(sqliteModule)});
          const { createHmac } = await import("node:crypto");
          const selector = ${JSON.stringify(nextSelector)};
          const when = Date.now();
          const create = admission.createRecoveryGmailNextSelectedLoadAdmission;
          const authenticate = admission.authenticateRecoveryGmailNextSelectedLoadAdmission;
          const bytes = create(input, selector, when);
          const verified = authenticate(input, selector, bytes);
          const again = create(input, selector, when, bytes);
          const { signature, ...payload } = JSON.parse(bytes.toString('utf8'));
          const encode = (record) => Buffer.from(canonicalJson(record) + '\\n');
          const sign = (record) => createHmac('sha256', input.recoveryKey)
            .update('zivv-recovery-gmail-selected-load-admission/v2\\0')
            .update(canonicalJson(record)).digest('hex');
          const wrongParent = { ...payload, priorLoadFamilySha256: 'f'.repeat(64) };
          const rejects = (test) => {
            try { test(); return false; }
            catch (error) {
              return error instanceof Error &&
                error.message === 'INVALID_RECOVERY_GMAIL_NEXT_SELECTED_LOAD_ADMISSION';
            }
          };
          const wrongTime = rejects(() => create(input, selector, when - 1, bytes));
          const tamper = rejects(() => authenticate(input, selector, encode({ ...wrongParent, signature })));
          const wrongParentRejected = rejects(() => authenticate(input, selector, encode({ ...wrongParent, signature: sign(wrongParent) })));
          const knownSignatureMatches = sign(payload) === signature;
          const installer = e.installRecoveredGmailNextSelectedLoadAdmission;
          const firstInstall = await installer(input, selector, bytes);
          const secondInstall = await installer(input, selector, bytes);
          const digest = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
          const fs = await import('node:fs');
          const paths = await import('node:path');
          const directory = paths.join(input.destination, 'recovery-gmail-load', verified.runId);
          const target = paths.join(directory, 'admission.json');
          const alias = paths.join(directory, 'stages/admission', 'admission.json.1234.0123456789abcdef.tmp');
          fs.linkSync(target, alias);
          const linkedRetry = await installer(input, selector, bytes);
          const cleanupVerified = !fs.existsSync(alias) &&
            fs.lstatSync(target).nlink === 1 && fs.readFileSync(target).equals(bytes);
          const foreign = paths.join(directory, 'unexpected-fixture.bin');
          const foreignBytes = Buffer.from('synthetic foreign entry');
          fs.writeFileSync(foreign, foreignBytes, {flag:'wx'});
          let foreignRefused = false, foreignPreserved = false;
          try {
            try { await installer(input, selector, bytes); } catch { foreignRefused = true; }
            foreignPreserved = fs.readFileSync(foreign).equals(foreignBytes);
          } finally { fs.unlinkSync(foreign); }
          const legacy = await import(${JSON.stringify(legacyInspector)});
          let legacyRefused = false;
          try { legacy.inspectSelectedLoadInterruption(input); } catch { legacyRefused = true; }
          return {
            verified, when, firstInstall, secondInstall, linkedRetry, cleanupVerified,
            digest, byteLength: bytes.length, foreignRefused, foreignPreserved, legacyRefused,
            retryMatches: bytes.equals(again),
            knownSignatureMatches, wrongTime, tamper, wrongParent: wrongParentRejected,
          };
        }
      )()`
    );
    if (admissionCheck.status !== 0)
      console.error(
        "NEXT_LOAD_ADMISSION_DIAGNOSTIC",
        admissionCheck.stderr.slice(0, 1500)
      );
    expect(admissionCheck.status).toBe(0);
    const admission = JSON.parse(admissionCheck.stdout) as {
      when: number;
      firstInstall: unknown;
      secondInstall: unknown;
      linkedRetry: unknown;
      digest: string;
      byteLength: number;
      verified: {
        catalogSha256: string;
        journalSha256: string;
        inventorySha256: string;
      };
    };
    expect(admission).toMatchObject({
      retryMatches: true,
      knownSignatureMatches: true,
      wrongTime: true,
      tamper: true,
      wrongParent: true,
      foreignRefused: true,
      foreignPreserved: true,
      legacyRefused: true,
      cleanupVerified: true,
      firstInstall: {
        status: "next-load-admission-installed",
        runId: summary.runId,
        admissionSha256: admission.digest,
        priorLoadFamilySha256: summary.priorLoadFamilySha256,
        loadAllowed: false,
        activationAllowed: false,
      },
      verified: {
        version: 2,
        previousRunId: installed.runId,
        priorLoadFamilySha256: summary.priorLoadFamilySha256,
        generation: 2,
        runId: summary.runId,
        admittedAtEpochMs: admission.when,
        loadAllowed: false,
        activationAllowed: false,
      },
    });
    expect(admission.verified).toMatchObject({
      catalogSha256: (summary as unknown as { catalogSha256: string })
        .catalogSha256,
      journalSha256: (summary as unknown as { journalSha256: string })
        .journalSha256,
      inventorySha256: (summary as unknown as { inventorySha256: string })
        .inventorySha256,
    });
    expect(admission.secondInstall).toEqual(admission.firstInstall);
    expect(admission.linkedRetry).toEqual(admission.firstInstall);
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    expect(
      openPreparedRuntimeForAdmission(
        fixture.input
      ).inventoryGmailSelectedLoadExecution()
    ).toEqual(
      [
        ...inventory,
        { path: `recovery-gmail-load/${summary.runId}`, kind: "directory" },
        {
          path: `recovery-gmail-load/${summary.runId}/stages`,
          kind: "directory",
        },
        {
          path: `recovery-gmail-load/${summary.runId}/stages/admission`,
          kind: "directory",
        },
        {
          path: `recovery-gmail-load/${summary.runId}/admission.json`,
          kind: "file",
          size: admission.byteLength,
          sha256: admission.digest,
        },
      ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    );
    preserve = false;
  } finally {
    if (preserve)
      console.error("SELECTED_LOAD_NEXT_INSPECTION_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
