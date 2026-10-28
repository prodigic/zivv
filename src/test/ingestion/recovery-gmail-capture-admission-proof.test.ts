import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authenticateRecoveryGmailCaptureAdmission,
  createRecoveryGmailCaptureAdmission,
  createRecoveryGmailCaptureResult,
  proveRecoveryGmailCaptureDelta,
  proveRecoveryGmailCaptureFamily,
  type RecoveryGmailCaptureAdmissionInput,
  type RecoveryGmailCaptureDeltaInput,
} from "../../lib/ingestion/recovery-gmail-capture-admission-proof.js";
import { proveRecoveryGmailBatchInventory } from "../../lib/ingestion/recovery-gmail-batch-proof.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  validateWeeklyJournalRecoverySnapshot,
  type WeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  createRecoveryGmailCaptureAdmissionFixture,
  type RecoveryGmailCaptureAdmissionFixture,
} from "./fixtures/recovery-gmail-capture-admission-fixture.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });
let fixture: RecoveryGmailCaptureAdmissionFixture;
let admissionInput: RecoveryGmailCaptureAdmissionInput;
let admission: Buffer;
const production = "prodigic/zivv/production";
type Inventory = RecoveryGmailCaptureDeltaInput["current"];
function state(current: Inventory) {
  return validateWeeklyJournalRecoverySnapshot(
    Buffer.from(current.journal, "base64")
  );
}
function changedJournal(
  current: Inventory,
  change: (journal: WeeklyJournalRecoverySnapshot) => void
): Inventory {
  const next = structuredClone(current),
    parsed = state(current);
  change(parsed);
  const { digest: _digest, ...body } = parsed;
  next.journal = Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  ).toString("base64");
  return next;
}
function input(
  current: Inventory,
  selected = admission,
  priorCompleted: RecoveryGmailCaptureDeltaInput["priorCompleted"] = []
): RecoveryGmailCaptureDeltaInput {
  return {
    checkpoint: fixture.checkpoint,
    recoveryKey: fixture.recoveryKey,
    admission: selected,
    unfinishedAdmissions: [selected],
    priorCompleted,
    current,
    ownProductionOwnership: state(current).ownership.find(
      (row) => row.scope === production
    )!,
  };
}
beforeAll(async () => {
  fixture = await createRecoveryGmailCaptureAdmissionFixture();
  admissionInput = {
    checkpoint: fixture.checkpoint,
    recoveryKey: fixture.recoveryKey,
    binding: {
      capsuleSha256: "1".repeat(64),
      retirementSha256: "2".repeat(64),
      checkpointSha256: "3".repeat(64),
      preparedReceiptSha256: "4".repeat(64),
      preparedTreeSha256: "5".repeat(64),
      preparedImmutableTreeSha256: "6".repeat(64),
      physicalRoot: fixture.physicalRoot,
      physicalOperatorDirectory: fixture.physicalOperatorDirectory,
      physicalNpmPath:
        fixture.physicalRoot +
        (fixture.physicalRoot.includes("\\")
          ? "\\npm\\npm-cli.js"
          : "/npm/npm-cli.js"),
      keyId: sha256(fixture.recoveryKey),
    },
    batchId: fixture.batchIds[0],
    correctionOfByMessageId: fixture.correctionOfByMessageId,
    admittedAtEpochMs: fixture.admittedAtEpochMs,
    unfinishedAdmissions: [],
  };
  admission = createRecoveryGmailCaptureAdmission(admissionInput);
});
afterAll(() => fixture?.cleanup());

describe("detached immutable Gmail capture admission and exact progress", () => {
  it("preserves implicit original archive ancestors without admitting arbitrary additions", () => {
    const checkpoint = structuredClone(fixture.checkpoint),
      bytes = Buffer.from("retained worker fixture\n");
    checkpoint.files.push({
      area: "checkout",
      path: "dist/lib/implicit.js",
      bytes: bytes.toString("base64"),
      sha256: sha256(bytes),
    });
    checkpoint.directories.push({ area: "checkout", path: "dist/lib" });
    for (const values of [checkpoint.files, checkpoint.directories])
      values.sort((a, b) =>
        a.area + "/" + a.path < b.area + "/" + b.path ? -1 : 1
      );
    const selected = createRecoveryGmailCaptureAdmission({
      ...admissionInput,
      checkpoint,
    });
    expect(
      proveRecoveryGmailCaptureDelta({
        ...input(checkpoint, selected),
        checkpoint,
      }).status
    ).toBe("capture-pending");
    const changed = structuredClone(checkpoint);
    changed.files.push({
      area: "checkout",
      path: "dist/unrelated.txt",
      bytes: bytes.toString("base64"),
      sha256: sha256(bytes),
    });
    expect(() =>
      proveRecoveryGmailCaptureDelta({
        ...input(changed, selected),
        checkpoint,
      })
    ).toThrow("INVALID_RECOVERY_GMAIL_CAPTURE_ADMISSION_PROOF");
  });
  it("binds intent deterministically and grants no capture or physical authority", () => {
    expect(createRecoveryGmailCaptureAdmission(admissionInput)).toEqual(
      admission
    );
    const parsed = authenticateRecoveryGmailCaptureAdmission(
      input(fixture.checkpoint)
    );
    expect(parsed.batchId).toBe(fixture.batchIds[0]);
    expect(parsed.binding.keyId).toBe(sha256(fixture.recoveryKey));
    expect(
      proveRecoveryGmailCaptureDelta(input(fixture.checkpoint))
    ).toMatchObject({
      status: "capture-pending",
      captureAllowed: false,
      activationAllowed: false,
      physicalValidationRequired: true,
    });
  });
  it("replays exact unfinished intent bytes and refuses new time or a different selection", () => {
    expect(
      createRecoveryGmailCaptureAdmission({
        ...admissionInput,
        unfinishedAdmissions: [admission],
      })
    ).toEqual(admission);
    expect(() =>
      createRecoveryGmailCaptureAdmission({
        ...admissionInput,
        admittedAtEpochMs: admissionInput.admittedAtEpochMs + 1,
        unfinishedAdmissions: [admission],
      })
    ).toThrow();
    expect(() =>
      createRecoveryGmailCaptureAdmission({
        ...admissionInput,
        batchId: fixture.batchIds[1],
        unfinishedAdmissions: [admission],
      })
    ).toThrow();
    expect(() =>
      proveRecoveryGmailCaptureDelta({
        ...input(fixture.checkpoint),
        unfinishedAdmissions: [admission, admission],
      })
    ).toThrow();
  });
  it("bounds physical metadata and keeps completed-prefix commitments compact", () => {
    const physicalRoot = "/" + "p".repeat(4070);
    const bounded = createRecoveryGmailCaptureAdmission({
      ...admissionInput,
      binding: {
        ...admissionInput.binding,
        physicalRoot,
        physicalOperatorDirectory: physicalRoot + "/operator",
        physicalNpmPath: "/" + "n".repeat(4095),
      },
    });
    expect(bounded.length).toBeLessThan(64 * 1024);
    expect(() =>
      createRecoveryGmailCaptureAdmission({
        ...admissionInput,
        binding: {
          ...admissionInput.binding,
          physicalNpmPath: "/" + "n".repeat(4096),
        },
      })
    ).toThrow();
    const parsed = authenticateRecoveryGmailCaptureAdmission(
      input(fixture.checkpoint)
    );
    expect(parsed.priorCompleted).toEqual({
      count: 0,
      sha256: sha256(canonicalJson([])),
    });
  });
  it("requires an explicit unfinished-family input and rejects forged intent/key", () => {
    const changed = Buffer.from(admission);
    changed[changed.length - 5] = changed[changed.length - 5]! ^ 1;
    expect(() =>
      proveRecoveryGmailCaptureDelta(input(fixture.checkpoint, changed))
    ).toThrow();
    expect(() =>
      proveRecoveryGmailCaptureDelta({
        ...input(fixture.checkpoint),
        recoveryKey: Buffer.alloc(32, 99),
      })
    ).toThrow();
    const missingFamily = input(fixture.checkpoint);
    Reflect.set(missingFamily, "unfinishedAdmissions", undefined);
    expect(() => proveRecoveryGmailCaptureDelta(missingFamily)).toThrow();
  });
  it("accepts committed source evidence before canonical files without weakening ordinary proof", () => {
    const result = proveRecoveryGmailCaptureDelta(
      input(fixture.sourceJournalOnly)
    );
    expect(result.status).toBe("capture-partial");
    expect(result.missingFiles).toHaveLength(4);
    const observation = result.receipts[0]!.firstObservedAtEpochMs;
    expect(observation).toBe(
      proveRecoveryGmailCaptureDelta(input(fixture.currentAfterFirstCapture))
        .receipts[0]!.firstObservedAtEpochMs
    );
    expect(() =>
      proveRecoveryGmailBatchInventory({
        checkpoint: {
          ...fixture.checkpoint,
          ...fixture.sourceJournalOnly,
          createdAtEpochMs: Date.now(),
        },
        recoveryKey: fixture.recoveryKey,
      })
    ).toThrow();
    expect(() =>
      createRecoveryGmailCaptureResult(input(fixture.sourceJournalOnly))
    ).toThrow();
  });
  it("accepts each exact canonical-file prefix after the source journal commit", () => {
    const baselinePaths = new Set(
      fixture.checkpoint.files.map((file) => file.path)
    );
    const additions = fixture.currentAfterFirstCapture.files.filter(
      (file) => !baselinePaths.has(file.path)
    );
    for (let count = 0; count <= additions.length; count++) {
      const current = {
        ...fixture.sourceJournalOnly,
        directories: fixture.currentAfterFirstCapture.directories,
        files: [...fixture.checkpoint.files, ...additions.slice(0, count)],
      };
      expect(proveRecoveryGmailCaptureDelta(input(current)).status).toBe(
        count === additions.length ? "capture-complete" : "capture-partial"
      );
    }
  });
  it("signs only complete exact evidence and preserves result bytes on replay", () => {
    const complete = input(fixture.currentAfterFirstCapture);
    expect(proveRecoveryGmailCaptureDelta(complete).status).toBe(
      "capture-complete"
    );
    expect(createRecoveryGmailCaptureResult(complete)).toEqual(
      createRecoveryGmailCaptureResult(complete)
    );
  });
  it("binds a real same-account correction to its already captured ready parent", () => {
    const parsed = authenticateRecoveryGmailCaptureAdmission(
      input(fixture.currentAfterFirstCapture)
    );
    expect(parsed.correctionOfByMessageId).toEqual(
      fixture.correctionOfByMessageId
    );
    const receipt = state(fixture.sourceJournalOnly).intakeEvidence.find(
      (row) =>
        row.kind === "source" &&
        !state(fixture.checkpoint).intakeEvidence.some(
          (original) => original.id === row.id && original.kind === row.kind
        )
    )!;
    expect(
      JSON.parse(Buffer.from(receipt.bytes, "base64").toString("utf8"))
    ).toMatchObject({
      disposition: "ready",
      correctionOf: Object.values(fixture.correctionOfByMessageId)[0],
    });
    expect(
      proveRecoveryGmailCaptureDelta(input(fixture.currentAfterFirstCapture))
        .receipts[0]!.disposition
    ).toBe("ready");
  });
  it("can complete an already captured selected batch without replacing its observation", () => {
    const selected = createRecoveryGmailCaptureAdmission({
      ...admissionInput,
      batchId: fixture.completedBatchId,
      correctionOfByMessageId: undefined,
    });
    const report = proveRecoveryGmailCaptureDelta(
      input(fixture.checkpoint, selected)
    );
    expect(report.status).toBe("capture-complete");
    expect(report.receipts[0]!.firstObservedAtEpochMs).toBeLessThan(
      admissionInput.admittedAtEpochMs
    );
    expect(
      createRecoveryGmailCaptureResult(input(fixture.checkpoint, selected))
        .length
    ).toBeGreaterThan(0);
  });
  it("validates a second selected batch against original plus the completed first delta", () => {
    const first = {
      admission,
      result: createRecoveryGmailCaptureResult(
        input(fixture.currentAfterFirstCapture)
      ),
    };
    const second = createRecoveryGmailCaptureAdmission({
      ...admissionInput,
      batchId: fixture.batchIds[1],
      correctionOfByMessageId: undefined,
      admittedAtEpochMs: fixture.secondAdmittedAtEpochMs,
      priorCompleted: [first],
    });
    expect(
      authenticateRecoveryGmailCaptureAdmission(
        input(fixture.currentAfterCapture, second, [first])
      ).priorCompleted
    ).toEqual({
      count: 1,
      sha256: sha256(
        canonicalJson([
          {
            admissionSha256: sha256(first.admission),
            resultSha256: sha256(first.result),
          },
        ])
      ),
    });
    expect(
      proveRecoveryGmailCaptureDelta(
        input(fixture.currentAfterCapture, second, [first])
      )
    ).toMatchObject({ status: "capture-complete" });
    expect(
      createRecoveryGmailCaptureResult(
        input(fixture.currentAfterCapture, second, [first])
      ).length
    ).toBeGreaterThan(0);
    expect(() =>
      proveRecoveryGmailCaptureDelta(input(fixture.currentAfterCapture, second))
    ).toThrow();
    expect(() =>
      createRecoveryGmailCaptureAdmission({
        ...admissionInput,
        priorCompleted: [first],
      })
    ).toThrow();
    const damaged = { admission, result: Buffer.from(first.result) };
    damaged.result[damaged.result.length - 5] =
      damaged.result[damaged.result.length - 5]! ^ 1;
    expect(() =>
      proveRecoveryGmailCaptureDelta(
        input(fixture.currentAfterCapture, second, [damaged])
      )
    ).toThrow();
  });
  it("refuses unrelated second-batch effects under the first admission", () => {
    expect(() =>
      proveRecoveryGmailCaptureDelta(input(fixture.currentAfterCapture))
    ).toThrow();
  });
  it("refuses changed baseline bytes and arbitrary canonical-stage paths", () => {
    const current = structuredClone(fixture.currentAfterFirstCapture),
      file = current.files[0]!;
    file.bytes = Buffer.from("changed").toString("base64");
    file.sha256 = sha256(Buffer.from("changed"));
    expect(() => proveRecoveryGmailCaptureDelta(input(current))).toThrow();
    const stage = structuredClone(fixture.currentAfterFirstCapture),
      target = stage.files.find((file) => file.path.endsWith("message.eml"))!;
    stage.files.push({
      ...target,
      path: target.path + ".1.0123456789abcdef.tmp",
    });
    expect(() => proveRecoveryGmailCaptureDelta(input(stage))).toThrow();
  });
  it("refuses changed canonical bytes, missing originals, and unrelated directories", () => {
    const current = structuredClone(fixture.currentAfterFirstCapture),
      file = current.files.find(
        (file) =>
          file.path.endsWith("source.txt") &&
          !fixture.checkpoint.files.some(
            (original) => original.path === file.path
          )
      )!;
    file.bytes = Buffer.from("changed").toString("base64");
    file.sha256 = sha256(Buffer.from("changed"));
    expect(() => proveRecoveryGmailCaptureDelta(input(current))).toThrow();
    const missing = structuredClone(fixture.currentAfterFirstCapture);
    missing.files = missing.files.filter(
      (file) => file.path !== fixture.checkpoint.files[0]!.path
    );
    expect(() => proveRecoveryGmailCaptureDelta(input(missing))).toThrow();
    const directory = structuredClone(fixture.currentAfterFirstCapture);
    directory.directories.push({ area: "operator", path: "unrelated" });
    expect(() => proveRecoveryGmailCaptureDelta(input(directory))).toThrow();
  });
  it("requires exact own production bookkeeping and preserves all other ownership", () => {
    const current = fixture.currentAfterFirstCapture;
    expect(() =>
      proveRecoveryGmailCaptureDelta({
        ...input(current),
        ownProductionOwnership: undefined,
      })
    ).toThrow();
    const changed = changedJournal(current, (journal) => {
      journal.ownership.push({
        scope: "other",
        owner: "00000000-0000-0000-0000-000000000000",
        fence: 1,
        expiresAtEpochMs: 0,
      });
      journal.ownership.sort((a, b) => a.scope.localeCompare(b.scope));
    });
    expect(() => proveRecoveryGmailCaptureDelta(input(changed))).toThrow();
  });
  it("rejects substituted message identity, pre-intent observation, and new Monday capture", () => {
    for (const mutation of ["message", "observation", "monday"]) {
      const changed = changedJournal(fixture.sourceJournalOnly, (journal) => {
        const row = journal.intakeEvidence.find(
          (row) =>
            row.kind === "source" &&
            !state(fixture.checkpoint).intakeEvidence.some(
              (original) => original.id === row.id && original.kind === row.kind
            )
        )!;
        const receipt = JSON.parse(
          Buffer.from(row.bytes, "base64").toString("utf8")
        ) as { messageId: string; firstObservedAtEpochMs: number };
        if (mutation === "message") receipt.messageId = "bad";
        else if (mutation === "observation")
          receipt.firstObservedAtEpochMs = admissionInput.admittedAtEpochMs - 1;
        else
          receipt.firstObservedAtEpochMs = Date.parse(
            "2026-10-19T07:00:00.000Z"
          );
        const bytes = Buffer.from(canonicalJson(receipt) + "\n");
        row.bytes = bytes.toString("base64");
        row.identity = sha256(bytes);
      });
      expect(() => proveRecoveryGmailCaptureDelta(input(changed))).toThrow();
    }
  });
});

describe("full capture-family projection for selected-receipt loading", () => {
  function firstPair() {
    return {
      admission,
      result: createRecoveryGmailCaptureResult(
        input(fixture.currentAfterFirstCapture)
      ),
    };
  }
  function family(
    current: Inventory = fixture.checkpoint,
    completed: RecoveryGmailCaptureDeltaInput["priorCompleted"] = [],
    unfinishedAdmissions: Buffer[] = []
  ) {
    return {
      checkpoint: fixture.checkpoint,
      recoveryKey: fixture.recoveryKey,
      completed: completed!,
      unfinishedAdmissions,
      current,
    };
  }
  it("accepts the exact original family without granting load authority", () => {
    expect(proveRecoveryGmailCaptureFamily(family())).toMatchObject({
      completedCount: 0,
      unfinished: null,
      captureAllowed: false,
      loadAllowed: false,
      activationAllowed: false,
      physicalValidationRequired: true,
      projectedInventory: {
        files: fixture.checkpoint.files,
        directories: fixture.checkpoint.directories,
        journal: fixture.checkpoint.journal,
      },
    });
  });
  it("projects a completed prefix and all original batches into detached output", () => {
    const proof = proveRecoveryGmailCaptureFamily(
      family(fixture.currentAfterFirstCapture, [firstPair()])
    );
    expect(proof.completedCount).toBe(1);
    expect(proof.unfinished).toBeNull();
    expect(proof.projectedInventory.files).toEqual(
      fixture.currentAfterFirstCapture.files
    );
    const batches = (files: Inventory["files"]) =>
      files.filter((file) =>
        file.path.startsWith("email-acquisition/batches/")
      );
    expect(batches(proof.projectedInventory.files)).toEqual(
      batches(fixture.checkpoint.files)
    );
    const expected = structuredClone(fixture.currentAfterFirstCapture);
    proof.projectedInventory.files.length = 0;
    expect(fixture.currentAfterFirstCapture).toEqual(expected);
  });
  it("retains an authenticated journal-first unfinished tail without calling it completed", () => {
    const proof = proveRecoveryGmailCaptureFamily({
      ...family(fixture.sourceJournalOnly, [], [admission]),
      ownProductionOwnership: state(fixture.sourceJournalOnly).ownership.find(
        (r) => r.scope === production
      )!,
    });
    expect(proof.completedCount).toBe(0);
    expect(proof.unfinished).toMatchObject({ status: "capture-partial" });
    expect(proof.projectedInventory.journal).toBe(
      fixture.sourceJournalOnly.journal
    );
  });
  it("rejects an omitted completed pair or unfinished admission instead of adopting a new baseline", () => {
    expect(() =>
      proveRecoveryGmailCaptureFamily(family(fixture.currentAfterFirstCapture))
    ).toThrow();
    expect(() =>
      proveRecoveryGmailCaptureFamily(family(fixture.sourceJournalOnly))
    ).toThrow();
    expect(() =>
      proveRecoveryGmailCaptureFamily(
        family(fixture.currentAfterFirstCapture, [firstPair()], [admission])
      )
    ).toThrow();
  });
  it("validates every ordered predecessor and refuses corrupt, duplicate or reversed pairs", () => {
    const first = firstPair();
    const secondAdmission = createRecoveryGmailCaptureAdmission({
      ...admissionInput,
      batchId: fixture.batchIds[1],
      correctionOfByMessageId: undefined,
      admittedAtEpochMs: fixture.secondAdmittedAtEpochMs,
      priorCompleted: [first],
    });
    const second = {
      admission: secondAdmission,
      result: createRecoveryGmailCaptureResult(
        input(fixture.currentAfterCapture, secondAdmission, [first])
      ),
    };
    const args = family(fixture.currentAfterCapture, [first, second]);
    const proof = proveRecoveryGmailCaptureFamily(args);
    expect(Object.keys(proof.projectedInventory).sort()).toEqual([
      "directories",
      "files",
      "journal",
    ]);
    const unfinished = proveRecoveryGmailCaptureFamily({
      ...family(fixture.currentAfterCapture, [first], [secondAdmission]),
      ownProductionOwnership: state(fixture.currentAfterCapture).ownership.find(
        (row) => row.scope === production
      )!,
    });
    expect(unfinished.completedCount).toBe(1);
    expect(unfinished.unfinished?.status).toBe("capture-complete");
    expect(unfinished.familySha256).not.toBe(proof.familySha256);
    expect(proof.completedCount).toBe(2);
    expect(proof.familySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.familySha256).toBe(
      proveRecoveryGmailCaptureFamily(args).familySha256
    );
    for (const pairs of [[second, first], [first, first], [second]])
      expect(() =>
        proveRecoveryGmailCaptureFamily({ ...args, completed: pairs })
      ).toThrow();
    const corrupt = Buffer.from(second.result);
    corrupt[corrupt.length - 5] ^= 1;
    expect(() =>
      proveRecoveryGmailCaptureFamily({
        ...args,
        completed: [first, { ...second, result: corrupt }],
      })
    ).toThrow();
  });
  it("rejects unrelated journal and file changes after a valid completed prefix", () => {
    const args = family(fixture.currentAfterFirstCapture, [firstPair()]);
    expect(() =>
      proveRecoveryGmailCaptureFamily({
        ...args,
        current: changedJournal(args.current, (j) => {
          j.stageArtifacts = [];
          j.runState = [];
          j.intakeEvidence = [];
        }),
      })
    ).toThrow();
    const altered = structuredClone(args.current);
    altered.files[0]!.sha256 = "f".repeat(64);
    expect(() =>
      proveRecoveryGmailCaptureFamily({ ...args, current: altered })
    ).toThrow();
    expect(() =>
      proveRecoveryGmailCaptureFamily({
        ...args,
        unfinishedAdmissions: [admission, admission],
      })
    ).toThrow();
    expect(() =>
      proveRecoveryGmailCaptureFamily({
        ...args,
        ownProductionOwnership: state(args.current).ownership.find(
          (r) => r.scope === production
        )!,
      })
    ).toThrow();
  });
});
