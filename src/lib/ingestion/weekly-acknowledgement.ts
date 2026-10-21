import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { writeDurableFile } from "./encrypted-backup.js";
import { withIngestionLock } from "./lock.js";
import { parseReleaseCandidate } from "./release-candidate.js";
import {
  markWeeklyEditionPublished,
  parseWeeklyEditionLedger,
  serializeWeeklyEditionLedger,
} from "./weekly.js";
import {
  applyPromotionTransition,
  createCompletionProof,
  parsePromotionControl,
  promotionDigest,
  serializePromotionControl,
  verifyCompletionProof,
  type PromotionControl,
} from "./promotion-control.js";
import type {
  PreparedPromotionControlAppend,
  PromotionControlStore,
} from "./promotion-control-git.js";
import type { WeeklyRunJournal, WeeklyRunLease } from "./weekly-run-journal.js";
import {
  transitionWeeklyRun,
  type StageEvidence,
  type WeeklyRunState,
} from "./weekly-run-state.js";

interface Intent {
  schemaVersion: 1;
  runId: string;
  operationId: string;
  requestId: string;
  candidateId: string;
  verificationReceiptId: string;
  before: string;
  after: string;
  createdAt: string;
}
interface SavedAppend {
  expectedHead: string;
  attemptedHead: string;
  bytes: string;
  createdAt: string;
}
interface Artifact {
  intent: Intent;
  intentAppend: SavedAppend;
  completionAppend: SavedAppend;
}
const same = (a: unknown, b: unknown, label: string) => {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(label);
};
function readWeekly(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("Unsafe weekly state file");
  return readFileSync(path);
}
function decode(value: string): Buffer {
  if (typeof value !== "string") throw new Error("Invalid retained bytes");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error("Invalid retained byte encoding");
  return bytes;
}
function saveAppend(value: PreparedPromotionControlAppend): SavedAppend {
  if (!value.expectedHead)
    throw new Error("Acknowledgement needs existing owner");
  return {
    ...value,
    expectedHead: value.expectedHead,
    bytes: value.bytes.toString("base64"),
  };
}

/**
 * Acknowledge an already journaled, natively verified release. This executes only
 * acknowledgement: it never imports, builds, deploys, sends mail or activates a
 * publisher. The delivery adapter must first journal exact deployment/verification
 * evidence and provide its normal physical-store/runtime context guard.
 */
export async function acknowledgeVerifiedWeeklyRelease(input: {
  root: string;
  state: WeeklyRunState;
  journal: WeeklyRunJournal;
  lease: WeeklyRunLease;
  store: PromotionControlStore;
  candidate: Buffer;
  verifyContext: () => void;
  onProgress?: (
    phase:
      | "intent-saved"
      | "intent-bound"
      | "cutoff-written"
      | "remote-completed"
  ) => Promise<void>;
}): Promise<WeeklyRunState> {
  if (input.lease.scope !== "prodigic/zivv/production")
    throw new Error("Acknowledgement requires production journal ownership");
  same(
    input.store.ref,
    "refs/heads/zivv-promotion-control/production",
    "Wrong production control ref"
  );
  let state = input.journal.loadOwned(input.state.runId, input.lease);
  same(state, input.state, "Stale acknowledgement run");
  input.verifyContext();
  const candidate = parseReleaseCandidate(input.candidate);
  if (candidate.applicationProvenanceSha256 === null)
    throw new Error("Acknowledgement requires reviewed build provenance");
  const evidence = (stage: string) => {
    const item = state.stages.find((s) => s.stage === stage);
    if (item?.status !== "succeeded" || !item.evidence)
      throw new Error(`Acknowledgement requires completed ${stage}`);
    return item.evidence;
  };
  const exported = evidence("export");
  evidence("validate");
  const verified = evidence("verify");
  const frozen = evidence("freeze");
  for (const key of [
    "candidateId",
    "editionId",
    "cutoffEpochMs",
    "membershipSha256",
    "datasetVersion",
    "manifestSha256",
    "ledgerRevision",
    "configSha256",
  ] as const)
    same(
      candidate[key],
      exported[key],
      `Acknowledgement candidate ${key} changed`
    );
  same(
    candidate.basePath,
    "/zivv/",
    "Acknowledgement requires release candidate"
  );
  same(verified.destination, "production", "Wrong verified destination");
  const weeklyPath = join(input.root, "data/ingestion/weekly-editions.json");
  const readControl = () => {
    const record = input.store.read();
    if (!record.head || !record.bytes)
      throw new Error("Missing native control");
    const control = parsePromotionControl(record.bytes);
    same(control.destination, "production", "Wrong native destination");
    return { head: record.head, control };
  };
  const requireVerified = (control: PromotionControl) => {
    const op = control.active;
    if (!op || op.phase !== "verified" || !op.verification)
      throw new Error("Current verified release owner required");
    same(
      op.request.candidateId,
      candidate.candidateId,
      "Wrong native candidate"
    );
    same(
      op.request.sourceCommit,
      candidate.sourceCommit,
      "Wrong native source"
    );
    same(
      op.request.publicInventorySha256,
      promotionDigest(candidate.files),
      "Wrong native public inventory"
    );
    same(
      op.verification.deployment.deploymentId,
      verified.deploymentId,
      "Wrong native deployment"
    );
    return op;
  };
  const transition = (evidence: StageEvidence | null) => {
    state = input.journal.save(
      transitionWeeklyRun(
        state,
        state.revision,
        "acknowledge",
        evidence ? { status: "succeeded", evidence } : { status: "running" },
        Date.now()
      ),
      state.revision,
      input.lease
    );
  };
  let item = state.stages.find((s) => s.stage === "acknowledge")!;
  if (!["running", "succeeded"].includes(item.status)) transition(null);
  item = state.stages.find((s) => s.stage === "acknowledge")!;
  let bytes = input.journal.readArtifact(
    state.runId,
    "acknowledge",
    item.attempt
  );
  if (!bytes && item.status !== "succeeded") {
    const current = readControl(),
      active = current.control.active;
    const needsRecovery =
      !active ||
      active.phase !== "verified" ||
      active.request.candidateId !== candidate.candidateId ||
      active.request.sourceCommit !== candidate.sourceCommit ||
      active.verification?.deployment.deploymentId !== verified.deploymentId ||
      !!active.acknowledgementIntent;
    if (needsRecovery) {
      if (!input.store.readCanonicalHistory)
        throw new Error(
          "Missing private acknowledgement intent; canonical history is required"
        );
      const history = input.store.readCanonicalHistory({
        maxCommits: 1000,
        maxBytes: 16 * 1024 * 1024,
      });
      if (!history.complete)
        throw new Error("Acknowledgement recovery history is incomplete");
      const matches = history.commits.filter((record) => {
        const control = parsePromotionControl(record.bytes),
          event = control.lastTransition.event;
        if (event.type !== "acknowledgement-intent") return false;
        const operation = control.active;
        return (
          operation?.operationId === event.operationId &&
          operation.request.candidateId === candidate.candidateId &&
          operation.request.sourceCommit === candidate.sourceCommit &&
          operation.verification?.deployment.deploymentId ===
            verified.deploymentId
        );
      });
      if (
        matches.length === 0 &&
        current.control.active &&
        current.control.active.phase !== "verified"
      )
        throw new Error("Current verified release owner required");
      if (matches.length !== 1)
        throw new Error(
          "Canonical acknowledgement intent is missing or ambiguous"
        );
      const record = matches[0],
        bound = parsePromotionControl(record.bytes),
        event = bound.lastTransition.event;
      if (
        event.type !== "acknowledgement-intent" ||
        !record.parentHead ||
        !record.parentBytes
      )
        throw new Error("Canonical acknowledgement lacks its parent");
      const parent = parsePromotionControl(record.parentBytes),
        operation = requireVerified(parent);
      same(
        operation.operationId,
        event.operationId,
        "Recovered acknowledgement owner changed"
      );
      same(
        operation.verification!.receiptId,
        event.verificationReceiptId,
        "Recovered acknowledgement verification changed"
      );
      const enriched = state.stages.find((stage) => stage.stage === "enrich")!;
      const retained = input.journal.readArtifact(
        state.runId,
        "enrich",
        enriched.attempt
      );
      if (!retained)
        throw new Error(
          "Missing sealed weekly preimage for acknowledgement recovery"
        );
      const configuration = JSON.parse(retained.toString("utf8")) as {
        configuration?: Record<string, unknown>;
      };
      const encoded =
        configuration.configuration?.["ingestion/weekly-editions.json"];
      if (typeof encoded !== "string")
        throw new Error(
          "Missing sealed weekly preimage for acknowledgement recovery"
        );
      const before = decode(encoded);
      same(
        sha256(before),
        candidate.configuration.find(
          (file) => file.path === "ingestion/weekly-editions.json"
        )?.sha256,
        "Recovered weekly preimage differs from sealed configuration"
      );
      const weekly = parseWeeklyEditionLedger(
        JSON.parse(before.toString("utf8"))
      );
      const after = Buffer.from(
        serializeWeeklyEditionLedger(
          markWeeklyEditionPublished(weekly, candidate.editionId).ledger
        )
      );
      const intent: Intent = {
        schemaVersion: 1,
        runId: state.runId,
        operationId: operation.operationId,
        requestId: operation.request.requestId,
        candidateId: candidate.candidateId,
        verificationReceiptId: operation.verification!.receiptId,
        before: before.toString("base64"),
        after: after.toString("base64"),
        createdAt: record.createdAt,
      };
      same(
        sha256(canonicalJson(intent)),
        event.acknowledgementId,
        "Recovered acknowledgement digest differs from canonical intent"
      );
      same(
        serializePromotionControl(
          applyPromotionTransition(parent, event)
        ).toString("base64"),
        record.bytes.toString("base64"),
        "Recovered acknowledgement transition changed"
      );
      const intentAppend = input.store.prepareAppend({
        expectedHead: record.parentHead,
        bytes: record.bytes,
        createdAt: record.createdAt,
      });
      same(
        intentAppend.attemptedHead,
        record.head,
        "Recovered acknowledgement commit changed"
      );
      const completed = applyPromotionTransition(bound, {
        type: "acknowledged",
        operationId: intent.operationId,
        verificationReceiptId: intent.verificationReceiptId,
        acknowledgementId: event.acknowledgementId,
        replayProof: null,
      });
      const completionAppend = input.store.prepareAppend({
        expectedHead: record.head,
        bytes: serializePromotionControl(completed),
        createdAt: record.createdAt,
      });
      bytes = Buffer.from(
        canonicalJson({
          intent,
          intentAppend: saveAppend(intentAppend),
          completionAppend: saveAppend(completionAppend),
        }) + "\n"
      );
      input.verifyContext();
      input.journal.writeArtifact(
        state.runId,
        "acknowledge",
        bytes,
        input.lease
      );
      await input.onProgress?.("intent-saved");
    }
  }
  if (!bytes) {
    if (item.status === "succeeded")
      throw new Error("Missing completed acknowledgement intent");
    const current = readControl();
    const operation = requireVerified(current.control);
    if (operation.acknowledgementIntent)
      throw new Error("Missing private acknowledgement intent");
    let before!: Buffer;
    let after!: Buffer;
    await input.journal.guardOperation(input.lease, () =>
      withIngestionLock(input.root, async () => {
        input.verifyContext();
        before = readWeekly(weeklyPath);
        same(
          sha256(before),
          candidate.configuration.find(
            (file) => file.path === "ingestion/weekly-editions.json"
          )?.sha256,
          "Acknowledgement weekly state differs from sealed configuration"
        );
        const weekly = parseWeeklyEditionLedger(
          JSON.parse(before.toString("utf8"))
        );
        const target = weekly.editions.find(
          (e) => e.editionId === candidate.editionId
        );
        if (!target) throw new Error("Exact frozen edition required");
        same(target.endEpochMs, candidate.cutoffEpochMs, "Wrong weekly cutoff");
        same(
          sha256(canonicalJson(target.eventIds)),
          candidate.membershipSha256,
          "Wrong weekly membership"
        );
        after = Buffer.from(
          serializeWeeklyEditionLedger(
            markWeeklyEditionPublished(weekly, candidate.editionId).ledger
          )
        );
      })
    );
    const intent: Intent = {
      schemaVersion: 1,
      runId: state.runId,
      operationId: operation.operationId,
      requestId: operation.request.requestId,
      candidateId: candidate.candidateId,
      verificationReceiptId: operation.verification!.receiptId,
      before: before.toString("base64"),
      after: after.toString("base64"),
      createdAt: new Date().toISOString(),
    };
    const acknowledgementId = sha256(canonicalJson(intent));
    const bound = applyPromotionTransition(current.control, {
      type: "acknowledgement-intent",
      operationId: intent.operationId,
      verificationReceiptId: intent.verificationReceiptId,
      acknowledgementId,
    });
    const intentAppend = input.store.prepareAppend({
      expectedHead: current.head,
      bytes: serializePromotionControl(bound),
      createdAt: intent.createdAt,
    });
    const completed = applyPromotionTransition(bound, {
      type: "acknowledged",
      operationId: intent.operationId,
      verificationReceiptId: intent.verificationReceiptId,
      acknowledgementId,
      replayProof: null,
    });
    const completionAppend = input.store.prepareAppend({
      expectedHead: intentAppend.attemptedHead,
      bytes: serializePromotionControl(completed),
      createdAt: intent.createdAt,
    });
    bytes = Buffer.from(
      canonicalJson({
        intent,
        intentAppend: saveAppend(intentAppend),
        completionAppend: saveAppend(completionAppend),
      }) + "\n"
    );
    input.journal.writeArtifact(state.runId, "acknowledge", bytes, input.lease);
    await input.onProgress?.("intent-saved");
  }
  const artifact = JSON.parse(bytes.toString("utf8")) as Artifact;
  same(
    Buffer.from(canonicalJson(artifact) + "\n").toString("base64"),
    bytes.toString("base64"),
    "Noncanonical acknowledgement artifact"
  );
  const { intent } = artifact;
  same(
    Object.keys(intent).sort(),
    [
      "schemaVersion",
      "runId",
      "operationId",
      "requestId",
      "candidateId",
      "verificationReceiptId",
      "before",
      "after",
      "createdAt",
    ].sort(),
    "Invalid acknowledgement intent fields"
  );
  const acknowledgementId = sha256(canonicalJson(intent));
  same(intent.schemaVersion, 1, "Invalid acknowledgement schema");
  same(intent.runId, state.runId, "Wrong acknowledgement run");
  same(
    intent.candidateId,
    candidate.candidateId,
    "Wrong acknowledgement candidate"
  );
  const before = decode(intent.before),
    after = decode(intent.after);
  same(
    sha256(before),
    candidate.configuration.find(
      (file) => file.path === "ingestion/weekly-editions.json"
    )?.sha256,
    "Acknowledgement weekly state differs from sealed configuration"
  );
  const beforeWeekly = parseWeeklyEditionLedger(
    JSON.parse(before.toString("utf8"))
  );
  same(
    Buffer.from(
      serializeWeeklyEditionLedger(
        markWeeklyEditionPublished(beforeWeekly, candidate.editionId).ledger
      )
    ).toString("base64"),
    intent.after,
    "Invalid acknowledgement mutation"
  );
  const beforeTarget = beforeWeekly.editions.find(
    (e) => e.editionId === candidate.editionId
  )!;
  same(
    beforeTarget.endEpochMs,
    candidate.cutoffEpochMs,
    "Changed intent cutoff"
  );
  same(
    sha256(canonicalJson(beforeTarget.eventIds)),
    candidate.membershipSha256,
    "Changed intent membership"
  );
  const prepared = (saved: SavedAppend) => {
    const value = input.store.prepareAppend({
      ...saved,
      bytes: decode(saved.bytes),
    });
    same(saveAppend(value), saved, "Changed prepared acknowledgement append");
    return value;
  };
  const intentAppend = prepared(artifact.intentAppend);
  const completionAppend = prepared(artifact.completionAppend);
  same(
    completionAppend.expectedHead,
    intentAppend.attemptedHead,
    "Broken acknowledgement append chain"
  );
  const bound = parsePromotionControl(intentAppend.bytes);
  const operation = requireVerified(bound);
  same(operation.operationId, intent.operationId, "Changed intent operation");
  same(operation.request.requestId, intent.requestId, "Changed intent request");
  same(
    operation.acknowledgementIntent,
    { verificationReceiptId: intent.verificationReceiptId, acknowledgementId },
    "Changed native acknowledgement binding"
  );
  const isCompleted = (current: ReturnType<typeof readControl>) => {
    const proof = createCompletionProof(
      current.control.completionRoot,
      intent.requestId,
      (hash, type) => input.store.readCompletionObject(current.head, hash, type)
    );
    const record = verifyCompletionProof(
      current.control.completionRoot,
      intent.requestId,
      proof
    );
    if (!record) return false;
    same(record.outcome, "acknowledged", "Release was rolled back");
    same(record.operationId, intent.operationId, "Wrong completion owner");
    same(
      record.acknowledgementId,
      acknowledgementId,
      "Wrong completion acknowledgement"
    );
    same(
      record.verification.receiptId,
      intent.verificationReceiptId,
      "Wrong completion verification"
    );
    return true;
  };
  const append = (value: PreparedPromotionControlAppend) => {
    const current = readControl();
    if (current.head === value.attemptedHead) return;
    if (current.head !== value.expectedHead)
      throw new Error("Acknowledgement control changed");
    const result = input.store.compareAndAppend({
      ...value,
      checkContext: input.verifyContext,
    });
    if (result.status !== "appended") {
      const readback = input.store.readback(value);
      if (readback.status !== "appended")
        throw new Error("Acknowledgement append requires recovery");
    }
  };
  let remoteCompleted = isCompleted(readControl());
  if (!remoteCompleted) {
    append(intentAppend);
    await input.onProgress?.("intent-bound");
    await input.journal.guardOperation(input.lease, () =>
      withIngestionLock(input.root, async () => {
        input.verifyContext();
        const current = readControl();
        same(
          current.head,
          intentAppend.attemptedHead,
          "Acknowledgement lost native owner"
        );
        const actual = readWeekly(weeklyPath);
        if (!actual.equals(after)) {
          if (!actual.equals(before))
            throw new Error("Weekly state changed before acknowledgement");
          writeDurableFile(weeklyPath, after);
        }
        same(
          readWeekly(weeklyPath).toString("base64"),
          intent.after,
          "Weekly acknowledgement readback changed"
        );
        input.verifyContext();
      })
    );
    await input.onProgress?.("cutoff-written");
    await input.journal.guardOperation(input.lease, () =>
      withIngestionLock(input.root, async () => {
        input.verifyContext();
        same(
          readWeekly(weeklyPath).toString("base64"),
          intent.after,
          "Weekly state changed before remote acknowledgement"
        );
        append(completionAppend);
        remoteCompleted = isCompleted(readControl());
      })
    );
    if (!remoteCompleted)
      throw new Error("Missing acknowledgement completion proof");
    await input.onProgress?.("remote-completed");
  } else {
    // A newer native completion can survive loss of the private weekly write.
    // Only the exact original preimage may be repaired; later legitimate weekly
    // state with an already-published matching target is retained byte-for-byte.
    await input.journal.guardOperation(input.lease, () =>
      withIngestionLock(input.root, async () => {
        input.verifyContext();
        if (!isCompleted(readControl()))
          throw new Error("Acknowledgement completion authority changed");
        const actual = readWeekly(weeklyPath);
        if (actual.equals(before) && !actual.equals(after))
          writeDurableFile(weeklyPath, after);
        else {
          const current = parseWeeklyEditionLedger(
              JSON.parse(actual.toString("utf8"))
            ),
            expected = parseWeeklyEditionLedger(
              JSON.parse(after.toString("utf8"))
            );
          same(
            current.editions.find(
              (edition) => edition.editionId === candidate.editionId
            ),
            expected.editions.find(
              (edition) => edition.editionId === candidate.editionId
            ),
            "Completed weekly edition changed"
          );
        }
        input.verifyContext();
      })
    );
  }
  const currentWeekly = parseWeeklyEditionLedger(
    JSON.parse(readWeekly(weeklyPath).toString("utf8"))
  );
  const expectedTarget = parseWeeklyEditionLedger(
    JSON.parse(after.toString("utf8"))
  ).editions.find((e) => e.editionId === candidate.editionId);
  same(
    currentWeekly.editions.find((e) => e.editionId === candidate.editionId),
    expectedTarget,
    "Completed weekly edition changed"
  );
  input.verifyContext();
  const receipt: StageEvidence = {
    candidateId: candidate.candidateId,
    editionId: candidate.editionId,
    cutoffEpochMs: candidate.cutoffEpochMs,
    acknowledgementId,
    verificationReceiptId: intent.verificationReceiptId,
    operationId: intent.operationId,
    controlHead: completionAppend.attemptedHead,
  };
  same(frozen.editionId, receipt.editionId, "Wrong frozen acknowledgement");
  if (item.status === "succeeded")
    same(item.evidence, receipt, "Changed acknowledgement receipt");
  else transition(receipt);
  return state;
}
