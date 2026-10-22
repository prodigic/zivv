import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertOperatorInstallationWritable } from "./operator-installation.js";
import { canonicalJson } from "./sqlite-store.js";
import {
  loadBackupKey,
  secureOperatorDirectory,
  writeDurableFile,
} from "./encrypted-backup.js";
import { resolvePrivateCandidateDirectory } from "./private-artifacts.js";
import { parseReleaseCandidate } from "./release-candidate.js";
import { localDateStartEpochMs } from "./weekly.js";
import { createPublicationPayload } from "./publication-payload.js";
import {
  readPublicationPayloadGit,
  writePublicationPayloadGit,
} from "./publication-git.js";
import { verifyPublicationPayload } from "./publication-payload.js";
import { retainPublicationArtifact } from "./publication-artifact.js";
import {
  claimPromotion,
  createCompletionProof,
  parsePromotionControl,
  promotionDigest,
  serializePromotionControl,
} from "./promotion-control.js";
import type {
  PreparedPromotionControlAppend,
  PromotionControlStore,
  PromotionControlTransport,
} from "./promotion-control-git.js";
import {
  runPagesCandidateDispatch,
  verifyReviewedPagesWorkflowCommit,
} from "./pages-dispatch-runner.js";
import type { PagesTestTransport } from "./pages-deployment.js";
import {
  transitionWeeklyRun,
  type WeeklyRunState,
} from "./weekly-run-state.js";
import type { WeeklyRunJournal, WeeklyRunLease } from "./weekly-run-journal.js";

interface Plan {
  schemaVersion: 1;
  runId: string;
  candidateId: string;
  workflowCommit: string;
  payloadCommit: string;
  payloadReceiptId: string;
  createdAt: string;
  claim: {
    expectedHead: string;
    attemptedHead: string;
    bytes: string;
    createdAt: string;
  };
}
const same = (a: unknown, b: unknown, label: string) => {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(label);
};
function readRegular(path: string): Buffer {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 2_000_000
  )
    throw new Error("Unsafe publication evidence");
  return readFileSync(path);
}

export interface WeeklyPublicationOptions {
  store: PromotionControlStore;
  transport: PromotionControlTransport;
  candidate: Buffer;
  workflowCommit: string;
  githubToken: string;
  /** Offline workflow HTTP fixtures only; never exposed by the CLI. */
  testTransport?: PagesTestTransport;
}

/** Preparing an early edition does not authorize publication before Pacific Friday. */
export function assertWeeklyPublicationTime(
  editionId: string,
  now: number
): void {
  const midnight = localDateStartEpochMs(editionId);
  if (new Date(editionId + "T12:00:00Z").getUTCDay() !== 5)
    throw new Error("Publication requires a Friday edition");
  if (!Number.isSafeInteger(now) || now < midnight)
    throw new Error(
      "Weekly publication must wait until Friday Pacific midnight"
    );
}

/** Retain, claim and dispatch once; subsequent invocations reconcile that attempt. */
export async function ensureWeeklyPublication(
  input: WeeklyPublicationOptions & {
    root: string;
    operatorDirectory: string;
    state: WeeklyRunState;
    journal: WeeklyRunJournal;
    lease: WeeklyRunLease;
    controlledPublishing?: string;
    manualPublisherJoined?: string;
    verifyContext: () => void;
    heartbeatMs: number;
    onProgress: (
      stage: "deploy",
      phase: "started" | "artifact-saved" | "effect-committed"
    ) => Promise<void>;
  }
): Promise<{ state: WeeklyRunState; status: "pending" | "verified" }> {
  const verifyOriginalContext = input.verifyContext;
  input = {
    ...input,
    verifyContext: () => {
      assertOperatorInstallationWritable(input.operatorDirectory);
      verifyOriginalContext();
    },
  };
  input.verifyContext();
  if (
    input.controlledPublishing !== "enabled" ||
    input.manualPublisherJoined !== "true" ||
    !/^[a-f0-9]{40}$/.test(input.workflowCommit) ||
    !/^[A-Za-z0-9_-]+$/.test(input.githubToken) ||
    input.lease.scope !== "prodigic/zivv/production" ||
    input.store.ref !== "refs/heads/zivv-promotion-control/production" ||
    input.transport.repository !== "prodigic/zivv"
  )
    throw new Error("Weekly publication is not enabled");
  let state = input.journal.loadOwned(input.state.runId, input.lease);
  same(state, input.state, "Stale publication run");
  input.verifyContext();
  const candidate = parseReleaseCandidate(Buffer.from(input.candidate));
  assertWeeklyPublicationTime(candidate.editionId, Date.now());
  const validated = state.stages.find((s) => s.stage === "validate"),
    exported = state.stages.find((s) => s.stage === "export"),
    enriched = state.stages.find((s) => s.stage === "enrich");
  if (
    validated?.status !== "succeeded" ||
    exported?.status !== "succeeded" ||
    enriched?.status !== "succeeded"
  )
    throw new Error("Publication requires validated candidate stages");
  same(
    validated.evidence?.candidateId,
    candidate.candidateId,
    "Wrong candidate"
  );
  same(
    validated.evidence?.manifestSha256,
    candidate.manifestSha256,
    "Wrong manifest"
  );
  for (const field of Object.keys(exported.evidence!))
    if (field !== "snapshotRevision")
      same(
        exported.evidence![field],
        candidate[field as keyof typeof candidate],
        "Changed exported candidate"
      );
  same(
    exported.evidence?.snapshotRevision,
    candidate.ledgerRevision,
    "Changed exported snapshot revision"
  );
  const buildBytes = input.journal.readArtifact(
      state.runId,
      "enrich",
      enriched.attempt
    ),
    exportBytes = input.journal.readArtifact(
      state.runId,
      "export",
      exported.attempt
    );
  if (!buildBytes || !exportBytes)
    throw new Error("Missing candidate artifacts");
  const build = JSON.parse(buildBytes.toString("utf8")).build as {
    purpose: string;
    sourceCommit: string;
    basePath: string;
  };
  same(
    promotionDigest(build),
    enriched.evidence?.buildSha256,
    "Changed build context"
  );
  same(build.purpose, "release", "Release build required");
  same(build.sourceCommit, candidate.sourceCommit, "Changed build source");
  same(build.basePath, "/zivv/", "Production base required");
  const workDirectory = resolvePrivateCandidateDirectory(
    JSON.parse(exportBytes.toString("utf8")).workDirectory
  );
  const directories = readdirSync(workDirectory).filter((name) =>
    name.startsWith("candidate-")
  );
  if (directories.length !== 1) throw new Error("Ambiguous candidate bundle");
  const expected = {
    expectedCandidateId: candidate.candidateId,
    expectedSourceCommit: candidate.sourceCommit,
    purpose: "release" as const,
    basePath: "/zivv/",
  };
  const payload = await createPublicationPayload({
    ...expected,
    directory: join(workDirectory, directories[0]),
    recoveryKey: loadBackupKey(input.operatorDirectory),
  });
  if (!input.testTransport)
    verifyReviewedPagesWorkflowCommit(input.root, input.workflowCommit);
  input.verifyContext();
  const stage = state.stages.find((s) => s.stage === "deploy")!;
  if (stage.status === "succeeded") return { state, status: "verified" };
  if (stage.status !== "running") {
    state = input.journal.save(
      transitionWeeklyRun(
        state,
        state.revision,
        "deploy",
        { status: "running" },
        Date.now()
      ),
      state.revision,
      input.lease
    );
    await input.onProgress("deploy", "started");
  }
  const directory = resolvePrivateCandidateDirectory(
    join(input.operatorDirectory, "weekly-publication", state.runId)
  );
  secureOperatorDirectory(directory);
  const path = join(directory, "claim-plan.json");
  let heartbeatError: unknown;
  const timer = setInterval(() => {
    try {
      input.verifyContext();
    } catch (error) {
      heartbeatError = error;
    }
  }, input.heartbeatMs);
  timer.unref();
  const guard = () => {
    if (heartbeatError) throw heartbeatError;
    input.verifyContext();
  };
  try {
    return await input.journal.guardOperation(input.lease, async () => {
      guard();
      let plan: Plan;
      let recoveredClaim = false;
      if (existsSync(path)) {
        const bytes = readRegular(path);
        plan = JSON.parse(bytes.toString("utf8")) as Plan;
        same(
          bytes.toString("utf8"),
          canonicalJson(plan) + "\n",
          "Noncanonical publication plan"
        );
      } else {
        const current = input.store.read();
        if (!current.head || !current.bytes)
          throw new Error("Native bootstrap required");
        const control = parsePromotionControl(current.bytes);
        // A restored private checkpoint may predate an accepted native claim.
        // Recover its original bytes before preparing any new remote effect.
        if (!input.store.readCanonicalHistory)
          throw new Error("Canonical history is required for claim recovery");
        const history = input.store.readCanonicalHistory({
          maxCommits: 1000,
          maxBytes: 16 * 1024 * 1024,
        });
        if (!history.complete)
          throw new Error("Publication claim recovery history is incomplete");
        const matches = history.commits.filter((record) => {
          const event = parsePromotionControl(record.bytes).lastTransition
            .event;
          return (
            event.type === "claim" && event.request.requestId === state.runId
          );
        });
        if (matches.length > 1)
          throw new Error("Canonical publication claim is ambiguous");
        if (matches.length === 1) {
          const record = matches[0],
            claimed = parsePromotionControl(record.bytes),
            event = claimed.lastTransition.event;
          if (
            event.type !== "claim" ||
            !record.parentHead ||
            !record.parentBytes
          )
            throw new Error("Canonical publication claim lacks its parent");
          const request = event.request;
          same(
            request.candidateId,
            candidate.candidateId,
            "Recovered claim candidate changed"
          );
          same(
            request.sourceCommit,
            candidate.sourceCommit,
            "Recovered claim source changed"
          );
          same(request.basePath, "/zivv/", "Recovered claim base changed");
          same(request.purpose, "release", "Recovered claim purpose changed");
          same(
            request.publicInventorySha256,
            promotionDigest(candidate.files),
            "Recovered claim inventory changed"
          );
          const operationId = claimed.active?.operationId;
          if (!operationId) throw new Error("Recovered claim has no owner");
          for (const item of history.commits) {
            const transition = parsePromotionControl(item.bytes).lastTransition
              .event;
            if (
              transition.type === "dispatch-intent" &&
              transition.operationId === operationId &&
              transition.mode === "promote"
            )
              same(
                transition.workflowCommit,
                input.workflowCommit,
                "Recovered publisher workflow changed"
              );
          }
          const ref =
            "refs/heads/zivv-candidate-artifacts/" + request.payloadCommit;
          same(
            input.transport.readHead(ref),
            request.payloadCommit,
            "Recovered publication artifact is missing or changed"
          );
          input.transport.fetchCommit(request.payloadCommit);
          const retained = verifyPublicationPayload(
            readPublicationPayloadGit({
              repositoryRoot: input.root,
              payloadCommit: request.payloadCommit,
            }).files,
            expected
          );
          same(
            retained.receipt.receiptId,
            payload.receipt.receiptId,
            "Recovered publication payload changed"
          );
          const prepared = input.store.prepareAppend({
            expectedHead: record.parentHead,
            bytes: record.bytes,
            createdAt: record.createdAt,
          });
          same(
            prepared.attemptedHead,
            record.head,
            "Recovered claim commit changed"
          );
          plan = {
            schemaVersion: 1,
            runId: state.runId,
            candidateId: candidate.candidateId,
            workflowCommit: input.workflowCommit,
            payloadCommit: request.payloadCommit,
            payloadReceiptId: retained.receipt.receiptId,
            createdAt: record.createdAt,
            claim: {
              ...prepared,
              expectedHead: record.parentHead,
              bytes: prepared.bytes.toString("base64"),
            },
          };
          recoveredClaim = true;
        } else {
          if (control.active?.request.requestId === state.runId)
            throw new Error("Canonical publication claim is missing");
          const createdAt = new Date().toISOString();
          const stored = writePublicationPayloadGit({
            repositoryRoot: input.root,
            files: payload.files,
            createdAt,
          });
          const request = {
            requestId: state.runId,
            payloadCommit: stored.payloadCommit,
            candidateId: candidate.candidateId,
            sourceCommit: candidate.sourceCommit,
            basePath: "/zivv/",
            purpose: "release" as const,
            publicInventorySha256: promotionDigest(candidate.files),
            expectedVerifiedReleaseId: control.lastVerified.releaseId,
          };
          const claimed = claimPromotion(
            control,
            request,
            createCompletionProof(
              control.completionRoot,
              request.requestId,
              (id, type) =>
                input.store.readCompletionObject(current.head!, id, type)
            )
          );
          const prepared = input.store.prepareAppend({
            expectedHead: current.head,
            bytes: serializePromotionControl(claimed),
            createdAt,
          });
          plan = {
            schemaVersion: 1,
            runId: state.runId,
            candidateId: candidate.candidateId,
            workflowCommit: input.workflowCommit,
            payloadCommit: stored.payloadCommit,
            payloadReceiptId: payload.receipt.receiptId,
            createdAt,
            claim: {
              ...prepared,
              expectedHead: current.head,
              bytes: prepared.bytes.toString("base64"),
            },
          };
        }
        guard();
        writeDurableFile(path, Buffer.from(canonicalJson(plan) + "\n"));
        await input.onProgress("deploy", "artifact-saved");
      }
      same(
        Object.keys(plan).sort(),
        [
          "schemaVersion",
          "runId",
          "candidateId",
          "workflowCommit",
          "payloadCommit",
          "payloadReceiptId",
          "createdAt",
          "claim",
        ].sort(),
        "Invalid publication plan fields"
      );
      same(plan.schemaVersion, 1, "Invalid publication plan schema");
      same(plan.runId, state.runId, "Wrong publication run");
      same(
        plan.candidateId,
        candidate.candidateId,
        "Wrong publication candidate"
      );
      same(
        plan.workflowCommit,
        input.workflowCommit,
        "Changed publisher workflow"
      );
      same(
        plan.payloadReceiptId,
        payload.receipt.receiptId,
        "Changed publication payload"
      );
      const actual = writePublicationPayloadGit({
        repositoryRoot: input.root,
        files: payload.files,
        createdAt: plan.createdAt,
      });
      same(actual.payloadCommit, plan.payloadCommit, "Changed payload commit");
      same(
        Object.keys(plan.claim).sort(),
        ["expectedHead", "attemptedHead", "bytes", "createdAt"].sort(),
        "Invalid claim fields"
      );
      same(plan.claim.createdAt, plan.createdAt, "Changed claim timestamp");
      const before = input.store.readAt(plan.claim.expectedHead);
      if (!before.bytes) throw new Error("Missing prior controller");
      const control = parsePromotionControl(before.bytes);
      const claimed = claimPromotion(
        control,
        {
          requestId: state.runId,
          payloadCommit: actual.payloadCommit,
          candidateId: candidate.candidateId,
          sourceCommit: candidate.sourceCommit,
          basePath: "/zivv/",
          purpose: "release",
          publicInventorySha256: promotionDigest(candidate.files),
          expectedVerifiedReleaseId: control.lastVerified.releaseId,
        },
        createCompletionProof(control.completionRoot, state.runId, (id, type) =>
          input.store.readCompletionObject(before.head!, id, type)
        )
      );
      const prepared: PreparedPromotionControlAppend =
        input.store.prepareAppend({
          expectedHead: before.head,
          bytes: serializePromotionControl(claimed),
          createdAt: plan.createdAt,
        });
      same(
        { ...prepared, bytes: prepared.bytes.toString("base64") },
        plan.claim,
        "Changed prepared claim"
      );
      guard();
      let current = input.store.read();
      // Even a later retry of a reconstructed plan must not recreate a lost
      // artifact ref after its original claim has already been accepted.
      const acceptedClaim = current.head !== prepared.expectedHead;
      if (acceptedClaim) {
        const owner =
          current.bytes && parsePromotionControl(current.bytes).active;
        if (!owner || owner.operationId !== claimed.active!.operationId)
          throw new Error("Publication claim requires reconciliation");
        same(
          input.store.readAt(prepared.attemptedHead).bytes?.toString("base64"),
          prepared.bytes.toString("base64"),
          "Unproven native claim"
        );
        same(
          input.transport.readHead(
            "refs/heads/zivv-candidate-artifacts/" + actual.payloadCommit
          ),
          actual.payloadCommit,
          "Accepted publication artifact is missing or changed"
        );
        input.transport.fetchCommit(actual.payloadCommit);
        const retainedPayload = verifyPublicationPayload(
          readPublicationPayloadGit({
            repositoryRoot: input.root,
            payloadCommit: actual.payloadCommit,
          }).files,
          expected
        );
        same(
          retainedPayload.receipt.receiptId,
          plan.payloadReceiptId,
          "Accepted publication payload changed"
        );
      }
      const retained =
        recoveredClaim || acceptedClaim
          ? { status: "retained" }
          : retainPublicationArtifact({
              ...expected,
              repositoryRoot: input.root,
              payloadCommit: actual.payloadCommit,
              transport: input.transport,
            });
      if (retained.status !== "retained")
        return { state, status: "pending" as const };
      guard();
      current = input.store.read();
      if (current.head === prepared.expectedHead) {
        input.store.compareAndAppend(prepared);
        guard();
        current = input.store.read();
      }
      if (!current.head || !current.bytes)
        throw new Error("Missing claim readback");
      const active = parsePromotionControl(current.bytes).active;
      if (active?.operationId !== claimed.active!.operationId)
        throw new Error("Publication claim requires reconciliation");
      same(
        input.store.readAt(prepared.attemptedHead).bytes?.toString("base64"),
        prepared.bytes.toString("base64"),
        "Unproven native claim"
      );
      if (active.phase === "verified")
        return { state, status: "verified" as const };
      guard();
      const recovery =
        active.promotionAttempt &&
        !existsSync(join(directory, "dispatch/pages-dispatch.json"))
          ? {
              operationId: active.operationId,
              attemptId: active.promotionAttempt.attemptId,
            }
          : undefined;
      const result = await runPagesCandidateDispatch({
        command: recovery ? "recover" : "dispatch",
        repositoryRoot: input.root,
        workflowCommit: input.workflowCommit,
        mode: "promote",
        intentDirectory: join(directory, "dispatch"),
        githubToken: input.githubToken,
        store: input.store,
        controlledPublishing: input.controlledPublishing,
        manualPublisherJoined: input.manualPublisherJoined,
        testTransport: input.testTransport,
        checkContext: guard,
        recovery,
      });
      guard();
      if (["dispatched", "matched"].includes(result.status))
        await input.onProgress("deploy", "effect-committed");
      return { state, status: "pending" as const };
    });
  } finally {
    clearInterval(timer);
  }
}
