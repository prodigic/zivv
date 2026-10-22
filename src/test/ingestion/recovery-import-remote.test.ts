import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  openRecoveryImportRemoteForTest,
  openRecoveryImportRemote,
} from "../../lib/ingestion/recovery-import-remote.js";
import { captureOperatorRecoveryCheckpoint } from "../../lib/ingestion/operator-recovery.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  ledgerDigest,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import { createWeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";
import { createAcknowledgedRecoveryRemoteFixture } from "./fixtures/recovery-import-remote-fixture.js";
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const key = Buffer.alloc(32, 31);
let directory: string;
function write(path: string, bytes: string | Buffer) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
}
async function fixture() {
  const home = mkdtempSync(join(directory, "case-")),
    root = join(home, "checkout"),
    operator = join(home, "operator");
  vi.stubEnv("ZIVV_LEDGER_HOME", operator);
  write(
    join(root, "data/ingestion/store.json"),
    '{"schemaVersion":1,"backend":"sqlite","namespace":"zivv"}\n'
  );
  write(join(root, "package.json"), "{}\n");
  write(join(root, "package-lock.json"), "fixture\n");
  for (const path of [
    "lib/ingestion/weekly-import-runner.js",
    "types/fixture.js",
    "utils/fixture.js",
  ])
    write(join(root, "dist", path), "// retained fixture\n");
  const ledger = bootstrapLedger({ events: [], artists: [], venues: [] }, 1000);
  await writeSqliteLedger(join(operator, "ledger.sqlite"), ledger, true);
  const journal = new WeeklyRunJournal(operator),
    lease = journal.acquire("prodigic/zivv/production"),
    raw = Buffer.from("synthetic source\n");
  const state = createWeeklyRunState({
    editionId: "2026-10-16",
    deliveryId: "remote-recovery",
    rawSha256: hash(raw),
    rulesSha256: "b".repeat(64),
    importObservedAtEpochMs: Date.parse("2026-10-16T20:00:00Z"),
  });
  try {
    journal.create(state, lease, raw);
  } finally {
    journal.release(lease);
    journal.close();
  }
  const checkpoint = await captureOperatorRecoveryCheckpoint(root);

  const remote = await createAcknowledgedRecoveryRemoteFixture({
    directory: join(home, "authority"),
    ledger,
    recoveryKey: key,
  });
  return {
    ...remote,
    originalRoot: root,
    operator,
    root: remote.repositoryRoot,
    bare: remote.bareDirectory,
    checkpoint,
    runId: state.runId,
    key,
    open: () =>
      openRecoveryImportRemoteForTest({
        repositoryRoot: remote.repositoryRoot,
        bareDirectory: remote.bareDirectory,
        checkpoint,
        recoveryKey: key,
        runId: state.runId,
      }),
  };
}
describe("canonical remote gate for import-only recovery", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "zivv-recovery-remote-"));
    f = await fixture();
  }, 90_000);
  afterAll(() => {
    vi.unstubAllEnvs();
    if (directory?.startsWith(join(tmpdir(), "zivv-recovery-remote-")))
      rmSync(directory, { recursive: true, force: true });
  });
  it("binds the real acknowledged payload and fresh main without changing refs or HEAD", () => {
    const refs = f.refs(),
      head = f.git(["symbolic-ref", "HEAD"]);
    const context = f.open();
    expect(context.binding).toMatchObject({
      mainHead: f.sourceCommit,
      acknowledgedOperationId: f.operationId,
      acknowledgedCandidateId: f.candidateId,
      acknowledgedLedgerRevision: f.ledgerRevision,
      acknowledgedCutoffEpochMs: Date.parse("2026-10-16T19:00:00Z"),
    });
    expect(context.binding.controlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(context.binding)).toBe(true);
    context.assertCurrent();
    expect(f.refs()).toBe(refs);
    expect(f.git(["symbolic-ref", "HEAD"])).toBe(head);
    expect(f.transport.readMainHead!()).toBe(f.sourceCommit);
    expect(() =>
      f.transport.append("refs/heads/main", f.sourceCommit, null)
    ).toThrow(/dedicated control/);
  }, 30_000);
  it("rejects an obsolete or divergent ledger, wrong key and unretained run", () => {
    const checkpoint = structuredClone(f.checkpoint);
    checkpoint.ledger = bootstrapLedger(
      { events: [], artists: [], venues: [] },
      2000
    );
    checkpoint.ledgerRevision = ledgerDigest(checkpoint.ledger);
    expect(() =>
      openRecoveryImportRemoteForTest({
        repositoryRoot: f.root,
        bareDirectory: f.bare,
        checkpoint,
        recoveryKey: key,
        runId: f.runId,
      })
    ).toThrow("LEDGER_DIVERGED");
    expect(() =>
      openRecoveryImportRemoteForTest({
        repositoryRoot: f.root,
        bareDirectory: f.bare,
        checkpoint: f.checkpoint,
        recoveryKey: Buffer.alloc(32, 99),
        runId: f.runId,
      })
    ).toThrow();
    expect(() =>
      openRecoveryImportRemoteForTest({
        repositoryRoot: f.root,
        bareDirectory: f.bare,
        checkpoint: f.checkpoint,
        recoveryKey: key,
        runId: "unretained",
      })
    ).toThrow("RUN_NOT_RETAINED");
  }, 45_000);
  it("refuses absent watermark, active owner, missing control and unretained artifacts", () => {
    const head = f.store.read().head!;
    try {
      f.setControl(f.bootstrapHead);
      expect(f.open).toThrow("ACKNOWLEDGED_WATERMARK_REQUIRED");
      f.setControl(f.claimHead);
      expect(f.open).toThrow("ACTIVE_OWNER");
      f.git(["push", "--quiet", f.bare, `:${f.store.ref}`]);
      expect(f.open).toThrow("CONTROL_REQUIRED");
    } finally {
      f.setControl(head);
    }
    f.git(["push", "--quiet", f.bare, `:${f.artifactRef}`]);
    try {
      expect(f.open).toThrow("ARTIFACT_NOT_RETAINED");
    } finally {
      f.transport.append(f.artifactRef, f.payloadCommit, null);
    }
  }, 30_000);
  it("production entry refuses a wrong origin before any remote IO", () => {
    f.git(["remote", "set-url", "origin", "https://example.invalid/other.git"]);
    try {
      expect(() =>
        openRecoveryImportRemote({
          repositoryRoot: f.root,
          checkpoint: f.checkpoint,
          recoveryKey: key,
          runId: f.runId,
        })
      ).toThrow(/authoritative Zivv origin/);
    } finally {
      f.git([
        "remote",
        "set-url",
        "origin",
        "https://github.com/prodigic/zivv.git",
      ]);
    }
  });
  it("rechecks main, control and the immutable artifact before later effects", () => {
    const context = f.open(),
      controlHead = f.store.read().head!;
    const tree = f.git(["rev-parse", `${f.sourceCommit}^{tree}`]);
    const child = f.git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      tree,
      "-p",
      f.sourceCommit,
      "-m",
      "later main",
    ]);
    f.git(["push", "--quiet", f.bare, `${child}:refs/heads/main`]);
    try {
      expect(context.assertCurrent).toThrow("REMOTE_CHANGED");
    } finally {
      f.main(f.sourceCommit);
    }
    f.setControl(f.bootstrapHead);
    try {
      expect(context.assertCurrent).toThrow("REMOTE_CHANGED");
    } finally {
      f.setControl(controlHead);
    }
    f.git([
      "push",
      "--quiet",
      "--force",
      f.bare,
      `${f.sourceCommit}:${f.artifactRef}`,
    ]);
    try {
      expect(context.assertCurrent).toThrow("REMOTE_CHANGED");
      expect(f.open).toThrow("ARTIFACT_NOT_RETAINED");
    } finally {
      f.git([
        "push",
        "--quiet",
        "--force",
        f.bare,
        `${f.payloadCommit}:${f.artifactRef}`,
      ]);
    }
  }, 45_000);
  it("does not trust stale local main ancestry or a malformed canonical control tip", () => {
    const controlHead = f.store.read().head!;
    const tree = f.git(["rev-parse", `${f.sourceCommit}^{tree}`]);
    const fork = f.git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      tree,
      "-m",
      "unrelated main",
    ]);
    f.git(["update-ref", "refs/remotes/origin/main", f.sourceCommit]);
    f.git(["push", "--quiet", "--force", f.bare, `${fork}:refs/heads/main`]);
    try {
      expect(f.open).toThrow("SOURCE_NOT_ON_MAIN");
    } finally {
      f.main(f.sourceCommit);
    }
    f.setControl(f.sourceCommit);
    try {
      expect(f.open).toThrow();
    } finally {
      f.setControl(controlHead);
    }
  }, 30_000);
  it("refuses a retained observation before the acknowledged cutoff even when local weekly state is absent", async () => {
    const journal = new WeeklyRunJournal(f.operator),
      lease = journal.acquire("prodigic/zivv/production"),
      raw = Buffer.from("older synthetic source\n");
    const run = createWeeklyRunState({
      editionId: "2026-10-16",
      deliveryId: "older-recovery",
      rawSha256: hash(raw),
      rulesSha256: "b".repeat(64),
      importObservedAtEpochMs: Date.parse("2026-10-16T18:59:59Z"),
    });
    try {
      journal.create(run, lease, raw);
    } finally {
      journal.release(lease);
      journal.close();
    }
    const checkpoint = await captureOperatorRecoveryCheckpoint(f.originalRoot);
    expect(() =>
      openRecoveryImportRemoteForTest({
        repositoryRoot: f.root,
        bareDirectory: f.bare,
        checkpoint,
        recoveryKey: key,
        runId: run.runId,
      })
    ).toThrow("OBSERVATION_BEFORE_ACKNOWLEDGED_CUTOFF");
  }, 30_000);
});
