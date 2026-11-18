import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  signNextSelectedLoadResumeIntent,
  verifyNextSelectedLoadResumeIntent,
  type NextSelectedLoadResumeGap,
} from "../../lib/ingestion/recovery-gmail-selected-load-next-resume-intent.js";
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
const gap: NextSelectedLoadResumeGap = {
  runId: sha256("retained B run"),
  admissionSha256,
  executionBaselineSha256: sha256("B start record"),
  priorLoadFamilySha256: sha256("complete A"),
  journalSha256: sha256("interrupted journal"),
  inventorySha256: sha256("interrupted inventory"),
  ledgerRevision: sha256("committed B ledger"),
  generation: 3,
  previousOwner: {
    scope: "prodigic/zivv/production",
    owner,
    fence: 12,
    expiresAtEpochMs: epoch,
  },
  backupSha256: sha256("inherited snapshot"),
  backupSize: 53,
  reportPresent: true,
};
const invalid = "INVALID_NEXT_SELECTED_LOAD_RESUME_INTENT";

describe("signed second-load resume intent", () => {
  it("binds an exact gap to the same owner and next fence after expiry", () => {
    const bytes = signNextSelectedLoadResumeIntent(gap, epoch + 1, key);
    expect(verifyNextSelectedLoadResumeIntent(bytes, key)).toEqual({
      ...gap,
      owner,
      fence: 13,
      startedAtEpochMs: epoch + 1,
      deadlineEpochMs: epoch + 180001,
    });
    expect(() => signNextSelectedLoadResumeIntent(gap, epoch, key)).toThrow(
      invalid
    );
    expect(() =>
      verifyNextSelectedLoadResumeIntent(bytes, Buffer.alloc(32, 27))
    ).toThrow(invalid);
  });

  it("rejects a committed gap without its report or a skipped fence even with a valid MAC", () => {
    const bytes = signNextSelectedLoadResumeIntent(gap, epoch + 1, key);
    const original = JSON.parse(bytes.toString("utf8")) as {
      kind: string;
      version: number;
      intent: Record<string, unknown>;
    };
    for (const change of [{ reportPresent: false }, { fence: 14 }]) {
      const payload = {
        kind: original.kind,
        version: original.version,
        intent: { ...original.intent, ...change },
      };
      const signature = createHmac("sha256", key)
        .update("zivv-selected-next-load-resume-intent/v1\0")
        .update(canonicalJson(payload))
        .digest("hex");
      expect(() =>
        verifyNextSelectedLoadResumeIntent(
          Buffer.from(canonicalJson({ ...payload, signature }) + "\n"),
          key
        )
      ).toThrow(invalid);
    }
  });
});
