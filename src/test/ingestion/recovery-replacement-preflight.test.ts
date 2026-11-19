import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { writeSqliteLedger } from "../../lib/ingestion/sqlite-store.js";
import {
  WeeklyRunJournal,
  readWeeklyJournalRecoverySnapshotReadOnly,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createEmptyWeeklyEditionLedger,
  prepareWeeklyEdition,
  markWeeklyEditionPublished,
  serializeWeeklyEditionLedger,
} from "../../lib/ingestion/weekly.js";
import { retireAndCaptureOperatorRecovery } from "../../lib/ingestion/operator-recovery.js";
import {
  prepareOperatorRecoveryRuntime,
  verifyPreparedOperatorRuntime,
} from "../../lib/ingestion/recovery-runtime.js";
import { inspectReplacementPreflightForTest } from "../../lib/ingestion/recovery-replacement-preflight.js";
import { createAcknowledgedRecoveryRemoteFixture } from "./fixtures/recovery-import-remote-fixture.js";

it("composes a retired old fence, exact prepared successor and current acknowledged watermark", async () => {
  const prefix = "zivv-replacement-preflight-";
  const base = mkdtempSync(join(tmpdir(), prefix));
  let preserve = true;
  const write = (path: string, value: string | Buffer) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  try {
    const oldRoot = join(base, "old checkout");
    const operator = join(base, "old operator");
    const oldNpm = join(base, "old npm");
    const oldNpmCli = join(oldNpm, "bin/npm-cli.js");
    const out = join(base, "retired.enc");
    vi.stubEnv("ZIVV_LEDGER_HOME", operator);
    write(
      join(oldRoot, "data/ingestion/store.json"),
      '{"schemaVersion":1,"backend":"sqlite","namespace":"zivv"}\n'
    );
    for (const path of [
      "package.json",
      "package-lock.json",
      "dist/lib",
      "dist/types",
      "dist/utils",
    ])
      cpSync(resolve(path), join(oldRoot, path), { recursive: true });
    mkdirSync(join(oldNpm, "node_modules"), { recursive: true });
    cpSync(
      resolve("node_modules/postal-mime"),
      join(oldNpm, "node_modules/postal-mime"),
      { recursive: true }
    );
    write(
      join(oldNpm, "package.json"),
      '{"name":"npm","version":"11.6.0","type":"module"}\n'
    );
    write(
      oldNpmCli,
      `import {cpSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.argv[2]==='--version') console.log('11.6.0'); else {
 const modules=join(process.cwd(),'node_modules');mkdirSync(modules);
 cpSync(resolve(dirname(fileURLToPath(import.meta.url)),'../node_modules/postal-mime'),join(modules,'postal-mime'),{recursive:true});
}\n`
    );
    const ledger = bootstrapLedger(
      { events: [], artists: [], venues: [] },
      1000
    );
    await writeSqliteLedger(join(operator, "ledger.sqlite"), ledger, true);
    const key = loadBackupKey(operator, true);
    const journal = new WeeklyRunJournal(operator);
    try {
      const lease = journal.acquire("prodigic/zivv/production");
      journal.release(lease);
    } finally {
      journal.close();
    }
    const draft = prepareWeeklyEdition(createEmptyWeeklyEditionLedger(), [], {
      editionId: "2026-10-16",
      cutoffEpochMs: Date.parse("2026-10-16T19:00:00Z"),
      datasetVersion: "recovery-fixture",
    }).ledger;
    write(
      join(oldRoot, "data/ingestion/weekly-editions.json"),
      serializeWeeklyEditionLedger(
        markWeeklyEditionPublished(draft, "2026-10-16").ledger
      )
    );
    const remote = await createAcknowledgedRecoveryRemoteFixture({
      directory: join(base, "authority"),
      ledger,
      recoveryKey: key,
    });
    const retired = await retireAndCaptureOperatorRecovery({
      root: oldRoot,
      out,
      npmCli: oldNpmCli,
    });
    const replacementNpm = join(base, "replacement npm");
    cpSync(oldNpm, replacementNpm, { recursive: true });
    const prepared = {
      archive: readFileSync(out),
      retirementReceipt: retired.retirementReceipt,
      recoveryKey: key,
      destination: join(base, "replacement"),
      npmCli: join(replacementNpm, "bin/npm-cli.js"),
    };
    const preparedReport = await prepareOperatorRecoveryRuntime(prepared);
    const args = {
      oldRoot,
      oldNpmCli,
      prepared,
      repositoryRoot: remote.repositoryRoot,
      bareDirectory: remote.bareDirectory,
    };
    const oldJournal = () =>
      readWeeklyJournalRecoverySnapshotReadOnly(
        join(operator, "weekly-runs.sqlite")
      );
    const originalSnapshot = oldJournal();
    const refs = remote.refs();
    const head = remote.git(["symbolic-ref", "HEAD"]);
    const controlHead = remote.store.read().head!;
    const report = inspectReplacementPreflightForTest(args);
    expect(report).toMatchObject({
      status: "replacement-preflight-observed",
      activationAllowed: false,
      oldFence: {
        status: "retired-operator-fence-observed",
        activationAllowed: false,
        ledgerRevision: remote.ledgerRevision,
      },
      successor: {
        status: "prepared",
        activationAllowed: false,
        ledgerRevision: remote.ledgerRevision,
      },
      watermark: {
        acknowledgedLedgerRevision: remote.ledgerRevision,
        acknowledgedCutoffEpochMs: Date.parse("2026-10-16T19:00:00Z"),
        editionId: "2026-10-16",
        datasetVersion: "recovery-fixture",
      },
    });
    expect(report.oldFence.checkpointSha256).toBe(
      report.successor.checkpointSha256
    );
    for (const secret of [base, oldRoot, operator, key.toString("base64")])
      expect(JSON.stringify(report)).not.toContain(secret);
    expect(oldJournal()).toEqual(originalSnapshot);
    expect(verifyPreparedOperatorRuntime(prepared)).toEqual(preparedReport);
    expect(remote.refs()).toBe(refs);
    expect(remote.git(["symbolic-ref", "HEAD"])).toBe(head);
    expect(existsSync(oldRoot)).toBe(true);
    expect(existsSync(operator)).toBe(true);

    remote.setControl(remote.claimHead);
    try {
      expect(() => inspectReplacementPreflightForTest(args)).toThrow(
        "REPLACEMENT_HOST_PREFLIGHT_UNVERIFIED"
      );
    } finally {
      remote.setControl(controlHead);
    }
    const marker = join(operator, "operator-retired.json");
    const markerBytes = readFileSync(marker);
    try {
      unlinkSync(marker);
      expect(() => inspectReplacementPreflightForTest(args)).toThrow(
        "REPLACEMENT_HOST_PREFLIGHT_UNVERIFIED"
      );
    } finally {
      writeFileSync(marker, markerBytes);
    }
    const preparedReceipt = join(prepared.destination, "prepared-runtime.json");
    const receiptBytes = readFileSync(preparedReceipt);
    try {
      writeFileSync(preparedReceipt, "synthetic changed receipt");
      expect(() => inspectReplacementPreflightForTest(args)).toThrow(
        "REPLACEMENT_HOST_PREFLIGHT_UNVERIFIED"
      );
    } finally {
      writeFileSync(preparedReceipt, receiptBytes);
    }
    expect(inspectReplacementPreflightForTest(args)).toEqual(report);
    expect(oldJournal()).toEqual(originalSnapshot);
    expect(verifyPreparedOperatorRuntime(prepared)).toEqual(preparedReport);
    expect(remote.refs()).toBe(refs);
    expect(remote.git(["symbolic-ref", "HEAD"])).toBe(head);
    preserve = false;
  } finally {
    vi.unstubAllEnvs();
    if (preserve)
      console.error("REPLACEMENT_PREFLIGHT_FIXTURE_PRESERVED", base);
    else {
      const absolute = resolve(base);
      if (
        dirname(absolute) !== resolve(tmpdir()) ||
        !basename(absolute).startsWith(prefix)
      )
        throw Error("UNSAFE_FIXTURE_CLEANUP");
      rmSync(absolute, { recursive: true, force: true });
    }
  }
}, 600_000);
