import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decryptRecoveryResultChain,
  RECOVERY_RESULT_CHAIN_MAX_MEMBER_BYTES,
} from "../../lib/ingestion/recovery-result-chain.js";

const key = Buffer.alloc(32, 0x31);
const outerMagic = Buffer.from("ZIVV-RESULT-CHAIN\0", "ascii");
const memberMagic = Buffer.from("ZIVV-CHAIN-MEMBERS\0", "ascii");
const memberCount = 7;
const outerPrefixBytes = outerMagic.length + 4 + 32 + 12 + 4;
const memberHeaderBytes = memberMagic.length + 2 + (memberCount + 1) * 4;

function envelope(clear: Buffer): Buffer {
  const compressed = gzipSync(clear);
  const prefix = Buffer.alloc(outerPrefixBytes);
  outerMagic.copy(prefix);
  Buffer.from([1, 1, 1, 1]).copy(prefix, outerMagic.length);
  createHash("sha256")
    .update(key)
    .digest()
    .copy(prefix, outerMagic.length + 4);
  const nonce = randomBytes(12);
  nonce.copy(prefix, outerMagic.length + 4 + 32);
  prefix.writeUInt32BE(compressed.length, outerPrefixBytes - 4);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(prefix);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([prefix, cipher.getAuthTag(), ciphertext]);
}

function inner(
  lengths: readonly number[],
  certificateLength: number,
  bodyLength: number,
  options: { magic?: Buffer; version?: number; depth?: number } = {}
): Buffer {
  if (lengths.length !== memberCount) throw new Error("Wrong member count");
  const header = Buffer.alloc(memberHeaderBytes);
  (options.magic ?? memberMagic).copy(header);
  header[memberMagic.length] = options.version ?? 1;
  header[memberMagic.length + 1] = options.depth ?? 1;
  lengths.forEach((length, index) =>
    header.writeUInt32BE(length, memberMagic.length + 2 + index * 4)
  );
  header.writeUInt32BE(
    certificateLength,
    memberMagic.length + 2 + memberCount * 4
  );
  return Buffer.concat([header, Buffer.alloc(bodyLength)]);
}

function expectCode(bytes: Buffer, code: string, suppliedKey = key) {
  expect(() => decryptRecoveryResultChain(bytes, suppliedKey)).toThrow(
    `RECOVERY_RESULT_CHAIN_${code}`
  );
}

describe("recovery result-chain framing", () => {
  it("rejects each unsupported outer header byte before decryption", () => {
    const validOuter = envelope(Buffer.alloc(0));
    const badMagic = Buffer.from(validOuter);
    badMagic[0] ^= 1;
    expectCode(badMagic, "INVALID_ENVELOPE");

    for (let field = 0; field < 4; field++) {
      const changed = Buffer.from(validOuter);
      changed[outerMagic.length + field] = 2;
      expectCode(changed, "INVALID_ENVELOPE");
    }
  });

  it("rejects truncated, trailing, zero and overclaimed outer lengths", () => {
    const valid = envelope(Buffer.alloc(0));
    expectCode(valid.subarray(0, outerPrefixBytes - 1), "LIMIT");
    expectCode(valid.subarray(0, outerPrefixBytes + 15), "LIMIT");
    expectCode(Buffer.concat([valid, Buffer.from([0])]), "INVALID_LENGTH");
    expectCode(valid.subarray(0, valid.length - 1), "INVALID_LENGTH");

    const zero = Buffer.from(valid);
    zero.writeUInt32BE(0, outerPrefixBytes - 4);
    expectCode(zero, "INVALID_LENGTH");
    const excessive = Buffer.from(valid);
    excessive.writeUInt32BE(0xffff_ffff, outerPrefixBytes - 4);
    expectCode(excessive, "INVALID_LENGTH");
  });

  it("checks the key identifier and authenticates the GCM tag", () => {
    const valid = envelope(Buffer.alloc(0));
    expectCode(valid, "INVALID_KEY", Buffer.alloc(32, 0x32));
    const tampered = Buffer.from(valid);
    tampered[outerPrefixBytes] ^= 1;
    expect(() => decryptRecoveryResultChain(tampered, key)).toThrow();
  });

  it("rejects malformed authenticated inner magic, version, depth and short headers", () => {
    expectCode(envelope(Buffer.alloc(0)), "INVALID_CONTENT");
    const ordinaryLengths = Array(memberCount).fill(1) as number[];
    const validSizedBody = inner(ordinaryLengths, 1, memberCount + 1);

    const badMagic = Buffer.from(validSizedBody);
    badMagic[0] ^= 1;
    expectCode(envelope(badMagic), "INVALID_CONTENT");
    expectCode(
      envelope(inner(ordinaryLengths, 1, memberCount + 1, { version: 2 })),
      "INVALID_CONTENT"
    );
    expectCode(
      envelope(inner(ordinaryLengths, 1, memberCount + 1, { depth: 2 })),
      "INVALID_CONTENT"
    );
  });

  it("rejects authenticated zero, excessive, truncated and trailing member lengths", () => {
    const lengths = Array(memberCount).fill(1) as number[];
    const zeroMember = [...lengths];
    zeroMember[0] = 0;
    expectCode(envelope(inner(zeroMember, 1, memberCount)), "LIMIT");

    const overTotal = [...Array(memberCount).fill(0)] as number[];
    overTotal[0] = RECOVERY_RESULT_CHAIN_MAX_MEMBER_BYTES;
    overTotal[1] = 1;
    expectCode(envelope(inner(overTotal, 1, 0)), "LIMIT");

    expectCode(envelope(inner(lengths, 1, memberCount - 1)), "INVALID_LENGTH");
    expectCode(envelope(inner(lengths, 1, memberCount + 2)), "INVALID_LENGTH");
  });

  it("bounds individual metadata and certificate lengths before parsing payloads", () => {
    const metadataOversize = [1, 65_537, 1, 1, 1, 1, 1];
    const metadataBody =
      metadataOversize.reduce((sum, value) => sum + value, 0) + 1;
    expectCode(envelope(inner(metadataOversize, 1, metadataBody)), "LIMIT");

    const zeroCertificate = Array(memberCount).fill(1) as number[];
    expectCode(envelope(inner(zeroCertificate, 0, memberCount)), "LIMIT");
    expectCode(envelope(inner(zeroCertificate, 65_537, 0)), "LIMIT");
  });
});
