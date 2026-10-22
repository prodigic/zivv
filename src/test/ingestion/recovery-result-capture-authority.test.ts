import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import { ledgerDigest } from "../../lib/ingestion/sqlite-store.js";
import {
  captureRecoveryResultCheckpoint,
  type OperatorRecoveryCheckpoint,
} from "../../lib/ingestion/operator-recovery.js";
import {
  assertRecoveryResultCaptureCurrent,
  executeRecoveredFrozenResultRecapture,
  finalizeRecoveryResultCapture,
  type RecoveryResultRecaptureInput,
} from "../../lib/ingestion/recovery-result-recapture.js";

const expectedAuthorityError =
  "RECOVERY_RESULT_RECAPTURE_CAPTURE_AUTHORITY_REQUIRED";

function minimalCheckpoint(): OperatorRecoveryCheckpoint {
  const ledger = bootstrapLedger({ events: [], artists: [], venues: [] }, 1000);
  return {
    format: "zivv-operator-recovery",
    version: 1,
    createdAtEpochMs: 1000,
    originalOperatorDirectory: resolve(
      tmpdir(),
      "recapture-authority-operator"
    ),
    originalCheckout: resolve(tmpdir(), "recapture-authority-checkout"),
    runtime: {
      node: process.version,
      icu: process.versions.icu ?? "",
      executableSha256: "a".repeat(64),
      workerSha256: "b".repeat(64),
      lockfileSha256: "c".repeat(64),
    },
    ledgerRevision: ledgerDigest(ledger),
    ledger,
    journal: "",
    files: [],
    directories: [],
  };
}

function structurallyValidInput(): RecoveryResultRecaptureInput {
  const destination = resolve(tmpdir(), "untrusted-recapture-destination");
  return {
    archive: Buffer.from("not an archive"),
    retirementReceipt: Buffer.from("not a receipt"),
    recoveryKey: Buffer.alloc(32, 0x4a),
    destination,
    npmCli: resolve(process.execPath),
    repositoryRoot: resolve(tmpdir(), "untrusted-repository"),
    runId: "d".repeat(64),
    sourceCommit: "e".repeat(40),
    out: join(tmpdir(), "untrusted-result.enc"),
  };
}

describe("frozen-result recapture authority boundary", () => {
  it("requires private capture authority for the exported current-scope query", () => {
    expect(() =>
      assertRecoveryResultCaptureCurrent({
        checkout: resolve(tmpdir(), "checkout"),
        operator: resolve(tmpdir(), "operator"),
        npmCli: resolve(process.execPath),
      })
    ).toThrow(expectedAuthorityError);
  });

  it("requires private capture authority before the specialized checkpoint capture", () => {
    expect(() =>
      captureRecoveryResultCheckpoint({
        checkout: resolve(tmpdir(), "checkout"),
        operator: resolve(tmpdir(), "operator"),
        npmCli: resolve(process.execPath),
      })
    ).toThrow(expectedAuthorityError);
  });

  it("requires private capture authority before finalization", () => {
    expect(() => finalizeRecoveryResultCapture(minimalCheckpoint())).toThrow(
      expectedAuthorityError
    );
  });

  it("refuses the retained recapture entry from the parent runtime before inspecting fake evidence", async () => {
    await expect(
      executeRecoveredFrozenResultRecapture(structurallyValidInput())
    ).rejects.toThrow("RECOVERY_RESULT_RECAPTURE_RETAINED_EXECUTOR_REQUIRED");
  });
});
