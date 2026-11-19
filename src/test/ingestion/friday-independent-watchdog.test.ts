import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { readVerifiedFridayWatchdogEvidence } from "../../lib/ingestion/friday-independent-watchdog.js";
import { FridayNoticeOutbox } from "../../lib/ingestion/friday-notice-outbox.js";

const keys = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const editionId = "2026-10-30";
const due = Date.parse("2026-10-30T15:00:00.000Z");
const kind = "zivv-friday-independent-watchdog";
const body = () => ({
  kind,
  version: 1,
  editionId,
  expectedStartEpochMs: due,
  observedAtEpochMs: due,
  coveredThroughEpochMs: due,
  status: "not-started",
});
function signed(value: object) {
  const signature = sign(
    null,
    Buffer.from(kind + "/v1\0" + canonicalJson(value)),
    keys.privateKey
  ).toString("hex");
  return Buffer.from(canonicalJson({ ...value, signature }) + "\n");
}
function input(bytes = signed(body())) {
  return {
    bytes,
    publicKey: keys.publicKey,
    editionId,
    expectedStartEpochMs: due,
    nowEpochMs: due,
    maxEvidenceAgeMs: 0,
  };
}

it("records only fresh signed coverage through the exact due time and deduplicates its claim", () => {
  const prefix = "zivv-friday-watchdog-";
  const root = resolve(mkdtempSync(join(tmpdir(), prefix)));
  const path = join(root, "outbox.sqlite");
  const db = new DatabaseSync(path);
  try {
    const outbox = FridayNoticeOutbox.initialize(db);
    const evidence = readVerifiedFridayWatchdogEvidence(input());
    expect(evidence).toEqual({
      editionId,
      nowEpochMs: due,
      maxEvidenceAgeMs: 0,
      evidence: {
        kind: "independent-watchdog",
        status: "not-started",
        expectedStartEpochMs: due,
        observedAtEpochMs: due,
      },
    });
    const pending = outbox.recordVerifiedWatchdog(input())!;
    expect(pending).toMatchObject({
      status: "pending",
      notice: {
        editionId,
        kind: "missed-start",
        dueAtEpochMs: due,
        key: `friday/${editionId}/missed-start/${due}`,
      },
    });
    expect(outbox.recordVerifiedWatchdog(input())).toEqual(pending);
    const claim = outbox.claim(pending.notice.key)!;
    expect(claim).toMatchObject({
      status: "delivery-unknown",
      attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(outbox.recordVerifiedWatchdog(input())).toEqual(claim);
    expect(outbox.claim(pending.notice.key)).toBeNull();
    const reopened = new DatabaseSync(path);
    try {
      const second = new FridayNoticeOutbox(reopened);
      expect(second.inspect(pending.notice.key)).toEqual(claim);
      expect(second.claim(pending.notice.key)).toBeNull();
    } finally {
      reopened.close();
    }
    expect(
      outbox.recordVerifiedWatchdog(
        input(signed({ ...body(), coveredThroughEpochMs: due - 1 }))
      )
    ).toBeNull();
    expect(
      outbox.recordVerifiedWatchdog({ ...input(), nowEpochMs: due + 1 })
    ).toBeNull();
    const freshSignatureOldCoverage = signed({
      ...body(),
      observedAtEpochMs: due + 1000,
      coveredThroughEpochMs: due,
    });
    expect(
      outbox.recordVerifiedWatchdog({
        ...input(freshSignatureOldCoverage),
        nowEpochMs: due + 1000,
        maxEvidenceAgeMs: 999,
      })
    ).toBeNull();
    for (const status of ["started", "unknown"] as const) {
      const value = {
        ...body(),
        status,
        coveredThroughEpochMs: status === "unknown" ? null : due,
      };
      expect(outbox.recordVerifiedWatchdog(input(signed(value)))).toBeNull();
    }
  } finally {
    db.close();
    if (
      dirname(root) !== resolve(tmpdir()) ||
      !basename(root).startsWith(prefix)
    )
      throw Error("UNSAFE_TEST_CLEANUP");
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects substituted authority, changed content and noncanonical or future evidence", () => {
  const good = input();
  const changed = JSON.parse(good.bytes.toString()) as Record<string, unknown>;
  const cases = [
    { ...good, publicKey: other.publicKey },
    { ...good, publicKey: keys.privateKey },
    { ...good, editionId: "2026-11-06" },
    { ...good, expectedStartEpochMs: due + 1 },
    { ...good, nowEpochMs: due - 1 },
    { ...good, maxEvidenceAgeMs: -1 },
    {
      ...good,
      bytes: Buffer.from(
        canonicalJson({ ...changed, status: "started" }) + "\n"
      ),
    },
    {
      ...good,
      bytes: Buffer.from(
        canonicalJson({ ...changed, signature: "0".repeat(128) }) + "\n"
      ),
    },
    { ...good, bytes: Buffer.from(JSON.stringify(changed, null, 2) + "\n") },
    { ...good, bytes: Buffer.concat([good.bytes, Buffer.from("\n")]) },
    { ...good, bytes: signed({ ...body(), extra: "private-synthetic" }) },
  ];
  for (const value of cases)
    expect(() => readVerifiedFridayWatchdogEvidence(value)).toThrow(
      "FRIDAY_WATCHDOG_OBSERVATION_UNVERIFIED"
    );
});
