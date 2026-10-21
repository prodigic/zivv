import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  candidatePublicReleaseId,
  parsePromotionControl,
  promotionDigest,
  PROMOTION_DESTINATIONS,
} from "../../../lib/ingestion/promotion-control.js";
import { runWeeklyImport } from "../../../lib/ingestion/weekly-import-runner.js";
import type { WeeklyRunStage } from "../../../lib/ingestion/weekly-run-state.js";
import { PROMOTION_FIXTURE_CHECKS } from "./promotion-control-fixture.js";
import { createRecoveryDispatchFixture } from "./recovery-dispatch-fixture.js";

const retainedStages: WeeklyRunStage[] = [
  "acquire",
  "prepare",
  "reconcile",
  "load",
  "freeze",
  "enrich",
  "export",
  "validate",
  "deploy",
  "verify",
];

function artifactBytes(databasePath: string, runId: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT stage, attempt, bytes FROM stage_artifact WHERE run_id=? ORDER BY stage, attempt"
      )
      .all(runId) as { stage: string; attempt: number; bytes: Uint8Array }[];
    return rows
      .filter((row) => retainedStages.includes(row.stage as WeeklyRunStage))
      .map(({ stage, attempt, bytes }) => ({
        stage,
        attempt,
        bytes: Buffer.from(bytes).toString("base64"),
      }));
  } finally {
    db.close();
  }
}

function acknowledgementArtifactBytes(databasePath: string, runId: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT bytes FROM stage_artifact WHERE run_id=? AND stage='acknowledge' ORDER BY attempt DESC LIMIT 1"
      )
      .get(runId) as { bytes: Uint8Array } | undefined;
    return row ? Buffer.from(row.bytes).toString("base64") : undefined;
  } finally {
    db.close();
  }
}

function git(directory: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    windowsHide: true,
    stdio: "pipe",
    maxBuffer: 8 * 1024 * 1024,
  })
    .toString()
    .trim();
}

/** A real verified run retired after delivery verification and before acknowledgement. */
export async function createRecoveryVerifiedFixture() {
  let workflowCommit = "";
  let originalCandidateBytes = Buffer.alloc(0);
  let initialArtifactBytes: ReturnType<typeof artifactBytes> = [];
  const dispatch = await createRecoveryDispatchFixture({
    async afterAccepted(
      context,
      state,
      candidateBytes,
      reviewedWorkflowCommit,
      saved
    ) {
      workflowCommit = reviewedWorkflowCommit;
      originalCandidateBytes = Buffer.from(candidateBytes);
      const control = parsePromotionControl(
        context.authority.store.read().bytes!
      );
      const active = control.active;
      if (!active) throw new Error("Accepted dispatch has no active promotion");
      const owner = {
        operationId: saved.intent.inputs.operation_id,
        mode: saved.intent.inputs.mode,
        attemptId: saved.intent.inputs.attempt_id,
      };
      if (active.operationId !== owner.operationId)
        throw new Error("Accepted dispatch and promotion owner differ");
      const admission = {
        workflowCommit,
        runId: "101",
        runAttempt: 1,
      };
      context.authority.step({ type: "admit-run", ...owner, admission });
      const deployment = { admission, artifactId: "201", deploymentId: "301" };
      context.authority.step({ type: "deployed", ...owner, deployment });
      const body = {
        destination: "production" as const,
        liveUrl: PROMOTION_DESTINATIONS.production.liveUrl,
        releaseId: candidatePublicReleaseId("production", active.request),
        inventorySha256: active.request.publicInventorySha256,
        deployment,
        verifiedAt: "2026-10-18T12:10:00.000Z",
        checks: PROMOTION_FIXTURE_CHECKS,
      };
      const verification = { ...body, receiptId: promotionDigest(body) };
      context.authority.step({
        type: "verified",
        ...owner,
        verification,
        replayProof: null,
      });
      const verifiedControl = parsePromotionControl(
        context.authority.store.read().bytes!
      );
      if (
        verifiedControl.lastTransition.event.type !== "verified" ||
        verifiedControl.active?.verification?.receiptId !==
          verification.receiptId
      )
        throw new Error("Fixture authority did not retain verified progress");
      const verified = await runWeeklyImport({
        root: context.root,
        runId: state.runId,
        stopAfter: "verify",
        controlledPublishing: "enabled",
        manualPublisherJoined: "true",
        verifiedDelivery: {
          store: context.authority.store,
          candidate: candidateBytes,
        },
      });
      if (
        verified.stages
          .slice(0, 10)
          .some((stage) => stage.status !== "succeeded") ||
        verified.stages.find((stage) => stage.stage === "acknowledge")
          ?.status !== "pending"
      )
        throw new Error("Verified fixture did not stop before acknowledgement");
      initialArtifactBytes = artifactBytes(
        join(context.operatorDirectory, "weekly-runs.sqlite"),
        verified.runId
      );
      if (
        new Set(initialArtifactBytes.map((item) => item.stage)).size !==
        retainedStages.length
      )
        throw new Error("Verified fixture is missing retained stage artifacts");
      return verified;
    },
  });

  return {
    ...dispatch,
    workflowCommit,
    originalCandidateBytes,
    initialArtifactBytes,
    async prepare(name: string) {
      const f = await dispatch.prepare(name);
      const {
        githubToken: _githubToken,
        pagesApiBaseUrl: _pagesApiBaseUrl,
        ...input
      } = f.input;
      return {
        ...f,
        input: { ...input, workflowCommit },
        acknowledgementArtifactBytes: () =>
          acknowledgementArtifactBytes(
            join(f.input.destination, "operator/weekly-runs.sqlite"),
            f.input.runId
          ),
        hasCapsule: () =>
          existsSync(join(f.input.destination, "recovery-verified.json")),
        capsuleBytes: () =>
          readFileSync(join(f.input.destination, "recovery-verified.json")),
        control: () =>
          parsePromotionControl(
            Buffer.from(
              git(f.input.repositoryRoot, [
                "--git-dir",
                f.input.bareDirectory,
                "show",
                "refs/heads/zivv-promotion-control/production:control.json",
              ])
            )
          ),
        artifactBytes: () =>
          artifactBytes(
            join(f.input.destination, "operator/weekly-runs.sqlite"),
            f.input.runId
          ),
      };
    },
  };
}
