import { expect, it } from "vitest";
import {
  signSelectedLoadExecutionBaseline,
  verifySelectedLoadExecutionBaseline,
} from "../../lib/ingestion/recovery-gmail-execution-baseline.js";

it("authenticates the original execution time and immutable physical baseline", () => {
  const key = Buffer.alloc(32, 7);
  const baseline = {
    admissionSha256: "a".repeat(64),
    evidenceSha256: "b".repeat(64),
    physicalSnapshotSha256: "c".repeat(64),
    generation: 1,
    startedAtEpochMs: 1000,
    entries: [{ path: "operator", kind: "directory" as const }],
  };
  expect(() =>
    signSelectedLoadExecutionBaseline({ ...baseline, generation: 2 }, key)
  ).toThrow();
  expect(() =>
    signSelectedLoadExecutionBaseline(
      { ...baseline, entries: [baseline.entries[0]!, baseline.entries[0]!] },
      key
    )
  ).toThrow();
  expect(() =>
    signSelectedLoadExecutionBaseline(
      {
        ...baseline,
        entries: [{ path: "operator/../escape", kind: "directory" }],
      },
      key
    )
  ).toThrow();
  const signed = signSelectedLoadExecutionBaseline(baseline, key);
  expect(verifySelectedLoadExecutionBaseline(signed, key)).toEqual(baseline);
  expect(() =>
    verifySelectedLoadExecutionBaseline(
      Buffer.from(signed.toString().replace("1000", "1001")),
      key
    )
  ).toThrow();
  expect(() =>
    verifySelectedLoadExecutionBaseline(signed, Buffer.alloc(32, 8))
  ).toThrow();
  expect(() =>
    verifySelectedLoadExecutionBaseline(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), signed]),
      key
    )
  ).toThrow();
  expect(() =>
    signSelectedLoadExecutionBaseline(
      { ...baseline, startedAtEpochMs: -1 },
      key
    )
  ).toThrow();
});
