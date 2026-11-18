import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  signSelectedLoadExecutionBaseline,
  signSelectedNextLoadExecutionBaseline,
  type SelectedNextLoadExecutionBaseline,
  verifySelectedLoadExecutionBaseline,
  verifySelectedNextLoadExecutionBaseline,
} from "../../lib/ingestion/recovery-gmail-execution-baseline.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";

const key = Buffer.alloc(32, 17);
const entries = [
  { path: "checkout", kind: "directory" },
  { path: "operator", kind: "directory" },
] satisfies SelectedNextLoadExecutionBaseline["entries"];
const baseline: SelectedNextLoadExecutionBaseline = {
  admissionSha256: sha256("admission"),
  catalogSha256: sha256("catalog"),
  journalSha256: sha256("journal"),
  priorLoadFamilySha256: sha256("ordered released predecessor"),
  physicalSnapshotSha256: sha256(canonicalJson(entries)),
  generation: 2,
  startedAtEpochMs: 1_700_000_000_000,
  entries,
};
const invalid = "INVALID_SELECTED_LOAD_EXECUTION_BASELINE";

describe("second selected load execution baseline", () => {
  it("binds the ordered inventory and requires the exact v2 format", () => {
    const bytes = signSelectedNextLoadExecutionBaseline(baseline, key);
    expect(verifySelectedNextLoadExecutionBaseline(bytes, key)).toEqual(
      baseline
    );
    expect(() => verifySelectedLoadExecutionBaseline(bytes, key)).toThrow(
      invalid
    );

    const old = {
      admissionSha256: baseline.admissionSha256,
      evidenceSha256: sha256("original evidence"),
      physicalSnapshotSha256: baseline.physicalSnapshotSha256,
      generation: 1,
      startedAtEpochMs: baseline.startedAtEpochMs,
      entries,
    };
    const legacy = signSelectedLoadExecutionBaseline(old, key);
    expect(verifySelectedLoadExecutionBaseline(legacy, key)).toEqual(old);
    expect(() => verifySelectedNextLoadExecutionBaseline(legacy, key)).toThrow(
      invalid
    );
  });

  it("refuses an authenticated but inconsistent execution baseline", () => {
    for (const change of [
      { generation: 3 },
      { physicalSnapshotSha256: sha256("other inventory") },
      { entries: [...entries].reverse() },
      { unexpectedField: "scope drift" },
    ]) {
      const payload = {
        kind: "zivv-selected-load-execution-baseline",
        version: 2,
        ...baseline,
        ...change,
      };
      const signature = createHmac("sha256", key)
        .update("zivv-selected-load-execution-baseline/v2\0")
        .update(canonicalJson(payload))
        .digest("hex");
      const bytes = Buffer.from(
        canonicalJson({ ...payload, signature }) + "\n"
      );
      expect(() => verifySelectedNextLoadExecutionBaseline(bytes, key)).toThrow(
        invalid
      );
    }
  });
});
