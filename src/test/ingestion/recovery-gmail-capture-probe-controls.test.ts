import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureProbeControls } from "../../lib/ingestion/recovery-gmail-capture-probe-controls.js";
import { transitionWeeklyRun } from "../../lib/ingestion/weekly-run-state.js";
import {
  inheritStoreRevision,
  openStore,
  readSqliteLedger,
  withStoreTransaction,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";

function cleanupContainedTemporaryRoot(root: string): void {
  const absoluteRoot = resolve(root);
  const absoluteTemp = resolve(tmpdir());
  const fromTemp = relative(absoluteTemp, absoluteRoot);
  if (
    !isAbsolute(absoluteRoot) ||
    !fromTemp ||
    fromTemp === ".." ||
    fromTemp.startsWith(`..${sep}`) ||
    resolve(absoluteTemp, fromTemp) !== absoluteRoot
  )
    throw new Error("Refusing cleanup outside the temporary test root");
  rmSync(absoluteRoot, { recursive: true, force: true });
}

describe("recovery Gmail capture probe controls", () => {
  it("supplies ordinary-valid journal states and a valid empty catalog ledger", () => {
    const controls = createRecoveryGmailCaptureProbeControls();
    expect(controls.create.state.revision).toBe(0);
    expect(controls.create.rawSource.length).toBeGreaterThan(0);
    expect(controls.create.state.runId).not.toBe(
      controls.seed.initialState.runId
    );
    expect(controls.seed.runningState.revision).toBe(1);
    expect(controls.seed.succeededState.revision).toBe(2);
    expect(controls.seed.runningRawArtifact).toEqual(controls.artifactBytes);
    expect(controls.catalogLedger).toMatchObject({
      schemaVersion: 1,
      events: [],
      artists: [],
      venues: [],
      runs: [],
      redirects: [],
    });
    controls.seed.rawSource.fill(0);
    expect(controls.seed.initialState.source.rawSha256).not.toMatch(/^0+$/);
  });

  it("accepts normal create, run, artifact, snapshot, restore, and fencing controls", () => {
    const root = mkdtempSync(
      join(tmpdir(), "zivv-gmail-capture-positive-control-")
    );
    const controls = createRecoveryGmailCaptureProbeControls();
    const opened: WeeklyRunJournal[] = [];
    let completed = false;
    try {
      const clock = () => 1_792_000_000_010;
      const directory = join(root, "operator");
      const journal = new WeeklyRunJournal(directory, clock);
      opened.push(journal);
      const productionLease = journal.acquire(
        "prodigic/zivv/production",
        60_000
      );

      expect(
        journal.create(
          controls.create.state,
          productionLease,
          controls.create.rawSource
        )
      ).toEqual(controls.create.state);

      expect(
        journal.create(
          controls.seed.initialState,
          productionLease,
          controls.seed.rawSource
        )
      ).toEqual(controls.seed.initialState);
      expect(
        journal.save(
          controls.seed.runningState,
          controls.seed.initialState.revision,
          productionLease
        )
      ).toEqual(controls.seed.runningState);
      journal.writeArtifact(
        controls.seed.initialState.runId,
        "acquire",
        controls.artifactBytes,
        productionLease
      );
      expect(
        journal.readArtifact(controls.seed.initialState.runId, "acquire", 1)
      ).toEqual(controls.artifactBytes);
      expect(
        journal.save(
          controls.seed.succeededState,
          controls.seed.runningState.revision,
          productionLease
        )
      ).toEqual(controls.seed.succeededState);

      const snapshot = journal.exportRecoverySnapshot(productionLease);
      const restoredDirectory = join(root, "restored-operator");
      mkdirSync(restoredDirectory, { recursive: true });
      const restored = new WeeklyRunJournal(restoredDirectory, clock);
      opened.push(restored);
      restored.restoreRecoverySnapshot(snapshot);
      expect(restored.load(controls.create.state.runId)).toEqual(
        controls.create.state
      );
      expect(restored.load(controls.seed.initialState.runId)).toEqual(
        controls.seed.succeededState
      );
      expect(
        restored.readArtifact(controls.seed.initialState.runId, "acquire", 1)
      ).toEqual(controls.artifactBytes);

      const previewLease = journal.acquire("preview", 60_000);
      expect(previewLease.scope).toBe("preview");
      expect(() => journal.create(controls.create.state, previewLease)).toThrow(
        "another destination"
      );
      const wrongFence = {
        ...productionLease,
        fence: productionLease.fence + 1,
      };
      expect(() =>
        journal.writeArtifact(
          controls.seed.initialState.runId,
          "acquire",
          Buffer.from("wrong-owner-control"),
          wrongFence
        )
      ).toThrow("fenced");
      completed = true;
    } finally {
      for (const journal of opened) journal.close();
      if (completed) cleanupContainedTemporaryRoot(root);
    }
  });

  it("accepts ordinary catalog initialization, revision writes, and a guarded transaction", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "zivv-gmail-capture-catalog-control-")
    );
    const path = join(root, "operator", "ledger.sqlite");
    const controls = createRecoveryGmailCaptureProbeControls();
    let completed = false;
    try {
      await writeSqliteLedger(path, controls.catalogLedger, true);
      expect(readSqliteLedger(path)).toEqual(controls.catalogLedger);

      const loaded = readSqliteLedger(path);
      const secondRevision = inheritStoreRevision(loaded, {
        ...loaded,
        version: "2",
      });
      await writeSqliteLedger(path, secondRevision);
      expect(readSqliteLedger(path)).toEqual(secondRevision);

      const thirdRevision = await withStoreTransaction(path, async () => {
        const current = readSqliteLedger(path);
        const next = { ...current, version: "3" };
        await writeSqliteLedger(path, next);
        return next;
      });
      expect(readSqliteLedger(path)).toEqual(thirdRevision);
      const db = openStore(path);
      try {
        expect(
          db.prepare("SELECT generation FROM metadata WHERE id=1").get()
        ).toMatchObject({ generation: 3 });
      } finally {
        db.close();
      }
      completed = true;
    } finally {
      if (completed) cleanupContainedTemporaryRoot(root);
    }
  });

  it("keeps control transitions within the ordinary validated state machine", () => {
    const controls = createRecoveryGmailCaptureProbeControls();
    const running = transitionWeeklyRun(
      controls.seed.initialState,
      0,
      "acquire",
      { status: "running" },
      1_792_000_000_001
    );
    expect(running).toEqual(controls.seed.runningState);
    expect(() =>
      transitionWeeklyRun(
        controls.seed.runningState,
        controls.seed.runningState.revision,
        "acquire",
        {
          status: "succeeded",
          evidence: {
            rawSha256: "0".repeat(64),
            deliveryId: controls.seed.initialState.source.deliveryId,
          },
        },
        1_792_000_000_002
      )
    ).toThrow("Acquired source identity changed");
  });
});
