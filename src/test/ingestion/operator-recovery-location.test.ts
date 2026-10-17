import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  captureOperatorRecoveryCheckpoint,
  encryptOperatorRecovery,
  stageOperatorRecovery,
  type OperatorRecoveryCheckpoint,
} from "../../lib/ingestion/operator-recovery.js";
import { inspectOperatorRecoveryLocations } from "../../lib/ingestion/operator-recovery-location.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { importSteveContent } from "../../lib/ingestion/imports.js";
import {
  canonicalJson,
  ledgerDigest,
  readSqliteLedger,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import { createWeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const scope = "prodigic/zivv/production";
describe("authenticated offline recovery location inspection", () => {
  let base: string, originalCheckout: string, originalOperator: string;
  let stagingRoot: string,
    checkpoint: OperatorRecoveryCheckpoint,
    archive: Buffer;
  const recoveryKey = randomBytes(32);
  const workRelative = "weekly-candidates/candidate-work-fixture";
  const captureRelative = workRelative + "/source-build-fixture";
  const sourceRelative = captureRelative + "/source";
  const retainedRelative = sourceRelative + "/private-source.txt";
  const retainedBytes = Buffer.from("synthetic private source body\r\n");
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  };
  const inspect = () =>
    inspectOperatorRecoveryLocations({ archive, recoveryKey, stagingRoot });
  function physicalSnapshot(root: string, prefix = ""): Record<string, string> {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name),
        name = prefix + entry.name;
      if (entry.isDirectory())
        Object.assign(files, physicalSnapshot(path, name + "/"));
      else files[name] = sha256(readFileSync(path));
    }
    return files;
  }
  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "zivv-location-inspect-"));
    originalCheckout = join(base, "original-checkout");
    originalOperator = join(base, "original-operator");
    vi.stubEnv("ZIVV_LEDGER_HOME", originalOperator);
    write(
      join(originalCheckout, "data/ingestion/store.json"),
      canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    write(
      join(originalCheckout, "package-lock.json"),
      "fixture locked dependencies\n"
    );
    write(join(originalCheckout, "package.json"), "{}\n");
    for (const path of [
      "lib/ingestion/weekly-import-runner.js",
      "types/fixture.js",
      "utils/fixture.js",
    ])
      write(
        join(originalCheckout, "dist", path),
        "// synthetic retained runtime\n"
      );
    await writeSqliteLedger(
      join(originalOperator, "ledger.sqlite"),
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
      true
    );
    const journal = new WeeklyRunJournal(originalOperator),
      lease = journal.acquire(scope);
    try {
      const raw = Buffer.from("synthetic retained raw source\n");
      journal.create(
        createWeeklyRunState({
          editionId: "2026-10-16",
          deliveryId: "location-fixture",
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
    write(join(originalOperator, retainedRelative), retainedBytes);
    write(
      join(originalOperator, captureRelative, "source-capture.json"),
      canonicalJson({
        directory: join(originalOperator, captureRelative),
        sourceRoot: join(originalOperator, sourceRelative),
      }) + "\n"
    );
    mkdirSync(join(originalOperator, workRelative, "empty-attempt"));
    checkpoint = await captureOperatorRecoveryCheckpoint(originalCheckout);
    archive = encryptOperatorRecovery(checkpoint, recoveryKey);
    vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    stagingRoot = join(mkdtempSync(join(base, "case-")), "staging");
    await stageOperatorRecovery(checkpoint, stagingRoot, recoveryKey);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    const caseDirectory = resolve(stagingRoot, "..");
    if (!relative(base, caseDirectory).startsWith("case-"))
      throw new Error("Unsafe fixture cleanup");
    rmSync(caseDirectory, { recursive: true, force: true });
  });
  afterAll(() => {
    if (!base.startsWith(join(tmpdir(), "zivv-location-inspect-")))
      throw new Error("Unsafe fixture cleanup");
    rmSync(base, { recursive: true, force: true });
  });

  it("authenticates original paths, returns detached exact staged bytes and leaves stores, evidence and quarantine unchanged", () => {
    const before = physicalSnapshot(stagingRoot),
      original = canonicalJson(checkpoint);
    const context = inspect();
    expect(context.report).toMatchObject({
      status: "inspected",
      activationAllowed: false,
      checkpointSha256: sha256(canonicalJson(checkpoint)),
      ledgerRevision: checkpoint.ledgerRevision,
      fileCount: checkpoint.files.length,
      directoryCount: checkpoint.directories.length,
      runtime: {
        nodeMatches: true,
        icuMatches: true,
        executableMatches: true,
        workerMatches: false,
        lockfileMatches: false,
        npmIdentity: "not-retained",
      },
    });
    const bytes = context.readOriginalFile(
      join(originalOperator, retainedRelative)
    );
    expect(bytes).toEqual(retainedBytes);
    bytes.fill(0);
    expect(
      context.readOriginalFile(join(originalOperator, retainedRelative))
    ).toEqual(retainedBytes);
    expect(
      context.readOriginalFile(join(originalCheckout, "package-lock.json"))
    ).toEqual(Buffer.from("fixture locked dependencies\n"));
    for (const [field, path] of [
      ["export.workDirectory", workRelative],
      ["capture.directory", captureRelative],
      ["capture.sourceRoot", sourceRelative],
    ] as const)
      expect(
        context.resolveOriginalDirectory(field, join(originalOperator, path))
      ).toBe(join(stagingRoot, "operator", path));
    expect(physicalSnapshot(stagingRoot)).toEqual(before);
    for (const database of ["ledger.sqlite", "weekly-runs.sqlite"])
      for (const suffix of ["-wal", "-shm"])
        expect(
          existsSync(join(stagingRoot, "operator", database + suffix))
        ).toBe(false);
    expect(existsSync(join(stagingRoot, "operator/backup-key.bin"))).toBe(
      false
    );
    expect(existsSync(join(stagingRoot, "operator/backup-key.dpapi"))).toBe(
      false
    );
    expect(canonicalJson(checkpoint)).toBe(original);
    expect(() =>
      assertOperatorNotQuarantined(join(stagingRoot, "operator"))
    ).toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
    const report = JSON.stringify(context.report);
    for (const secret of [
      originalOperator,
      originalCheckout,
      stagingRoot,
      retainedBytes.toString(),
      recoveryKey.toString("base64"),
    ])
      expect(report).not.toContain(secret);
    expect(context.report.requiredBeforeActivation.length).toBeGreaterThan(0);
  });

  it("rejects a wrong key and changed authenticated archive even when the marker is intact", () => {
    expect(() =>
      inspectOperatorRecoveryLocations({
        archive,
        recoveryKey: randomBytes(32),
        stagingRoot,
      })
    ).toThrow();
    const damaged = Buffer.from(archive);
    damaged[damaged.length - 10] ^= 1;
    expect(() =>
      inspectOperatorRecoveryLocations({
        archive: damaged,
        recoveryKey,
        stagingRoot,
      })
    ).toThrow();
  });

  it.each(["digest", "activation", "incomplete", "missing"])(
    "rejects a %s staging marker without trusting it as authority",
    (problem) => {
      const path = join(stagingRoot, "recovery-state.json"),
        marker = JSON.parse(readFileSync(path, "utf8"));
      if (problem === "digest") marker.checkpointSha256 = "0".repeat(64);
      if (problem === "activation") marker.activationAllowed = true;
      if (problem === "incomplete") marker.status = "incomplete";
      if (problem === "missing") unlinkSync(path);
      else writeFileSync(path, canonicalJson(marker));
      expect(inspect).toThrow();
    }
  );

  it.each([
    "changed",
    "missing",
    "extra-file",
    "extra-directory",
    "absent-configuration",
  ])(
    "rejects %s staged inventory before constructing a location context",
    (problem) => {
      const file = join(stagingRoot, "operator", retainedRelative);
      if (problem === "changed") writeFileSync(file, "changed");
      if (problem === "missing") unlinkSync(file);
      if (problem === "extra-file")
        write(
          join(stagingRoot, "operator", workRelative, "extra.txt"),
          "extra"
        );
      if (problem === "extra-directory")
        mkdirSync(
          join(stagingRoot, "operator", workRelative, "extra-directory")
        );
      if (problem === "absent-configuration") {
        const absent = checkpoint.files.find(
          (entry) => entry.area === "checkout" && entry.bytes === null
        )!;
        write(
          join(stagingRoot, "checkout", absent.path),
          "unexpected configuration"
        );
      }
      expect(inspect).toThrow();
    }
  );

  it("revalidates the complete staged inventory on use and never falls back to a surviving original file", () => {
    const context = inspect();
    expect(readFileSync(join(originalOperator, retainedRelative))).toEqual(
      retainedBytes
    );
    unlinkSync(join(stagingRoot, "operator", retainedRelative));
    expect(() =>
      context.readOriginalFile(join(originalOperator, retainedRelative))
    ).toThrow();
    expect(() =>
      context.readOriginalFile(join(originalCheckout, "package.json"))
    ).toThrow();
    expect(() =>
      context.resolveOriginalDirectory(
        "export.workDirectory",
        join(originalOperator, workRelative)
      )
    ).toThrow();
  });

  it("refuses traversal, unknown paths, cross-field directories and physical database files", () => {
    const context = inspect();
    for (const path of [
      join(base, "outside.txt"),
      originalOperator +
        "/weekly-candidates/../weekly-candidates/candidate-work-fixture/source-build-fixture/source/private-source.txt",
      join(originalOperator, "ledger.sqlite"),
      join(originalOperator, workRelative, "not-captured.txt"),
    ])
      expect(() => context.readOriginalFile(path)).toThrow();
    expect(() =>
      context.resolveOriginalDirectory(
        "export.workDirectory",
        join(originalOperator, captureRelative)
      )
    ).toThrow();
    expect(() =>
      context.resolveOriginalDirectory(
        "capture.sourceRoot",
        join(originalOperator, workRelative)
      )
    ).toThrow();
    expect(() =>
      Reflect.apply(context.resolveOriginalDirectory, context, [
        "unknown-field",
        join(originalOperator, workRelative),
      ])
    ).toThrow();
  });

  it("rejects a hardlinked retained file", () => {
    const file = join(stagingRoot, "operator", retainedRelative),
      original = join(originalOperator, retainedRelative);
    unlinkSync(file);
    linkSync(original, file);
    expect(inspect).toThrow();
  });

  it("rejects a staged directory junction that points at the surviving original evidence", () => {
    const path = join(stagingRoot, "operator", sourceRelative);
    rmSync(path, { recursive: true });
    symlinkSync(
      join(originalOperator, sourceRelative),
      path,
      process.platform === "win32" ? "junction" : "dir"
    );
    expect(inspect).toThrow();
  });

  it.each(["catalog", "journal"])(
    "refuses valid %s drift without normalizing it away",
    async (kind) => {
      if (kind === "journal") {
        const db = new DatabaseSync(
          join(stagingRoot, "operator/weekly-runs.sqlite")
        );
        try {
          db.exec("UPDATE ownership SET fence=fence+1");
        } finally {
          db.close();
        }
      } else {
        const path = join(stagingRoot, "operator/ledger.sqlite"),
          ledger = readSqliteLedger(path);
        ledger.version = String(BigInt(ledger.version) + 1n);
        await writeSqliteLedger(path, ledger);
      }
      expect(inspect).toThrow();
    }
  );

  it("validates a populated catalog and rejects query-column drift even when its payload digest is unchanged", async () => {
    const directory = resolve(stagingRoot, ".."),
      checkout = join(directory, "populated-checkout"),
      operator = join(directory, "populated-operator"),
      target = join(directory, "populated-staging");
    cpSync(originalCheckout, checkout, { recursive: true });
    vi.stubEnv("ZIVV_LEDGER_HOME", operator);
    await writeSqliteLedger(
      join(operator, "ledger.sqlite"),
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
      true
    );
    loadBackupKey(operator, true);
    await importSteveContent(
      checkout,
      "oct 23 2026 Fixture Band at Test Room, Oakland a/a $20 8pm\n" +
        "oct 24 2026 Later Band at Other Room, Oakland a/a $15 8pm\n",
      { observedAtEpochMs: Date.parse("2026-10-16T12:00:00Z") }
    );
    const ledgerPath = join(operator, "ledger.sqlite"),
      ledger = readSqliteLedger(ledgerPath);
    expect(ledger.events).toHaveLength(2);
    const removed = ledger.events.shift()!,
      retained = ledger.events[0];
    ledger.redirects.push({
      fromEventId: removed.id,
      toEventId: retained.id,
      reason: "manual-merge",
      createdAtEpochMs: Date.parse("2026-10-16T13:00:00Z"),
    });
    ledger.version = String(BigInt(ledger.version) + 1n);
    await writeSqliteLedger(ledgerPath, ledger);
    const populated = await captureOperatorRecoveryCheckpoint(checkout);
    for (const rows of [
      populated.ledger.events,
      populated.ledger.artists,
      populated.ledger.venues,
      populated.ledger.runs,
      populated.ledger.redirects,
      populated.ledger.events[0].artistIds,
      populated.ledger.events[0].sources,
    ])
      expect(rows.length).toBeGreaterThan(0);
    await stageOperatorRecovery(populated, target, recoveryKey);
    const input = {
        archive: encryptOperatorRecovery(populated, recoveryKey),
        recoveryKey,
        stagingRoot: target,
      },
      before = physicalSnapshot(target);
    expect(inspectOperatorRecoveryLocations(input).report).toMatchObject({
      status: "inspected",
      activationAllowed: false,
      ledgerRevision: populated.ledgerRevision,
    });
    expect(physicalSnapshot(target)).toEqual(before);
    const stagedLedger = join(target, "operator/ledger.sqlite"),
      db = new DatabaseSync(stagedLedger);
    try {
      for (const table of [
        "events",
        "artists",
        "venues",
        "runs",
        "redirects",
        "event_artists",
        "sources",
      ])
        expect(
          Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)
        ).toBeGreaterThan(0);
      db.exec("UPDATE events SET date='2026-11-30'");
    } finally {
      db.close();
    }
    expect(ledgerDigest(readSqliteLedger(stagedLedger))).toBe(
      populated.ledgerRevision
    );
    expect(existsSync(stagedLedger + "-wal")).toBe(false);
    expect(existsSync(stagedLedger + "-shm")).toBe(false);
    expect(() => inspectOperatorRecoveryLocations(input)).toThrow();
  });

  it.each(["-wal", "-shm"])(
    "refuses an offline database with a %s sidecar",
    (suffix) => {
      write(
        join(stagingRoot, "operator/weekly-runs.sqlite" + suffix),
        "unexpected live database sidecar"
      );
      expect(inspect).toThrow();
    }
  );

  it("revalidates the staged database baseline before every location operation", () => {
    const context = inspect();
    const db = new DatabaseSync(
      join(stagingRoot, "operator/weekly-runs.sqlite")
    );
    try {
      db.exec("UPDATE ownership SET fence=fence+1");
    } finally {
      db.close();
    }
    expect(() =>
      context.readOriginalFile(join(originalCheckout, "package.json"))
    ).toThrow();
    expect(() =>
      context.resolveOriginalDirectory(
        "export.workDirectory",
        join(originalOperator, workRelative)
      )
    ).toThrow();
  });

  it("reports authenticated runtime mismatches while preserving quarantine", async () => {
    const different = structuredClone(checkpoint);
    different.runtime.node = "v0.0.0";
    different.runtime.icu = "0";
    different.runtime.executableSha256 = "0".repeat(64);
    const target = join(resolve(stagingRoot, ".."), "different-runtime");
    await stageOperatorRecovery(different, target, recoveryKey);
    const context = inspectOperatorRecoveryLocations({
      archive: encryptOperatorRecovery(different, recoveryKey),
      recoveryKey,
      stagingRoot: target,
    });
    expect(context.report).toMatchObject({
      status: "inspected",
      activationAllowed: false,
      runtime: {
        nodeMatches: false,
        icuMatches: false,
        executableMatches: false,
        npmIdentity: "not-retained",
      },
    });
    expect(() =>
      assertOperatorNotQuarantined(join(target, "operator"))
    ).toThrow("RECOVERY_INSTALLATION_NOT_ACTIVATED");
  });

  it.each(["same", "nested"])(
    "rejects authenticated %s original roots rather than ambiguously routing evidence",
    async (problem) => {
      const colliding = structuredClone(checkpoint);
      colliding.originalCheckout =
        problem === "same"
          ? colliding.originalOperatorDirectory
          : join(colliding.originalOperatorDirectory, "nested-checkout");
      const target = join(resolve(stagingRoot, ".."), "colliding-roots");
      await stageOperatorRecovery(colliding, target, recoveryKey);
      expect(() =>
        inspectOperatorRecoveryLocations({
          archive: encryptOperatorRecovery(colliding, recoveryKey),
          recoveryKey,
          stagingRoot: target,
        })
      ).toThrow();
    }
  );

  it.each([false, true])(
    "runs the actual inspect CLI without writes or private output (tampered %s)",
    (tampered) => {
      const privateDirectory = resolve(stagingRoot, ".."),
        archivePath = join(privateDirectory, "capsule.enc"),
        keyPath = join(privateDirectory, "portable.key");
      writeFileSync(archivePath, archive, { mode: 0o600 });
      const keyBytes = Buffer.from(recoveryKey.toString("base64") + "\n");
      writeFileSync(keyPath, keyBytes, { mode: 0o600 });
      if (tampered)
        writeFileSync(
          join(stagingRoot, "operator", retainedRelative),
          "changed private body"
        );
      const before = physicalSnapshot(stagingRoot);
      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts/operator-recovery.js"),
          "inspect",
          "--file",
          archivePath,
          "--key",
          keyPath,
          "--destination",
          stagingRoot,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 20_000 }
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(
        tampered ? 1 : 0
      );
      if (!tampered)
        expect(JSON.parse(result.stdout)).toMatchObject({
          command: "inspect",
          status: "inspected",
          activationAllowed: false,
          ledgerRevision: checkpoint.ledgerRevision,
        });
      const output = result.stdout + result.stderr;
      for (const secret of [
        originalOperator,
        originalCheckout,
        stagingRoot,
        archivePath,
        keyPath,
        retainedBytes.toString(),
        "changed private body",
        recoveryKey.toString("base64"),
      ])
        expect(output).not.toContain(secret);
      expect(physicalSnapshot(stagingRoot)).toEqual(before);
      expect(readFileSync(archivePath)).toEqual(archive);
      expect(readFileSync(keyPath)).toEqual(keyBytes);
    }
  );
});
