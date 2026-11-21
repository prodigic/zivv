import { expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { verifySelectedLoadResult } from "../../lib/ingestion/recovery-gmail-selected-result-proof.js";

it("authenticates exact completion evidence without granting replay authority", () => {
  const key = Buffer.alloc(32, 9),
    digest = "a".repeat(64),
    body = {
      kind: "zivv-selected-load-result",
      version: 1,
      admissionSha256: digest,
      executionBaselineSha256: digest,
      runId: digest,
      ledgerRevision: digest,
      generation: 2,
      journalSha256: digest,
      guardedJournalSha256: digest,
      runStateSha256: digest,
      reportSha256: digest,
    };
  const signature = createHmac("sha256", key)
    .update("zivv-selected-load-result/v1\0")
    .update(canonicalJson(body))
    .digest("hex");
  const bytes = Buffer.from(canonicalJson({ ...body, signature }) + "\n");
  const expected = {
    admissionSha256: digest,
    executionBaselineSha256: digest,
    runId: digest,
    ledgerRevision: digest,
    generation: 2,
    journalSha256: digest,
    runStateSha256: digest,
    reportSha256: digest,
  };
  expect(verifySelectedLoadResult(bytes, key, expected)).toMatchObject({
    status: "authenticated",
    loadAllowed: false,
  });
  const successorSha256 = "b".repeat(64);
  const successorBody = { ...body, version: 2, successorSha256 };
  const successorSignature = createHmac("sha256", key)
    .update("zivv-selected-load-result/v2\0")
    .update(canonicalJson(successorBody))
    .digest("hex");
  const successorBytes = Buffer.from(
    canonicalJson({ ...successorBody, signature: successorSignature }) + "\n"
  );
  expect(
    verifySelectedLoadResult(successorBytes, key, {
      ...expected,
      successorSha256,
    })
  ).toMatchObject({ status: "authenticated", loadAllowed: false });
  expect(() =>
    verifySelectedLoadResult(successorBytes, key, expected)
  ).toThrow();
  expect(() =>
    verifySelectedLoadResult(successorBytes, key, {
      ...expected,
      successorSha256: "c".repeat(64),
    })
  ).toThrow();
  expect(() =>
    verifySelectedLoadResult(bytes, key, { ...expected, successorSha256 })
  ).toThrow();
  expect(() =>
    verifySelectedLoadResult(bytes, Buffer.alloc(32, 8), expected)
  ).toThrow();
  expect(() =>
    verifySelectedLoadResult(bytes, key, {
      ...expected,
      journalSha256: "b".repeat(64),
    })
  ).toThrow();
  expect(() =>
    verifySelectedLoadResult(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      key,
      expected
    )
  ).toThrow();
  expect(() =>
    verifySelectedLoadResult(
      Buffer.from(bytes.toString().replace('"generation":2', '"generation":3')),
      key,
      expected
    )
  ).toThrow();
});
