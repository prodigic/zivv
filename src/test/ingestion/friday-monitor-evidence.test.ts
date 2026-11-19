import { describe, expect, it, vi } from "vitest";
import {
  planFridayMonitorNotice,
  type FridayMonitorEvaluation,
} from "../../lib/ingestion/friday-monitor-evidence.js";

const due = Date.parse("2026-10-31T01:00:00.000Z");
const mailbox = (): FridayMonitorEvaluation => ({
  editionId: "2026-10-30",
  nowEpochMs: due,
  maxEvidenceAgeMs: 60_000,
  evidence: {
    kind: "mailbox-scan",
    status: "absent",
    scannedThroughEpochMs: due,
  },
});
const watchdog = (): FridayMonitorEvaluation => ({
  editionId: "2026-10-30",
  nowEpochMs: due + 10_000,
  maxEvidenceAgeMs: 60_000,
  evidence: {
    kind: "independent-watchdog",
    status: "not-started",
    expectedStartEpochMs: due,
    observedAtEpochMs: due + 10_000,
  },
});
const evaluateUnknown = (value: unknown) =>
  planFridayMonitorNotice(value as FridayMonitorEvaluation);

function expectInvalid(value: unknown): void {
  expect(() => evaluateUnknown(value)).toThrow(
    "INVALID_FRIDAY_MONITOR_EVIDENCE"
  );
}

describe("Friday monitor evidence decisions", () => {
  it("requires the Friday 18:00 Pacific deadline and a scan through that instant", () => {
    const base = mailbox();
    expect(
      planFridayMonitorNotice({
        ...base,
        nowEpochMs: due - 1,
        evidence: {
          kind: "mailbox-scan",
          status: "absent",
          scannedThroughEpochMs: due - 1,
        },
      })
    ).toBeNull();
    expect(
      planFridayMonitorNotice({
        ...base,
        evidence: {
          kind: "mailbox-scan",
          status: "absent",
          scannedThroughEpochMs: due - 1,
        },
      })
    ).toBeNull();
    expect(planFridayMonitorNotice(base)).toMatchObject({
      schemaVersion: 1,
      editionId: "2026-10-30",
      kind: "missing-source",
      dueAtEpochMs: due,
      key: expect.any(String),
    });
    const later = due + 2 * 86_400_000;
    expect(
      planFridayMonitorNotice({
        ...base,
        nowEpochMs: later,
        evidence: {
          kind: "mailbox-scan",
          status: "absent",
          scannedThroughEpochMs: later,
        },
      })
    ).toMatchObject({ kind: "missing-source", dueAtEpochMs: due });
  });

  it.each([
    ["2026-03-06", "2026-03-07T02:00:00.000Z"],
    ["2026-03-13", "2026-03-14T01:00:00.000Z"],
    ["2026-10-30", "2026-10-31T01:00:00.000Z"],
    ["2026-11-06", "2026-11-07T02:00:00.000Z"],
  ])("uses the Pacific Friday alert boundary for %s", (editionId, utc) => {
    const deadline = Date.parse(utc);
    expect(
      planFridayMonitorNotice({
        editionId,
        nowEpochMs: deadline,
        maxEvidenceAgeMs: 0,
        evidence: {
          kind: "mailbox-scan",
          status: "absent",
          scannedThroughEpochMs: deadline,
        },
      })
    ).toMatchObject({ kind: "missing-source", dueAtEpochMs: deadline });
  });

  it("requires fresh evidence while accepting exact age equality", () => {
    const base = mailbox();
    const observed = due + 1_000;
    const evidence = {
      kind: "mailbox-scan" as const,
      status: "absent" as const,
      scannedThroughEpochMs: observed,
    };
    expect(
      planFridayMonitorNotice({
        ...base,
        nowEpochMs: observed + 60_000,
        evidence,
      })
    ).not.toBeNull();
    expect(
      planFridayMonitorNotice({
        ...base,
        nowEpochMs: observed + 60_001,
        evidence,
      })
    ).toBeNull();
    for (const status of ["ready", "unknown"] as const)
      expect(
        planFridayMonitorNotice({
          ...base,
          evidence: { ...evidence, status },
          nowEpochMs: observed,
        })
      ).toBeNull();
  });

  it("requires an independent observation at or after the expected start", () => {
    const base = watchdog();
    expect(
      planFridayMonitorNotice({
        ...base,
        evidence: {
          kind: "independent-watchdog",
          status: "not-started",
          expectedStartEpochMs: due,
          observedAtEpochMs: due - 1,
        },
      })
    ).toBeNull();
    const notice = planFridayMonitorNotice({
      ...base,
      nowEpochMs: due,
      evidence: {
        kind: "independent-watchdog",
        status: "not-started",
        expectedStartEpochMs: due,
        observedAtEpochMs: due,
      },
    });
    expect(notice).toMatchObject({
      schemaVersion: 1,
      kind: "missed-start",
      editionId: "2026-10-30",
      dueAtEpochMs: due,
      key: expect.any(String),
    });
    for (const status of ["started", "unknown"] as const)
      expect(
        planFridayMonitorNotice({
          ...base,
          evidence: {
            kind: "independent-watchdog",
            status,
            expectedStartEpochMs: due,
            observedAtEpochMs: due,
          },
        })
      ).toBeNull();
    expect(
      planFridayMonitorNotice({
        ...base,
        nowEpochMs: due + 60_001,
        evidence: {
          kind: "independent-watchdog",
          status: "not-started",
          expectedStartEpochMs: due,
          observedAtEpochMs: due,
        },
      })
    ).toBeNull();
  });

  it("deduplicates repeated observations while separating edition, kind and due time", () => {
    const first = planFridayMonitorNotice(mailbox())!;
    const repeated = planFridayMonitorNotice({
      ...mailbox(),
      nowEpochMs: due + 1_000,
      evidence: {
        kind: "mailbox-scan",
        status: "absent",
        scannedThroughEpochMs: due + 1_000,
      },
    })!;
    expect(repeated.key).toBe(first.key);
    expect(first.key.length).toBeGreaterThan(0);
    const watch = planFridayMonitorNotice(watchdog())!;
    expect(watch.key).not.toBe(first.key);
    const laterStart = planFridayMonitorNotice({
      ...watchdog(),
      evidence: {
        kind: "independent-watchdog",
        status: "not-started",
        expectedStartEpochMs: due + 1,
        observedAtEpochMs: due + 10_000,
      },
    })!;
    expect(laterStart.key).not.toBe(watch.key);
    const earlier = Date.parse("2026-10-24T01:00:00.000Z");
    const other = planFridayMonitorNotice({
      editionId: "2026-10-23",
      nowEpochMs: earlier,
      maxEvidenceAgeMs: 0,
      evidence: {
        kind: "mailbox-scan",
        status: "absent",
        scannedThroughEpochMs: earlier,
      },
    })!;
    expect(other.key).not.toBe(first.key);
  });

  it("rejects invalid clocks, editions, evidence shape and hidden caller controls", () => {
    const base = mailbox();
    for (const editionId of ["2026-10-29", "2026-02-30", "2026-10-30 ", "bad"])
      expectInvalid({ ...base, editionId });
    for (const nowEpochMs of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])
      expectInvalid({ ...base, nowEpochMs });
    for (const maxEvidenceAgeMs of [-1, NaN, Infinity, 0.5])
      expectInvalid({ ...base, maxEvidenceAgeMs });
    expectInvalid({
      ...base,
      evidence: {
        kind: "mailbox-scan",
        status: "absent",
        scannedThroughEpochMs: due + 1,
      },
    });
    expectInvalid({
      ...base,
      evidence: {
        kind: "mailbox-scan",
        status: "absent",
        scannedThroughEpochMs: -1,
      },
    });
    expectInvalid({
      ...base,
      evidence: {
        kind: "mailbox-scan",
        status: "absent",
        scannedThroughEpochMs: due,
        secret: "synthetic-private-value",
      },
    });
    expectInvalid({ ...base, send: true });
    expectInvalid({
      ...base,
      evidence: {
        kind: "independent-watchdog",
        status: "not-started",
        expectedStartEpochMs: due,
        observedAtEpochMs: due + 1,
      },
    });
    expectInvalid({
      ...base,
      evidence: {
        kind: "independent-watchdog",
        status: "not-started",
        expectedStartEpochMs: -1,
        observedAtEpochMs: due,
      },
    });
    expectInvalid({
      ...base,
      evidence: {
        kind: "mailbox-scan",
        status: "maybe",
        scannedThroughEpochMs: due,
      },
    });
    const getter = vi.fn();
    const accessor = Object.defineProperty(mailbox(), "evidence", {
      get: getter,
    });
    expectInvalid(accessor);
    expect(getter).not.toHaveBeenCalled();
    expectInvalid({ ...base, [Symbol("control")]: true });
  });

  it("returns only the bounded notice contract", () => {
    const notice = planFridayMonitorNotice(mailbox());
    expect(Object.keys(notice!).sort()).toEqual([
      "dueAtEpochMs",
      "editionId",
      "key",
      "kind",
      "schemaVersion",
    ]);
    expect(JSON.stringify(notice)).not.toContain("synthetic-private-value");
  });
});
