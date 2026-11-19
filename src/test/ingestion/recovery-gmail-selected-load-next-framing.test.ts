import { expect, it, vi } from "vitest";
import {
  encodeRecoveryGmailNextSelectedLoadFrame as encode,
  decodeRecoveryGmailNextSelectedLoadFrame as decode,
} from "../../lib/ingestion/recovery-gmail-selected-load-next-framing.js";
import {
  encodeRecoveryGmailSelectedLoadFrame as encodePrior,
  decodeRecoveryGmailSelectedLoadFrame as decodePrior,
} from "../../lib/ingestion/recovery-gmail-selected-load-framing.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";

const input = () => ({
  prior: {
    archive: Buffer.from("synthetic private archive"),
    retirementReceipt: Buffer.from("synthetic private retirement"),
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
  admission: Buffer.from("synthetic signed admission\n"),
});

function replaceSelector(wire: Buffer, bytes: Buffer): Buffer {
  const priorLength = wire.readUInt32BE(5);
  const selectorLength = wire.readUInt32BE(9);
  const header = Buffer.from(wire.subarray(0, 17));
  header.writeUInt32BE(bytes.length, 9);
  return Buffer.concat([
    header,
    wire.subarray(17, 17 + priorLength),
    bytes,
    wire.subarray(17 + priorLength + selectorLength),
  ]);
}

it("round trips a distinct next receipt and detaches all private bytes", () => {
  const original = input();
  const wire = encode(original);
  expect(wire.subarray(0, 4).toString("ascii")).toBe("ZGLN");
  expect(wire[4]).toBe(1);
  const priorLength = wire.readUInt32BE(5);
  const selectorLength = wire.readUInt32BE(9);
  expect(wire.readUInt32BE(13)).toBe(original.admission.length);
  expect(wire.subarray(17, 17 + priorLength)).toEqual(
    encodePrior(original.prior)
  );
  expect(
    wire.subarray(17 + priorLength, 17 + priorLength + selectorLength)
  ).toEqual(Buffer.from(canonicalJson(original.next)));
  const decoded = decode(wire);
  expect(decoded).toEqual(original);
  original.prior.archive.fill(0);
  original.prior.recoveryKey.fill(0);
  original.admission.fill(0);
  original.next.messageId = "a3";
  wire.fill(0);
  expect(decoded.prior.archive.toString()).toBe("synthetic private archive");
  expect(decoded.prior.recoveryKey).toEqual(Buffer.alloc(32, 7));
  expect(decoded.admission.toString()).toBe("synthetic signed admission\n");
  expect(decoded.next.messageId).toBe("a2");
});

it("separates the prior frame from the next-load frame", () => {
  const value = input();
  expect(() => decode(encodePrior(value.prior))).toThrow();
  expect(() => decodePrior(encode(value))).toThrow();
});

it("accepts the admission size limit and refuses empty or oversized admissions", () => {
  const value = input();
  expect(
    decode(encode({ ...value, admission: Buffer.alloc(65_536, 1) })).admission
      .length
  ).toBe(65_536);
  expect(() => encode({ ...value, admission: Buffer.alloc(0) })).toThrow();
  expect(() => encode({ ...value, admission: Buffer.alloc(65_537) })).toThrow();
});

it("rejects unknown fields, getters and malformed or repeated receipt selectors", () => {
  const value = input();
  expect(() => encode({ ...value, operation: "execute" })).toThrow();
  expect(() => encode({ ...value, [Symbol("extra")]: true })).toThrow();
  const getter = vi.fn();
  const accessor = Object.defineProperty(input(), "admission", { get: getter });
  expect(() => encode(accessor)).toThrow();
  const selector = Object.defineProperty(input().next, "messageId", {
    get: getter,
  });
  expect(() => encode({ ...input(), next: selector })).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    encode({ ...value, next: { ...value.next, unexpected: true } })
  ).toThrow();
  expect(() =>
    encode({ ...value, next: { ...value.next, messageId: "bad/id" } })
  ).toThrow();
  expect(() =>
    encode({
      ...value,
      next: { ...value.next, receiptId: value.prior.selector.receiptId },
    })
  ).toThrow();
});

it("refuses wrong magic, version, lengths, truncation and trailing frames", () => {
  const wire = encode(input());
  const magic = Buffer.from(wire);
  magic[0] ^= 1;
  expect(() => decode(magic)).toThrow();
  const version = Buffer.from(wire);
  version[4] = 2;
  expect(() => decode(version)).toThrow();
  for (const offset of [5, 9, 13]) {
    for (const length of [0, 0xffffffff]) {
      const changed = Buffer.from(wire);
      changed.writeUInt32BE(length, offset);
      expect(() => decode(changed)).toThrow();
    }
  }
  expect(() => decode(wire.subarray(0, 16))).toThrow();
  expect(() => decode(wire.subarray(0, wire.length - 1))).toThrow();
  expect(() => decode(Buffer.concat([wire, Buffer.from([0])]))).toThrow();
  expect(() => decode(Buffer.concat([wire, wire]))).toThrow();
  const priorCorrupt = Buffer.from(wire);
  priorCorrupt[17] ^= 1;
  expect(() => decode(priorCorrupt)).toThrow();
});

it("requires strict canonical UTF-8 selector bytes and a distinct receipt", () => {
  const value = input();
  const wire = encode(value);
  const canonical = canonicalJson(value.next);
  const duplicate = canonical.replace(
    '"batchId":',
    '"batchId":"duplicate","batchId":'
  );
  const sameReceipt = canonicalJson({
    ...value.next,
    receiptId: value.prior.selector.receiptId,
  });
  for (const text of [
    "\ufeff" + canonical,
    canonical + "\n",
    JSON.stringify(value.next, null, 2),
    duplicate,
    canonical.replace('"batchId":', '"extra":1,"batchId":'),
    sameReceipt,
  ])
    expect(() => decode(replaceSelector(wire, Buffer.from(text)))).toThrow();
  const invalidUtf8 = Buffer.from(canonical);
  invalidUtf8[0] = 0xff;
  expect(() => decode(replaceSelector(wire, invalidUtf8))).toThrow();
});
