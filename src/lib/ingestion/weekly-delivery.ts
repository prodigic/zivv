import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { parseReleaseCandidate } from "./release-candidate.js";
import { parsePromotionControl, promotionDigest } from "./promotion-control.js";
import type { PromotionControlStore } from "./promotion-control-git.js";
import type { WeeklyRunJournal, WeeklyRunLease } from "./weekly-run-journal.js";
import {
  transitionWeeklyRun,
  type StageEvidence,
  type WeeklyRunState,
} from "./weekly-run-state.js";

interface Anchor {
  schemaVersion: 1;
  runId: string;
  candidateId: string;
  controlHead: string;
  controlSha256: string;
}
const same = (a: unknown, b: unknown, message: string) => {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(message);
};

/** Adopt real native verification; never fabricate effects from a supplied receipt. */
export async function journalVerifiedWeeklyDelivery(input: {
  state: WeeklyRunState;
  candidate: Buffer;
  store: PromotionControlStore;
  journal: WeeklyRunJournal;
  lease: WeeklyRunLease;
  verifyContext: () => void;
  onProgress: (
    stage: "deploy" | "verify",
    phase: "started" | "artifact-saved" | "completed"
  ) => Promise<void>;
}): Promise<WeeklyRunState> {
  same(input.lease.scope, "prodigic/zivv/production", "Wrong delivery scope");
  same(
    input.store.ref,
    "refs/heads/zivv-promotion-control/production",
    "Wrong delivery control ref"
  );
  let state = input.journal.loadOwned(input.state.runId, input.lease);
  same(state, input.state, "Stale delivery state");
  input.verifyContext();
  const candidate = parseReleaseCandidate(input.candidate);
  const validated = state.stages.find((s) => s.stage === "validate");
  if (validated?.status !== "succeeded")
    throw new Error("Candidate validation must precede delivery");
  same(
    validated.evidence?.candidateId,
    candidate.candidateId,
    "Wrong delivery candidate"
  );
  same(
    validated.evidence?.manifestSha256,
    candidate.manifestSha256,
    "Wrong delivery manifest"
  );
  if (
    candidate.basePath !== "/zivv/" ||
    candidate.applicationProvenanceSha256 === null
  )
    throw new Error("Delivery requires reviewed production candidate");
  let anchor: Anchor | undefined;
  for (const stage of ["deploy", "verify"] as const) {
    let item = state.stages.find((s) => s.stage === stage)!;
    if (!["running", "succeeded"].includes(item.status)) {
      state = input.journal.save(
        transitionWeeklyRun(
          state,
          state.revision,
          stage,
          { status: "running" },
          Date.now()
        ),
        state.revision,
        input.lease
      );
      await input.onProgress(stage, "started");
    }
    item = state.stages.find((s) => s.stage === stage)!;
    let bytes = input.journal.readArtifact(state.runId, stage, item.attempt);
    if (!bytes) {
      if (item.status === "succeeded")
        throw new Error("Missing delivery authority artifact");
      if (!anchor) {
        const current = input.store.read();
        if (!current.head || !current.bytes)
          throw new Error("Missing native delivery control");
        anchor = {
          schemaVersion: 1,
          runId: state.runId,
          candidateId: candidate.candidateId,
          controlHead: current.head,
          controlSha256: sha256(current.bytes),
        };
      }
      // Validate the authority before retaining an adoptable checkpoint.
      check(anchor);
      bytes = Buffer.from(canonicalJson(anchor) + "\n");
      input.verifyContext();
      input.journal.writeArtifact(state.runId, stage, bytes, input.lease);
      await input.onProgress(stage, "artifact-saved");
    }
    const saved = JSON.parse(bytes.toString("utf8")) as Anchor;
    same(
      Object.keys(saved).sort(),
      [
        "schemaVersion",
        "runId",
        "candidateId",
        "controlHead",
        "controlSha256",
      ].sort(),
      "Invalid delivery anchor fields"
    );
    same(
      bytes.toString("utf8"),
      canonicalJson(saved) + "\n",
      "Noncanonical delivery anchor"
    );
    if (anchor)
      same(saved, anchor, "Delivery authority changed between stages");
    anchor = saved;
    const evidence = check(saved);
    input.verifyContext();
    if (item.status === "succeeded")
      same(item.evidence, evidence, "Changed delivery receipt");
    else {
      state = input.journal.save(
        transitionWeeklyRun(
          state,
          state.revision,
          stage,
          { status: "succeeded", evidence },
          Date.now()
        ),
        state.revision,
        input.lease
      );
      await input.onProgress(stage, "completed");
    }
  }
  return state;

  function check(saved: Anchor): StageEvidence {
    same(saved.schemaVersion, 1, "Invalid delivery anchor schema");
    same(saved.runId, state.runId, "Wrong anchored run");
    same(saved.candidateId, candidate.candidateId, "Wrong anchored candidate");
    // readAt proves actual canonical ancestry, not merely self-consistent JSON.
    const historical = input.store.readAt(saved.controlHead);
    if (!historical.bytes) throw new Error("Missing native historical state");
    same(historical.head, saved.controlHead, "Wrong historical native head");
    same(
      sha256(historical.bytes),
      saved.controlSha256,
      "Changed native delivery bytes"
    );
    const control = parsePromotionControl(historical.bytes);
    const op = control.active;
    if (
      control.destination !== "production" ||
      !op ||
      op.phase !== "verified" ||
      !op.verification
    )
      throw new Error("Native successful verification is required");
    same(
      op.request.candidateId,
      candidate.candidateId,
      "Native candidate mismatch"
    );
    same(
      op.request.sourceCommit,
      candidate.sourceCommit,
      "Native source mismatch"
    );
    same(
      op.request.publicInventorySha256,
      promotionDigest(candidate.files),
      "Native inventory mismatch"
    );
    return {
      candidateId: candidate.candidateId,
      manifestSha256: candidate.manifestSha256,
      deploymentId: op.verification.deployment.deploymentId,
      destination: "production",
    };
  }
}
