import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import {
  signSelectedThirdLoadExecutionBaseline as sign,
  verifySelectedThirdLoadExecutionBaseline as verify,
  verifySelectedNextLoadExecutionBaseline as verifyNext,
  signSelectedNextLoadExecutionBaseline as signNext,
  type SelectedThirdLoadExecutionBaseline,
} from "../../lib/ingestion/recovery-gmail-execution-baseline.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";

const key = Buffer.alloc(32, 7);
const runId = "c".repeat(64);
const root = `recovery-gmail-load/${runId}`;
const base = (): SelectedThirdLoadExecutionBaseline => {
  const predecessor: SelectedThirdLoadExecutionBaseline["entries"] = [
    { path: "operator", kind: "directory" },
  ];
  const entries: SelectedThirdLoadExecutionBaseline["entries"] = [
    ...predecessor,
    { path: root, kind: "directory" },
    {
      path: root + "/admission.json",
      kind: "file",
      size: 20,
      sha256: "a".repeat(64),
    },
    { path: root + "/stages", kind: "directory" },
    { path: root + "/stages/admission", kind: "directory" },
  ];
  return {
    runId,
    admissionSha256: "a".repeat(64),
    completedPrefixSha256: "b".repeat(64),
    preparedReceiptSha256: "d".repeat(64),
    catalogSha256: "e".repeat(64),
    journalSha256: "f".repeat(64),
    predecessorInventorySha256: sha256(canonicalJson(predecessor)),
    physicalSnapshotSha256: sha256(canonicalJson(entries)),
    generation: 3,
    startedAtEpochMs: 1234,
    entries,
  };
};
function signedRaw(value: unknown) {
  const body = {
    kind: "zivv-selected-load-execution-baseline",
    version: 3,
    ...(value as object),
  };
  const signature = createHmac("sha256", key)
    .update("zivv-selected-load-execution-baseline/v3\0")
    .update(canonicalJson(body))
    .digest("hex");
  return Buffer.from(canonicalJson({ ...body, signature }) + "\n");
}

it("authenticates a canonical v3 baseline and returns an owned record", () => {
  const value = base();
  const bytes = sign(value, key);
  const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const { signature, ...body } = parsed;
  expect(signature).toBe(
    createHmac("sha256", key)
      .update("zivv-selected-load-execution-baseline/v3\0")
      .update(canonicalJson(body))
      .digest("hex")
  );
  const result = verify(bytes, key);
  expect(result).toEqual(value);
  result.entries.pop();
  expect(verify(bytes, key)).toEqual(value);
  expect(() => verify(bytes, Buffer.alloc(32, 8))).toThrow();
  expect(() =>
    verify(Buffer.concat([bytes, Buffer.from("\n")]), key)
  ).toThrow();
  expect(() =>
    verify(
      Buffer.from(
        canonicalJson({ ...parsed, signature: "0".repeat(64) }) + "\n"
      ),
      key
    )
  ).toThrow();
  expect(() => verifyNext(bytes, key)).toThrow();
  const v2Entries = [{ path: "operator", kind: "directory" as const }];
  const v2 = signNext(
    {
      admissionSha256: "a".repeat(64),
      catalogSha256: "b".repeat(64),
      journalSha256: "c".repeat(64),
      priorLoadFamilySha256: "d".repeat(64),
      physicalSnapshotSha256: sha256(canonicalJson(v2Entries)),
      generation: 2,
      startedAtEpochMs: 1234,
      entries: v2Entries,
    },
    key
  );
  expect(() => verify(v2, key)).toThrow();
});

it("refuses authentically signed malformed fields and inventory commitments", () => {
  const value = base();
  const cases: unknown[] = [
    { ...value, generation: 2 },
    { ...value, catalogSha256: "not-a-digest" },
    { ...value, physicalSnapshotSha256: "0".repeat(64) },
    { ...value, predecessorInventorySha256: "0".repeat(64) },
    { ...value, admissionSha256: "0".repeat(64) },
    { ...value, extra: true },
    { ...value, entries: [...value.entries].reverse() },
  ];
  const withoutAdmission = value.entries.filter(
    (entry) => entry.path !== root + "/admission.json"
  );
  cases.push({
    ...value,
    entries: withoutAdmission,
    physicalSnapshotSha256: sha256(canonicalJson(withoutAdmission)),
  });
  const extra = [
    ...value.entries,
    { path: root + "/stages/extra", kind: "directory" },
  ];
  cases.push({
    ...value,
    entries: extra,
    physicalSnapshotSha256: sha256(canonicalJson(extra)),
  });
  const wrongAdmission = value.entries.map((entry) =>
    entry.path === root + "/admission.json" && entry.kind === "file"
      ? { ...entry, sha256: "0".repeat(64) }
      : entry
  );
  cases.push({
    ...value,
    entries: wrongAdmission,
    physicalSnapshotSha256: sha256(canonicalJson(wrongAdmission)),
  });
  for (const malformed of cases)
    expect(() => verify(signedRaw(malformed), key)).toThrow();
});
