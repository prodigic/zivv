import { expect, it } from "vitest";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { validateWeeklyJournalRecoverySnapshot } from "../../lib/ingestion/weekly-run-journal.js";
import {
  reconstructSelectedLoadCompletionJournals,
  signSelectedLoadCompletionIntent,
  verifySelectedLoadCompletionIntent,
} from "../../lib/ingestion/recovery-gmail-selected-load-completion-intent.js";

const key = Buffer.alloc(32, 7);
const identity = {
  runId: "a".repeat(64),
  admissionSha256: "b".repeat(64),
  executionBaselineSha256: "c".repeat(64),
  priorFamilySha256: "d".repeat(64),
  ledgerRevision: "e".repeat(64),
  generation: 2,
};
const owner = {
  scope: "prodigic/zivv/production",
  owner: "12345678-1234-1234-1234-123456789abc",
  fence: 7,
  expiresAtEpochMs: 12000,
};
const unrelated = {
  scope: "prodigic/zivv/staging",
  owner: "87654321-4321-4321-4321-cba987654321",
  fence: 4,
  expiresAtEpochMs: 9000,
};
const snapshot = (owners: (typeof owner)[]) => {
  const body = {
    format: "zivv-weekly-journal-recovery",
    version: 1,
    journalSchemaVersion: 3,
    ownership: owners,
    runState: [],
    stageArtifacts: [],
    intakeEvidence: [],
  };
  return Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  );
};
const guarded = snapshot([owner, unrelated]);
const released = snapshot([{ ...owner, expiresAtEpochMs: 0 }, unrelated]);
const fields = {
  identity,
  owner,
  guardedJournalSha256: sha256(guarded),
  releasedJournalSha256: sha256(released),
  historyManifestSha256: "f".repeat(64),
  resultSha256: "1".repeat(64),
};

it("authenticates exact completion identity and both journal commitments", () => {
  validateWeeklyJournalRecoverySnapshot(guarded);
  validateWeeklyJournalRecoverySnapshot(released);
  const signed = signSelectedLoadCompletionIntent(fields, key);
  expect(
    verifySelectedLoadCompletionIntent(signed, key, identity)
  ).toMatchObject({
    fields,
    intentSha256: sha256(signed),
    loadAllowed: false,
  });
  expect(() =>
    verifySelectedLoadCompletionIntent(signed, Buffer.alloc(32, 8), identity)
  ).toThrow();
  for (const name of [
    "runId",
    "admissionSha256",
    "executionBaselineSha256",
    "priorFamilySha256",
    "ledgerRevision",
  ] as const)
    expect(() =>
      verifySelectedLoadCompletionIntent(signed, key, {
        ...identity,
        [name]: "2".repeat(64),
      })
    ).toThrow();
  expect(() =>
    verifySelectedLoadCompletionIntent(signed, key, {
      ...identity,
      generation: 3,
    })
  ).toThrow();
  const modified = Buffer.from(signed);
  modified[modified.length - 2] = modified[modified.length - 2]! ^ 1;
  expect(() =>
    verifySelectedLoadCompletionIntent(modified, key, identity)
  ).toThrow();
  expect(() =>
    verifySelectedLoadCompletionIntent(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), signed]),
      key,
      identity
    )
  ).toThrow();
});

it("reconstructs only the signed guarded and released journal pair", () => {
  for (const observed of [guarded, released])
    expect(reconstructSelectedLoadCompletionJournals(observed, fields)).toEqual(
      {
        guardedJournal: guarded,
        releasedJournal: released,
        loadAllowed: false,
      }
    );
  for (const changed of [
    snapshot([{ ...owner, owner: unrelated.owner }, unrelated]),
    snapshot([{ ...owner, fence: owner.fence + 1 }, unrelated]),
    snapshot([
      { ...owner, expiresAtEpochMs: owner.expiresAtEpochMs + 1 },
      unrelated,
    ]),
    snapshot([owner, { ...unrelated, fence: unrelated.fence + 1 }]),
    snapshot([
      { ...owner, expiresAtEpochMs: 0 },
      { ...unrelated, expiresAtEpochMs: 0 },
    ]),
  ])
    expect(() =>
      reconstructSelectedLoadCompletionJournals(changed, fields)
    ).toThrow();
  const damaged = Buffer.from(guarded);
  damaged[damaged.length - 2] = damaged[damaged.length - 2]! ^ 1;
  expect(() =>
    reconstructSelectedLoadCompletionJournals(damaged, fields)
  ).toThrow();
  expect(() =>
    reconstructSelectedLoadCompletionJournals(guarded, {
      ...fields,
      releasedJournalSha256: "2".repeat(64),
    })
  ).toThrow();
  expect(() =>
    reconstructSelectedLoadCompletionJournals(released, {
      ...fields,
      guardedJournalSha256: "2".repeat(64),
    })
  ).toThrow();
});
