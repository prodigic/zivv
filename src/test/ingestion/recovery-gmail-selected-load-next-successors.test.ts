import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  prepareNextSelectedLoadResumeSuccessor,
  readNextSelectedLoadResumeSuccessors,
  rewindNextSelectedLoadAcquiredRetries,
} from "../../lib/ingestion/recovery-gmail-selected-load-next-successors.js";
import {
  signNextSelectedLoadResumeIntent,
  verifyNextSelectedLoadResumeIntent,
  type NextSelectedLoadResumeGap,
} from "../../lib/ingestion/recovery-gmail-selected-load-next-resume-intent.js";
import type { RecoveryRuntimeEntry } from "../../lib/ingestion/recovery-runtime.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";

const key = Buffer.alloc(32, 26);
const admissionSha256 = sha256("selected B admission");
const hash = sha256("selected-load/" + admissionSha256);
const owner = [
  hash.slice(0, 8),
  hash.slice(8, 12),
  hash.slice(12, 16),
  hash.slice(16, 20),
  hash.slice(20, 32),
].join("-");
const epoch = 1_700_000_000_000;
const path = "recovery-gmail-load/" + sha256("retained B run");
const previousOwner = {
  scope: "prodigic/zivv/production",
  owner,
  fence: 12,
  expiresAtEpochMs: epoch,
};
const otherOwner = {
  scope: "another/scope",
  owner,
  fence: 3,
  expiresAtEpochMs: epoch,
};
const journal = (lease: typeof previousOwner, other = otherOwner) => {
  const body = {
    format: "zivv-weekly-journal-recovery",
    version: 1,
    journalSchemaVersion: 3,
    ownership: [other, lease],
    runState: [],
    stageArtifacts: [],
    intakeEvidence: [],
  };
  return Buffer.from(
    canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
  );
};
const gap: NextSelectedLoadResumeGap = {
  runId: sha256("retained B run"),
  admissionSha256,
  executionBaselineSha256: sha256("B start record"),
  priorLoadFamilySha256: sha256("complete A"),
  journalSha256: sha256(journal(previousOwner)),
  inventorySha256: sha256("inventory"),
  ledgerRevision: sha256("ledger"),
  generation: 3,
  previousOwner,
  backupSha256: sha256("snapshot"),
  backupSize: 53,
  reportPresent: true,
};
const initialBytes = signNextSelectedLoadResumeIntent(gap, epoch + 1, key);
const initial = {
  bytes: initialBytes,
  intent: verifyNextSelectedLoadResumeIntent(initialBytes, key),
};
const acquiredInitial = {
  ...previousOwner,
  fence: initial.intent.fence,
  expiresAtEpochMs: epoch + 100_000,
};
const first = prepareNextSelectedLoadResumeSuccessor({
  initial,
  parent: initial,
  sequence: 1,
  journal: journal(acquiredInitial),
  previousOwner: acquiredInitial,
  startedAtEpochMs: initial.intent.deadlineEpochMs,
  key,
});
const acquiredFirst = {
  ...previousOwner,
  fence: first.intent.fence,
  expiresAtEpochMs: first.intent.startedAtEpochMs + 100_000,
};
const second = prepareNextSelectedLoadResumeSuccessor({
  initial,
  parent: first,
  sequence: 2,
  journal: journal(acquiredFirst),
  previousOwner: acquiredFirst,
  startedAtEpochMs: first.intent.deadlineEpochMs,
  key,
});
const acquiredSecond = {
  ...previousOwner,
  fence: second.intent.fence,
  expiresAtEpochMs: second.intent.startedAtEpochMs + 100_000,
};
const fileEntry = (name: string, bytes: Buffer): RecoveryRuntimeEntry => ({
  path: path + "/" + name,
  kind: "file",
  size: bytes.length,
  sha256: sha256(bytes),
});
const stageEntry = (name: string): RecoveryRuntimeEntry => ({
  path: path + "/" + name + "-stage",
  kind: "directory",
});
const entries = [
  fileEntry(first.filename, first.bytes),
  stageEntry(first.filename),
  fileEntry(second.filename, second.bytes),
  stageEntry(second.filename),
];
const files = new Map([
  [path + "/" + first.filename, first.bytes],
  [path + "/" + second.filename, second.bytes],
]);
const read = (name: string) => {
  const value = files.get(name);
  if (!value) throw Error("missing");
  return value;
};
const verify = (
  inputEntries = entries,
  init: typeof initial | null = initial,
  reader = read
) =>
  readNextSelectedLoadResumeSuccessors({
    loadPath: path,
    entries: inputEntries,
    read: reader,
    initial: init ?? undefined,
    key,
  });

describe("B signed resume successor codec", () => {
  it("binds one generation-two rollback commit in a distinct signed version", () => {
    const bytes = signNextSelectedLoadResumeIntent(
      { ...gap, generation: 2 },
      epoch + 1,
      key
    );
    const original = {
      bytes,
      intent: verifyNextSelectedLoadResumeIntent(bytes, key),
    };
    const committedRollback = {
      ledgerRevision: sha256("exact committed B"),
      inventorySha256: sha256("exact committed inventory"),
    };
    const options = {
      initial: original,
      parent: original,
      sequence: 1,
      journal: journal(acquiredInitial),
      previousOwner: acquiredInitial,
      startedAtEpochMs: original.intent.deadlineEpochMs,
      key,
      committedRollback,
    };
    const transition = prepareNextSelectedLoadResumeSuccessor(options);
    const listed = [
      fileEntry(transition.filename, transition.bytes),
      stageEntry(transition.filename),
    ];
    const decoded = verify(listed, original, () => transition.bytes);
    expect(decoded[0]!.intent.committedRollback).toEqual(committedRollback);
    const body = JSON.parse(transition.bytes.toString("utf8"));
    expect(body.version).toBe(2);
    const forged = Buffer.from(canonicalJson({ ...body, version: 1 }) + "\n");
    expect(() => verify(listed, original, () => forged)).toThrow();
    expect(() =>
      prepareNextSelectedLoadResumeSuccessor({
        ...options,
        initial,
        parent: initial,
      })
    ).toThrow();
    const duplicate = prepareNextSelectedLoadResumeSuccessor({
      ...options,
      parent: transition,
      sequence: 2,
      journal: journal(acquiredFirst),
      previousOwner: acquiredFirst,
      startedAtEpochMs: transition.intent.deadlineEpochMs,
    });
    expect(() =>
      verify(
        [
          ...listed,
          fileEntry(duplicate.filename, duplicate.bytes),
          stageEntry(duplicate.filename),
        ],
        original,
        (name) =>
          name.endsWith(duplicate.filename) ? duplicate.bytes : transition.bytes
      )
    ).toThrow();
  });

  it("authenticates a canonical two-link chain and rewinds only the acquired owner", () => {
    const chain = verify();
    expect(chain.map(({ intent }) => intent.sequence)).toEqual([1, 2]);
    expect(chain[1]!.intent.parentSha256).toBe(sha256(first.bytes));
    expect(
      rewindNextSelectedLoadAcquiredRetries(journal(acquiredSecond), [
        initial,
        ...chain,
      ])
    ).toEqual(journal(previousOwner));
    expect(() =>
      rewindNextSelectedLoadAcquiredRetries(
        journal(acquiredSecond, { ...otherOwner, fence: 4 }),
        [initial, ...chain]
      )
    ).toThrow();
    expect(() =>
      rewindNextSelectedLoadAcquiredRetries(journal(acquiredSecond), [
        initial,
        chain[0]!,
        {
          ...chain[1]!,
          intent: { ...chain[1]!.intent, journalSha256: sha256("substituted") },
        },
      ])
    ).toThrow();
  });

  it("rejects missing, dirty, or substituted stage/file and absent initial", () => {
    expect(() => verify(entries.slice(1))).toThrow();
    expect(() =>
      verify([
        ...entries,
        {
          path: path + "/" + first.filename + "-stage/extra",
          kind: "directory",
        },
      ])
    ).toThrow();
    expect(() =>
      verify(
        entries.map((entry) =>
          entry.path.endsWith(first.filename + "-stage")
            ? { path: entry.path, kind: "file", size: 0, sha256: sha256("") }
            : entry
        )
      )
    ).toThrow();
    expect(() => verify(entries, null)).toThrow();
    expect(() =>
      verify(entries, initial, (name) =>
        name.endsWith(first.filename) ? second.bytes : read(name)
      )
    ).toThrow();
  });

  it("rejects a wrong parent even when the altered record has a valid MAC", () => {
    const original = JSON.parse(second.bytes.toString("utf8")) as {
      kind: string;
      version: number;
      intent: Record<string, unknown>;
    };
    const body = {
      kind: original.kind,
      version: original.version,
      intent: { ...original.intent, parentSha256: sha256("wrong parent") },
    };
    const signature = createHmac("sha256", key)
      .update("zivv-selected-next-load-resume-successor/v1\0")
      .update(canonicalJson(body))
      .digest("hex");
    const substituted = Buffer.from(
      canonicalJson({ ...body, signature }) + "\n"
    );
    expect(() =>
      verify(entries, initial, (name) =>
        name.endsWith(second.filename) ? substituted : read(name)
      )
    ).toThrow();
  });

  it("refuses early successors and mismatched previous expiry or fence", () => {
    const base = {
      initial,
      parent: initial,
      sequence: 1,
      journal: journal(acquiredInitial),
      previousOwner: acquiredInitial,
      startedAtEpochMs: initial.intent.deadlineEpochMs,
      key,
    };
    expect(() =>
      prepareNextSelectedLoadResumeSuccessor({
        ...base,
        startedAtEpochMs: initial.intent.deadlineEpochMs - 1,
      })
    ).toThrow();
    expect(() =>
      prepareNextSelectedLoadResumeSuccessor({
        ...base,
        previousOwner: {
          ...acquiredInitial,
          expiresAtEpochMs: initial.intent.deadlineEpochMs + 1,
        },
      })
    ).toThrow();
    expect(() =>
      prepareNextSelectedLoadResumeSuccessor({
        ...base,
        previousOwner: { ...acquiredInitial, fence: acquiredInitial.fence + 1 },
      })
    ).toThrow();
  });
});
