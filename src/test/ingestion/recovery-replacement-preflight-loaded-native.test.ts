import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { resumeOperatorRecoveryGmailBatch } from "../../lib/ingestion/recovery-gmail-capture.js";
import { inspectLoadedReplacementPreflightForTest } from "../../lib/ingestion/recovery-replacement-preflight.js";
import { proveRecoveryGmailCaptureSelection } from "../../lib/ingestion/recovery-gmail-capture-selection.js";
import type { RecoveryGmailCaptureAdmission } from "../../lib/ingestion/recovery-gmail-capture-admission-proof.js";
import { openPreparedRuntimeForAdmission } from "../../lib/ingestion/recovery-runtime.js";
import {
  canonicalJson,
  readCanonicalSqliteLedgerReadOnly,
} from "../../lib/ingestion/sqlite-store.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import { decryptLedgerSnapshot } from "../../lib/ingestion/encrypted-backup.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import type { SteveEmailReceipt } from "../../lib/ingestion/steve-email-intake.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { createRecoveryGmailCaptureRuntimeFixture } from "./fixtures/recovery-gmail-capture-runtime-fixture.js";

vi.setConfig({ testTimeout: 1_800_000 });

it("recovers linked corrections and loads two selected receipts while preserving both parents as obligations", async () => {
  const fixture = await createRecoveryGmailCaptureRuntimeFixture({
    composedBatches: true,
    loadableSource: true,
    retainPublishedOriginalForPreflight: true,
  });
  let preserve = true;
  try {
    const composition = fixture.composition!;
    expect(composition).toBeDefined();
    const root = fixture.input.destination;
    for (const name of [
      "original checkout",
      "original operator",
      "original npm",
    ])
      expect(existsSync(join(fixture.base, name))).toBe(true);
    const prior = {
      ...fixture.input,
      batchId: composition.priorBatchId,
      correctionOfByMessageId: { b1: composition.receiptIds.a1 },
    };
    const own = {
      ...fixture.input,
      batchId: composition.ownBatchId,
      correctionOfByMessageId: { d1: composition.receiptIds.c1 },
    };
    const checkpoint = openPreparedRuntimeForAdmission(
      fixture.input
    ).checkpoint;
    const selection = (batchId: string, corrections: Record<string, string>) =>
      proveRecoveryGmailCaptureSelection({
        checkpoint,
        recoveryKey: fixture.input.recoveryKey,
        batchId,
        correctionOfByMessageId: corrections,
      });
    const priorSelection = selection(
      prior.batchId,
      prior.correctionOfByMessageId
    );
    const ownSelection = selection(own.batchId, own.correctionOfByMessageId);
    const familyPath = (id: string, name: string) =>
      join(root, "recovery-gmail-capture", id, name);
    const journal = () =>
      validateWeeklyJournalRecoverySnapshot(
        readWeeklyJournalRecoverySnapshotReadOnly(
          join(root, "operator/weekly-runs.sqlite")
        )
      );
    const readReceipt = (id: string) => {
      const row = journal().intakeEvidence.find(
        (entry) => entry.kind === "source" && entry.id === id
      );
      if (!row) throw Error("MISSING_SYNTHETIC_RECEIPT");
      return JSON.parse(
        Buffer.from(row.bytes, "base64").toString("utf8")
      ) as SteveEmailReceipt;
    };
    const priorReport = await resumeOperatorRecoveryGmailBatch(prior);
    expect(priorReport).toMatchObject({
      status: "capture-complete",
      activationAllowed: false,
      captureAllowed: false,
    });
    const priorAdmission = readFileSync(
      familyPath(prior.batchId, "admission.json")
    );
    const priorResult = readFileSync(familyPath(prior.batchId, "result.json"));
    expect(readFileSync(familyPath(prior.batchId, "admission.json"))).toEqual(
      priorAdmission
    );
    expect(readReceipt(composition.receiptIds.b1)).toMatchObject({
      disposition: "ready",
      correctionOf: composition.receiptIds.a1,
    });
    const ownReport = await resumeOperatorRecoveryGmailBatch(own);
    expect(ownReport).toMatchObject({
      status: "capture-complete",
      activationAllowed: false,
      captureAllowed: false,
    });
    const ownAdmission = readFileSync(
      familyPath(own.batchId, "admission.json")
    );
    const ownResult = readFileSync(familyPath(own.batchId, "result.json"));
    const signedOwn = JSON.parse(
      ownAdmission.toString("utf8")
    ) as RecoveryGmailCaptureAdmission;
    expect(signedOwn.priorCompleted).toEqual({
      count: 1,
      sha256: sha256(
        canonicalJson([
          {
            admissionSha256: sha256(priorAdmission),
            resultSha256: sha256(priorResult),
          },
        ])
      ),
    });
    const b = readReceipt(composition.receiptIds.b1);
    const c = readReceipt(composition.receiptIds.c1);
    const d = readReceipt(composition.receiptIds.d1);
    expect(c).toMatchObject({ disposition: "ready", correctionOf: null });
    expect(d).toMatchObject({
      disposition: "ready",
      correctionOf: c.receiptId,
    });
    expect(b.editionId).not.toBe(d.editionId);
    const priorMessage = priorSelection.messages.find(
      (message) => message.messageId === "b1"
    )!;
    const ownMessage = ownSelection.messages.find(
      (message) => message.messageId === "d1"
    )!;
    const firstSelector = {
      batchId: prior.batchId,
      messageId: "b1",
      rawSha256: priorMessage.rawSha256,
      receiptId: b.receiptId,
    };
    const nextSelector = {
      batchId: own.batchId,
      messageId: "d1",
      rawSha256: ownMessage.rawSha256,
      receiptId: d.receiptId,
    };
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
    const nextWithAdmission = [...nextArgs, "--admission-file", admissionFile];
    const success = (command: string, args: string[]) => {
      const start = performance.now();
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
      const elapsed = Math.round(performance.now() - start);
      const safeCode = /^\{"error":"([A-Z_]{1,64})",/m.exec(
        result.stderr ?? ""
      )?.[1];
      expect(result.error).toBeUndefined();
      for (const value of [
        fixture.base,
        root,
        fixture.input.recoveryKey.toString("base64"),
      ])
        expect((result.stdout ?? "") + (result.stderr ?? "")).not.toContain(
          value
        );
      expect(
        result.status,
        `${command} failed after ${elapsed} ms (${safeCode ?? "no safe error code"})`
      ).toBe(0);
      const report = JSON.parse(result.stdout.trim()) as Record<
        string,
        unknown
      >;
      expect(report.command).toBe(command);
      return report;
    };
    const installed = success("install-selected-load", common);
    const loadedB = success("execute-selected-load", common);
    expect(loadedB).toMatchObject({
      status: "selected-load-complete",
      runId: installed.runId,
      generation: 2,
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
    });
    const prepared = success("prepare-next-selected-load", nextWithAdmission);
    expect(prepared.status).toBe("next-load-admission-prepared");
    const nextInstalled = success(
      "install-next-selected-load",
      nextWithAdmission
    );
    const loadedD = success("execute-next-selected-load", nextWithAdmission);
    expect(loadedD).toMatchObject({
      status: "selected-load-complete",
      runId: nextInstalled.runId,
      generation: 3,
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
    });
    expect(loadedD.runId).not.toBe(loadedB.runId);
    const catalogPath = join(root, "operator/ledger.sqlite");
    const journalPath = join(root, "operator/weekly-runs.sqlite");
    const catalog = readCanonicalSqliteLedgerReadOnly(catalogPath);
    const journalBytes = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    expect(success("resume-next-selected-load", nextWithAdmission)).toEqual({
      ...loadedD,
      command: "resume-next-selected-load",
    });
    expect(readCanonicalSqliteLedgerReadOnly(catalogPath)).toEqual(catalog);
    expect(readWeeklyJournalRecoverySnapshotReadOnly(journalPath)).toEqual(
      journalBytes
    );
    expect(
      decryptLedgerSnapshot(
        readFileSync(
          join(root, "checkout/data/ingestion/backups/ledger.snapshot.enc")
        ),
        fixture.input.recoveryKey
      )
    ).toEqual(catalog.ledger);
    expect(() => assertOperatorNotQuarantined(join(root, "operator"))).toThrow(
      "RECOVERY_INSTALLATION_NOT_ACTIVATED"
    );
    for (const [id, name, bytes] of [
      [prior.batchId, "admission.json", priorAdmission],
      [prior.batchId, "result.json", priorResult],
      [own.batchId, "admission.json", ownAdmission],
      [own.batchId, "result.json", ownResult],
    ] as const)
      expect(readFileSync(familyPath(id, name))).toEqual(bytes);
    const states = validateWeeklyJournalRecoverySnapshot(journalBytes).runState;
    expect(states).toHaveLength(2);
    const audit = success("inspect-composed-gmail-obligations", [
      ...nextWithAdmission,
      "--cutoff",
      new Date().toISOString(),
    ]);
    expect(audit).toMatchObject({
      status: "composed-gmail-obligations-inspected",
      generation: 3,
      blockingBatchCount: 2,
      activationAllowed: false,
      captureAllowed: false,
      loadAllowed: false,
      freezeAllowed: false,
    });
    const batches = audit.batches as Array<{
      messages: Array<{
        messageSha256: string;
        status: string;
        receiptId?: string;
        loadRunIds?: string[];
      }>;
    }>;
    const messages = batches.flatMap((batch) => batch.messages);
    const messageHash = (id: string) =>
      createHash("sha256").update(id).digest("hex");
    for (const [id, receiptId, runId] of [
      ["b1", b.receiptId, loadedB.runId],
      ["d1", d.receiptId, loadedD.runId],
    ] as const)
      expect(messages).toContainEqual(
        expect.objectContaining({
          messageSha256: messageHash(id),
          status: "loaded",
          receiptId,
          loadRunIds: [runId],
        })
      );
    for (const [id, receiptId] of [
      ["a1", composition.receiptIds.a1],
      ["c1", c.receiptId],
    ] as const)
      expect(messages).toContainEqual(
        expect.objectContaining({
          messageSha256: messageHash(id),
          status: "load-pending",
          receiptId,
          loadRunIds: [],
        })
      );
    expect(messages).toHaveLength(4);
    const retained = fixture.retainedOriginal!;
    expect(retained).toBeDefined();
    const laterCutoffEpochMs = Date.now();
    const loadedInput = {
      prior: { ...fixture.input, selector: firstSelector },
      next: nextSelector,
      admission: readFileSync(admissionFile),
    };
    const preflightInput = {
      oldRoot: retained.oldRoot,
      oldNpmCli: retained.oldNpmCli,
      loaded: loadedInput,
      repositoryRoot: retained.authority.repositoryRoot,
      bareDirectory: retained.authority.bareDirectory,
      laterCutoffEpochMs,
    };
    vi.stubEnv("ZIVV_LEDGER_HOME", join(fixture.base, "original operator"));
    try {
      const report = inspectLoadedReplacementPreflightForTest(preflightInput);
      expect(report).toMatchObject({
        status: "loaded-replacement-preflight-observed",
        activationAllowed: false,
        freezeAllowed: false,
        oldFence: {
          ledgerRevision: retained.authority.ledgerRevision,
          activationAllowed: false,
        },
        successor: { generation: 3, ledgerRevision: loadedD.ledgerRevision },
        watermark: {
          acknowledgedLedgerRevision: retained.authority.ledgerRevision,
        },
        acknowledgedBlockingBatchCount: 0,
        laterBlockingBatchCount: 2,
      });
      expect(report.successor.ledgerRevision).not.toBe(
        report.watermark.acknowledgedLedgerRevision
      );
      const obligations = report.batches.flatMap((batch) => batch.messages);
      for (const [id, receiptId] of [
        ["a1", composition.receiptIds.a1],
        ["c1", c.receiptId],
      ] as const)
        expect(obligations).toContainEqual(
          expect.objectContaining({
            messageSha256: messageHash(id),
            status: "load-pending",
            receiptId,
            loadRunIds: [],
          })
        );
      expect(inspectLoadedReplacementPreflightForTest(preflightInput)).toEqual(
        report
      );
      for (const value of [
        fixture.base,
        retained.oldRoot,
        fixture.input.recoveryKey.toString("base64"),
      ])
        expect(JSON.stringify(report)).not.toContain(value);
      const weeklyPath = join(
        root,
        "checkout/data/ingestion/weekly-editions.json"
      );
      const weeklyBytes = readFileSync(weeklyPath);
      try {
        writeFileSync(weeklyPath, "synthetic changed weekly evidence");
        expect(() =>
          inspectLoadedReplacementPreflightForTest(preflightInput)
        ).toThrow("REPLACEMENT_HOST_PREFLIGHT_UNVERIFIED");
      } finally {
        writeFileSync(weeklyPath, weeklyBytes);
      }
      expect(inspectLoadedReplacementPreflightForTest(preflightInput)).toEqual(
        report
      );
    } finally {
      vi.unstubAllEnvs();
    }
    preserve = false;
  } finally {
    if (preserve) console.error("LOADED_PREFLIGHT_FIXTURE_PRESERVED");
    fixture.cleanup(preserve);
  }
});
