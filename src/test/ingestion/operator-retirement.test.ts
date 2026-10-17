import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  withStoreTransaction,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import {
  captureOperatorRecoveryCheckpoint,
  decryptOperatorRecovery,
  retireAndCaptureOperatorRecovery,
  stageOperatorRecovery,
  verifyOperatorRetirementEvidence,
  encryptOperatorRecovery,
} from "../../lib/ingestion/operator-recovery.js";
import { verifyOperatorRetirementReceipt } from "../../lib/ingestion/operator-installation.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import { runWeeklyImport } from "../../lib/ingestion/weekly-import-runner.js";
import { captureSteveEmail } from "../../lib/ingestion/steve-email-intake.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";

const faults = vi.hoisted(() => ({ path: "", after: false }));
vi.mock("../../lib/ingestion/encrypted-backup.js", async (original) => {
  const actual =
    await original<typeof import("../../lib/ingestion/encrypted-backup.js")>();
  return {
    ...actual,
    writeDurableFile: (path: string, bytes: Buffer) => {
      if (path === faults.path && !faults.after)
        throw new Error("INJECTED_RETIREMENT_WRITE_FAILURE");
      actual.writeDurableFile(path, bytes);
      if (path === faults.path && faults.after)
        throw new Error("INJECTED_RETIREMENT_WRITE_FAILURE");
    },
  };
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
describe("cooperative operator retirement with a final encrypted checkpoint", () => {
  let base: string, root: string, operator: string, out: string, key: Buffer;
  const scope = "prodigic/zivv/production";
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  const journalRows = () => {
    const db = new DatabaseSync(join(operator, "weekly-runs.sqlite"), {
      readOnly: true,
    });
    try {
      return db.prepare("SELECT * FROM ownership ORDER BY scope").all();
    } finally {
      db.close();
    }
  };
  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "zivv-retire-test-"));
    root = join(base, "checkout");
    operator = join(base, "operator");
    out = join(base, "archives/final.enc");
    vi.stubEnv("ZIVV_LEDGER_HOME", operator);
    write(
      join(root, "data/ingestion/store.json"),
      canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    write(join(root, "package.json"), "{}\n");
    write(join(root, "package-lock.json"), "synthetic retained lock\n");
    for (const file of [
      "lib/ingestion/weekly-import-runner.js",
      "types/fixture.js",
      "utils/fixture.js",
    ])
      write(join(root, "dist", file), "// synthetic retained worker\n");
    await writeSqliteLedger(
      join(operator, "ledger.sqlite"),
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
      true
    );
    key = loadBackupKey(operator, true);
    const journal = new WeeklyRunJournal(operator),
      lease = journal.acquire(scope);
    journal.release(lease);
    journal.close();
    write(
      join(operator, "weekly-publication/fixture/proof.json"),
      "private retained evidence\n"
    );
  });
  afterEach(() => {
    faults.path = "";
    faults.after = false;
    vi.unstubAllEnvs();
    const within = relative(resolve(tmpdir()), resolve(base));
    if (!within.startsWith("zivv-retire-test-") || within.startsWith(".."))
      throw new Error("Unsafe fixture cleanup");
    rmSync(base, { recursive: true, force: true });
  });

  it("retains a bound final capsule, blocks old APIs and leaves restored state quarantined", async () => {
    const oldJournal = new WeeklyRunJournal(operator);
    const digest = ledgerDigest(
      readSqliteLedger(join(operator, "ledger.sqlite"))
    );
    try {
      const result = await retireAndCaptureOperatorRecovery({ root, out });
      const archive = readFileSync(out),
        receipt = verifyOperatorRetirementReceipt(
          result.retirementReceipt,
          key
        );
      expect(receipt).toMatchObject({
        archiveSha256: sha256(archive),
        checkpointSha256: sha256(canonicalJson(result.checkpoint)),
        ledgerRevision: digest,
        originalOperatorDirectory: operator,
      });
      expect(readFileSync(out + ".retirement.json")).toEqual(
        result.retirementReceipt
      );
      expect(readFileSync(join(operator, "operator-retired.json"))).toEqual(
        result.retirementReceipt
      );
      expect(archive.includes(Buffer.from("private retained evidence"))).toBe(
        false
      );
      expect(
        result.checkpoint.files.some((file) =>
          file.path.includes("operator-retired")
        )
      ).toBe(false);
      expect(
        ledgerDigest(readSqliteLedger(join(operator, "ledger.sqlite")))
      ).toBe(digest);
      expect(() => oldJournal.acquire(scope)).toThrow(
        "OPERATOR_INSTALLATION_RETIRED"
      );
      expect(() => new WeeklyRunJournal(operator)).toThrow(
        "OPERATOR_INSTALLATION_RETIRED"
      );
      await expect(
        writeSqliteLedger(
          join(operator, "ledger.sqlite"),
          result.checkpoint.ledger
        )
      ).rejects.toThrow("OPERATOR_INSTALLATION_RETIRED");
      const work = vi.fn(async () => undefined);
      await expect(
        withStoreTransaction(join(operator, "ledger.sqlite"), work)
      ).rejects.toThrow("OPERATOR_INSTALLATION_RETIRED");
      expect(work).not.toHaveBeenCalled();
      await expect(captureOperatorRecoveryCheckpoint(root)).rejects.toThrow(
        "OPERATOR_INSTALLATION_RETIRED"
      );
      await expect(
        runWeeklyImport({ root, runId: "retired-run", stopAfter: "load" })
      ).rejects.toThrow("OPERATOR_INSTALLATION_RETIRED");
      await expect(
        captureSteveEmail({
          operatorDirectory: operator,
          accountId: "synthetic",
          rawMessage: { id: "a", raw: "" },
          fullMessage: {
            id: "a",
            internal_date: 0,
            payload: { mime_type: "text/plain" },
          },
          expectedEditionId: "2026-10-16",
          observedAtEpochMs: 1000,
        })
      ).rejects.toThrow("OPERATOR_INSTALLATION_RETIRED");
      const target = join(base, "restored");
      await stageOperatorRecovery(
        decryptOperatorRecovery(archive, key),
        target,
        key
      );
      expect(
        JSON.parse(readFileSync(join(target, "recovery-state.json"), "utf8"))
      ).toMatchObject({ status: "staged", activationAllowed: false });
      expect(existsSync(join(target, "operator/operator-retired.json"))).toBe(
        false
      );
    } finally {
      oldJournal.close();
    }
  });

  it("repairs a lost portable receipt without re-capturing or changing ownership", async () => {
    const first = await retireAndCaptureOperatorRecovery({ root, out });
    const archive = readFileSync(out),
      rows = journalRows();
    unlinkSync(out + ".retirement.json");
    const retried = await retireAndCaptureOperatorRecovery({ root, out });
    expect(retried).toEqual(first);
    expect(readFileSync(out)).toEqual(archive);
    expect(journalRows()).toEqual(rows);
  });

  it("refuses to certify an outer transaction's uncommitted catalog changes", async () => {
    const before = ledgerDigest(
      readSqliteLedger(join(operator, "ledger.sqlite"))
    );
    await expect(
      withStoreTransaction(join(operator, "ledger.sqlite"), async () => {
        const changed = readSqliteLedger(join(operator, "ledger.sqlite"));
        changed.version = "2";
        await writeSqliteLedger(join(operator, "ledger.sqlite"), changed);
        await retireAndCaptureOperatorRecovery({ root, out });
      })
    ).rejects.toThrow("RECOVERY_REQUIRES_OWN_CATALOG_TRANSACTION");
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(operator, "operator-retired.json"))).toBe(false);
    expect(
      ledgerDigest(readSqliteLedger(join(operator, "ledger.sqlite")))
    ).toBe(before);
  });

  it.each(["marker", "archive", "portable-receipt"] as const)(
    "refuses conflicting %s on retry without clearing retirement",
    async (changed) => {
      await retireAndCaptureOperatorRecovery({ root, out });
      const path =
        changed === "marker"
          ? join(operator, "operator-retired.json")
          : changed === "archive"
            ? out
            : out + ".retirement.json";
      write(path, "changed evidence\n");
      await expect(
        retireAndCaptureOperatorRecovery({ root, out })
      ).rejects.toThrow();
      expect(existsSync(join(operator, "operator-retired.json"))).toBe(true);
      expect(() => new WeeklyRunJournal(operator)).toThrow(
        "OPERATOR_INSTALLATION_RETIRED"
      );
    }
  );

  it("refuses retirement while another owner is active and leaves importing available", async () => {
    const journal = new WeeklyRunJournal(operator),
      lease = journal.acquire(scope);
    try {
      await expect(
        retireAndCaptureOperatorRecovery({ root, out })
      ).rejects.toThrow("active owner");
      expect(existsSync(out)).toBe(false);
      expect(existsSync(join(operator, "operator-retired.json"))).toBe(false);
    } finally {
      journal.release(lease);
      journal.close();
    }
    await expect(
      captureOperatorRecoveryCheckpoint(root)
    ).resolves.toBeDefined();
  });

  it.each(["occupied", "inside-operator"] as const)(
    "refuses unsafe output %s without retiring",
    async (mode) => {
      const target =
        mode === "inside-operator" ? join(operator, "final.enc") : out;
      if (mode === "occupied") write(target, "keep\n");
      await expect(
        retireAndCaptureOperatorRecovery({ root, out: target })
      ).rejects.toThrow();
      expect(existsSync(join(operator, "operator-retired.json"))).toBe(false);
      if (mode === "occupied")
        expect(readFileSync(target, "utf8")).toBe("keep\n");
    }
  );

  it("a failed marker write leaves a valid backup but no retirement proof", async () => {
    faults.path = join(operator, "operator-retired.json");
    await expect(
      retireAndCaptureOperatorRecovery({ root, out })
    ).rejects.toThrow("INJECTED_RETIREMENT_WRITE_FAILURE");
    expect(
      decryptOperatorRecovery(readFileSync(out), key).originalOperatorDirectory
    ).toBe(operator);
    expect(existsSync(join(operator, "operator-retired.json"))).toBe(false);
    expect(existsSync(out + ".retirement.json")).toBe(false);
    faults.path = "";
    await expect(
      retireAndCaptureOperatorRecovery({ root, out })
    ).rejects.toThrow("RECOVERY_DESTINATION_EXISTS");
    await expect(
      captureOperatorRecoveryCheckpoint(root)
    ).resolves.toBeDefined();
  });

  it("a lost response after fencing is repaired from exact existing evidence", async () => {
    faults.path = join(operator, "operator-retired.json");
    faults.after = true;
    await expect(
      retireAndCaptureOperatorRecovery({ root, out })
    ).rejects.toThrow("INJECTED_RETIREMENT_WRITE_FAILURE");
    expect(existsSync(join(operator, "operator-retired.json"))).toBe(true);
    const archive = readFileSync(out),
      rows = journalRows();
    faults.path = "";
    await retireAndCaptureOperatorRecovery({ root, out });
    expect(readFileSync(out)).toEqual(archive);
    expect(journalRows()).toEqual(rows);
  });

  it("rolls back a writer when retirement appears after entry but before commit", async () => {
    const before = ledgerDigest(
      readSqliteLedger(join(operator, "ledger.sqlite"))
    );
    await expect(
      withStoreTransaction(join(operator, "ledger.sqlite"), async () => {
        const changed = readSqliteLedger(join(operator, "ledger.sqlite"));
        changed.version = "2";
        await writeSqliteLedger(join(operator, "ledger.sqlite"), changed);
        write(
          join(operator, "operator-retired.json"),
          "another process retired this installation\n"
        );
      })
    ).rejects.toThrow("OPERATOR_INSTALLATION_RETIRED");
    expect(
      ledgerDigest(readSqliteLedger(join(operator, "ledger.sqlite")))
    ).toBe(before);
  });

  it("a queued catalog writer rechecks retirement after obtaining its lock", async () => {
    let started: () => void = () => undefined,
      release: () => void = () => undefined;
    const ready = new Promise<void>((done) => {
      started = done;
    });
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const held = withStoreTransaction(
      join(operator, "ledger.sqlite"),
      async () => {
        started();
        await pending;
      }
    );
    await ready;
    const callback = vi.fn(async () => undefined);
    const queued = withStoreTransaction(
      join(operator, "ledger.sqlite"),
      callback
    );
    const heldResult = expect(held).rejects.toThrow(
      "OPERATOR_INSTALLATION_RETIRED"
    );
    const queuedResult = expect(queued).rejects.toThrow(
      "OPERATOR_INSTALLATION_RETIRED"
    );
    write(join(operator, "operator-retired.json"), "external retirement\n");
    release();
    await Promise.all([heldResult, queuedResult]);
    expect(callback).not.toHaveBeenCalled();
  });

  it("an already-open guarded journal rolls back its writes when retirement appears", async () => {
    const journal = new WeeklyRunJournal(operator),
      lease = journal.acquire(scope);
    const before = journalRows();
    try {
      await expect(
        journal.guardOperation(lease, async () => {
          journal.renew(lease, 240_000);
          write(
            join(operator, "operator-retired.json"),
            "external retirement\n"
          );
        })
      ).rejects.toThrow("OPERATOR_INSTALLATION_RETIRED");
      expect(journalRows()).toEqual(before);
    } finally {
      journal.close();
    }
  });

  it("authenticates portable retirement after original roots are deleted, and refuses another archive", async () => {
    const result = await retireAndCaptureOperatorRecovery({ root, out });
    const archive = readFileSync(out);
    expect(() =>
      verifyOperatorRetirementEvidence({
        archive: encryptOperatorRecovery(result.checkpoint, key),
        retirementReceipt: result.retirementReceipt,
        recoveryKey: key,
      })
    ).toThrow("RETIREMENT_EVIDENCE_MISMATCH");
    const keyFile = join(base, "portable.key");
    write(keyFile, key.toString("base64") + "\n");
    for (const path of [root, operator]) {
      if (!["checkout", "operator"].includes(relative(base, path)))
        throw new Error("Unsafe source removal");
      rmSync(path, { recursive: true });
    }
    expect(
      verifyOperatorRetirementEvidence({
        archive,
        retirementReceipt: result.retirementReceipt,
        recoveryKey: key,
      }).checkpoint
    ).toEqual(result.checkpoint);
    const cli = spawnSync(
      process.execPath,
      [
        resolve("scripts/operator-recovery.js"),
        "verify-retirement",
        "--file",
        out,
        "--receipt",
        out + ".retirement.json",
        "--key",
        keyFile,
      ],
      { encoding: "utf8" }
    );
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      command: "verify-retirement",
      status: "verified",
      activationAllowed: false,
    });
    expect(cli.stdout).not.toContain(key.toString("base64"));
    expect(cli.stdout).not.toContain(operator);
  });

  it("the retire CLI emits bounded status, supports receipt retry and never activates staging", () => {
    const args = [
      resolve("scripts/operator-recovery.js"),
      "retire",
      "--root",
      root,
      "--out",
      out,
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, args, {
        encoding: "utf8",
        env: { ...process.env, ZIVV_LEDGER_HOME: operator },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "retire",
        status: "retired",
        activationAllowed: false,
      });
      expect(result.stdout).not.toContain(operator);
      expect(result.stdout).not.toContain(key.toString("base64"));
    }
  });
});
