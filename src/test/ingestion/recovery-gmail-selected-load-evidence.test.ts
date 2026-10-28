import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  createRecoveryGmailCaptureAdmission,
  createRecoveryGmailCaptureResult,
} from "../../lib/ingestion/recovery-gmail-capture-admission-proof.js";
import {
  proveRecoveryGmailSelectedLoadBaseline,
  type RecoveryGmailSelectedLoadBaselineInput,
} from "../../lib/ingestion/recovery-gmail-selected-load-proof.js";
import { createRecoveryGmailSelectedLoadAdmission } from "../../lib/ingestion/recovery-gmail-selected-load-admission-proof.js";
import {
  createRecoveryGmailSelectedLoadEvidence,
  restoreRecoveryGmailSelectedLoadEvidence,
  type RecoveryGmailSelectedLoadEvidenceInput,
} from "../../lib/ingestion/recovery-gmail-selected-load-evidence.js";
import { validateWeeklyJournalRecoverySnapshot } from "../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailSelectedLoadFixture } from "./fixtures/recovery-gmail-selected-load-fixture.js";
vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });
let fixture: Awaited<ReturnType<typeof createRecoveryGmailSelectedLoadFixture>>;
beforeAll(async () => {
  fixture = await createRecoveryGmailSelectedLoadFixture();
});
afterAll(() => fixture?.cleanup());
function binding() {
  const root = dirname(fixture.baseline.checkpoint.originalOperatorDirectory);
  return {
    capsuleSha256: "1".repeat(64),
    retirementSha256: "2".repeat(64),
    checkpointSha256: "3".repeat(64),
    preparedReceiptSha256: "4".repeat(64),
    preparedTreeSha256: "5".repeat(64),
    preparedImmutableTreeSha256: "6".repeat(64),
    physicalRoot: root,
    physicalOperatorDirectory: join(root, "operator"),
    physicalNpmPath: join(root, "npm", "npm-cli.js"),
    keyId: sha256(fixture.baseline.recoveryKey),
  };
}
function tail(canonical = false): RecoveryGmailSelectedLoadBaselineInput {
  const baseline = fixture.baseline,
    original = fixture.capture;
  const admission = createRecoveryGmailCaptureAdmission({
    checkpoint: baseline.checkpoint,
    recoveryKey: baseline.recoveryKey,
    binding: binding(),
    batchId: original.batchIds[0],
    correctionOfByMessageId: original.correctionOfByMessageId,
    admittedAtEpochMs: original.admittedAtEpochMs,
    unfinishedAdmissions: [],
  });
  const snapshot = canonical
    ? original.currentAfterFirstCapture
    : original.sourceJournalOnly;
  return {
    ...baseline,
    unfinishedAdmissions: [admission],
    current: {
      files: [
        ...snapshot.files,
        ...baseline.checkpoint.files.filter((file) => file.area === "checkout"),
      ],
      directories: [
        ...snapshot.directories,
        ...baseline.checkpoint.directories.filter(
          (file) => file.area === "checkout"
        ),
      ],
      journal: snapshot.journal,
    },
    ownProductionOwnership: validateWeeklyJournalRecoverySnapshot(
      Buffer.from(snapshot.journal, "base64")
    ).ownership.find((row) => row.scope === "prodigic/zivv/production")!,
  };
}
function packet(baseline = fixture.baseline) {
  const host = binding(),
    admission = createRecoveryGmailSelectedLoadAdmission({
      baseline,
      binding: host,
      admittedAtEpochMs: Date.now() - 1_000,
      unfinishedAdmissions: [],
    });
  const evidence = createRecoveryGmailSelectedLoadEvidence({
    baseline,
    binding: host,
    admission,
  });
  const input: RecoveryGmailSelectedLoadEvidenceInput = {
    checkpoint: baseline.checkpoint,
    recoveryKey: baseline.recoveryKey,
    binding: host,
    completed: baseline.completed,
    unfinishedAdmissions: baseline.unfinishedAdmissions,
    manifest: evidence.manifest,
    chunks: evidence.chunks,
    observedAdmission: admission,
  };
  return { baseline, admission, evidence, input };
}
function reject(input: RecoveryGmailSelectedLoadEvidenceInput) {
  expect(() => restoreRecoveryGmailSelectedLoadEvidence(input)).toThrow(
    "INVALID_RECOVERY_GMAIL_SELECTED_LOAD_EVIDENCE"
  );
}
function forged(
  input: RecoveryGmailSelectedLoadEvidenceInput,
  change: (value: Record<string, unknown>) => void,
  domain = "zivv-recovery-gmail-selected-load-baseline-evidence/v1\0"
) {
  const { signature, ...value } = JSON.parse(
    input.manifest.toString("utf8")
  ) as Record<string, unknown>;
  void signature;
  change(value);
  const next = createHmac("sha256", input.recoveryKey)
    .update(domain)
    .update(canonicalJson(value))
    .digest("hex");
  return Buffer.from(canonicalJson({ ...value, signature: next }) + "\n");
}
it("restores the admitted original catalog/runtime without duplicating original bodies or returning a key", () => {
  const value = packet(),
    restored = restoreRecoveryGmailSelectedLoadEvidence(value.input);
  expect(value.evidence.chunks).toHaveLength(0);
  expect(restored).toMatchObject({
    activationAllowed: false,
    captureAllowed: false,
    loadAllowed: false,
    physicalValidationRequired: true,
  });
  expect(restored.admission).toEqual(value.admission);
  expect(canonicalJson(restored.originalBaseline.currentLedger)).toBe(
    canonicalJson(value.baseline.currentLedger)
  );
  expect(Object.keys(restored.originalBaseline)).not.toContain("recoveryKey");
  expect(
    proveRecoveryGmailSelectedLoadBaseline({
      ...value.baseline,
      ...restored.originalBaseline,
    }).baselineSha256
  ).toBe(restored.baselineSha256);
  const manifest = JSON.parse(value.input.manifest.toString("utf8")) as {
    delta: { files: unknown[]; intakeEvidence: unknown[] };
  };
  expect(manifest.delta.files).toHaveLength(0);
  expect(manifest.delta.intakeEvidence).toHaveLength(0);
});
it("round-trips a journal-first tail and retains the missing canonical-file obligation", () => {
  const value = packet(tail()),
    restored = restoreRecoveryGmailSelectedLoadEvidence(value.input);
  expect(value.evidence.chunks).toHaveLength(1);
  expect(restored.originalBaseline.current.journal).toBe(
    value.baseline.current.journal
  );
  const proof = proveRecoveryGmailSelectedLoadBaseline({
    ...value.baseline,
    ...restored.originalBaseline,
  });
  expect(proof.baselineSha256).toBe(restored.baselineSha256);
  expect(
    proof.selection.obligations.find((row) => row.messageId === "b1")?.status
  ).toBe("capture-pending");
  expect(
    restored.originalBaseline.current.files.some((file) =>
      file.path.includes("/messages/" + sha256("b1"))
    )
  ).toBe(false);
});
it("reconstructs exact canonical tail bytes from archive and rows instead of storing RAW copies", () => {
  const value = packet(tail(true)),
    restored = restoreRecoveryGmailSelectedLoadEvidence(value.input);
  const files = (
    list: RecoveryGmailSelectedLoadBaselineInput["current"]["files"]
  ) =>
    [...list].sort((a, b) => (a.area + a.path).localeCompare(b.area + b.path));
  expect(files(restored.originalBaseline.current.files)).toEqual(
    files(value.baseline.current.files)
  );
  expect(
    proveRecoveryGmailSelectedLoadBaseline({
      ...value.baseline,
      ...restored.originalBaseline,
    }).selection.obligations.find((row) => row.messageId === "b1")?.status
  ).toBe("ready");
  expect(value.evidence.chunks).toHaveLength(1);
  const row = JSON.parse(
    value.evidence.chunks[0]!.bytes.toString("utf8")
  ) as Record<string, unknown>;
  expect(row).not.toHaveProperty("rawMessage");
  expect(row).not.toHaveProperty("source");
});
it("refuses missing, extra, duplicate, substituted and oversized row chunks", () => {
  const value = packet(tail()),
    chunk = value.evidence.chunks[0]!;
  reject({ ...value.input, chunks: [] });
  reject({ ...value.input, chunks: [chunk, chunk] });
  reject({ ...value.input, chunks: [{ ...chunk, id: "f".repeat(64) }] });
  const changed = Buffer.from(chunk.bytes);
  changed[0] ^= 1;
  reject({ ...value.input, chunks: [{ ...chunk, bytes: changed }] });
  reject({
    ...value.input,
    chunks: [{ ...chunk, bytes: Buffer.alloc(8 * 1024 * 1024 + 1) }],
  });
});
it("refuses valid-HMAC omission or invention of tail evidence and canonical membership", () => {
  const value = packet(tail());
  reject({
    ...value.input,
    manifest: forged(value.input, (record) => {
      (record.delta as Record<string, unknown>).intakeEvidence = [];
    }),
    chunks: [],
  });
  reject({
    ...value.input,
    manifest: forged(value.input, (record) => {
      (record.delta as Record<string, unknown>).files = [
        { area: "operator", path: "unrelated.txt", sha256: "a".repeat(64) },
      ];
    }),
  });
  reject({
    ...value.input,
    manifest: forged(value.input, (record) => {
      record.extraControl = "load";
    }),
  });
});
it("refuses a changed original checkpoint, missing capture admission, host or observed intent", () => {
  const value = packet(tail());
  reject({
    ...value.input,
    checkpoint: {
      ...value.input.checkpoint,
      createdAtEpochMs: value.input.checkpoint.createdAtEpochMs + 1,
    },
  });
  reject({ ...value.input, unfinishedAdmissions: [] });
  reject({
    ...value.input,
    binding: { ...value.input.binding, capsuleSha256: "a".repeat(64) },
  });
  reject({ ...value.input, observedAdmission: Buffer.from("different") });
});
it("validates an orphan baseline packet without granting installation or load permission", () => {
  const value = packet(tail()),
    restored = restoreRecoveryGmailSelectedLoadEvidence({
      ...value.input,
      observedAdmission: null,
    });
  expect(restored.admission).toEqual(value.admission);
  expect(restored.loadAllowed).toBe(false);
  const missing = Object.defineProperty(
    { ...value.input },
    "observedAdmission",
    { value: undefined }
  );
  reject(missing);
});
it("requires canonical bounded manifest bytes and the separate evidence signature domain", () => {
  const value = packet();
  reject({
    ...value.input,
    manifest: Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      value.input.manifest,
    ]),
  });
  reject({ ...value.input, manifest: Buffer.alloc(16 * 1024 * 1024 + 1, 32) });
  reject({
    ...value.input,
    manifest: forged(
      value.input,
      () => {},
      "zivv-recovery-gmail-selected-load-admission/v1\0"
    ),
  });
  reject({ ...value.input, recoveryKey: Buffer.alloc(32, 8) });
});
it("returns detached original evidence rather than adopting post-load mutable state", () => {
  const value = packet(tail(true)),
    restored = restoreRecoveryGmailSelectedLoadEvidence(value.input);
  restored.originalBaseline.current.files.length = 0;
  restored.admission[0] = 0;
  expect(value.baseline.current.files.length).toBeGreaterThan(0);
  expect(
    restoreRecoveryGmailSelectedLoadEvidence(value.input).admission
  ).toEqual(value.admission);
});

it("references a completed predecessor and stores only the own tail rows across original/prior/own evidence", () => {
  const prior = tail(true),
    original = fixture.capture;
  const firstAdmission = prior.unfinishedAdmissions[0]!;
  const first = {
    admission: firstAdmission,
    result: createRecoveryGmailCaptureResult({
      checkpoint: prior.checkpoint,
      recoveryKey: prior.recoveryKey,
      admission: firstAdmission,
      unfinishedAdmissions: [firstAdmission],
      current: prior.current,
      ownProductionOwnership: prior.ownProductionOwnership,
    }),
  };
  const own = createRecoveryGmailCaptureAdmission({
    checkpoint: prior.checkpoint,
    recoveryKey: prior.recoveryKey,
    binding: binding(),
    batchId: original.batchIds[1],
    admittedAtEpochMs: original.secondAdmittedAtEpochMs,
    priorCompleted: [first],
    unfinishedAdmissions: [],
  });
  const snapshot = original.currentAfterCapture;
  const baseline: RecoveryGmailSelectedLoadBaselineInput = {
    ...fixture.baseline,
    completed: [first],
    unfinishedAdmissions: [own],
    current: {
      files: [
        ...snapshot.files,
        ...fixture.baseline.checkpoint.files.filter(
          (file) => file.area === "checkout"
        ),
      ],
      directories: [
        ...snapshot.directories,
        ...fixture.baseline.checkpoint.directories.filter(
          (file) => file.area === "checkout"
        ),
      ],
      journal: snapshot.journal,
    },
    ownProductionOwnership: validateWeeklyJournalRecoverySnapshot(
      Buffer.from(snapshot.journal, "base64")
    ).ownership.find((row) => row.scope === "prodigic/zivv/production")!,
  };
  const value = packet(baseline),
    restored = restoreRecoveryGmailSelectedLoadEvidence(value.input);
  expect(value.evidence.chunks).toHaveLength(1);
  const row = JSON.parse(value.evidence.chunks[0]!.bytes.toString("utf8")) as {
    messageId: string;
  };
  expect(row.messageId).toBe("c1");
  const manifest = JSON.parse(value.input.manifest.toString("utf8")) as {
    captureFamily: { completed: { resultSha256: string }[] };
  };
  expect(manifest.captureFamily.completed).toEqual([
    {
      admissionSha256: sha256(first.admission),
      resultSha256: sha256(first.result),
    },
  ]);
  expect(
    proveRecoveryGmailSelectedLoadBaseline({
      ...baseline,
      ...restored.originalBaseline,
    }).baselineSha256
  ).toBe(restored.baselineSha256);
  reject({ ...value.input, completed: [] });
  const corrupt = Buffer.from(first.result);
  corrupt[corrupt.length - 1] ^= 1;
  reject({ ...value.input, completed: [{ ...first, result: corrupt }] });
});
