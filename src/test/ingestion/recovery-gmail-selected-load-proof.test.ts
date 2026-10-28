import { prepareSteveBatch } from "../../lib/ingestion/imports.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  bootstrapLedger,
  reconcileCandidates,
} from "../../lib/ingestion/ledger.js";
import {
  canonicalJson,
  ledgerDigest,
} from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { selectSteveEmailPlaintext } from "../../lib/ingestion/steve-email-intake.js";
import { proveRecoveryGmailBatchInventory } from "../../lib/ingestion/recovery-gmail-batch-proof.js";
import {
  proveRecoveryGmailSelectedLoadBaseline,
  type RecoveryGmailSelectedLoadBaselineInput,
} from "../../lib/ingestion/recovery-gmail-selected-load-proof.js";
import {
  compiledWorkerInventoryDigest,
  IMPORT_CONFIGURATION_FILES,
  importConfigurationInventoryDigest,
  weeklyRunRulesDigest,
} from "../../lib/ingestion/weekly-run-context.js";
import { createWeeklyRunState } from "../../lib/ingestion/weekly-run-state.js";
import { validateWeeklyJournalRecoverySnapshot } from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureAdmissionFixture,
  type RecoveryGmailCaptureAdmissionFixture,
} from "./fixtures/recovery-gmail-capture-admission-fixture.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });
let fixture: RecoveryGmailCaptureAdmissionFixture;
let baseline: RecoveryGmailSelectedLoadBaselineInput;
const workerBytes = Buffer.from("export const fixture = true;\n");
beforeAll(async () => {
  fixture = await createRecoveryGmailCaptureAdmissionFixture();
  const empty = bootstrapLedger({ events: [], artists: [], venues: [] }, 1_000);
  const ledger = reconcileCandidates(
    empty,
    prepareSteveBatch(
      empty,
      "oct 16 2026 Baseline Fixture Band at Test Room, Oakland a/a $20 8pm\n",
      Date.parse("2026-10-09T20:00:00Z")
    )
  ).ledger;
  const file = (path: string, bytes: Buffer) => ({
    area: "checkout" as const,
    path,
    bytes: bytes.toString("base64"),
    sha256: sha256(bytes),
  });
  const extras = [
    file("dist/lib/ingestion/weekly-import-runner.js", workerBytes),
    file("package-lock.json", Buffer.from('{"lockfileVersion":3}\n')),
  ];
  const checkpoint = {
    ...fixture.checkpoint,
    files: [...fixture.checkpoint.files, ...extras],
    directories: [
      ...fixture.checkpoint.directories,
      ...[
        "dist",
        "dist/lib",
        "dist/lib/ingestion",
        "dist/types",
        "dist/utils",
      ].map((path) => ({ area: "checkout" as const, path })),
    ],
    ledger,
    ledgerRevision: ledgerDigest(ledger),
    runtime: {
      node: process.version,
      icu: process.versions.icu ?? "",
      executableSha256: "e".repeat(64),
      workerSha256: compiledWorkerInventoryDigest([
        {
          path: "lib/ingestion/weekly-import-runner.js",
          size: workerBytes.length,
          sha256: sha256(workerBytes),
        },
      ]),
      lockfileSha256: extras[1]!.sha256,
    },
  };
  const selected = proveRecoveryGmailBatchInventory({
    checkpoint,
    recoveryKey: fixture.recoveryKey,
  }).batches.find((item) => item.batch.batchId === fixture.completedBatchId)!;
  const snapshot = selected.batch.snapshots[0]!;
  const receipt = selected.messages[0]!;
  if (receipt.status !== "captured")
    throw new Error("Expected normal captured receipt");
  baseline = {
    checkpoint,
    recoveryKey: fixture.recoveryKey,
    completed: [],
    unfinishedAdmissions: [],
    current: checkpoint,
    currentLedger: structuredClone(ledger),
    currentRuntime: { ...checkpoint.runtime },
    priorLoads: [],
    selector: {
      batchId: selected.batch.batchId,
      messageId: snapshot.rawMessage.id,
      rawSha256: sha256(Buffer.from(snapshot.rawMessage.raw, "base64url")),
      receiptId: receipt.receiptId,
    },
  };
});
afterAll(() => fixture?.cleanup());
function reject(input: RecoveryGmailSelectedLoadBaselineInput) {
  expect(() => proveRecoveryGmailSelectedLoadBaseline(input)).toThrow(
    "INVALID_RECOVERY_GMAIL_SELECTED_LOAD_BASELINE"
  );
}
function withJournal(
  input: RecoveryGmailSelectedLoadBaselineInput,
  change: (
    journal: ReturnType<typeof validateWeeklyJournalRecoverySnapshot>
  ) => void
) {
  const journal = validateWeeklyJournalRecoverySnapshot(
    Buffer.from(input.checkpoint.journal, "base64")
  );
  change(journal);
  const { digest, ...body } = journal;
  void digest;
  const bytes = Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  ).toString("base64");
  return {
    ...input,
    checkpoint: { ...input.checkpoint, journal: bytes },
    current: { ...input.current, journal: bytes },
  };
}
it("preserves the pre-extraction normal context commitment bytes", () => {
  expect(
    compiledWorkerInventoryDigest([
      {
        path: "lib/ingestion/weekly-import-runner.js",
        size: workerBytes.length,
        sha256: sha256(workerBytes),
      },
    ])
  ).toBe("80122d7783eb29da4050e53a202f5630cbe7abb78f1906748402d8765fdcfd29");
  expect(
    importConfigurationInventoryDigest(
      IMPORT_CONFIGURATION_FILES.map((path) => ({ path, sha256: null }))
    )
  ).toBe("f1897d93c5bfcda497352adc450440c205f08076dd2ff157fada1312263c7083");
  expect(
    weeklyRunRulesDigest({
      runtimeSha256: "a".repeat(64),
      packageLockSha256: "b".repeat(64),
      configurationSha256: "c".repeat(64),
      node: "v24.22.1",
      icu: "77.1",
    })
  ).toBe("ed57083ee7f6aa719fb4b88d29847d01722bbaaa21d929601864d5a8cf2ad246");
});
it("derives the exact normal source/run and binds the full baseline without granting effects", () => {
  const proof = proveRecoveryGmailSelectedLoadBaseline(baseline);
  expect(proof).toMatchObject({
    activationAllowed: false,
    captureAllowed: false,
    loadAllowed: false,
    physicalValidationRequired: true,
    runDisposition: "new",
    catalogSha256: baseline.checkpoint.ledgerRevision,
  });
  expect(baseline.checkpoint.ledger.events).toHaveLength(1);
  expect(baseline.checkpoint.ledger.artists).toHaveLength(1);
  expect(baseline.checkpoint.ledger.venues).toHaveLength(1);
  expect(baseline.checkpoint.ledger.runs).toHaveLength(1);
  expect(proof.source.rawSha256).toBe(proof.selection.source.sourceSha256);
  expect(proof.source.rawSha256).not.toBe(baseline.selector.rawSha256);
  expect(proof.source.importObservedAtEpochMs).toBe(
    proof.selection.receipt.firstObservedAtEpochMs
  );
  expect(proof.initialState).toEqual(createWeeklyRunState(proof.source));
  expect(proof.runState).toEqual(proof.initialState);
  expect(proof.baselineSha256).toBe(
    proveRecoveryGmailSelectedLoadBaseline(baseline).baselineSha256
  );
  expect(
    proof.selection.obligations.filter(
      (row) => row.status === "capture-pending"
    )
  ).toHaveLength(2);
});
it("refuses a valid catalog metadata change even with unchanged entity counts", () => {
  const changed = structuredClone(baseline.checkpoint.ledger);
  changed.version = String(Number(changed.version) + 1);
  reject({ ...baseline, currentLedger: changed });
  const changedSlug = structuredClone(baseline.checkpoint.ledger);
  changedSlug.events[0]!.slug = "changed-baseline-slug";
  reject({ ...baseline, currentLedger: changedSlug });
  reject({
    ...baseline,
    checkpoint: { ...baseline.checkpoint, ledgerRevision: "f".repeat(64) },
  });
  reject({ ...baseline, currentLedger: { ...changed, schemaVersion: 999 } });
});
it("refuses current runtime, executable, worker, lock, Node and ICU drift", () => {
  for (const change of [
    { executableSha256: "a".repeat(64) },
    { workerSha256: "b".repeat(64) },
    { lockfileSha256: "c".repeat(64) },
    { node: "v25.0.0" },
    { icu: "changed" },
  ])
    reject({
      ...baseline,
      currentRuntime: { ...baseline.currentRuntime, ...change },
    });
  reject({
    ...baseline,
    checkpoint: {
      ...baseline.checkpoint,
      runtime: { ...baseline.checkpoint.runtime, workerSha256: "f".repeat(64) },
    },
    currentRuntime: {
      ...baseline.currentRuntime,
      workerSha256: "f".repeat(64),
    },
  });
});
it("refuses unproved prior-load history instead of silently adopting its changed baseline", () => {
  reject({
    ...baseline,
    priorLoads: [
      { admission: Buffer.from("prior"), result: Buffer.from("load") },
    ],
  });
});
it("binds exact captured policy bytes and refuses current configuration drift", () => {
  const bytes = Buffer.from('{"Fixture":"Canonical"}\n');
  const config = {
    area: "checkout" as const,
    path: "data/venue-aliases.json",
    bytes: bytes.toString("base64"),
    sha256: sha256(bytes),
  };
  const input = {
    ...baseline,
    checkpoint: {
      ...baseline.checkpoint,
      files: [...baseline.checkpoint.files, config],
    },
    current: {
      ...baseline.current,
      files: [...baseline.current.files, config],
    },
  };
  const changed = proveRecoveryGmailSelectedLoadBaseline(input),
    original = proveRecoveryGmailSelectedLoadBaseline(baseline);
  expect(changed.source.rulesSha256).not.toBe(original.source.rulesSha256);
  expect(changed.runState.runId).not.toBe(original.runState.runId);
  reject({
    ...input,
    current: {
      ...input.current,
      files: input.current.files.map((file) =>
        file === config
          ? {
              ...file,
              bytes: Buffer.from("changed").toString("base64"),
              sha256: sha256("changed"),
            }
          : file
      ),
    },
  });
});
it("reuses an exact retained run only with its original acquisition artifact", () => {
  const first = proveRecoveryGmailSelectedLoadBaseline(baseline);
  const batch = proveRecoveryGmailBatchInventory({
    checkpoint: baseline.checkpoint,
    recoveryKey: baseline.recoveryKey,
  }).batches.find(
    (item) => item.batch.batchId === baseline.selector.batchId
  )!.batch;
  const bytes = selectSteveEmailPlaintext(
    batch.snapshots[0]!.fullMessage.payload
  ).source;
  const retained = withJournal(baseline, (journal) => {
    journal.runState.push({
      id: first.initialState.runId,
      scope: "prodigic/zivv/production",
      revision: 0,
      payload: canonicalJson(first.initialState),
    });
    journal.stageArtifacts.push({
      runId: first.initialState.runId,
      stage: "acquire",
      attempt: 0,
      identity: sha256(bytes),
      bytes: bytes.toString("base64"),
    });
  });
  expect(proveRecoveryGmailSelectedLoadBaseline(retained)).toMatchObject({
    runDisposition: "retained",
    runState: first.initialState,
  });
  reject(
    withJournal(retained, (journal) => {
      journal.stageArtifacts = [];
    })
  );
});
it("returns detached run/source data and rejects incomplete worker inventory", () => {
  const proof = proveRecoveryGmailSelectedLoadBaseline(baseline);
  proof.runState.source.deliveryId = "changed";
  expect(
    proveRecoveryGmailSelectedLoadBaseline(baseline).source.deliveryId
  ).not.toBe("changed");
  const files = baseline.checkpoint.files.filter(
    (file) => file.path !== "dist/lib/ingestion/weekly-import-runner.js"
  );
  reject({
    ...baseline,
    checkpoint: { ...baseline.checkpoint, files },
    current: { ...baseline.current, files },
  });
});

it("rejects caller source, run and rules replacements instead of accepting alternate authority", () => {
  for (const control of [
    { runId: "caller-run" },
    { rulesSha256: "a".repeat(64) },
    { source: { raw: Buffer.from("replacement") } },
  ]) {
    const input = { ...baseline, ...control };
    reject(input);
  }
});
