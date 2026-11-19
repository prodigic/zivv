import { describe, expect, it, vi } from "vitest";
import { superviseFridayGmailPoll } from "../../lib/ingestion/steve-gmail-friday-poll";
import type { SteveGmailBatchResult } from "../../lib/ingestion/steve-gmail-handoff";

const start = Date.parse("2026-11-06T08:00:00Z");
const cutoff = Date.parse("2026-11-09T08:00:00Z");
const input = { editionId: "2026-11-06", scanStartsAtEpochMs: start };
const empty: SteveGmailBatchResult = {
  status: "missing",
  replayed: false,
  batchIds: [],
  messageCount: 0,
  receipts: [],
};
const captured: SteveGmailBatchResult = {
  status: "captured",
  replayed: false,
  batchIds: ["batch"],
  messageCount: 1,
  receipts: [
    {
      receiptId: "receipt",
      sourceSha256: "hash",
      firstObservedAtEpochMs: start,
      disposition: "ready",
    },
  ],
};

function fixture(now: number, result: SteveGmailBatchResult = empty) {
  const clock = vi.fn(() => now);
  const wait = vi.fn(async (_delay: number) => {});
  const capture = vi.fn(
    async (_bounds: {
      startEpochMs: number;
      endEpochMs: number;
      requireStableMailboxForMissing: true;
    }) => result
  );
  return { clock, wait, capture };
}

describe("supervised Friday Gmail poll", () => {
  it("does not scan before start or at Monday midnight", async () => {
    const early = fixture(start - 1);
    expect(await superviseFridayGmailPoll(input, early)).toEqual({
      status: "not-open",
      editionId: input.editionId,
      nextAtEpochMs: start,
    });
    const late = fixture(cutoff);
    expect(await superviseFridayGmailPoll(input, late)).toEqual({
      status: "closed-for-review",
      editionId: input.editionId,
      reviewAtEpochMs: cutoff,
    });
    expect(early.capture).not.toHaveBeenCalled();
    expect(late.capture).not.toHaveBeenCalled();
    expect(early.wait).not.toHaveBeenCalled();
    expect(late.wait).not.toHaveBeenCalled();
  });

  it("records an exact inclusive scan through the sampled instant", async () => {
    const deps = fixture(start);
    expect(await superviseFridayGmailPoll(input, deps)).toEqual({
      status: "missing",
      editionId: input.editionId,
      attempts: 1,
      mailboxEvidence: {
        kind: "mailbox-scan",
        status: "absent",
        scannedThroughEpochMs: start,
      },
    });
    expect(deps.capture).toHaveBeenCalledWith({
      startEpochMs: start,
      endEpochMs: start + 1,
      requireStableMailboxForMissing: true,
    });
  });

  it("caps the final scan at the Monday boundary", async () => {
    const deps = fixture(cutoff - 1);
    const result = await superviseFridayGmailPoll(input, deps);
    expect(result).toMatchObject({
      status: "missing",
      mailboxEvidence: { scannedThroughEpochMs: cutoff - 1 },
    });
    expect(deps.capture).toHaveBeenCalledWith({
      startEpochMs: start,
      endEpochMs: cutoff,
      requireStableMailboxForMissing: true,
    });
  });

  it("uses the Pacific offset on a daylight-saving transition weekend", async () => {
    const springStart = Date.parse("2026-03-06T08:00:00Z");
    const springCutoff = Date.parse("2026-03-09T07:00:00Z");
    const deps = fixture(springCutoff);
    expect(
      await superviseFridayGmailPoll(
        { editionId: "2026-03-06", scanStartsAtEpochMs: springStart },
        deps
      )
    ).toEqual({
      status: "closed-for-review",
      editionId: "2026-03-06",
      reviewAtEpochMs: springCutoff,
    });
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("returns captured batch intact without absence evidence", async () => {
    const deps = fixture(start, captured);
    expect(await superviseFridayGmailPoll(input, deps)).toEqual({
      status: "captured",
      editionId: input.editionId,
      attempts: 1,
      batch: captured,
    });
  });

  it.each([
    { ...empty, replayed: true },
    { ...empty, messageCount: 1 },
    { ...empty, batchIds: ["unexpected"] },
    { ...empty, receipts: captured.receipts },
  ])("rejects unverified missing shape %#", async (result) => {
    await expect(
      superviseFridayGmailPoll(input, fixture(start, result))
    ).rejects.toThrow("GMAIL_MAILBOX_OBSERVATION_UNVERIFIED");
  });

  it.each([
    "GMAIL_RETRYABLE_FAILURE",
    "GMAIL_TRANSPORT_FAILED",
    "GMAIL_AUTH_RETRYABLE_FAILURE",
    "GMAIL_AUTH_TRANSPORT_FAILED",
    "GMAIL_CREDENTIAL_STORAGE_BUSY",
    "GMAIL_MAILBOX_OBSERVATION_CHANGED",
  ])("retries %s with fresh scan bounds", async (code) => {
    let now = start;
    const deps = fixture(now);
    deps.clock.mockImplementation(() => now);
    deps.wait.mockImplementation(async (delay) => {
      now += delay;
    });
    deps.capture
      .mockRejectedValueOnce(new Error(code))
      .mockRejectedValueOnce(new Error(code))
      .mockResolvedValueOnce(empty);
    const result = await superviseFridayGmailPoll(input, deps);
    expect(result).toMatchObject({
      status: "missing",
      attempts: 3,
      mailboxEvidence: { scannedThroughEpochMs: start + 10000 },
    });
    expect(deps.wait.mock.calls).toEqual([[2000], [8000]]);
    expect(
      deps.capture.mock.calls.map(([bounds]) => bounds.endEpochMs)
    ).toEqual([start + 1, start + 2001, start + 10001]);
  });

  it("propagates the final retryable error after exhausting retries", async () => {
    const deps = fixture(start);
    const error = new Error("GMAIL_TRANSPORT_FAILED");
    deps.capture.mockRejectedValue(error);
    await expect(superviseFridayGmailPoll(input, deps)).rejects.toBe(error);
    expect(deps.capture).toHaveBeenCalledTimes(3);
    expect(deps.wait.mock.calls).toEqual([[2000], [8000]]);
  });

  it("propagates nonretryable errors immediately", async () => {
    const deps = fixture(start);
    const error = new Error("GMAIL_AUTH_FAILED");
    deps.capture.mockRejectedValue(error);
    await expect(superviseFridayGmailPoll(input, deps)).rejects.toBe(error);
    expect(deps.wait).not.toHaveBeenCalled();
  });

  it("never retries across the Monday cutoff", async () => {
    let now = cutoff - 1000;
    const deps = fixture(now);
    deps.clock.mockImplementation(() => now);
    deps.wait.mockImplementation(async (delay) => {
      now += delay;
    });
    const error = new Error("GMAIL_TRANSPORT_FAILED");
    deps.capture.mockRejectedValue(error);
    await expect(superviseFridayGmailPoll(input, deps)).rejects.toBe(error);
    expect(deps.capture).toHaveBeenCalledTimes(1);
  });

  it.each([
    { editionId: "not-a-date", scanStartsAtEpochMs: start },
    { editionId: "2026-11-07", scanStartsAtEpochMs: start },
    { editionId: "2026-11-06", scanStartsAtEpochMs: start + 1 },
    { editionId: "2026-11-06", scanStartsAtEpochMs: -1 },
  ])("rejects invalid poll window %#", async (bad) => {
    const deps = fixture(start);
    await expect(superviseFridayGmailPoll(bad, deps)).rejects.toThrow(
      "INVALID_GMAIL_FRIDAY_POLL_WINDOW"
    );
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("rejects a clock that reverses during retry", async () => {
    const deps = fixture(start + 5000);
    deps.clock.mockReturnValueOnce(start + 5000).mockReturnValue(start + 4000);
    deps.capture.mockRejectedValueOnce(new Error("GMAIL_TRANSPORT_FAILED"));
    await expect(superviseFridayGmailPoll(input, deps)).rejects.toThrow(
      "INVALID_GMAIL_FRIDAY_POLL_WINDOW"
    );
  });
});
