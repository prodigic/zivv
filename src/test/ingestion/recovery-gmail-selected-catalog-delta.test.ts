import { createSelectedGmailLoadEffectPlan } from "../../lib/ingestion/recovery-gmail-selected-load-effects.js";
import { expect, it, vi } from "vitest";
import { createRecoveryGmailSelectedLoadFixture } from "./fixtures/recovery-gmail-selected-load-fixture.js";
import { proveRecoveryGmailSelectedLoadBaseline } from "../../lib/ingestion/recovery-gmail-selected-load-proof.js";
import { signSelectedLoadExecutionBaseline } from "../../lib/ingestion/recovery-gmail-execution-baseline.js";
import { proveSelectedLoadCatalogDelta } from "../../lib/ingestion/recovery-gmail-selected-catalog-delta.js";

vi.setConfig({ testTimeout: 90000 });
it("classifies only the original catalog and the exact selected source result", async () => {
  const fixture = await createRecoveryGmailSelectedLoadFixture({
    firstBody:
      "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\noct 23 2026 Delta Band at Test Room, Oakland a/a $20 8pm\n",
  });
  try {
    const input = fixture.baseline,
      proof = proveRecoveryGmailSelectedLoadBaseline(input);
    const file = input.checkpoint.files.find((item) =>
      item.path.endsWith("/bodies/" + input.selector.receiptId + "/source.txt")
    );
    expect(file?.bytes).toBeTruthy();
    const raw = Buffer.from(file!.bytes!, "base64");
    const binding = {
      admissionSha256: "a".repeat(64),
      evidenceSha256: "b".repeat(64),
      physicalSnapshotSha256: "c".repeat(64),
    };
    const executionBaseline = signSelectedLoadExecutionBaseline(
      { ...binding, generation: 1, startedAtEpochMs: Date.now(), entries: [] },
      input.recoveryKey
    );
    const common = {
      baseline: input,
      ...binding,
      executionBaseline,
      raw,
      observedGeneration: 1,
      observedLedger: input.checkpoint.ledger,
    };
    expect(proveSelectedLoadCatalogDelta(common)).toMatchObject({
      disposition: "unchanged",
      loadAllowed: false,
    });
    expect(() =>
      proveSelectedLoadCatalogDelta({ ...common, observedGeneration: 2 })
    ).toThrow();
    const plan = createSelectedGmailLoadEffectPlan(
      input.checkpoint,
      proof,
      raw
    );
    expect(plan.result.report.acceptedEventIds).toHaveLength(1);
    const committed = structuredClone(plan.result.ledger);
    const run = committed.runs.find(
      (item) => item.runId === plan.receipt.importRunId
    )!;
    expect(run).toBeDefined();
    run.status = "committed";
    run.committedAtEpochMs = Date.now();
    for (const table of ["artists", "venues"] as const) {
      const prior = new Set(
        input.checkpoint.ledger[table].map((item) => item.id)
      );
      for (const item of committed[table])
        if (!prior.has(item.id)) {
          item.createdAtEpochMs = run.committedAtEpochMs;
          item.updatedAtEpochMs = run.committedAtEpochMs;
        }
    }
    expect(
      proveSelectedLoadCatalogDelta({
        ...common,
        observedGeneration: 2,
        observedLedger: committed,
      })
    ).toMatchObject({
      disposition: "committed",
      importRunId: run.runId,
      loadAllowed: false,
    });
    const backdated = structuredClone(committed);
    backdated.runs.find(
      (item) => item.runId === run.runId
    )!.committedAtEpochMs = 1;
    expect(() =>
      proveSelectedLoadCatalogDelta({
        ...common,
        observedGeneration: 2,
        observedLedger: backdated,
      })
    ).toThrow();
    const wrong = structuredClone(committed);
    wrong.events[0]!.notes = "unrelated";
    expect(() =>
      proveSelectedLoadCatalogDelta({
        ...common,
        observedGeneration: 2,
        observedLedger: wrong,
      })
    ).toThrow();
    expect(() =>
      proveSelectedLoadCatalogDelta({
        ...common,
        observedGeneration: 3,
        observedLedger: committed,
      })
    ).toThrow();
    expect(() =>
      proveSelectedLoadCatalogDelta({
        ...common,
        admissionSha256: "d".repeat(64),
      })
    ).toThrow();
    const changed = structuredClone(input.checkpoint.ledger);
    changed.events[0]!.notes = "tampered";
    expect(() =>
      proveSelectedLoadCatalogDelta({ ...common, observedLedger: changed })
    ).toThrow();
    expect(proof.source.rawSha256).toBeDefined();
  } finally {
    fixture.cleanup();
  }
});
