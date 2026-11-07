import { expect, it } from "vitest";
import {
  describeResumeSnapshot,
  restoreResumeSnapshot,
} from "../../lib/ingestion/recovery-gmail-selected-resume-snapshot-evidence.js";
it("binds every encrypted snapshot chunk, its order, and exact total bytes", () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 8);
  const evidence = describeResumeSnapshot(bytes);
  const chunks = [
    bytes.subarray(0, 4 * 1024 * 1024),
    bytes.subarray(4 * 1024 * 1024),
  ];
  expect(restoreResumeSnapshot(evidence, chunks).equals(bytes)).toBe(true);
  expect(() => restoreResumeSnapshot(evidence, chunks.slice(0, 1))).toThrow();
  expect(() =>
    restoreResumeSnapshot(evidence, [chunks[1]!, chunks[0]!])
  ).toThrow();
  expect(() =>
    restoreResumeSnapshot(evidence, [chunks[0]!, Buffer.alloc(17, 9)])
  ).toThrow();
  expect(() =>
    restoreResumeSnapshot({ ...evidence, size: evidence.size - 1 }, chunks)
  ).toThrow();
  expect(() => describeResumeSnapshot(Buffer.alloc(0))).toThrow();
});
