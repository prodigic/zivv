import { expect, it, vi } from "vitest";
import {
  encodeRecoveryGmailSelectedLoadFrame as encode,
  decodeRecoveryGmailSelectedLoadFrame as decode,
} from "../../lib/ingestion/recovery-gmail-selected-load-framing.js";
import {
  encodeRecoveryGmailCaptureFrame,
  decodeRecoveryGmailCaptureFrame,
} from "../../lib/ingestion/recovery-gmail-capture-framing.js";
const input = () => ({
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
});
function metadata(wire: Buffer, text: string) {
  const oldLength = wire.readUInt32BE(5),
    header = Buffer.from(wire.subarray(0, 21));
  const bytes = Buffer.from(text);
  header.writeUInt32BE(bytes.length, 5);
  return Buffer.concat([header, bytes, wire.subarray(21 + oldLength)]);
}
it("round-trips exact bounded source selector and owns secret/input bytes", () => {
  const original = input(),
    wire = encode(original),
    copy = decode(wire);
  expect(copy).toEqual(original);
  expect(Object.isFrozen(copy)).toBe(true);
  expect(Object.isFrozen(copy.selector)).toBe(true);
  original.archive.fill(0);
  original.recoveryKey.fill(0);
  original.selector.messageId = "b1";
  expect(copy.archive.toString()).toBe("private archive");
  expect(copy.recoveryKey).toEqual(Buffer.alloc(32, 7));
  expect(copy.selector.messageId).toBe("a1");
  wire.fill(0);
  expect(copy.recoveryKey).toEqual(Buffer.alloc(32, 7));
});
it("separates selected-load framing from capture commands", () => {
  const value = input();
  const capture = encodeRecoveryGmailCaptureFrame({
    archive: value.archive,
    retirementReceipt: value.retirementReceipt,
    recoveryKey: value.recoveryKey,
    destination: value.destination,
    npmCli: value.npmCli,
    batchId: value.selector.batchId,
  });
  expect(() => decode(capture)).toThrow();
  expect(() => decodeRecoveryGmailCaptureFrame(encode(value))).toThrow();
});
it.each(["runId", "source", "executor", "callback", "activate", "stopAfter"])(
  "refuses caller %s controls before serialization",
  (name) => {
    expect(() => encode({ ...input(), [name]: "override" })).toThrow(
      "INVALID_RECOVERY_GMAIL_SELECTED_LOAD_FRAME"
    );
  }
);
it("rejects getters and symbol controls without executing them", () => {
  const getter = vi.fn();
  const value = Object.defineProperty(input(), "archive", { get: getter });
  expect(() => encode(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() => encode({ ...input(), [Symbol("control")]: true })).toThrow();
  const selected = Object.defineProperty(input().selector, "messageId", {
    get: getter,
  });
  expect(() => encode({ ...input(), selector: selected })).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("rejects noncanonical UTF-8, BOM, duplicate keys and unknown metadata", () => {
  const wire = encode(input()),
    text = wire.toString("utf8", 21, 21 + wire.readUInt32BE(5));
  for (const altered of [
    "\ufeff" + text,
    JSON.stringify(JSON.parse(text), null, 2),
    text.replace('"destination":', '"destination":"duplicate","destination":'),
    text.replace('"selector":', '"source":{},"selector":'),
  ])
    expect(() => decode(metadata(wire, altered))).toThrow();
  const invalid = metadata(wire, text);
  invalid[21] = 0xff;
  expect(() => decode(invalid)).toThrow();
});
it("refuses truncated, concatenated, unknown-version and oversized declared payloads", () => {
  const wire = encode(input());
  expect(() => decode(wire.subarray(0, wire.length - 1))).toThrow();
  expect(() => decode(Buffer.concat([wire, wire]))).toThrow();
  for (const offset of [5, 9, 13, 17]) {
    const changed = Buffer.from(wire);
    changed.writeUInt32BE(0xffffffff, offset);
    expect(() => decode(changed)).toThrow();
  }
  const version = Buffer.from(wire);
  version[4] = 2;
  expect(() => decode(version)).toThrow();
});
it("refuses empty payloads, wrong key sizes, malformed selectors and control characters", () => {
  for (const name of ["archive", "retirementReceipt", "recoveryKey"] as const)
    expect(() => encode({ ...input(), [name]: Buffer.alloc(0) })).toThrow();
  expect(() => encode({ ...input(), recoveryKey: Buffer.alloc(31) })).toThrow();
  expect(() => encode({ ...input(), destination: "bad\npath" })).toThrow();
  expect(() =>
    encode({
      ...input(),
      selector: { ...input().selector, messageId: "not/gmail" },
    })
  ).toThrow();
});
