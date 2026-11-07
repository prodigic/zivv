import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  linkSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeSelectedLoadIntentSuccessors } from "../../lib/ingestion/recovery-gmail-selected-intent-successors.js";
import type { RecoveryRuntimeEntry } from "../../lib/ingestion/recovery-runtime.js";
import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { verifySelectedLoadIntentChain } from "../../lib/ingestion/recovery-gmail-selected-intent-chain.js";

it("validates v2 successor bindings for either predecessor fence", () => {
  const key = Buffer.alloc(32, 9),
    id = "d".repeat(64),
    hash = sha256("selected-load/" + id),
    owner = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join("-");
  const sign = (body: object, domain: string) =>
    Buffer.from(
      canonicalJson({
        ...body,
        signature: createHmac("sha256", key)
          .update(domain + "\0")
          .update(canonicalJson(body))
          .digest("hex"),
      }) + "\n"
    );
  const initial = sign(
    {
      kind: "zivv-selected-load-resume-intent",
      version: 2,
      snapshotEvidence: null,
      admissionSha256: id,
      executionBaselineSha256: id,
      journalSha256: id,
      inventorySha256: id,
      ledgerRevision: id,
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
    },
    "zivv-selected-load-resume-intent/v1"
  );
  const initialSha256 = sha256(initial);
  const make = (
    previousOwner: object,
    fence: number,
    startedAtEpochMs: number,
    sequence = 1,
    parentSha256 = initialSha256,
    journalSha256 = id
  ) =>
    sign(
      {
        kind: "zivv-selected-load-intent-successor",
        version: 2,
        initialSha256,
        parentSha256,
        sequence,
        journalSha256,
        previousOwner,
        fence,
        owner,
        startedAtEpochMs,
        deadlineEpochMs: startedAtEpochMs + 180000,
      },
      "zivv-selected-load-intent-successor/v2"
    );
  const unacquired = make(
    {
      scope: "prodigic/zivv/production",
      owner,
      fence: 1,
      expiresAtEpochMs: 1000,
    },
    2,
    181000
  );
  const acquired = make(
    {
      scope: "prodigic/zivv/production",
      owner,
      fence: 2,
      expiresAtEpochMs: 181000,
    },
    3,
    181000
  );
  expect(
    verifySelectedLoadIntentChain(initial, [unacquired], key)
  ).toMatchObject({
    successorProtocol: "v2-journal-bound",
    successorCount: 1,
    loadAllowed: false,
  });
  expect(verifySelectedLoadIntentChain(initial, [acquired], key)).toMatchObject(
    {
      successorProtocol: "v2-journal-bound",
      successorCount: 1,
      loadAllowed: false,
    }
  );
  const later = make(
    {
      scope: "prodigic/zivv/production",
      owner,
      fence: 2,
      expiresAtEpochMs: 271000,
    },
    3,
    361000,
    2,
    sha256(unacquired),
    "e".repeat(64)
  );
  expect(
    verifySelectedLoadIntentChain(initial, [unacquired, later], key)
  ).toMatchObject({
    successorProtocol: "v2-journal-bound",
    successorCount: 2,
    lastSha256: sha256(later),
    latestV2Successor: {
      successorSha256: sha256(later),
      sequence: 2,
      journalSha256: "e".repeat(64),
      previousOwner: {
        scope: "prodigic/zivv/production",
        owner,
        fence: 2,
        expiresAtEpochMs: 271000,
      },
      fence: 3,
      owner,
      startedAtEpochMs: 361000,
      deadlineEpochMs: 541000,
    },
  });
  const latest = verifySelectedLoadIntentChain(
    initial,
    [unacquired, later],
    key
  ).latestV2Successor!;
  expect(Object.isFrozen(latest)).toBe(true);
  expect(Object.isFrozen(latest.previousOwner)).toBe(true);
  expect(Reflect.set(latest.previousOwner, "fence", 99)).toBe(false);
  expect(latest.previousOwner.fence).toBe(2);
  const valid = JSON.parse(unacquired.toString("utf8"));
  for (const body of [
    { ...valid, journalSha256: "invalid" },
    { ...valid, owner: "00000000-0000-0000-0000-000000000000" },
    { ...valid, fence: 4 },
    { ...valid, startedAtEpochMs: 180999, deadlineEpochMs: 360999 },
    { ...valid, unexpected: true },
  ]) {
    const { signature: _signature, ...unsigned } = body;
    expect(() =>
      verifySelectedLoadIntentChain(
        initial,
        [sign(unsigned, "zivv-selected-load-intent-successor/v2")],
        key
      )
    ).toThrow();
  }
  const wrongSignature = { ...valid, signature: "f".repeat(64) };
  expect(() =>
    verifySelectedLoadIntentChain(
      initial,
      [Buffer.from(canonicalJson(wrongSignature) + "\n")],
      key
    )
  ).toThrow();
  expect(() =>
    verifySelectedLoadIntentChain(
      initial,
      [Buffer.from(JSON.stringify(valid, null, 2) + "\n")],
      key
    )
  ).toThrow();
  expect(() =>
    verifySelectedLoadIntentChain(initial, [unacquired], Buffer.alloc(32, 8))
  ).toThrow();
});

it("authenticates ordered, non-overlapping signed intent successors without authority", () => {
  const key = Buffer.alloc(32, 4),
    id = "a".repeat(64),
    hash = sha256("selected-load/" + id),
    owner = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      hash.slice(12, 16),
      hash.slice(16, 20),
      hash.slice(20, 32),
    ].join("-");
  const sign = (body: object, domain: string) =>
    Buffer.from(
      canonicalJson({
        ...body,
        signature: createHmac("sha256", key)
          .update(domain + "\0")
          .update(canonicalJson(body))
          .digest("hex"),
      }) + "\n"
    );
  const initial = sign(
    {
      kind: "zivv-selected-load-resume-intent",
      version: 2,
      snapshotEvidence: null,
      admissionSha256: id,
      executionBaselineSha256: id,
      journalSha256: id,
      inventorySha256: id,
      ledgerRevision: id,
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
    },
    "zivv-selected-load-resume-intent/v1"
  );
  const one = {
    kind: "zivv-selected-load-intent-successor",
    version: 1,
    initialSha256: sha256(initial),
    parentSha256: sha256(initial),
    sequence: 1,
    startedAtEpochMs: 181000,
    deadlineEpochMs: 361000,
  };
  const first = sign(one, "zivv-selected-load-intent-successor/v1");
  const two = {
    ...one,
    parentSha256: sha256(first),
    sequence: 2,
    startedAtEpochMs: 361000,
    deadlineEpochMs: 541000,
  };
  const second = sign(two, "zivv-selected-load-intent-successor/v1");
  expect(
    verifySelectedLoadIntentChain(initial, [first, second], key)
  ).toMatchObject({
    successorProtocol: "v1-observation",
    successorCount: 2,
    lastSha256: sha256(second),
    effectiveDeadlineEpochMs: 541000,
    loadAllowed: false,
    activationAllowed: false,
  });
  expect(
    verifySelectedLoadIntentChain(initial, [first, second], key)
  ).not.toHaveProperty("latestV2Successor");
  for (const bad of [
    { ...one, startedAtEpochMs: 180999, deadlineEpochMs: 360999 },
    { ...one, parentSha256: "b".repeat(64) },
    { ...one, initialSha256: "c".repeat(64) },
    { ...one, sequence: 2 },
    { ...one, deadlineEpochMs: 361001 },
    { ...one, extra: true },
  ])
    expect(() =>
      verifySelectedLoadIntentChain(
        initial,
        [sign(bad, "zivv-selected-load-intent-successor/v1")],
        key
      )
    ).toThrow();
  expect(() => verifySelectedLoadIntentChain(initial, [second], key)).toThrow();
  expect(() =>
    verifySelectedLoadIntentChain(initial, [first, first], key)
  ).toThrow();
  expect(() =>
    verifySelectedLoadIntentChain(initial, [first], Buffer.alloc(32, 3))
  ).toThrow();
  expect(() =>
    verifySelectedLoadIntentChain(
      initial,
      [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), first])],
      key
    )
  ).toThrow();
  const root = mkdtempSync(join(tmpdir(), "zivv-intent-chain-"));
  const loadPath = "recovery-gmail-load/" + id,
    firstPath = loadPath + "/resume-successor-00001.json",
    firstStage = firstPath + "-stage",
    secondPath = loadPath + "/resume-successor-00002.json",
    secondStage = secondPath + "-stage",
    candidate =
      secondStage + "/resume-successor-00002.json.123.0123456789abcdef.tmp";
  const file = (path: string): RecoveryRuntimeEntry => {
    const data = readFileSync(join(root, path));
    return { path, kind: "file", size: data.length, sha256: sha256(data) };
  };
  try {
    expect(
      observeSelectedLoadIntentSuccessors({
        destination: root,
        loadPath,
        entries: [],
        initial,
        key,
        initialSettled: false,
      })
    ).toMatchObject({ successorCount: 0, lastSettled: false });
    mkdirSync(join(root, firstStage), { recursive: true });
    mkdirSync(join(root, secondStage), { recursive: true });
    writeFileSync(join(root, firstPath), first);
    writeFileSync(join(root, candidate), second);
    const entries: RecoveryRuntimeEntry[] = [
      { path: firstStage, kind: "directory" },
      file(firstPath),
      { path: secondStage, kind: "directory" },
      file(candidate),
    ];
    expect(
      observeSelectedLoadIntentSuccessors({
        destination: root,
        loadPath,
        entries,
        initial,
        key,
        initialSettled: true,
      })
    ).toMatchObject({
      successorCount: 2,
      lastSettled: false,
      loadAllowed: false,
    });
    expect(() =>
      observeSelectedLoadIntentSuccessors({
        destination: root,
        loadPath,
        entries,
        initial,
        key,
        initialSettled: false,
      })
    ).toThrow();
    expect(() =>
      observeSelectedLoadIntentSuccessors({
        destination: root,
        loadPath,
        entries: entries.slice(2),
        initial,
        key,
        initialSettled: true,
      })
    ).toThrow();
    linkSync(join(root, candidate), join(root, secondPath));
    const linked = [...entries, file(secondPath)];
    expect(
      observeSelectedLoadIntentSuccessors({
        destination: root,
        loadPath,
        entries: linked,
        initial,
        key,
        initialSettled: true,
      })
    ).toMatchObject({ successorCount: 2, lastSettled: false });
    expect(() =>
      observeSelectedLoadIntentSuccessors({
        destination: root,
        loadPath,
        entries: [
          ...linked,
          {
            path: loadPath + "/resume-successor-unexpected",
            kind: "directory",
          },
        ],
        initial,
        key,
        initialSettled: true,
      })
    ).toThrow();
    expect(lstatSync(join(root, secondPath)).nlink).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
