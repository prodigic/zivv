import { describe, expect, it } from "vitest";
import {
  parseSavedPagesDispatch,
  parseSavedPagesDispatchReceipt,
  type SavedPagesDispatch,
} from "../../lib/ingestion/pages-dispatch-runner.js";
import { preparePagesWorkflowDispatch } from "../../lib/ingestion/pages-dispatch.js";
import {
  applyPromotionTransition,
  claimPromotion,
  serializePromotionControl,
} from "../../lib/ingestion/promotion-control.js";
import { createPromotionControlFixture } from "./fixtures/promotion-control-fixture.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
function fixture(receipt = false): SavedPagesDispatch {
  const base = createPromotionControlFixture();
  const control = claimPromotion(base.state, base.request);
  const intent = preparePagesWorkflowDispatch({
    control,
    controlHead: "c".repeat(40),
    workflowCommit: "b".repeat(40),
    mode: "promote",
    reviewedMainAncestor: true,
    dispatchNonce: "d".repeat(64),
  });
  const pendingAppend = {
    expectedHead: intent.expectedControlHead,
    attemptedHead: "e".repeat(40),
    bytes: serializePromotionControl(
      applyPromotionTransition(control, intent.event)
    ).toString("base64"),
    createdAt: "2026-10-16T12:00:00.123Z",
  };
  return {
    schemaVersion: 1,
    intent,
    pendingAppend,
    ...(receipt
      ? {
          receipt: {
            intent,
            controlHead: pendingAppend.attemptedHead,
            runId: "101",
            runUrl:
              "https://api.github.com/repos/prodigic/zivv/actions/runs/101",
            htmlUrl: "https://github.com/prodigic/zivv/actions/runs/101",
          },
        }
      : {}),
  };
}

describe("strict saved Pages dispatch evidence", () => {
  it.each([false, true])(
    "preserves exact producer bytes with receipt=%s",
    (receipt) => {
      const original = encode(fixture(receipt));
      const parsed = parseSavedPagesDispatch(original);
      expect(encode(parsed)).toEqual(original);
      expect(parsed.intent.event.dispatchNonce).toBe("d".repeat(64));
      expect(parsed.pendingAppend.createdAt).toBe("2026-10-16T12:00:00.123Z");
      parsed.pendingAppend.createdAt = "2026-10-16T12:00:01.000Z";
      expect(parseSavedPagesDispatch(original).pendingAppend.createdAt).toBe(
        "2026-10-16T12:00:00.123Z"
      );
    }
  );

  it("validates receipt ownership independently without granting dispatch authority", () => {
    const saved = fixture(true);
    expect(
      parseSavedPagesDispatchReceipt(saved.receipt, {
        intent: saved.intent,
        controlHead: saved.pendingAppend.attemptedHead,
      })
    ).toEqual(saved.receipt);
    expect(() =>
      parseSavedPagesDispatchReceipt(saved.receipt, {
        intent: saved.intent,
        controlHead: "f".repeat(40),
      })
    ).toThrow();
  });

  it.each([
    [
      "unknown envelope field",
      (saved: SavedPagesDispatch) => ({ ...saved, credential: "forbidden" }),
    ],
    [
      "missing envelope field",
      (saved: SavedPagesDispatch) => ({
        schemaVersion: 1,
        intent: saved.intent,
      }),
    ],
    [
      "wrong schema",
      (saved: SavedPagesDispatch) => ({ ...saved, schemaVersion: 2 }),
    ],
    [
      "unknown intent field",
      (saved: SavedPagesDispatch) => ({
        ...saved,
        intent: { ...saved.intent, credential: "forbidden" },
      }),
    ],
    [
      "unknown event field",
      (saved: SavedPagesDispatch) => ({
        ...saved,
        intent: {
          ...saved.intent,
          event: { ...saved.intent.event, extra: true },
        },
      }),
    ],
    [
      "unknown append field",
      (saved: SavedPagesDispatch) => ({
        ...saved,
        pendingAppend: { ...saved.pendingAppend, extra: true },
      }),
    ],
    [
      "numeric append head",
      (saved: SavedPagesDispatch) => ({
        ...saved,
        pendingAppend: { ...saved.pendingAppend, attemptedHead: 1 },
      }),
    ],
    [
      "unchanged append head",
      (saved: SavedPagesDispatch) => ({
        ...saved,
        pendingAppend: {
          ...saved.pendingAppend,
          attemptedHead: saved.pendingAppend.expectedHead,
        },
      }),
    ],
    [
      "changed append parent",
      (saved: SavedPagesDispatch) => ({
        ...saved,
        pendingAppend: { ...saved.pendingAppend, expectedHead: "f".repeat(40) },
      }),
    ],
    [
      "noncanonical base64",
      (saved: SavedPagesDispatch) => ({
        ...saved,
        pendingAppend: {
          ...saved.pendingAppend,
          bytes: saved.pendingAppend.bytes + "\n",
        },
      }),
    ],
    [
      "noncanonical control bytes",
      (saved: SavedPagesDispatch) => ({
        ...saved,
        pendingAppend: {
          ...saved.pendingAppend,
          bytes: Buffer.from(
            Buffer.from(saved.pendingAppend.bytes, "base64")
              .toString("utf8")
              .trimEnd()
          ).toString("base64"),
        },
      }),
    ],
    [
      "noncanonical timestamp",
      (saved: SavedPagesDispatch) => ({
        ...saved,
        pendingAppend: {
          ...saved.pendingAppend,
          createdAt: "2026-10-16T12:00:00.123+00:00",
        },
      }),
    ],
    [
      "invalid timestamp",
      (saved: SavedPagesDispatch) => ({
        ...saved,
        pendingAppend: { ...saved.pendingAppend, createdAt: "invalid" },
      }),
    ],
  ] as const)("rejects %s", (_label, mutate) => {
    expect(() => parseSavedPagesDispatch(encode(mutate(fixture())))).toThrow();
  });

  it.each([
    ["null receipt", () => null],
    ["array receipt", () => []],
    [
      "unknown receipt field",
      (receipt: NonNullable<SavedPagesDispatch["receipt"]>) => ({
        ...receipt,
        extra: true,
      }),
    ],
    [
      "missing receipt URL",
      (receipt: NonNullable<SavedPagesDispatch["receipt"]>) => ({
        intent: receipt.intent,
        controlHead: receipt.controlHead,
        runId: receipt.runId,
        runUrl: receipt.runUrl,
      }),
    ],
    [
      "numeric run ID",
      (receipt: NonNullable<SavedPagesDispatch["receipt"]>) => ({
        ...receipt,
        runId: 101,
      }),
    ],
    [
      "zero run ID",
      (receipt: NonNullable<SavedPagesDispatch["receipt"]>) => ({
        ...receipt,
        runId: "0",
      }),
    ],
    [
      "noncanonical run ID",
      (receipt: NonNullable<SavedPagesDispatch["receipt"]>) => ({
        ...receipt,
        runId: "0101",
      }),
    ],
    [
      "wrong run URL",
      (receipt: NonNullable<SavedPagesDispatch["receipt"]>) => ({
        ...receipt,
        runUrl: receipt.runUrl + "?token=forbidden",
      }),
    ],
    [
      "mismatched HTML URL",
      (receipt: NonNullable<SavedPagesDispatch["receipt"]>) => ({
        ...receipt,
        htmlUrl: "https://github.com/prodigic/zivv/actions/runs/999",
      }),
    ],
    [
      "wrong control head",
      (receipt: NonNullable<SavedPagesDispatch["receipt"]>) => ({
        ...receipt,
        controlHead: "f".repeat(40),
      }),
    ],
    [
      "extra receipt intent field",
      (receipt: NonNullable<SavedPagesDispatch["receipt"]>) => ({
        ...receipt,
        intent: { ...receipt.intent, extra: true },
      }),
    ],
  ] as const)("rejects %s", (_label, mutate) => {
    const saved = fixture(true);
    expect(() =>
      parseSavedPagesDispatch(
        encode({ ...saved, receipt: mutate(saved.receipt!) })
      )
    ).toThrow();
  });

  it("refuses whitespace, duplicate keys and unbounded evidence", () => {
    const saved = fixture();
    expect(() =>
      parseSavedPagesDispatch(
        Buffer.from(JSON.stringify(saved, null, 2) + "\n")
      )
    ).toThrow();
    expect(() =>
      parseSavedPagesDispatch(Buffer.from(JSON.stringify(saved)))
    ).toThrow();
    const duplicate = encode(saved)
      .toString("utf8")
      .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    expect(() => parseSavedPagesDispatch(Buffer.from(duplicate))).toThrow();
    expect(() => parseSavedPagesDispatch(Buffer.alloc(0))).toThrow();
    expect(() =>
      parseSavedPagesDispatch(Buffer.alloc(2_000_001, 32))
    ).toThrow();
  });
});
