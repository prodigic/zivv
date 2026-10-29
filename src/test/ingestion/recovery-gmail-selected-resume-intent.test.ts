import { describeResumeSnapshot } from "../../lib/ingestion/recovery-gmail-selected-resume-snapshot-evidence.js";
import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { verifySelectedLoadResumeIntent } from "../../lib/ingestion/recovery-gmail-selected-resume-intent.js";

it("authenticates a closed first-resume intent without granting authority", () => {
  const key = Buffer.alloc(32, 7),
    digest = "a".repeat(64);
  const hash = sha256("selected-load/" + digest);
  const owner = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
  const body = {
    kind: "zivv-selected-load-resume-intent",
    version: 2,
    snapshotEvidence: null,
    admissionSha256: digest,
    executionBaselineSha256: digest,
    journalSha256: digest,
    inventorySha256: digest,
    ledgerRevision: digest,
    generation: 2,
    previousOwner: {
      scope: "prodigic/zivv/production",
      owner,
      fence: 1,
      expiresAtEpochMs: 1000,
    },
    fence: 2,
    owner,
    startedAtEpochMs: 1000,
    deadlineEpochMs: 181000,
  };
  const sign = (value: object) =>
    Buffer.from(
      canonicalJson({
        ...value,
        signature: createHmac("sha256", key)
          .update("zivv-selected-load-resume-intent/v1\0")
          .update(canonicalJson(value))
          .digest("hex"),
      }) + "\n"
    );
  const manifest = describeResumeSnapshot(Buffer.from("encrypted fixture"));
  expect(
    verifySelectedLoadResumeIntent(
      sign({ ...body, snapshotEvidence: manifest }),
      key
    ).snapshotEvidence
  ).toEqual(manifest);
  expect(() =>
    verifySelectedLoadResumeIntent(
      sign({ ...body, snapshotEvidence: { ...manifest, chunks: [] } }),
      key
    )
  ).toThrow();
  const valid = sign(body);
  expect(verifySelectedLoadResumeIntent(valid, key)).toEqual(body);
  expect(() =>
    verifySelectedLoadResumeIntent(valid, Buffer.alloc(32, 8))
  ).toThrow();
  expect(() =>
    verifySelectedLoadResumeIntent(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
      key
    )
  ).toThrow();
  for (const invalid of [
    { ...body, fence: 3 },
    { ...body, generation: 3 },
    { ...body, startedAtEpochMs: 999, deadlineEpochMs: 180999 },
    { ...body, deadlineEpochMs: 181001 },
    { ...body, owner: "00000000-0000-0000-0000-000000000000" },
    { ...body, previousOwner: { ...body.previousOwner, fence: 0 } },
    { ...body, previousOwner: { ...body.previousOwner, extra: true } },
    { ...body, inventorySha256: "A".repeat(64) },
    { ...body, extra: true },
  ])
    expect(() => verifySelectedLoadResumeIntent(sign(invalid), key)).toThrow();
});
