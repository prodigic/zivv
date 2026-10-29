import { reconstructSelectedLoadIntentBaseline } from "../../lib/ingestion/recovery-gmail-selected-intent-baseline.js";
import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { prepareSelectedLoadIntentSuccessor } from "../../lib/ingestion/recovery-gmail-selected-successor-preparation.js";
import { verifySelectedLoadIntentChain } from "../../lib/ingestion/recovery-gmail-selected-intent-chain.js";

it("prepares a successor only for the exact unacquired or owner-only acquired journal", () => {
  const key = Buffer.alloc(32, 9),
    id = "a".repeat(64),
    hash = sha256("selected-load/" + id);
  const owner = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
  const previousOwner = {
    scope: "prodigic/zivv/production",
    owner,
    fence: 1,
    expiresAtEpochMs: 1000,
  };
  const journal = (lease: typeof previousOwner) => {
    const body = {
      format: "zivv-weekly-journal-recovery",
      version: 1,
      journalSchemaVersion: 3,
      ownership: [lease],
      runState: [],
      stageArtifacts: [],
      intakeEvidence: [],
    };
    return Buffer.from(
      canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
    );
  };
  const initialBody = {
    kind: "zivv-selected-load-resume-intent",
    version: 2,
    snapshotEvidence: null,
    admissionSha256: id,
    executionBaselineSha256: id,
    journalSha256: sha256(journal(previousOwner)),
    inventorySha256: id,
    ledgerRevision: id,
    generation: 2,
    previousOwner,
    fence: 2,
    owner,
    startedAtEpochMs: 1000,
    deadlineEpochMs: 181000,
  };
  const signature = createHmac("sha256", key)
    .update("zivv-selected-load-resume-intent/v1\0")
    .update(canonicalJson(initialBody))
    .digest("hex");
  const initial = Buffer.from(
    canonicalJson({ ...initialBody, signature }) + "\n"
  );
  const base = {
    initial,
    successors: [],
    observedJournal: journal(previousOwner),
    key,
    nowEpochMs: 181000,
  };
  const first = prepareSelectedLoadIntentSuccessor(base);
  expect(first).toMatchObject({
    sequence: 1,
    loadAllowed: false,
    activationAllowed: false,
  });
  expect(
    verifySelectedLoadIntentChain(initial, [first.bytes], key).latestV2Successor
  ).toMatchObject({ fence: 2, journalSha256: sha256(base.observedJournal) });
  const acquired = { ...previousOwner, fence: 2, expiresAtEpochMs: 150000 };
  const second = prepareSelectedLoadIntentSuccessor({
    ...base,
    observedJournal: journal(acquired),
  });
  expect(
    verifySelectedLoadIntentChain(initial, [second.bytes], key)
      .latestV2Successor
  ).toMatchObject({ fence: 3, journalSha256: sha256(journal(acquired)) });
  expect(() =>
    prepareSelectedLoadIntentSuccessor({ ...base, nowEpochMs: 180999 })
  ).toThrow();
  expect(() =>
    prepareSelectedLoadIntentSuccessor({
      ...base,
      observedJournal: journal({ ...acquired, fence: 3 }),
    })
  ).toThrow();
  expect(() =>
    prepareSelectedLoadIntentSuccessor({
      ...base,
      observedJournal: journal({ ...acquired, expiresAtEpochMs: 181001 }),
    })
  ).toThrow();
  const next = prepareSelectedLoadIntentSuccessor({
    ...base,
    successors: [first.bytes],
    observedJournal: journal({ ...acquired, expiresAtEpochMs: 271000 }),
    nowEpochMs: 361000,
  });
  const chain = verifySelectedLoadIntentChain(
    initial,
    [first.bytes, next.bytes],
    key
  );
  const laterAcquired = journal({
    ...acquired,
    fence: 3,
    expiresAtEpochMs: 400000,
  });
  const reconstructed = reconstructSelectedLoadIntentBaseline({
    initial: chain.initialIntent,
    latest: chain.latestV2Successor,
    observedJournal: laterAcquired,
  });
  expect(reconstructed.baselineJournal.equals(journal(previousOwner))).toBe(
    true
  );
  expect(reconstructed.acquired).toBe(true);
  expect(reconstructed.loadAllowed).toBe(false);
  expect(() =>
    reconstructSelectedLoadIntentBaseline({
      initial: chain.initialIntent,
      latest: chain.latestV2Successor,
      observedJournal: journal({ ...acquired, fence: 4 }),
    })
  ).toThrow();
  expect(
    verifySelectedLoadIntentChain(initial, [first.bytes, next.bytes], key)
      .latestV2Successor
  ).toMatchObject({ sequence: 2, fence: 3 });
});
