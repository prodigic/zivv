import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  describeResumeSnapshot,
  restoreResumeSnapshot,
} from "../../lib/ingestion/recovery-gmail-selected-resume-snapshot-evidence.js";
import {
  signSelectedLoadHistoryManifest,
  verifySelectedLoadHistoryManifest,
} from "../../lib/ingestion/recovery-gmail-selected-load-history.js";

const key = Buffer.alloc(32, 7);
const identity = {
  runId: "a".repeat(64),
  admissionSha256: "b".repeat(64),
  executionBaselineSha256: "c".repeat(64),
  priorFamilySha256: "d".repeat(64),
  ledgerRevision: "e".repeat(64),
  generation: 2,
};
const parts = {
  encryptedCatalog: Buffer.from("encrypted catalog fixture"),
  guardedJournal: Buffer.from("guarded journal fixture"),
  inventory: Buffer.from("inventory fixture"),
};

it("binds the exact history identity and each retained part without load authority", () => {
  const signed = signSelectedLoadHistoryManifest(identity, parts, key);
  const verified = verifySelectedLoadHistoryManifest(signed, key, identity);
  expect(verified.manifestSha256).toBe(sha256(signed));
  expect(verified.loadAllowed).toBe(false);
  for (const name of [
    "encryptedCatalog",
    "guardedJournal",
    "inventory",
  ] as const) {
    expect(verified.parts[name]).toEqual(describeResumeSnapshot(parts[name]));
    expect(restoreResumeSnapshot(verified.parts[name], [parts[name]])).toEqual(
      parts[name]
    );
    expect(() =>
      restoreResumeSnapshot(verified.parts[name], [
        Buffer.from("substituted part"),
      ])
    ).toThrow();
    expect(() => restoreResumeSnapshot(verified.parts[name], [])).toThrow();
  }
  expect(() =>
    verifySelectedLoadHistoryManifest(signed, Buffer.alloc(32, 8), identity)
  ).toThrow();
  for (const name of [
    "runId",
    "admissionSha256",
    "executionBaselineSha256",
    "priorFamilySha256",
    "ledgerRevision",
  ] as const)
    expect(() =>
      verifySelectedLoadHistoryManifest(signed, key, {
        ...identity,
        [name]: "f".repeat(64),
      })
    ).toThrow();
  expect(() =>
    verifySelectedLoadHistoryManifest(signed, key, {
      ...identity,
      generation: 3,
    })
  ).toThrow();
});

it("rejects invalid identity, noncanonical or changed signed manifests", () => {
  for (const name of [
    "runId",
    "admissionSha256",
    "executionBaselineSha256",
    "priorFamilySha256",
    "ledgerRevision",
  ] as const) {
    expect(() =>
      signSelectedLoadHistoryManifest(
        { ...identity, [name]: "A".repeat(64) },
        parts,
        key
      )
    ).toThrow();
    expect(() =>
      signSelectedLoadHistoryManifest(
        { ...identity, [name]: "short" },
        parts,
        key
      )
    ).toThrow();
  }
  for (const generation of [0, 1, -1, 2.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      signSelectedLoadHistoryManifest({ ...identity, generation }, parts, key)
    ).toThrow();
  const signed = signSelectedLoadHistoryManifest(identity, parts, key);
  const manifest = JSON.parse(signed.toString("utf8")) as Record<
    string,
    unknown
  >;
  const { signature: _signature, ...body } = manifest;
  for (const malformedBody of [
    { ...body, kind: "other" },
    { ...body, version: 999 },
    { ...body, extra: true },
    { ...body, ledgerRevision: "f".repeat(64) },
  ]) {
    const signature = createHmac("sha256", key)
      .update("zivv-selected-load-history/v1\0")
      .update(canonicalJson(malformedBody))
      .digest("hex");
    const malformed = Buffer.from(
      canonicalJson({ ...malformedBody, signature }) + "\n"
    );
    expect(() =>
      verifySelectedLoadHistoryManifest(malformed, key, identity)
    ).toThrow();
  }
  expect(() =>
    verifySelectedLoadHistoryManifest(
      Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
      key,
      identity
    )
  ).toThrow();
  expect(() =>
    verifySelectedLoadHistoryManifest(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), signed]),
      key,
      identity
    )
  ).toThrow();
});
