import { expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  linkSync,
  lstatSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { describeResumeSnapshot } from "../../lib/ingestion/recovery-gmail-selected-resume-snapshot-evidence.js";
import { observeSelectedLoadPendingIntent } from "../../lib/ingestion/recovery-gmail-selected-pending-intent.js";
import type { RecoveryRuntimeEntry } from "../../lib/ingestion/recovery-runtime.js";

it("authenticates staged and linked intents against the exact pre-retry state without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "zivv-pending-intent-")),
    id = "a".repeat(64),
    loadPath = "recovery-gmail-load/" + id,
    target = loadPath + "/resume-intent.json",
    stage = target + "-stage",
    candidate = stage + "/resume-intent.json.123.0123456789abcdef.tmp",
    key = Buffer.alloc(32, 7),
    snapshot = Buffer.from("encrypted fixture"),
    priorEntries: RecoveryRuntimeEntry[] = [
      { path: "fixture", kind: "directory" },
    ];
  const hash = sha256("selected-load/" + id),
    owner = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join("-"),
    previousOwner = {
      scope: "prodigic/zivv/production",
      owner,
      fence: 1,
      expiresAtEpochMs: 1000,
    };
  const encodeJournal = (lease: typeof previousOwner) => {
    const value = {
      format: "zivv-weekly-journal-recovery",
      version: 1,
      journalSchemaVersion: 3,
      ownership: [lease],
      runState: [],
      stageArtifacts: [],
      intakeEvidence: [],
    };
    return Buffer.from(
      canonicalJson({ ...value, digest: sha256(canonicalJson(value)) }) + "\n"
    );
  };
  const journal = encodeJournal(previousOwner);
  const body = {
    kind: "zivv-selected-load-resume-intent",
    version: 2,
    snapshotEvidence: describeResumeSnapshot(snapshot),
    admissionSha256: id,
    executionBaselineSha256: id,
    journalSha256: sha256(journal),
    inventorySha256: sha256(canonicalJson(priorEntries)),
    ledgerRevision: id,
    generation: 2,
    previousOwner,
    fence: 2,
    owner,
    startedAtEpochMs: 1000,
    deadlineEpochMs: 181000,
  };
  const signature = createHmac("sha256", key)
      .update("zivv-selected-load-resume-intent/v1\0")
      .update(canonicalJson(body))
      .digest("hex"),
    bytes = Buffer.from(canonicalJson({ ...body, signature }) + "\n");
  const file = (path: string): RecoveryRuntimeEntry => {
    const data = readFileSync(join(root, path));
    return { path, kind: "file", size: data.length, sha256: sha256(data) };
  };
  const base = {
    destination: root,
    loadPath,
    priorEntries,
    journal,
    previousOwner,
    admissionSha256: id,
    executionBaselineSha256: id,
    ledgerRevision: id,
    generation: 2,
    snapshot,
    key,
  };
  try {
    mkdirSync(join(root, stage), { recursive: true });
    writeFileSync(join(root, candidate), bytes);
    const staged: RecoveryRuntimeEntry[] = [
      { path: stage, kind: "directory" },
      file(candidate),
    ];
    expect(
      observeSelectedLoadPendingIntent({ ...base, entries: staged })
    ).toMatchObject({
      targetPresent: false,
      loadAllowed: false,
      activationAllowed: false,
    });
    linkSync(join(root, candidate), join(root, target));
    const linked = [...staged, file(target)];
    expect(
      observeSelectedLoadPendingIntent({ ...base, entries: linked })
    ).toMatchObject({ targetPresent: true, loadAllowed: false });
    expect(lstatSync(join(root, target)).nlink).toBe(2);
    expect(() =>
      observeSelectedLoadPendingIntent({
        ...base,
        entries: linked,
        journal: Buffer.from("drift"),
      })
    ).toThrow();
    expect(() =>
      observeSelectedLoadPendingIntent({
        ...base,
        entries: linked,
        snapshot: Buffer.from("different"),
      })
    ).toThrow();
    expect(() =>
      observeSelectedLoadPendingIntent({
        ...base,
        entries: linked.filter((item) => item.path !== target),
      })
    ).toThrow();
    expect(() =>
      observeSelectedLoadPendingIntent({
        ...base,
        entries: linked,
        key: Buffer.alloc(32, 8),
      })
    ).toThrow();
    expect(() =>
      observeSelectedLoadPendingIntent({
        ...base,
        entries: linked,
        previousOwner: { ...previousOwner, fence: 2 },
      })
    ).toThrow();
    expect(lstatSync(join(root, target)).nlink).toBe(2);
    unlinkSync(join(root, candidate));
    const acquiredOwner = {
      ...previousOwner,
      fence: 2,
      expiresAtEpochMs: 2000,
    };
    const acquiredJournal = encodeJournal(acquiredOwner);
    const settled = [{ path: stage, kind: "directory" as const }, file(target)];
    const acquired = observeSelectedLoadPendingIntent({
      ...base,
      entries: settled,
      journal: acquiredJournal,
      previousOwner: acquiredOwner,
    });
    expect(acquired.priorJournal.equals(journal)).toBe(true);
    expect(acquired.loadAllowed).toBe(false);
    expect(() =>
      observeSelectedLoadPendingIntent({
        ...base,
        entries: settled,
        journal: encodeJournal({ ...acquiredOwner, fence: 3 }),
        previousOwner: { ...acquiredOwner, fence: 3 },
      })
    ).toThrow();
    linkSync(join(root, target), join(root, candidate));
    expect(() =>
      observeSelectedLoadPendingIntent({
        ...base,
        entries: linked,
        journal: acquiredJournal,
        previousOwner: acquiredOwner,
      })
    ).toThrow();
    unlinkSync(join(root, target));
    writeFileSync(join(root, candidate), bytes.subarray(0, 32));
    expect(() =>
      observeSelectedLoadPendingIntent({
        ...base,
        entries: [{ path: stage, kind: "directory" }, file(candidate)],
      })
    ).toThrow();
    expect(readFileSync(join(root, candidate)).length).toBe(32);
  } finally {
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});
