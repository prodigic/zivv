import { prepareSteveBatch } from "../../../lib/ingestion/imports.js";
import {
  bootstrapLedger,
  reconcileCandidates,
} from "../../../lib/ingestion/ledger.js";
import { ledgerDigest } from "../../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../../lib/ingestion/steve-preflight.js";
import { proveRecoveryGmailBatchInventory } from "../../../lib/ingestion/recovery-gmail-batch-proof.js";
import { compiledWorkerInventoryDigest } from "../../../lib/ingestion/weekly-run-context.js";
import type { RecoveryGmailSelectedLoadBaselineInput } from "../../../lib/ingestion/recovery-gmail-selected-load-proof.js";
import { createRecoveryGmailCaptureAdmissionFixture } from "./recovery-gmail-capture-admission-fixture.js";

export const selectedLoadWorkerFixtureBytes = Buffer.from(
  "export const fixture = true;\n"
);
/** Detached synthetic worker inventory plus ordinary Gmail/intake/catalog evidence.
 * This helper never claims to prepare or execute a genuine retained load worker. */
export async function createRecoveryGmailSelectedLoadFixture(
  options: { firstBody?: string } = {}
) {
  const workerBytes = selectedLoadWorkerFixtureBytes;

  const fixture = await createRecoveryGmailCaptureAdmissionFixture(options);
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
  const baseline: RecoveryGmailSelectedLoadBaselineInput = {
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

  return { baseline, capture: fixture, cleanup: () => fixture.cleanup() };
}
