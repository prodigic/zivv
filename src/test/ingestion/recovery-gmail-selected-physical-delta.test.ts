import { createSelectedGmailLoadEffectPlan } from "../../lib/ingestion/recovery-gmail-selected-load-effects.js";
import { expect, it, vi } from "vitest";
import { createRecoveryGmailSelectedLoadFixture } from "./fixtures/recovery-gmail-selected-load-fixture.js";
import { proveRecoveryGmailSelectedLoadBaseline } from "../../lib/ingestion/recovery-gmail-selected-load-proof.js";
import { signSelectedLoadExecutionBaseline } from "../../lib/ingestion/recovery-gmail-execution-baseline.js";
import { proveSelectedLoadPhysicalDelta } from "../../lib/ingestion/recovery-gmail-selected-physical-delta.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import type { RecoveryRuntimeEntry } from "../../lib/ingestion/recovery-runtime.js";
vi.setConfig({ testTimeout: 90000 });
it("accepts only the signed original tree and exact execution evidence", async () => {
  const fixture = await createRecoveryGmailSelectedLoadFixture({
    firstBody:
      "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\noct 23 2026 Delta Band at Test Room, Oakland a/a $20 8pm\n",
  });
  try {
    const baseline = fixture.baseline,
      proof = proveRecoveryGmailSelectedLoadBaseline(baseline),
      rawFile = baseline.checkpoint.files.find((item) =>
        item.path.endsWith(
          "/bodies/" + baseline.selector.receiptId + "/source.txt"
        )
      )!,
      raw = Buffer.from(rawFile.bytes!, "base64"),
      root = "recovery-gmail-load/" + proof.runState.runId;
    const entries: RecoveryRuntimeEntry[] = [
      { path: "checkout", kind: "directory" },
      { path: "operator", kind: "directory" },
      {
        path: "operator/ledger.sqlite",
        kind: "file",
        size: 1,
        sha256: sha256(Buffer.from("x")),
      },
      { path: "recovery-gmail-load", kind: "directory" },
      { path: root, kind: "directory" },
    ];
    const binding = {
      admissionSha256: "a".repeat(64),
      evidenceSha256: "b".repeat(64),
      physicalSnapshotSha256: sha256(canonicalJson(entries.slice(0, 3))),
    };
    const executionBaseline = signSelectedLoadExecutionBaseline(
      { ...binding, generation: 1, startedAtEpochMs: Date.now(), entries },
      baseline.recoveryKey
    );
    const observedEntries: RecoveryRuntimeEntry[] = [
      ...entries.filter((item) => item.path !== "operator/ledger.sqlite"),
      {
        path: root + "/execution-baseline.json",
        kind: "file",
        size: executionBaseline.length,
        sha256: sha256(executionBaseline),
      },
    ];
    const input = {
      baseline,
      ...binding,
      executionBaseline,
      raw,
      observedGeneration: 1,
      observedLedger: baseline.checkpoint.ledger,
      observedEntries,
      changedFiles: {},
    };
    expect(proveSelectedLoadPhysicalDelta(input)).toMatchObject({
      status: "unchanged",
      loadAllowed: false,
    });
    expect(() =>
      proveSelectedLoadPhysicalDelta({
        ...input,
        observedEntries: [
          ...observedEntries,
          {
            path: "operator/surprise",
            kind: "file",
            size: 0,
            sha256: sha256(Buffer.alloc(0)),
          },
        ],
      })
    ).toThrow();
    expect(() =>
      proveSelectedLoadPhysicalDelta({
        ...input,
        observedEntries: observedEntries.filter(
          (entry) => entry.path !== "checkout"
        ),
      })
    ).toThrow();
    const plan = createSelectedGmailLoadEffectPlan(
      baseline.checkpoint,
      proof,
      raw
    );
    const report = Buffer.from(
      JSON.stringify(plan.result.report, null, 2) + "\n"
    );
    const reportPath =
      "checkout/data/ingestion/reports/" +
      sha256(plan.result.report.runId) +
      ".json";
    const withReport: RecoveryRuntimeEntry[] = [
      ...observedEntries,
      {
        path: reportPath,
        kind: "file",
        size: report.length,
        sha256: sha256(report),
      },
    ];
    expect(
      proveSelectedLoadPhysicalDelta({
        ...input,
        observedEntries: withReport,
        changedFiles: { report },
      })
    ).toMatchObject({ status: "unchanged" });
    expect(() =>
      proveSelectedLoadPhysicalDelta({
        ...input,
        observedEntries: withReport,
        changedFiles: { report: Buffer.from("different") },
      })
    ).toThrow();
    const fakeSnapshot = Buffer.from("not an encrypted snapshot");
    const withSnapshot: RecoveryRuntimeEntry[] = [
      ...observedEntries,
      {
        path: "checkout/data/ingestion/backups/ledger.snapshot.enc",
        kind: "file",
        size: fakeSnapshot.length,
        sha256: sha256(fakeSnapshot),
      },
    ];
    expect(() =>
      proveSelectedLoadPhysicalDelta({
        ...input,
        observedEntries: withSnapshot,
        changedFiles: { snapshot: fakeSnapshot },
      })
    ).toThrow();
    const stagePath = root + "/key-stage";
    const fileBaseline: RecoveryRuntimeEntry[] = [
      ...entries,
      {
        path: stagePath,
        kind: "file" as const,
        size: 1,
        sha256: sha256(Buffer.from("x")),
      },
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const signedWithFile = signSelectedLoadExecutionBaseline(
      {
        ...binding,
        generation: 1,
        startedAtEpochMs: Date.now(),
        entries: fileBaseline,
      },
      baseline.recoveryKey
    );
    const replaced: RecoveryRuntimeEntry[] = [
      ...fileBaseline.filter(
        (item) =>
          item.path !== "operator/ledger.sqlite" && item.path !== stagePath
      ),
      { path: stagePath, kind: "directory" },
      {
        path: root + "/execution-baseline.json",
        kind: "file",
        size: signedWithFile.length,
        sha256: sha256(signedWithFile),
      },
    ];
    expect(() =>
      proveSelectedLoadPhysicalDelta({
        ...input,
        executionBaseline: signedWithFile,
        observedEntries: replaced,
      })
    ).toThrow();
    const altered = structuredClone(observedEntries);
    altered.find(
      (entry) => entry.path === root + "/execution-baseline.json"
    )!.path = root + "/other.json";
    expect(() =>
      proveSelectedLoadPhysicalDelta({ ...input, observedEntries: altered })
    ).toThrow();
  } finally {
    fixture.cleanup();
  }
});
