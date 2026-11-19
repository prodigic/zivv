import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import {
  canonicalJson,
  readCanonicalSqliteLedgerReadOnly,
} from "../../lib/ingestion/sqlite-store.js";
import { readWeeklyJournalRecoverySnapshotReadOnly } from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 1_200_000 });

it("prepares, installs, loads and replays one distinct retained receipt through the operator CLI", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    loadableSource: true,
    additionalReadyEdition: true,
    thirdReadyEdition: true,
  });
  let preserve = true;
  try {
    const root = fixture.input.destination;
    const ready = fixture.nextReady!;
    expect(ready).toBeDefined();
    const third = fixture.thirdReady!;
    expect(third).toBeDefined();
    const first = fixture.sourceReceipts.find(
      ({ receipt }) => receipt.messageId === "a1"
    )!.receipt;
    const firstSelector = {
      batchId: ready.originalBatchId,
      messageId: first.messageId,
      rawSha256: first.rawSha256,
      receiptId: first.receiptId,
    };
    const nextSelector = {
      batchId: ready.nextBatchId,
      messageId: ready.receipt.messageId,
      rawSha256: ready.receipt.rawSha256,
      receiptId: ready.receipt.receiptId,
    };
    expect(nextSelector.receiptId).not.toBe(firstSelector.receiptId);
    const firstFile = join(fixture.base, "first-selector.json");
    const nextFile = join(fixture.base, "next-selector.json");
    const admissionFile = join(fixture.base, "next-admission.json");
    writeFileSync(firstFile, canonicalJson(firstSelector) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(nextFile, canonicalJson(nextSelector) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    const common = [
      "--file",
      join(fixture.base, "retired-operator.enc"),
      "--key",
      join(fixture.base, "fixture-recovery-key.base64"),
      "--receipt",
      join(fixture.base, "retired-operator.enc.retirement.json"),
      "--destination",
      root,
      "--npm-cli",
      fixture.input.npmCli,
      "--selector-file",
      firstFile,
    ];
    const nextArgs = [...common, "--next-selector-file", nextFile];
    const run = (command: string, args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/operator-recovery.js"), command, ...args],
        {
          cwd: resolve("."),
          encoding: "utf8",
          windowsHide: true,
          timeout: 600_000,
          maxBuffer: 128 * 1024,
        }
      );
      expect(result.error).toBeUndefined();
      for (const value of [
        fixture.base,
        root,
        fixture.input.recoveryKey.toString("base64"),
      ])
        expect(result.stdout + result.stderr).not.toContain(value);
      return result;
    };
    const success = (command: string, args: string[]) => {
      const started = performance.now();
      const result = run(command, args);
      const elapsed = Math.round(performance.now() - started);
      const code = /^\{"error":"([A-Z_]{1,64})",/m.exec(result.stderr)?.[1];
      expect(
        result.status,
        `${command} failed after ${elapsed} ms (${code ?? "no safe error code"})`
      ).toBe(0);
      const report = JSON.parse(result.stdout.trim()) as Record<
        string,
        unknown
      >;
      expect(report.command).toBe(command);
      return report;
    };
    const firstInstalled = success("install-selected-load", common);
    const firstResult = success("execute-selected-load", common);
    expect(firstResult).toMatchObject({
      status: "selected-load-complete",
      runId: firstInstalled.runId,
      generation: 2,
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
    });
    const inspected = success("inspect-next-selected-load", nextArgs);
    expect(inspected).toMatchObject({
      status: "next-selected-load-inspected",
      previousRunId: firstResult.runId,
      generation: 2,
      activationAllowed: false,
      loadAllowed: false,
    });
    expect(inspected.runId).not.toBe(firstResult.runId);

    const unsafeAdmission = join(root, "unsafe-admission.json");
    const unsafe = run("prepare-next-selected-load", [
      ...nextArgs,
      "--admission-file",
      unsafeAdmission,
    ]);
    expect(unsafe.status).toBe(1);
    expect(unsafe.stdout).toBe("");
    expect(existsSync(unsafeAdmission)).toBe(false);

    const withAdmission = [...nextArgs, "--admission-file", admissionFile];
    const prepared = success("prepare-next-selected-load", withAdmission);
    expect(prepared).toMatchObject({
      status: "next-load-admission-prepared",
      runId: inspected.runId,
    });
    const bytes = readFileSync(admissionFile);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThanOrEqual(65_536);
    const preparedAgain = success("prepare-next-selected-load", withAdmission);
    expect(preparedAgain).toEqual(prepared);
    expect(readFileSync(admissionFile)).toEqual(bytes);

    const premature = run("execute-next-selected-load", withAdmission);
    expect(premature.status).toBe(1);
    expect(premature.stdout).toBe("");
    const tampered = join(fixture.base, "tampered-admission.json");
    const signed = JSON.parse(bytes.toString("utf8")) as {
      signature: string;
    };
    signed.signature =
      (signed.signature.startsWith("0") ? "1" : "0") +
      signed.signature.slice(1);
    const altered = Buffer.from(canonicalJson(signed) + "\n");
    writeFileSync(tampered, altered, { flag: "wx", mode: 0o600 });
    const refused = run("install-next-selected-load", [
      ...nextArgs,
      "--admission-file",
      tampered,
    ]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(readFileSync(admissionFile)).toEqual(bytes);

    const installed = success("install-next-selected-load", withAdmission);
    expect(installed).toMatchObject({
      status: "next-load-admission-installed",
      runId: inspected.runId,
    });
    expect(success("install-next-selected-load", withAdmission)).toEqual(
      installed
    );
    const loaded = success("execute-next-selected-load", withAdmission);
    expect(loaded).toMatchObject({
      status: "selected-load-complete",
      runId: inspected.runId,
      generation: 3,
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
      resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      ledgerRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const catalogPath = join(root, "operator/ledger.sqlite");
    const journalPath = join(root, "operator/weekly-runs.sqlite");
    const catalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
    const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    const replay = success("resume-next-selected-load", withAdmission);
    expect(replay).toEqual({ ...loaded, command: "resume-next-selected-load" });
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    expect(readFileSync(admissionFile)).toEqual(bytes);

    const composedArgs = [
      ...withAdmission,
      "--cutoff",
      new Date().toISOString(),
    ];
    const audit = success("inspect-composed-gmail-obligations", composedArgs);
    expect(audit).toMatchObject({
      status: "composed-gmail-obligations-inspected",
      generation: 3,
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
      freezeAllowed: false,
      blockingBatchCount: expect.any(Number),
    });
    const batches = audit.batches as Array<{
      batchId: string;
      firstSavedAtEpochMs: number;
      messages: Array<{
        messageSha256: string;
        status: string;
        receiptId?: string;
        loadRunIds?: string[];
      }>;
    }>;
    const messageHash = (id: string) =>
      createHash("sha256").update(id).digest("hex");
    const messages = batches.flatMap((batch) => batch.messages);
    expect(
      messages.filter((message) => message.status === "loaded")
    ).toHaveLength(2);
    expect(messages).toContainEqual(
      expect.objectContaining({
        messageSha256: messageHash(first.messageId),
        status: "loaded",
        receiptId: first.receiptId,
        loadRunIds: [firstResult.runId],
      })
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        messageSha256: messageHash(ready.receipt.messageId),
        status: "loaded",
        receiptId: ready.receipt.receiptId,
        loadRunIds: [loaded.runId],
      })
    );
    expect(messages).toContainEqual({
      messageSha256: messageHash("b1"),
      status: "capture-pending",
    });
    const thirdBatch = batches.find((batch) => batch.batchId === third.batchId);
    expect(thirdBatch).toBeDefined();
    expect(thirdBatch!.messages).toContainEqual(
      expect.objectContaining({
        messageSha256: messageHash("f1"),
        status: "load-pending",
        receiptId: third.receipt.receiptId,
        deliveryId: third.receipt.deliveryId,
        sourceSha256: third.receipt.sourceSha256,
        firstObservedAtEpochMs: third.receipt.firstObservedAtEpochMs,
        loadRunIds: [],
      })
    );
    expect(audit.blockingBatchCount).toBe(2);
    const earliest = Math.min(
      ...batches.map((batch) => batch.firstSavedAtEpochMs)
    );
    expect(Number.isSafeInteger(earliest)).toBe(true);
    const boundary = success("inspect-composed-gmail-obligations", [
      ...withAdmission,
      "--cutoff",
      new Date(earliest).toISOString(),
    ]);
    expect(boundary).toMatchObject({
      status: "composed-gmail-obligations-inspected",
      cutoffEpochMs: earliest,
      blockingBatchCount: 0,
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
      freezeAllowed: false,
    });
    expect(boundary.batches).toEqual(batches);

    const resultFile = join(
      root,
      "recovery-gmail-load",
      String(loaded.runId),
      "load-result.json"
    );
    const resultBytes = readFileSync(resultFile);
    const badAudit = run("inspect-composed-gmail-obligations", [
      ...nextArgs,
      "--admission-file",
      tampered,
      "--cutoff",
      new Date().toISOString(),
    ]);
    expect(badAudit.status).toBe(1);
    expect(badAudit.stdout).toBe("");
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journal
    );
    expect(readFileSync(resultFile)).toEqual(resultBytes);
    expect(readFileSync(admissionFile)).toEqual(bytes);
    preserve = false;
  } finally {
    if (preserve)
      console.error("NEXT_SELECTED_OPERATOR_FIXTURE_PRESERVED", fixture.base);
    fixture.cleanup(preserve);
  }
});
