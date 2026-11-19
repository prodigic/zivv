import { expect, it, vi } from "vitest";
import {
  encodeRecoveryGmailThirdSelectedLoadFrame as encode,
  decodeRecoveryGmailThirdSelectedLoadFrame as decode,
} from "../../lib/ingestion/recovery-gmail-selected-load-third-framing.js";
import {
  encodeRecoveryGmailNextSelectedLoadFrame as encodeFamily,
  decodeRecoveryGmailNextSelectedLoadFrame as decodeFamily,
} from "../../lib/ingestion/recovery-gmail-selected-load-next-framing.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import {
  decodeThirdSelectedLoadStartFrame as decodeStart,
  encodeThirdSelectedLoadStartFrame as encodeStart,
  maxThirdSelectedLoadBaselineBytes,
} from "../../lib/ingestion/recovery-gmail-selected-load-third-start-framing.js";

const input = () => ({
  family: {
    prior: {
      archive: Buffer.from("private archive"),
      retirementReceipt: Buffer.from("private retirement"),
      recoveryKey: Buffer.alloc(32, 7),
      destination: "/fixture/runtime",
      npmCli: "/fixture/npm-cli.js",
      selector: {
        batchId: "a".repeat(64),
        messageId: "a1",
        rawSha256: "b".repeat(64),
        receiptId: "c".repeat(64),
      },
    },
    next: {
      batchId: "a".repeat(64),
      messageId: "a2",
      rawSha256: "d".repeat(64),
      receiptId: "e".repeat(64),
    },
    admission: Buffer.from("private second admission"),
  },
  third: {
    batchId: "a".repeat(64),
    messageId: "a3",
    rawSha256: "f".repeat(64),
    receiptId: "1".repeat(64),
  },
  admission: Buffer.from("private third admission"),
});

function replaceSelector(wire: Buffer, selector: Buffer) {
  const familyLength = wire.readUInt32BE(5);
  const selectorLength = wire.readUInt32BE(9);
  const header = Buffer.from(wire.subarray(0, 17));
  header.writeUInt32BE(selector.length, 9);
  return Buffer.concat([
    header,
    wire.subarray(17, 17 + familyLength),
    selector,
    wire.subarray(17 + familyLength + selectorLength),
  ]);
}

it("round trips the nested frame and owns all private bytes", () => {
  const value = input();
  const wire = encode(value);
  expect(wire.subarray(0, 4).toString()).toBe("ZGL3");
  expect(wire[4]).toBe(1);
  const familyLength = wire.readUInt32BE(5);
  const selectorLength = wire.readUInt32BE(9);
  expect(wire.subarray(17, 17 + familyLength)).toEqual(
    encodeFamily(value.family)
  );
  expect(
    wire.subarray(17 + familyLength, 17 + familyLength + selectorLength)
  ).toEqual(Buffer.from(canonicalJson(value.third)));
  expect(wire.readUInt32BE(13)).toBe(value.admission.length);
  const decoded = decode(wire);
  expect(decoded).toEqual(value);
  value.family.prior.archive.fill(0);
  value.family.prior.retirementReceipt.fill(0);
  value.family.prior.recoveryKey.fill(0);
  value.family.admission.fill(0);
  value.admission.fill(0);
  value.third.messageId = "changed";
  wire.fill(0);
  expect(decoded.family.prior.archive.toString()).toBe("private archive");
  expect(decoded.family.prior.retirementReceipt.toString()).toBe(
    "private retirement"
  );
  expect(decoded.family.prior.recoveryKey).toEqual(Buffer.alloc(32, 7));
  expect(decoded.family.admission.toString()).toBe("private second admission");
  expect(decoded.admission.toString()).toBe("private third admission");
  expect(decoded.third.messageId).toBe("a3");
});

it("separates the third frame from its nested family", () => {
  const value = input();
  expect(() => decode(encodeFamily(value.family))).toThrow();
  expect(() => decodeFamily(encode(value))).toThrow();
});

it("bounds admission and refuses accessors, extra fields and duplicate receipts", () => {
  const value = input();
  expect(
    decode(encode({ ...value, admission: Buffer.alloc(65536, 1) })).admission
      .length
  ).toBe(65536);
  for (const size of [0, 65537])
    expect(() => encode({ ...value, admission: Buffer.alloc(size) })).toThrow();
  expect(() => encode({ ...value, extra: true })).toThrow();
  expect(() => encode({ ...value, [Symbol("extra")]: true })).toThrow();
  const getter = vi.fn();
  expect(() =>
    encode(Object.defineProperty(input(), "admission", { get: getter }))
  ).toThrow();
  const third = Object.defineProperty(input().third, "messageId", {
    get: getter,
  });
  expect(() => encode({ ...input(), third })).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    encode({ ...value, third: { ...value.third, extra: true } })
  ).toThrow();
  for (const receiptId of [
    value.family.prior.selector.receiptId,
    value.family.next.receiptId,
  ])
    expect(() =>
      encode({ ...value, third: { ...value.third, receiptId } })
    ).toThrow();
});

it("rejects malformed headers, lengths and nested payloads", () => {
  const wire = encode(input());
  for (const offset of [0, 4, 17]) {
    const changed = Buffer.from(wire);
    changed[offset] ^= 1;
    expect(() => decode(changed)).toThrow();
  }
  for (const offset of [5, 9, 13])
    for (const length of [0, 0xffffffff]) {
      const changed = Buffer.from(wire);
      changed.writeUInt32BE(length, offset);
      expect(() => decode(changed)).toThrow();
    }
  for (const changed of [
    wire.subarray(0, 16),
    wire.subarray(0, wire.length - 1),
    Buffer.concat([wire, Buffer.from([0])]),
    Buffer.concat([wire, wire]),
  ])
    expect(() => decode(changed)).toThrow();
});

it("requires canonical UTF-8 selector bytes and rejects manual receipt substitution", () => {
  const value = input();
  const wire = encode(value);
  const canonical = canonicalJson(value.third);
  for (const text of [
    "\ufeff" + canonical,
    canonical + "\n",
    JSON.stringify(value.third, null, 2),
    canonical.replace('"batchId":', '"batchId":"duplicate","batchId":'),
    canonical.replace('"batchId":', '"extra":1,"batchId":'),
    ...[value.family.prior.selector.receiptId, value.family.next.receiptId].map(
      (receiptId) => canonicalJson({ ...value.third, receiptId })
    ),
  ])
    expect(() => decode(replaceSelector(wire, Buffer.from(text)))).toThrow();
  const invalidUtf8 = Buffer.from(canonical);
  invalidUtf8[0] = 0xff;
  expect(() => decode(replaceSelector(wire, invalidUtf8))).toThrow();
});

it("separates the start frame and owns its private baseline and nested evidence", () => {
  const value = {
    input: input(),
    executionBaseline: Buffer.from("private start"),
  };
  const wire = encodeStart(value);
  expect(wire.subarray(0, 4).toString()).toBe("ZGLS");
  const restored = decodeStart(wire);
  expect(restored).toEqual(value);
  expect(() => decode(wire)).toThrow();
  expect(() => decodeStart(encode(value.input))).toThrow();
  value.input.family.prior.recoveryKey.fill(0);
  value.executionBaseline.fill(0);
  wire.fill(0);
  expect(restored.input.family.prior.recoveryKey).toEqual(Buffer.alloc(32, 7));
  expect(restored.executionBaseline.toString()).toBe("private start");
});

it("refuses start frame accessors, extra data and invalid declared sizes", () => {
  const value = {
    input: input(),
    executionBaseline: Buffer.from("private start"),
  };
  const getter = vi.fn();
  expect(() =>
    encodeStart(
      Object.defineProperty({ ...value }, "executionBaseline", { get: getter })
    )
  ).toThrow();
  expect(() => encodeStart({ ...value, extra: true })).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    encodeStart({ ...value, executionBaseline: Buffer.alloc(0) })
  ).toThrow();
  expect(() =>
    encodeStart({
      ...value,
      executionBaseline: Buffer.alloc(maxThirdSelectedLoadBaselineBytes + 1),
    })
  ).toThrow();
  const wire = encodeStart(value);
  for (const offset of [5, 9]) {
    const bad = Buffer.from(wire);
    bad.writeUInt32BE(0xffffffff, offset);
    expect(() => decodeStart(bad)).toThrow();
  }
  expect(() => decodeStart(Buffer.concat([wire, Buffer.of(0)]))).toThrow();
});
