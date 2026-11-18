import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import type { RecoveryRuntimeEntry } from "../../lib/ingestion/recovery-runtime.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { prepareSelectedLoadHistoryFiles } from "../../lib/ingestion/recovery-gmail-selected-load-history.js";
import {
  signSelectedLoadCompletionIntent,
  verifySelectedLoadCompletionIntent,
} from "../../lib/ingestion/recovery-gmail-selected-load-completion-intent.js";
import { regenerateSelectedLoadCompletionPlan } from "../../lib/ingestion/recovery-gmail-selected-load-completion-plan.js";

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
const snapshot = (expiry: number) => {
  const body = {
    format: "zivv-weekly-journal-recovery",
    version: 1,
    journalSchemaVersion: 3,
    ownership: [{ ...owner, expiresAtEpochMs: expiry }],
    runState: [],
    stageArtifacts: [],
    intakeEvidence: [],
  };
  return Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  );
};
const guarded = snapshot(owner.expiresAtEpochMs);
const released = snapshot(0);
const encryptedCatalog = Buffer.from("encrypted catalog fixture");
const runStateSha256 = "1".repeat(64);
const reportSha256 = "2".repeat(64);
const successorSha256 = "3".repeat(64);
const root = "recovery-gmail-load/" + identity.runId;
const projected: RecoveryRuntimeEntry[] = [
  { path: "checkout", kind: "directory" },
  {
    path: "checkout/config.json",
    kind: "file",
    size: 6,
    sha256: sha256("config"),
  },
  { path: "recovery-gmail-load", kind: "directory" },
  { path: root, kind: "directory" },
];
const entries: RecoveryRuntimeEntry[] = [
  ...projected,
  {
    path: root + "/completion-intent.json",
    kind: "file",
    size: 1,
    sha256: sha256("x"),
  },
  {
    path: root + "/history-catalog-000.bin",
    kind: "file",
    size: 1,
    sha256: sha256("x"),
  },
  { path: root + "/load-result.json-stage", kind: "directory" },
];
const history = prepareSelectedLoadHistoryFiles(
  identity,
  {
    encryptedCatalog,
    guardedJournal: guarded,
    inventory: Buffer.from(canonicalJson(projected) + "\n"),
  },
  key
);
const resultBody = {
  kind: "zivv-selected-load-result",
  version: 3,
  admissionSha256: identity.admissionSha256,
  executionBaselineSha256: identity.executionBaselineSha256,
  successorSha256,
  runId: identity.runId,
  ledgerRevision: identity.ledgerRevision,
  generation: identity.generation,
  journalSha256: sha256(released),
  guardedJournalSha256: sha256(guarded),
  runStateSha256,
  reportSha256,
  historyManifestSha256: history.manifestSha256,
};
const result = Buffer.from(
  canonicalJson({
    ...resultBody,
    signature: createHmac("sha256", key)
      .update("zivv-selected-load-result/v3\0")
      .update(canonicalJson(resultBody))
      .digest("hex"),
  }) + "\n"
);
const fields = {
  identity,
  owner,
  guardedJournalSha256: sha256(guarded),
  releasedJournalSha256: sha256(released),
  historyManifestSha256: history.manifestSha256,
  resultSha256: sha256(result),
};
const signed = signSelectedLoadCompletionIntent(fields, key);
const intent = verifySelectedLoadCompletionIntent(signed, key, identity).fields;
const input = {
  intent,
  observedJournal: guarded,
  encryptedCatalog,
  entries,
  runStateSha256,
  reportSha256,
  successorSha256,
  key,
};

it("regenerates the exact signed files and v3 result from either journal state", () => {
  for (const observedJournal of [guarded, released]) {
    const actual = regenerateSelectedLoadCompletionPlan({
      ...input,
      observedJournal,
    });
    expect(actual).toMatchObject({
      files: history.files,
      result,
      releasedJournal: released,
      loadAllowed: false,
    });
  }
});

it("refuses any drift that would change the authenticated completion plan", () => {
  const changedEntries = entries.map((entry) =>
    entry.path === "checkout/config.json" && entry.kind === "file"
      ? { ...entry, sha256: sha256("change") }
      : entry
  );
  for (const changed of [
    { ...input, entries: changedEntries },
    { ...input, encryptedCatalog: Buffer.from("different catalog") },
    { ...input, runStateSha256: "4".repeat(64) },
    { ...input, reportSha256: "4".repeat(64) },
    { ...input, successorSha256: "4".repeat(64) },
    { ...input, successorSha256: undefined },
    { ...input, key: Buffer.alloc(32, 8) },
  ])
    expect(() => regenerateSelectedLoadCompletionPlan(changed)).toThrow();
});
