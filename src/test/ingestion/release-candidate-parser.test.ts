import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import {
  CANDIDATE_CONFIG_FILES,
  parseReleaseCandidate,
} from "../../lib/ingestion/release-candidate.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function identity() {
  const configuration = CANDIDATE_CONFIG_FILES.map((path) => ({
    path,
    sha256: null,
  }));
  return {
    schemaVersion: 1,
    sourceCommit: "a".repeat(40),
    basePath: "/zivv/",
    ledgerRevision: "b".repeat(64),
    snapshotSha256: "c".repeat(64),
    configSha256: digest(canonicalJson(configuration)),
    configuration,
    editionId: "2026-10-16",
    cutoffEpochMs: 1792134000000,
    membershipSha256: "d".repeat(64),
    datasetVersion: "2026-10-16T10:00:00.000Z",
    manifestSha256: "e".repeat(64),
    applicationBuildSha256: "f".repeat(64),
    applicationProvenanceSha256: "1".repeat(64),
    files: [{ path: "index.html", size: 12, sha256: "2".repeat(64) }],
  };
}
function bytes(value: Record<string, unknown>) {
  return Buffer.from(
    canonicalJson({ ...value, candidateId: digest(canonicalJson(value)) })
  );
}
describe("public candidate identity parser", () => {
  it("accepts a canonical identity and rejects content edits retaining its original ID", () => {
    const original = bytes(identity());
    expect(parseReleaseCandidate(original).sourceCommit).toBe("a".repeat(40));
    const changed = JSON.parse(original.toString());
    changed.editionId = "2026-10-23";
    expect(() =>
      parseReleaseCandidate(Buffer.from(JSON.stringify(changed)))
    ).toThrow("public candidate identity");
  });
  it.each([
    { sourceCommit: "main" },
    { basePath: "/zivv/../" },
    { cutoffEpochMs: -1 },
    { snapshotSha256: "bad" },
    { extra: "untrusted" },
    { applicationProvenanceSha256: "bad" },
    { files: [{ path: "data/../raw.txt", size: 1, sha256: "2".repeat(64) }] },
    { files: [{ path: "index.html", size: -1, sha256: "2".repeat(64) }] },
    { files: [identity().files[0], identity().files[0]] },
    { configuration: identity().configuration.slice(1) },
    { configuration: [...identity().configuration].reverse() },
    { configSha256: "0".repeat(64) },
  ])(
    "rejects malformed identity even if its digest is recomputed: %j",
    (change) => {
      expect(() =>
        parseReleaseCandidate(bytes({ ...identity(), ...change }))
      ).toThrow();
    }
  );
});
