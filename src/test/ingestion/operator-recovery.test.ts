import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { runWeeklyImport } from "../../lib/ingestion/weekly-import-runner.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import {
  captureOperatorRecoveryCheckpoint,
  decryptOperatorRecovery,
  encryptOperatorRecovery,
  stageOperatorRecovery,
  validateOperatorRecoveryCheckpoint,
  retireAndCaptureOperatorRecovery,
  verifyOperatorRetirementEvidence,
} from "../../lib/ingestion/operator-recovery.js";
import { captureNpmExecutionTool } from "../../lib/ingestion/execution-tool-identity.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import { createWeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";

vi.setConfig({ testTimeout: 30000, hookTimeout: 15000 });
describe("offline operator recovery capsules", () => {
  let directory: string, root: string, operator: string;
  function write(path: string, bytes: string | Buffer) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  }
  function npmFixture() {
    const packageRoot = join(directory, "npm package; capture only"),
      npmCli = join(packageRoot, "bin/npm-cli.js"),
      dependency = join(packageRoot, "node_modules/fixture/index.js");
    write(npmCli, "throw new Error('capture must never execute npm');\n");
    write(
      join(packageRoot, "package.json"),
      '{"name":"npm","version":"11.6.0"}\n'
    );
    write(dependency, "module.exports = 'private fixture dependency';\n");
    return { packageRoot, npmCli, dependency };
  }
  function ownership() {
    const db = new DatabaseSync(join(operator, "weekly-runs.sqlite"));
    try {
      return db.prepare("SELECT * FROM ownership ORDER BY scope").all();
    } finally {
      db.close();
    }
  }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "zivv-recover-"));
    root = join(directory, "checkout");
    operator = join(directory, "operator");
    vi.stubEnv("ZIVV_LEDGER_HOME", operator);
    write(
      join(root, "data/ingestion/store.json"),
      canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    write(join(root, "package-lock.json"), "fixture lock\n");
    write(join(root, "package.json"), "{}\n");
    for (const name of [
      "lib/ingestion/weekly-import-runner.js",
      "types/fixture.js",
      "utils/fixture.js",
    ])
      write(join(root, "dist", name), "// retained fixture runtime\n");
    await writeSqliteLedger(
      join(operator, "ledger.sqlite"),
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
      true
    );
    const journal = new WeeklyRunJournal(operator),
      lease = journal.acquire("prodigic/zivv/production");
    try {
      const raw = Buffer.from("retained raw source\r\n");
      journal.create(
        createWeeklyRunState({
          editionId: "2026-10-16",
          deliveryId: "recovery-fixture",
          rawSha256: sha256(raw),
          rulesSha256: "b".repeat(64),
          importObservedAtEpochMs: 1000,
        }),
        lease,
        raw
      );
    } finally {
      journal.release(lease);
      journal.close();
    }
    mkdirSync(join(operator, "weekly-candidates/empty-attempt"), {
      recursive: true,
    });
    write(
      join(operator, "weekly-publication/fixture/claim-plan.json"),
      "private fixture claim\n"
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel.startsWith("zivv-recover-") || rel.startsWith(".."))
      throw Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  it("captures, encrypts and stages catalog, journal, evidence and empty attempts without activation", async () => {
    const checkpoint = await captureOperatorRecoveryCheckpoint(root),
      key = randomBytes(32);
    expect(checkpoint.version).toBe(1);
    expect(Object.hasOwn(checkpoint.runtime, "bootstrapNpm")).toBe(false);
    const archive = encryptOperatorRecovery(checkpoint, key);
    expect(archive.includes(Buffer.from("private fixture claim"))).toBe(false);
    const decoded = decryptOperatorRecovery(archive, key);
    expect(decoded).toEqual(checkpoint);
    const target = join(directory, "restored");
    await stageOperatorRecovery(decoded, target, key);
    expect(
      ledgerDigest(readSqliteLedger(join(target, "operator/ledger.sqlite")))
    ).toBe(checkpoint.ledgerRevision);
    expect(
      readFileSync(
        join(target, "operator/weekly-publication/fixture/claim-plan.json"),
        "utf8"
      )
    ).toBe("private fixture claim\n");
    expect(
      existsSync(join(target, "operator/weekly-candidates/empty-attempt"))
    ).toBe(true);
    const status = JSON.parse(
      readFileSync(join(target, "recovery-state.json"), "utf8")
    );
    expect(status).toMatchObject({
      status: "staged",
      activationAllowed: false,
      originalOperatorDirectory: checkpoint.originalOperatorDirectory,
    });
    const journal = new WeeklyRunJournal(join(target, "operator"));
    try {
      expect(journal.listRuns("prodigic/zivv/production")).toHaveLength(1);
      const lease = journal.acquire("prodigic/zivv/production");
      expect(lease.fence).toBeGreaterThan(1);
      journal.release(lease);
    } finally {
      journal.close();
    }
    expect(existsSync(join(target, "operator/backup-key.bin"))).toBe(false);
    expect(existsSync(join(target, "operator/backup-key.dpapi"))).toBe(false);
  });
  it.each(["empty", "batch", "partial"] as const)(
    "refuses unsupported Gmail acquisition %s state before retirement or archive output",
    async (kind) => {
      loadBackupKey(operator, true);
      const batchDirectory = join(operator, "email-acquisition/batches");
      mkdirSync(batchDirectory, { recursive: true });
      const evidencePath = join(
        batchDirectory,
        kind === "partial" ? "retained.json.tmp" : "retained.json"
      );
      const evidence = Buffer.from("synthetic retained acquisition evidence\n");
      if (kind !== "empty") writeFileSync(evidencePath, evidence);
      const before = ledgerDigest(
        readSqliteLedger(join(operator, "ledger.sqlite"))
      );
      const out = join(directory, "unsupported-email-recovery.enc");
      await expect(captureOperatorRecoveryCheckpoint(root)).rejects.toThrow(
        "UNCLASSIFIED_OPERATOR_ARTIFACT"
      );
      await expect(
        retireAndCaptureOperatorRecovery({ root, out })
      ).rejects.toThrow("UNCLASSIFIED_OPERATOR_ARTIFACT");
      expect(existsSync(out)).toBe(false);
      expect(existsSync(out + ".retirement.json")).toBe(false);
      expect(existsSync(join(operator, "operator-retired.json"))).toBe(false);
      expect(
        ledgerDigest(readSqliteLedger(join(operator, "ledger.sqlite")))
      ).toBe(before);
      if (kind !== "empty")
        expect(readFileSync(evidencePath)).toEqual(evidence);
    }
  );
  it("authenticates explicit v2 bootstrap npm metadata without executing or retaining package bytes", async () => {
    const tool = npmFixture(),
      expected = captureNpmExecutionTool(tool.npmCli),
      checkpoint = await captureOperatorRecoveryCheckpoint(root, {
        npmCli: tool.npmCli,
      }),
      key = randomBytes(32);
    expect(checkpoint.version).toBe(2);
    expect(checkpoint.runtime.bootstrapNpm).toEqual(expected);
    expect(canonicalJson(checkpoint)).not.toContain(
      "capture must never execute npm"
    );
    expect(canonicalJson(checkpoint)).not.toContain(
      "private fixture dependency"
    );
    rmSync(tool.packageRoot, { recursive: true });
    expect(validateOperatorRecoveryCheckpoint(checkpoint)).toEqual(checkpoint);
    const archive = encryptOperatorRecovery(checkpoint, key),
      decoded = decryptOperatorRecovery(archive, key),
      target = join(directory, "v2-staged");
    expect(decoded).toEqual(checkpoint);
    await stageOperatorRecovery(decoded, target, key);
    expect(
      JSON.parse(readFileSync(join(target, "recovery-state.json"), "utf8"))
    ).toMatchObject({
      status: "staged",
      activationAllowed: false,
      runtime: { bootstrapNpm: expected },
    });
    expect(() =>
      assertOperatorNotQuarantined(join(target, "operator"))
    ).toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
    expect(existsSync(join(target, "operator/backup-key.dpapi"))).toBe(false);
    expect(existsSync(join(target, "operator/backup-key.bin"))).toBe(false);
  });

  it("strictly separates legacy v1 metadata from required v2 bootstrap identity", async () => {
    const tool = npmFixture(),
      checkpoint = await captureOperatorRecoveryCheckpoint(root, {
        npmCli: tool.npmCli,
      }),
      identity = checkpoint.runtime.bootstrapNpm!,
      { bootstrapNpm: _profile, ...legacyRuntime } = checkpoint.runtime;
    const malformed: unknown[] = [
      { ...checkpoint, version: 1 },
      { ...checkpoint, version: 2, runtime: legacyRuntime },
      { ...checkpoint, version: 3 },
      { ...checkpoint, runtime: { ...checkpoint.runtime, extra: true } },
      ...[
        undefined,
        null,
        [],
        "npm",
        { ...identity, extra: true },
        { ...identity, identitySha256: "0".repeat(64) },
        { ...identity, originalCli: identity.originalCli + ".changed" },
        {
          ...identity,
          files: identity.files.map((file, index) =>
            index === 0 ? { ...file, sha256: "f".repeat(64) } : file
          ),
        },
      ].map((bootstrapNpm) => ({
        ...checkpoint,
        runtime: { ...checkpoint.runtime, bootstrapNpm },
      })),
    ];
    for (const value of malformed)
      expect(() => validateOperatorRecoveryCheckpoint(value)).toThrow();
    const legacy = { ...checkpoint, version: 1, runtime: legacyRuntime };
    expect(validateOperatorRecoveryCheckpoint(legacy)).toEqual(legacy);
  });

  it("refuses invalid bootstrap npm before changing journal ownership", async () => {
    const tool = npmFixture(),
      before = ownership();
    write(join(tool.packageRoot, ".npmrc"), "private configuration");
    await expect(
      captureOperatorRecoveryCheckpoint(root, { npmCli: tool.npmCli })
    ).rejects.toThrow("INVALID_NPM_EXECUTION_TOOL");
    expect(ownership()).toEqual(before);
  });

  it("rechecks the real bootstrap package under both checkpoint locks before finalization", async () => {
    const tool = npmFixture(),
      original = WeeklyRunJournal.prototype.exportRecoverySnapshot,
      revision = ledgerDigest(
        readSqliteLedger(join(operator, "ledger.sqlite"))
      );
    vi.spyOn(
      WeeklyRunJournal.prototype,
      "exportRecoverySnapshot"
    ).mockImplementation(function (this: WeeklyRunJournal, lease) {
      const bytes = original.call(this, lease);
      write(tool.dependency, "changed after initial tool capture\n");
      return bytes;
    });
    await expect(
      captureOperatorRecoveryCheckpoint(root, { npmCli: tool.npmCli })
    ).rejects.toThrow("INVALID_NPM_EXECUTION_TOOL");
    expect(
      ledgerDigest(readSqliteLedger(join(operator, "ledger.sqlite")))
    ).toBe(revision);
    const journal = new WeeklyRunJournal(operator),
      lease = journal.acquire("prodigic/zivv/production");
    journal.release(lease);
    journal.close();
    expect(existsSync(join(operator, "operator-retired.json"))).toBe(false);
  });

  it("binds a v2 retirement profile and preserves it on relocated, absent and conflicting tool retries", async () => {
    const tool = npmFixture(),
      key = loadBackupKey(operator, true),
      out = join(directory, "final-v2.enc"),
      result = await retireAndCaptureOperatorRecovery({
        root,
        out,
        npmCli: tool.npmCli,
      }),
      archive = readFileSync(out),
      receipt = Buffer.from(result.retirementReceipt),
      before = ownership(),
      movedRoot = join(directory, "relocated npm"),
      movedCli = join(movedRoot, "bin/npm-cli.js");
    expect(result.checkpoint.version).toBe(2);
    expect(
      verifyOperatorRetirementEvidence({
        archive,
        retirementReceipt: receipt,
        recoveryKey: key,
      }).checkpoint
    ).toEqual(result.checkpoint);
    cpSync(tool.packageRoot, movedRoot, { recursive: true });
    rmSync(tool.packageRoot, { recursive: true });
    rmSync(out + ".retirement.json");
    expect(
      (await retireAndCaptureOperatorRecovery({ root, out })).checkpoint
    ).toEqual(result.checkpoint);
    expect(
      (await retireAndCaptureOperatorRecovery({ root, out, npmCli: movedCli }))
        .checkpoint
    ).toEqual(result.checkpoint);
    expect(readFileSync(out + ".retirement.json")).toEqual(receipt);
    write(join(movedRoot, "node_modules/fixture/index.js"), "different tool");
    await expect(
      retireAndCaptureOperatorRecovery({ root, out, npmCli: movedCli })
    ).rejects.toThrow("INVALID_NPM_EXECUTION_TOOL");
    const changed = structuredClone(result.checkpoint);
    changed.runtime.bootstrapNpm = captureNpmExecutionTool(movedCli);
    expect(() =>
      verifyOperatorRetirementEvidence({
        archive: encryptOperatorRecovery(changed, key),
        retirementReceipt: receipt,
        recoveryKey: key,
      })
    ).toThrow("RETIREMENT_EVIDENCE_MISMATCH");
    expect(readFileSync(out)).toEqual(archive);
    expect(readFileSync(join(operator, "operator-retired.json"))).toEqual(
      receipt
    );
    expect(ownership()).toEqual(before);
  });

  it("does not silently add bootstrap authority to a legacy retirement retry", async () => {
    const tool = npmFixture();
    loadBackupKey(operator, true);
    const out = join(directory, "legacy-retirement.enc"),
      result = await retireAndCaptureOperatorRecovery({ root, out }),
      archive = readFileSync(out);
    expect(result.checkpoint.version).toBe(1);
    expect(Object.hasOwn(result.checkpoint.runtime, "bootstrapNpm")).toBe(
      false
    );
    await expect(
      retireAndCaptureOperatorRecovery({ root, out, npmCli: tool.npmCli })
    ).rejects.toThrow("RECOVERY_BOOTSTRAP_NPM_REQUIRED");
    expect(readFileSync(out)).toEqual(archive);
    expect(
      (await retireAndCaptureOperatorRecovery({ root, out })).checkpoint
    ).toEqual(result.checkpoint);
  });
  it("uses fresh encryption nonces and rejects wrong keys, changed ciphertext and authenticated header drift", async () => {
    const checkpoint = await captureOperatorRecoveryCheckpoint(root),
      key = randomBytes(32),
      a = encryptOperatorRecovery(checkpoint, key),
      b = encryptOperatorRecovery(checkpoint, key);
    expect(a.equals(b)).toBe(false);
    expect(() => decryptOperatorRecovery(a, randomBytes(32))).toThrow();
    const tampered = JSON.parse(a.toString());
    tampered.ciphertext = "AA" + tampered.ciphertext.slice(2);
    expect(() =>
      decryptOperatorRecovery(Buffer.from(JSON.stringify(tampered)), key)
    ).toThrow();
    const header = JSON.parse(a.toString());
    header.version = 2;
    expect(() =>
      decryptOperatorRecovery(Buffer.from(JSON.stringify(header)), key)
    ).toThrow();
  });
  it.each([
    "../escape",
    "email-intake/../escape",
    "email-intake/CON",
    "email-intake/file:stream",
    "email-intake/file.",
  ])("rejects unsafe archive path %s before writing", async (path) => {
    const checkpoint = await captureOperatorRecoveryCheckpoint(root);
    checkpoint.files.push({
      area: "operator",
      path,
      sha256: sha256("x"),
      bytes: Buffer.from("x").toString("base64"),
    });
    const target = join(directory, "invalid");
    await expect(
      stageOperatorRecovery(checkpoint, target, randomBytes(32))
    ).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });
  it("rejects changed files and case-colliding entries", async () => {
    const checkpoint = await captureOperatorRecoveryCheckpoint(root),
      changed = structuredClone(checkpoint);
    changed.files.find((file) => file.bytes !== null)!.bytes =
      Buffer.from("changed").toString("base64");
    expect(() => validateOperatorRecoveryCheckpoint(changed)).toThrow();
    const entry = checkpoint.files.find(
      (file) => file.path === "package.json"
    )!;
    checkpoint.files.push({ ...entry, path: "PACKAGE.json" });
    expect(() => validateOperatorRecoveryCheckpoint(checkpoint)).toThrow();
  });
  it("refuses an existing restore destination without changing its sentinel", async () => {
    const checkpoint = await captureOperatorRecoveryCheckpoint(root),
      target = join(directory, "occupied");
    write(join(target, "sentinel"), "keep");
    await expect(
      stageOperatorRecovery(checkpoint, target, randomBytes(32))
    ).rejects.toThrow("RECOVERY_DESTINATION_EXISTS");
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep");
  });
  it("refuses capture while another weekly owner is active", async () => {
    const journal = new WeeklyRunJournal(operator),
      lease = journal.acquire("prodigic/zivv/production");
    try {
      await expect(captureOperatorRecoveryCheckpoint(root)).rejects.toThrow(
        "active owner"
      );
    } finally {
      journal.release(lease);
      journal.close();
    }
  });
  it("requires explicit classification of unknown operator artifacts", async () => {
    write(join(operator, "not-classified.json"), "private");
    await expect(captureOperatorRecoveryCheckpoint(root)).rejects.toThrow(
      "UNCLASSIFIED_OPERATOR_ARTIFACT"
    );
  });
  it("refuses a journal run whose retained original source artifact was removed", async () => {
    const db = new DatabaseSync(join(operator, "weekly-runs.sqlite"));
    try {
      db.exec("DELETE FROM stage_artifact WHERE stage='acquire' AND attempt=0");
    } finally {
      db.close();
    }
    await expect(captureOperatorRecoveryCheckpoint(root)).rejects.toThrow(
      "INCOMPLETE_OPERATOR_RECOVERY"
    );
  });
  it("records absent configuration and excludes dependency/cache trees", async () => {
    write(
      join(operator, "weekly-candidates/attempt/node_modules/private.js"),
      "not captured"
    );
    const checkpoint = await captureOperatorRecoveryCheckpoint(root);
    expect(
      checkpoint.files.find((file) => file.path === "data/artist-links.json")
        ?.bytes
    ).toBeNull();
    expect(
      checkpoint.files.some((file) => file.path.includes("node_modules"))
    ).toBe(false);
  });
  it("leaves an incomplete marker if retained runtime identity fails verification", async () => {
    const checkpoint = await captureOperatorRecoveryCheckpoint(root);
    checkpoint.runtime.workerSha256 = "0".repeat(64);
    const target = join(directory, "incomplete");
    await expect(
      stageOperatorRecovery(checkpoint, target, randomBytes(32))
    ).rejects.toThrow();
    expect(
      JSON.parse(readFileSync(join(target, "recovery-state.json"), "utf8"))
    ).toMatchObject({ status: "incomplete", activationAllowed: false });
  });
  it("preserves both import-policy files, rollback snapshots, and keeps the separately exported key out", async () => {
    write(
      join(root, "data/ingestion/historical-batches.json"),
      "historic policy"
    );
    write(join(root, "data/ingestion/migration.json"), "migration proof");
    write(join(operator, "recovery/backup-recovery.key"), "separate key");
    write(
      join(operator, "rollback/fixture.snapshot.enc"),
      "prior encrypted ledger"
    );
    const checkpoint = await captureOperatorRecoveryCheckpoint(root);
    for (const path of [
      "data/ingestion/historical-batches.json",
      "data/ingestion/migration.json",
      "rollback/fixture.snapshot.enc",
    ])
      expect(
        checkpoint.files.find((file) => file.path === path)?.bytes
      ).not.toBeNull();
    expect(
      checkpoint.files.some((file) => file.path.includes("backup-recovery.key"))
    ).toBe(false);
  });
  it("requires all admitted source files and their exact hashes", async () => {
    const account = sha256("private account"),
      source = Buffer.from("private source"),
      raw = Buffer.from("private raw MIME"),
      id = sha256("receipt"),
      messageId = "123abc";
    const receipt = Buffer.from(
      canonicalJson({
        receiptId: id,
        accountSha256: account,
        messageId,
        sourceSha256: sha256(source),
        rawSha256: sha256(raw),
      }) + "\n"
    );
    const journal = new WeeklyRunJournal(operator),
      lease = journal.acquire("prodigic/zivv/production");
    try {
      journal.saveIntakeEvidence("source", id, receipt, lease);
    } finally {
      journal.release(lease);
      journal.close();
    }
    await expect(captureOperatorRecoveryCheckpoint(root)).rejects.toThrow(
      "INCOMPLETE_OPERATOR_RECOVERY"
    );
    const body = join(operator, "email-intake", account, "bodies", id),
      message = join(
        operator,
        "email-intake",
        account,
        "messages",
        sha256(messageId)
      );
    write(join(body, "receipt.json"), receipt);
    write(join(body, "source.txt"), source);
    write(join(message, "message.eml"), raw);
    write(join(message, "capture.json"), "{}");
    const checkpoint = await captureOperatorRecoveryCheckpoint(root);
    expect(
      checkpoint.files.find((file) => file.path.endsWith("message.eml"))?.sha256
    ).toBe(sha256(raw));
    write(join(body, "source.txt"), "changed");
    await expect(captureOperatorRecoveryCheckpoint(root)).rejects.toThrow(
      "INCOMPLETE_OPERATOR_RECOVERY"
    );
  });
  it("blocks worker effects in restored staging even if the marker claims activation", async () => {
    const checkpoint = await captureOperatorRecoveryCheckpoint(root),
      target = join(directory, "quarantined");
    await stageOperatorRecovery(checkpoint, target, randomBytes(32));
    const restored = join(target, "operator");
    expect(() => assertOperatorNotQuarantined(restored)).toThrow(
      "RECOVERY_INSTALLATION_NOT_ACTIVATED"
    );
    write(join(target, "recovery-state.json"), '{"activationAllowed":true}');
    vi.stubEnv("ZIVV_LEDGER_HOME", restored);
    await expect(
      runWeeklyImport({
        root: join(target, "checkout"),
        source: {
          editionId: "2026-10-16",
          deliveryId: "must-not-run",
          importObservedAtEpochMs: 1000,
          raw: Buffer.from("source"),
        },
        stopAfter: "acquire",
      })
    ).rejects.toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
    await expect(
      captureOperatorRecoveryCheckpoint(join(target, "checkout"))
    ).rejects.toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
  });
  it("runs actual capture/verify/stage commands without exposing private evidence or key", async () => {
    const key = loadBackupKey(operator, true),
      keyPath = join(operator, "recovery/backup-recovery.key");
    write(keyPath, key.toString("base64") + "\n");
    const capsule = join(directory, "operator.snapshot.enc"),
      target = join(directory, "cli-restored");
    const command = (args: string[]) =>
      spawnSync(
        process.execPath,
        [resolve("scripts/operator-recovery.js"), ...args],
        { encoding: "utf8", windowsHide: true, timeout: 30000 }
      );
    for (const args of [
      ["capture", "--root", root, "--out", capsule],
      ["verify", "--file", capsule, "--key", keyPath],
      ["stage", "--file", capsule, "--key", keyPath, "--destination", target],
    ]) {
      const result = command(args);
      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        activationAllowed: false,
      });
      expect(result.stdout).not.toContain("private fixture claim");
      expect(result.stdout).not.toContain(key.toString("base64"));
    }
    expect(
      JSON.parse(readFileSync(join(target, "recovery-state.json"), "utf8"))
    ).toMatchObject({ status: "staged", activationAllowed: false });
  });
});
