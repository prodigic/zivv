import { expect, it } from "vitest";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { reconstructSelectedLoadResumeInventory } from "../../lib/ingestion/recovery-gmail-selected-resume-inventory.js";
import type { RecoveryRuntimeEntry } from "../../lib/ingestion/recovery-runtime.js";

it("reconstructs only the inventory committed by the intent", () => {
  const id = "a".repeat(64),
    root = "recovery-gmail-load/" + id;
  const snapshot = "checkout/data/ingestion/backups/ledger.snapshot.enc";
  const reportPath =
    "checkout/data/ingestion/reports/" + "1".repeat(64) + ".json";
  const file = (path: string, digest: string): RecoveryRuntimeEntry => ({
    path,
    kind: "file",
    size: 1,
    sha256: digest.repeat(64),
  });
  const directory = (path: string): RecoveryRuntimeEntry => ({
    path,
    kind: "directory",
  });
  const sort = (rows: RecoveryRuntimeEntry[]) =>
    rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const oldSnapshot = file(snapshot, "b"),
    newSnapshot = file(snapshot, "c");
  const common = [file(root + "/admission.json", "d")];
  const resultStage = directory(root + "/load-result.json-stage");
  const completed = sort([
    ...common,
    file(reportPath, "1"),
    newSnapshot,
    resultStage,
    file(root + "/load-result.json", "e"),
    file(root + "/resume-intent.json", "f"),
    directory(root + "/resume-intent.json-stage"),
  ]);
  const retainedBytes = Buffer.from("previous ciphertext");
  const retainedEntry: RecoveryRuntimeEntry = {
    path: snapshot,
    kind: "file",
    size: retainedBytes.length,
    sha256: sha256(retainedBytes),
  };
  for (const prior of [
    sort([...common]),
    sort([...common, oldSnapshot]),
    sort([...common, retainedEntry]),
    sort([...common, newSnapshot, resultStage]),
  ]) {
    const intent = {
      kind: "zivv-selected-load-resume-intent" as const,
      version: 2 as const,
      snapshotEvidence: null,
      admissionSha256: id,
      executionBaselineSha256: id,
      journalSha256: id,
      inventorySha256: sha256(canonicalJson(prior)),
      ledgerRevision: id,
      generation: 2,
      previousOwner: {
        scope: "prodigic/zivv/production",
        owner: "00000000-0000-0000-0000-000000000000",
        fence: 1,
        expiresAtEpochMs: 1,
      },
      fence: 2,
      owner: "00000000-0000-0000-0000-000000000000",
      startedAtEpochMs: 1,
      deadlineEpochMs: 180001,
    };
    expect(
      reconstructSelectedLoadResumeInventory({
        completedEntries: completed,
        originalEntries: [oldSnapshot],
        preResumeSnapshot: retainedBytes,
        intent,
        runId: id,
        reportPath,
      })
    ).toEqual(prior);
    expect(() =>
      reconstructSelectedLoadResumeInventory({
        completedEntries: completed,
        originalEntries: [oldSnapshot],
        intent: { ...intent, inventorySha256: "0".repeat(64) },
        runId: id,
        reportPath,
      })
    ).toThrow();
    expect(() =>
      reconstructSelectedLoadResumeInventory({
        completedEntries: completed.filter(
          (entry) => entry.path !== root + "/load-result.json"
        ),
        originalEntries: [oldSnapshot],
        intent,
        runId: id,
        reportPath,
      })
    ).toThrow();
  }
});
