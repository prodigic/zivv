import {
  PROMOTION_DESTINATIONS,
  parsePromotionControl,
  promotionDigest,
} from "./promotion-control.js";
import type { PromotionControlStore } from "./promotion-control-git.js";
import { parseReleaseCandidate } from "./release-candidate.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";
import { parseWeeklyEditionLedger } from "./weekly.js";
import { parseWeeklyRunState } from "./weekly-run-state.js";

interface FridayVerifiedReleaseInput {
  state: unknown;
  candidate: Buffer;
  weeklyLedger: unknown;
  store: Pick<PromotionControlStore, "ref" | "readAt" | "read">;
}

function invalid(): never {
  throw new Error("INVALID_FRIDAY_VERIFIED_RELEASE");
}

/**
 * Read the authority for a success notice from an exactly recorded release.
 * The run and weekly ledger are snapshots from the operator's private store.
 * The promotion-control reader must enforce canonical ancestor membership.
 */
export function inspectFridayVerifiedRelease(
  input: FridayVerifiedReleaseInput
) {
  try {
    const run = parseWeeklyRunState(input.state);
    const acknowledgement = run.stages.find(
      (stage) => stage.stage === "acknowledge"
    );
    if (acknowledgement?.status !== "succeeded") return null;
    const evidence = acknowledgement.evidence;
    if (!evidence || typeof evidence.controlHead !== "string") return null;
    const verified = run.stages.find((stage) => stage.stage === "verify");
    if (verified?.status !== "succeeded" || !verified.evidence)
      return invalid();

    const production = PROMOTION_DESTINATIONS.production;
    const candidate = parseReleaseCandidate(input.candidate);
    if (
      input.store.ref !== "refs/heads/zivv-promotion-control/production" ||
      candidate.basePath !== production.basePath ||
      candidate.applicationProvenanceSha256 === null ||
      candidate.editionId !== run.source.editionId ||
      candidate.candidateId !== evidence.candidateId ||
      candidate.manifestSha256 !== verified.evidence.manifestSha256 ||
      candidate.editionId !== evidence.editionId ||
      candidate.cutoffEpochMs !== evidence.cutoffEpochMs
    )
      return invalid();

    const weekly = parseWeeklyEditionLedger(input.weeklyLedger);
    const edition = weekly.editions.find(
      (entry) => entry.editionId === candidate.editionId
    );
    if (
      edition?.status !== "published" ||
      weekly.publishedCutoffEpochMs !== candidate.cutoffEpochMs ||
      edition.endEpochMs !== candidate.cutoffEpochMs ||
      edition.datasetVersion !== candidate.datasetVersion ||
      sha256(canonicalJson(edition.eventIds)) !== candidate.membershipSha256
    )
      return invalid();

    const completed = input.store.readAt(evidence.controlHead);
    if (completed.head !== evidence.controlHead || !completed.bytes)
      return invalid();
    const saved = parsePromotionControl(completed.bytes);
    const event = saved.lastTransition.event;
    const release = saved.lastVerified;
    if (
      saved.destination !== "production" ||
      event.type !== "acknowledged" ||
      release.kind !== "candidateRelease" ||
      event.operationId !== evidence.operationId ||
      event.acknowledgementId !== evidence.acknowledgementId ||
      event.verificationReceiptId !== evidence.verificationReceiptId ||
      release.request.purpose !== "release" ||
      release.request.basePath !== candidate.basePath ||
      release.request.candidateId !== candidate.candidateId ||
      release.request.sourceCommit !== candidate.sourceCommit ||
      release.request.publicInventorySha256 !==
        promotionDigest(candidate.files) ||
      release.verification.destination !== "production" ||
      release.verification.receiptId !== event.verificationReceiptId ||
      release.deployment.deploymentId !== verified.evidence.deploymentId
    )
      return invalid();

    const live = input.store.read();
    if (!live.head || !live.bytes) return invalid();
    const current = parsePromotionControl(live.bytes);
    if (
      current.destination !== "production" ||
      current.active !== null ||
      canonicalJson(current.lastVerified) !== canonicalJson(release)
    )
      return invalid();
    return {
      status: "verified-release" as const,
      editionId: candidate.editionId,
      liveUrl: release.verification.liveUrl,
      addedEventCount: edition.eventIds.length,
      candidateId: candidate.candidateId,
      verificationReceiptId: event.verificationReceiptId,
      acknowledgementId: event.acknowledgementId,
      releaseId: release.releaseId,
      deduplicationKey: `friday/${candidate.editionId}/published`,
    };
  } catch {
    return invalid();
  }
}
