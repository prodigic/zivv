import {
  createPromotionControl,
  promotionDigest,
  PROMOTION_DESTINATIONS,
  type LegacyPublicSnapshot,
  type LiveChecks,
  type PromotionControl,
  type PromotionDestination,
  type PromotionRequest,
} from "../../../lib/ingestion/promotion-control.js";

export const PROMOTION_FIXTURE_CHECKS: LiveChecks = {
  inventory: true,
  routes: true,
  cachedClient: true,
  freshClient: true,
};
/** Synthetic receipts only; never use this fixture to bootstrap a real destination. */
export function syntheticLegacyPublicSnapshot(
  destination: PromotionDestination = "production"
): LegacyPublicSnapshot {
  const files = [
    { path: "data/manifest.json", size: 5, sha256: "c".repeat(64) },
    { path: "index.html", size: 100, sha256: "d".repeat(64) },
  ];
  const body = {
    kind: "legacyPublicSnapshot" as const,
    destination,
    retainedCommit: "a".repeat(40),
    files,
    inventorySha256: promotionDigest(files),
  };
  const receipt = {
    destination,
    liveUrl: PROMOTION_DESTINATIONS[destination].liveUrl,
    retainedCommit: body.retainedCommit,
    inventorySha256: body.inventorySha256,
    verifiedAt: "2026-10-14T18:00:00.000Z",
    checks: PROMOTION_FIXTURE_CHECKS,
  };
  return {
    ...body,
    releaseId: promotionDigest(body),
    verification: { ...receipt, receiptId: promotionDigest(receipt) },
  };
}
export function syntheticPromotionRequest(
  state: PromotionControl,
  requestId = "edition-2026-10-16"
): PromotionRequest {
  const target = PROMOTION_DESTINATIONS[state.destination];
  return {
    requestId,
    payloadCommit: "e".repeat(40),
    candidateId: "f".repeat(64),
    sourceCommit: "a".repeat(40),
    basePath: target.basePath,
    purpose: target.purpose,
    publicInventorySha256: "c".repeat(64),
    expectedVerifiedReleaseId: state.lastVerified.releaseId,
  };
}
export function createPromotionControlFixture(
  destination: PromotionDestination = "production"
) {
  const snapshot = syntheticLegacyPublicSnapshot(destination);
  const state = createPromotionControl(snapshot);
  return { snapshot, state, request: syntheticPromotionRequest(state) };
}
