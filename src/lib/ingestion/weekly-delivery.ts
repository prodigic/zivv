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
export interface CanonicalWeeklyVerification {
  controlHead: string;
  controlSha256: string;
}
const same = (a: unknown, b: unknown, message: string) => {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(message);
};

/** Find this run's exact canonical verification without creating remote effects. */
export function findCanonicalWeeklyVerification(input: {
  runId: string;
  candidate: Buffer;
  store: PromotionControlStore;
}): CanonicalWeeklyVerification | null {
  same(
    input.store.ref,
    "refs/heads/zivv-promotion-control/production",
    "Wrong delivery control ref"
  );
  const candidate = parseReleaseCandidate(input.candidate);
  if (
    candidate.basePath !== "/zivv/" ||
    candidate.applicationProvenanceSha256 === null
  )
    throw new Error("Delivery requires reviewed production candidate");
  if (!input.store.readCanonicalHistory)
    throw new Error("Canonical history is required for delivery recovery");
  const history = input.store.readCanonicalHistory({
    maxCommits: 1000,
    maxBytes: 16 * 1024 * 1024,
  });
  if (!history.complete)
    throw new Error("Delivery recovery history is incomplete");
  const matches = history.commits.filter((record) => {
    const control = parsePromotionControl(record.bytes),
      event = control.lastTransition.event;
    return (
      event.type === "verified" &&
      event.mode === "promote" &&
      control.active?.request.requestId === input.runId
    );
  });
  if (matches.length > 1)
    throw new Error("Canonical weekly verification is ambiguous");
  if (!matches.length) return null;
  const record = matches[0],
    control = parsePromotionControl(record.bytes),
    operation = control.active!;
  same(
    control.destination,
    "production",
    "Wrong historical delivery destination"
  );
  same(
    operation.phase,
    "verified",
    "Native successful verification is required"
  );
  same(
    operation.request.candidateId,
    candidate.candidateId,
    "Native historical candidate mismatch"
  );
  same(
    operation.request.sourceCommit,
    candidate.sourceCommit,
    "Native historical source mismatch"
  );
  same(
    operation.request.publicInventorySha256,
    promotionDigest(candidate.files),
    "Native historical inventory mismatch"
  );
  same(
    operation.request.purpose,
    "release",
    "Native historical purpose mismatch"
  );
  same(operation.request.basePath, "/zivv/", "Native historical base mismatch");
  // The selected bytes must still be an ancestor of authoritative control.
  const proven = input.store.readAt(record.head);
  same(proven.head, record.head, "Wrong historical delivery head");
  same(
    proven.bytes?.toString("base64"),
    record.bytes.toString("base64"),
    "Unproven historical delivery bytes"
  );
  return { controlHead: record.head, controlSha256: sha256(record.bytes) };
}

/** Adopt real native verification; never fabricate effects from a supplied receipt. */
export async function journalVerifiedWeeklyDelivery(input: {
  state: WeeklyRunState;
  candidate: Buffer;
  store: PromotionControlStore;
  journal: WeeklyRunJournal;
  lease: WeeklyRunLease;
  verifyContext: () => void;
  /** Canonical history probe from the worker; revalidated before persistence. */
  recoveredAuthority?: CanonicalWeeklyVerification;
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
        const active = parsePromotionControl(current.bytes).active;
        // Prefer this run's history even if a later verified owner happens to
        // reuse the same candidate. The manual current-owner route is fallback.
        const authority =
          input.recoveredAuthority ??
          (input.store.readCanonicalHistory
            ? findCanonicalWeeklyVerification({
                runId: state.runId,
                candidate: input.candidate,
                store: input.store,
              })
            : null) ??
          (active?.phase === "verified"
            ? {
                controlHead: current.head,
                controlSha256: sha256(current.bytes),
              }
            : null);
        if (!authority)
          throw new Error("Native successful verification is required");
        anchor = {
          schemaVersion: 1,
          runId: state.runId,
          candidateId: candidate.candidateId,
          ...authority,
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
    if (input.recoveredAuthority)
      same(
        op.request.requestId,
        state.runId,
        "Native historical request mismatch"
      );
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
