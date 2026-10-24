import { describe, expect, it } from "vitest";
import {
  decodeRecoveryGmailCaptureFrame,
  encodeRecoveryGmailCaptureFrame,
  MAX_RECOVERY_GMAIL_CAPTURE_FRAME_BYTES,
} from "../../lib/ingestion/recovery-gmail-capture-framing.js";

interface TestMetadata {
  batchId: string;
  correctionOfByMessageId: Record<string, string>;
  destination: string;
  npmCli: string;
  surprise?: boolean;
}

const input = () => ({
  archive: Buffer.from("archive bytes"),
  retirementReceipt: Buffer.from("retirement"),
  recoveryKey: Buffer.alloc(32, 7),
  destination: "C:/operator/root",
  npmCli: "C:/operator/root/npm/npm-cli.js",
  batchId: "a".repeat(64),
  correctionOfByMessageId: { b: "c".repeat(64) },
});

function withMetadata(frame: Buffer, metadata: unknown): Buffer {
  const oldLength = frame.readUInt32BE(5);
  const oldMetadataEnd = 21 + oldLength;
  const bytes = Buffer.from(JSON.stringify(metadata));
  const updated = Buffer.alloc(frame.length - oldLength + bytes.length);
  frame.copy(updated, 0, 0, 21);
  updated.writeUInt32BE(bytes.length, 5);
  bytes.copy(updated, 21);
  frame.copy(updated, 21 + bytes.length, oldMetadataEnd);
  return updated;
}

describe("recovery Gmail capture binary framing", () => {
  it("fits all 100 maximum-length correction references and physical paths", () => {
    const source = {
      ...input(),
      destination: "/" + "d".repeat(4095),
      npmCli: "/" + "n".repeat(4095),
      correctionOfByMessageId: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          index.toString(16).padStart(128, "0"),
          "e".repeat(64),
        ])
      ),
    };
    const frame = encodeRecoveryGmailCaptureFrame(source);
    expect(frame.readUInt32BE(5)).toBeLessThanOrEqual(64 * 1024);
    expect(decodeRecoveryGmailCaptureFrame(frame)).toMatchObject(source);
  });
  it("round trips bounded metadata and owns decoded payload buffers", () => {
    const source = input();
    const frame = encodeRecoveryGmailCaptureFrame(source);
    const decoded = decodeRecoveryGmailCaptureFrame(frame);
    expect(decoded).toMatchObject({
      destination: source.destination,
      npmCli: source.npmCli,
      batchId: source.batchId,
      correctionOfByMessageId: source.correctionOfByMessageId,
    });
    expect(decoded.archive).toEqual(source.archive);
    expect(decoded.retirementReceipt).toEqual(source.retirementReceipt);
    expect(decoded.recoveryKey).toEqual(source.recoveryKey);
    decoded.archive[0] = (decoded.archive[0] ?? 0) ^ 0xff;
    expect(source.archive).toEqual(Buffer.from("archive bytes"));
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.correctionOfByMessageId)).toBe(true);
    expect(MAX_RECOVERY_GMAIL_CAPTURE_FRAME_BYTES).toBeGreaterThan(
      frame.length
    );
  });

  const invalidFrames: Array<[string, (frame: Buffer) => Buffer]> = [
    ["bad magic", (frame: Buffer) => frame.fill(0, 0, 1)],
    [
      "bad version",
      (frame: Buffer) => {
        frame.writeUInt8(2, 4);
        return frame;
      },
    ],
    ["truncated header", (frame: Buffer) => frame.subarray(0, 20)],
    ["truncated body", (frame: Buffer) => frame.subarray(0, frame.length - 1)],
    [
      "trailing bytes",
      (frame: Buffer) => Buffer.concat([frame, Buffer.from([0])]),
    ],
    [
      "metadata overflow",
      (frame: Buffer) => {
        frame.writeUInt32BE(65537, 5);
        return frame;
      },
    ],
    [
      "archive overflow",
      (frame: Buffer) => {
        frame.writeUInt32BE(375809639, 9);
        return frame;
      },
    ],
    [
      "retirement overflow",
      (frame: Buffer) => {
        frame.writeUInt32BE(16385, 13);
        return frame;
      },
    ],
    [
      "wrong key length",
      (frame: Buffer) => {
        frame.writeUInt32BE(31, 17);
        return frame;
      },
    ],
  ];
  it.each(invalidFrames)("rejects %s", (_name, mutate) => {
    const frame = encodeRecoveryGmailCaptureFrame(input());
    expect(() => decodeRecoveryGmailCaptureFrame(mutate(frame))).toThrow(
      "INVALID_RECOVERY_GMAIL_CAPTURE_FRAME"
    );
  });

  it("rejects noncanonical or unknown metadata before returning payloads", () => {
    const frame = encodeRecoveryGmailCaptureFrame(input());
    const metadata = JSON.parse(
      frame.toString("utf8", 21, 21 + frame.readUInt32BE(5))
    ) as TestMetadata;
    expect(() =>
      decodeRecoveryGmailCaptureFrame(
        withMetadata(frame, { ...metadata, surprise: true })
      )
    ).toThrow("INVALID_RECOVERY_GMAIL_CAPTURE_FRAME");
    expect(() =>
      decodeRecoveryGmailCaptureFrame(
        withMetadata(frame, {
          batchId: metadata.batchId,
          correctionOfByMessageId: metadata.correctionOfByMessageId,
          destination: metadata.destination,
          npmCli: metadata.npmCli,
        })
      )
    ).not.toThrow();
    const start = 21;
    const rawMetadata = frame.toString(
      "utf8",
      start,
      start + frame.readUInt32BE(5)
    );
    const reordered = Buffer.from(
      rawMetadata.replace('{"batchId":', '{ "batchId":'),
      "utf8"
    );
    const altered = Buffer.alloc(
      frame.length - frame.readUInt32BE(5) + reordered.length
    );
    frame.copy(altered, 0, 0, 21);
    altered.writeUInt32BE(reordered.length, 5);
    reordered.copy(altered, 21);
    frame.copy(altered, 21 + reordered.length, 21 + frame.readUInt32BE(5));
    expect(() => decodeRecoveryGmailCaptureFrame(altered)).toThrow(
      "INVALID_RECOVERY_GMAIL_CAPTURE_FRAME"
    );
  });

  it("rejects malformed metadata references and path controls", () => {
    const source = input();
    expect(() =>
      encodeRecoveryGmailCaptureFrame({ ...source, batchId: "z".repeat(64) })
    ).toThrow("INVALID_RECOVERY_GMAIL_CAPTURE_FRAME");
    expect(() =>
      encodeRecoveryGmailCaptureFrame({
        ...source,
        correctionOfByMessageId: { ["f".repeat(129)]: "c".repeat(64) },
      })
    ).toThrow("INVALID_RECOVERY_GMAIL_CAPTURE_FRAME");
    expect(() =>
      encodeRecoveryGmailCaptureFrame({ ...source, destination: "bad\0path" })
    ).toThrow("INVALID_RECOVERY_GMAIL_CAPTURE_FRAME");
  });

  it("accepts 100 corrections and refuses 101", () => {
    const corrections = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        index.toString(16),
        "c".repeat(64),
      ])
    );
    const source = input();
    const frame = encodeRecoveryGmailCaptureFrame({
      ...source,
      correctionOfByMessageId: corrections,
    });
    expect(
      Object.keys(
        decodeRecoveryGmailCaptureFrame(frame).correctionOfByMessageId
      )
    ).toHaveLength(100);
    expect(() =>
      encodeRecoveryGmailCaptureFrame({
        ...source,
        correctionOfByMessageId: { ...corrections, ff: "d".repeat(64) },
      })
    ).toThrow("INVALID_RECOVERY_GMAIL_CAPTURE_FRAME");
  });

  it("rejects invalid UTF-8 metadata", () => {
    const frame = encodeRecoveryGmailCaptureFrame(input());
    const metadataLength = frame.readUInt32BE(5);
    const invalidMetadata = Buffer.from(
      frame.subarray(21, 21 + metadataLength)
    );
    invalidMetadata[0] = 0xff;
    const altered = Buffer.from(frame);
    invalidMetadata.copy(altered, 21);
    expect(() => decodeRecoveryGmailCaptureFrame(altered)).toThrow(
      "INVALID_RECOVERY_GMAIL_CAPTURE_FRAME"
    );
  });
});
