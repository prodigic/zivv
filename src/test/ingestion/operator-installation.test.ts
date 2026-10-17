import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertOperatorInstallationWritable,
  createOperatorRetirementReceipt,
  verifyOperatorRetirementReceipt,
  withOperatorRetirementScope,
  type OperatorRetirementInput,
} from "../../lib/ingestion/operator-installation.js";

describe("cooperative operator retirement authority", () => {
  let directory: string, operator: string;
  const key = randomBytes(32);
  const marker = () => join(operator, "operator-retired.json");
  const input = (): OperatorRetirementInput => ({
    checkpointSha256: "1".repeat(64),
    archiveSha256: "2".repeat(64),
    ledgerRevision: "3".repeat(64),
    originalOperatorDirectory: operator,
    installationId: randomUUID(),
    retiredAtEpochMs: 1_792_248_000_000,
  });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "zivv-retirement-test-"));
    operator = join(directory, "private operator");
    mkdirSync(operator);
  });
  afterEach(() => {
    if (!directory.startsWith(join(tmpdir(), "zivv-retirement-test-")))
      throw new Error("Unsafe fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  it("permits ordinary unretired and not-yet-created operator locations without writing", () => {
    expect(() => assertOperatorInstallationWritable(operator)).not.toThrow();
    expect(() =>
      assertOperatorInstallationWritable(join(operator, "new", "installation"))
    ).not.toThrow();
    expect(() => readFileSync(marker())).toThrow();
  });
  it.each(["empty", "malformed", "directory", "linked", "hardlinked"])(
    "refuses every existing %s retirement marker without trusting its content",
    async (shape) => {
      if (shape === "directory") mkdirSync(marker());
      else if (shape === "linked") {
        const target = join(directory, "marker-target");
        mkdirSync(target);
        symlinkSync(
          target,
          marker(),
          process.platform === "win32" ? "junction" : "dir"
        );
      } else if (shape === "hardlinked") {
        const target = join(directory, "marker-file");
        writeFileSync(target, "arbitrary bytes");
        linkSync(target, marker());
      } else writeFileSync(marker(), shape === "empty" ? "" : "{malformed");
      expect(() => assertOperatorInstallationWritable(operator)).toThrow(
        "OPERATOR_INSTALLATION_RETIRED"
      );
      await expect(
        withOperatorRetirementScope(operator, async () => undefined)
      ).rejects.toThrow("OPERATOR_INSTALLATION_RETIRED");
    }
  );
  it("allows only coordinator cleanup after its own marker and blocks concurrent external siblings", async () => {
    const entered = deferred(),
      finish = deferred(),
      receipt = createOperatorRetirementReceipt(input(), key);
    const coordinator = withOperatorRetirementScope(
      operator,
      async (permitOwnRetirement) => {
        permitOwnRetirement(receipt);
        writeFileSync(marker(), receipt);
        await Promise.resolve();
        expect(() =>
          assertOperatorInstallationWritable(operator)
        ).not.toThrow();
        entered.resolve();
        await finish.promise;
        expect(() =>
          assertOperatorInstallationWritable(operator)
        ).not.toThrow();
        return "committed and released";
      }
    );
    await entered.promise;
    expect(() => assertOperatorInstallationWritable(operator)).toThrow(
      "OPERATOR_INSTALLATION_RETIRED"
    );
    finish.resolve();
    await expect(coordinator).resolves.toBe("committed and released");
    expect(() => assertOperatorInstallationWritable(operator)).toThrow(
      "OPERATOR_INSTALLATION_RETIRED"
    );
    expect(readFileSync(marker())).toEqual(receipt);
  });
  it("expires inherited authority for asynchronous work that escapes the coordinator", async () => {
    const later = deferred();
    let escaped: Promise<void> | undefined;
    await withOperatorRetirementScope(operator, async (permitOwnRetirement) => {
      const receipt = createOperatorRetirementReceipt(input(), key);
      permitOwnRetirement(receipt);
      writeFileSync(marker(), receipt);
      escaped = later.promise.then(() =>
        assertOperatorInstallationWritable(operator)
      );
    });
    later.resolve();
    await expect(escaped).rejects.toThrow("OPERATOR_INSTALLATION_RETIRED");
  });

  it("does not let a pre-existing concurrent scope excuse another retirement marker", async () => {
    const firstEntered = deferred(),
      secondEntered = deferred(),
      writeFirst = deferred(),
      checkSecond = deferred(),
      firstReceipt = createOperatorRetirementReceipt(input(), key),
      secondReceipt = createOperatorRetirementReceipt(input(), key);
    const first = withOperatorRetirementScope(operator, async (permit) => {
      permit(firstReceipt);
      firstEntered.resolve();
      await writeFirst.promise;
      writeFileSync(marker(), firstReceipt);
      expect(() => assertOperatorInstallationWritable(operator)).not.toThrow();
    });
    const second = withOperatorRetirementScope(operator, async (permit) => {
      permit(secondReceipt);
      secondEntered.resolve();
      await checkSecond.promise;
      expect(() => assertOperatorInstallationWritable(operator)).toThrow(
        "OPERATOR_INSTALLATION_RETIRED"
      );
      expect(() => permit(firstReceipt)).toThrow(
        "INVALID_OPERATOR_RETIREMENT_PERMISSION"
      );
    });
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    writeFirst.resolve();
    await first;
    checkSecond.resolve();
    await second;
  });

  it("permits exactly one immutable marker copy and rejects different regular bytes", async () => {
    await withOperatorRetirementScope(operator, async (permit) => {
      const receipt = createOperatorRetirementReceipt(input(), key),
        original = Buffer.from(receipt);
      permit(receipt);
      receipt.fill(0);
      expect(() => permit(original)).toThrow(
        "INVALID_OPERATOR_RETIREMENT_PERMISSION"
      );
      writeFileSync(marker(), original);
      expect(() => assertOperatorInstallationWritable(operator)).not.toThrow();
      writeFileSync(marker(), Buffer.alloc(original.length, 1));
      expect(() => assertOperatorInstallationWritable(operator)).toThrow(
        "OPERATOR_INSTALLATION_RETIRED"
      );
    });
  });

  it("grants no marker exemption until an exact receipt was permitted before marker creation", async () => {
    await withOperatorRetirementScope(operator, async (permit) => {
      const receipt = createOperatorRetirementReceipt(input(), key);
      writeFileSync(marker(), receipt);
      expect(() => assertOperatorInstallationWritable(operator)).toThrow(
        "OPERATOR_INSTALLATION_RETIRED"
      );
      expect(() => permit(receipt)).toThrow(
        "INVALID_OPERATOR_RETIREMENT_PERMISSION"
      );
    });
  });
  it("expires scope on failure, refuses nested reentrancy and grants no other-directory exemption", async () => {
    const other = join(directory, "other");
    mkdirSync(other);
    writeFileSync(join(other, "operator-retired.json"), "retired");
    await expect(
      withOperatorRetirementScope(operator, async () => {
        await expect(
          withOperatorRetirementScope(other, async () => undefined)
        ).rejects.toThrow("NESTED_OPERATOR_RETIREMENT");
        await expect(
          withOperatorRetirementScope(operator, async () => undefined)
        ).rejects.toThrow("NESTED_OPERATOR_RETIREMENT");
        expect(() => assertOperatorInstallationWritable(other)).toThrow(
          "OPERATOR_INSTALLATION_RETIRED"
        );
        writeFileSync(marker(), "retired");
        throw new Error("coordinator failed");
      })
    ).rejects.toThrow("coordinator failed");
    expect(() => assertOperatorInstallationWritable(operator)).toThrow(
      "OPERATOR_INSTALLATION_RETIRED"
    );
  });
  it("does not excuse linked or hardlinked marker replacement even inside cleanup scope", async () => {
    await withOperatorRetirementScope(operator, async (permitOwnRetirement) => {
      permitOwnRetirement(Buffer.from("replacement"));
      const other = join(directory, "replacement");
      writeFileSync(other, "replacement");
      linkSync(other, marker());
      expect(() => assertOperatorInstallationWritable(operator)).toThrow(
        "OPERATOR_INSTALLATION_RETIRED"
      );
    });
  });
  it("rejects linked, missing, relative and Git-contained scope roots", async () => {
    const linked = join(directory, "linked");
    symlinkSync(
      operator,
      linked,
      process.platform === "win32" ? "junction" : "dir"
    );
    let volume = operator;
    while (dirname(volume) !== volume) volume = dirname(volume);
    for (const root of [
      linked,
      join(directory, "missing"),
      "relative/operator",
      volume,
    ])
      await expect(
        withOperatorRetirementScope(root, async () => undefined)
      ).rejects.toThrow("INVALID_OPERATOR_INSTALLATION");
    mkdirSync(join(directory, ".git"));
    await expect(
      withOperatorRetirementScope(operator, async () => undefined)
    ).rejects.toThrow("INVALID_OPERATOR_INSTALLATION");
  });
  it("signs a fixed domain-separated tuple, returns immutable detached evidence and performs no writes", () => {
    const payload = input(),
      bytes = createOperatorRetirementReceipt(payload, key),
      receipt = verifyOperatorRetirementReceipt(bytes, key);
    expect(receipt).toEqual({
      schemaVersion: 1,
      kind: "zivv-operator-retirement",
      ...payload,
      signature: createHmac("sha256", key)
        .update(
          JSON.stringify([
            "zivv-operator-retirement",
            1,
            payload.checkpointSha256,
            payload.archiveSha256,
            payload.ledgerRevision,
            payload.originalOperatorDirectory,
            payload.installationId,
            payload.retiredAtEpochMs,
          ])
        )
        .digest("hex"),
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(bytes[bytes.length - 1]).toBe(10);
    expect(() => readFileSync(marker())).toThrow();
    bytes.fill(0);
    expect(receipt.checkpointSha256).toBe(payload.checkpointSha256);
  });
  it("authenticates logical Windows and POSIX paths without requiring the retired host", () => {
    for (const originalOperatorDirectory of [
      "C:\\private operator",
      "/private/operator",
    ]) {
      const payload = { ...input(), originalOperatorDirectory };
      expect(
        verifyOperatorRetirementReceipt(
          createOperatorRetirementReceipt(payload, key),
          key
        ).originalOperatorDirectory
      ).toBe(originalOperatorDirectory);
    }
  });
  it("rejects wrong keys and tampering of every signed field", () => {
    const bytes = createOperatorRetirementReceipt(input(), key),
      value = JSON.parse(bytes.toString());
    expect(() =>
      verifyOperatorRetirementReceipt(bytes, randomBytes(32))
    ).toThrow("INVALID_OPERATOR_RETIREMENT");
    for (const change of [
      { checkpointSha256: "4".repeat(64) },
      { archiveSha256: "4".repeat(64) },
      { ledgerRevision: "4".repeat(64) },
      { originalOperatorDirectory: dirname(operator) },
      { installationId: randomUUID() },
      { retiredAtEpochMs: value.retiredAtEpochMs + 1 },
      { signature: "0".repeat(64) },
    ])
      expect(() =>
        verifyOperatorRetirementReceipt(
          Buffer.from(JSON.stringify({ ...value, ...change })),
          key
        )
      ).toThrow("INVALID_OPERATOR_RETIREMENT");
  });
  it("strictly rejects malformed shapes, identifiers, paths, times, digests and key sizes", () => {
    const payload = input(),
      bytes = createOperatorRetirementReceipt(payload, key),
      value = JSON.parse(bytes.toString());
    const changes: Record<string, unknown>[] = [
      { extra: true },
      { schemaVersion: 2 },
      { kind: "other" },
      { signature: "G".repeat(64) },
      { checkpointSha256: "A".repeat(64) },
      { archiveSha256: "invalid" },
      { ledgerRevision: null },
      { installationId: "not-a-uuid" },
      { retiredAtEpochMs: -1 },
      { retiredAtEpochMs: 1.5 },
      { retiredAtEpochMs: Number.MAX_SAFE_INTEGER + 1 },
      { originalOperatorDirectory: "relative" },
      { originalOperatorDirectory: operator + "/../elsewhere" },
      { originalOperatorDirectory: "\\\\server\\share\\operator" },
      { originalOperatorDirectory: "\\\\?\\C:\\operator" },
    ];
    for (const change of changes)
      expect(() =>
        verifyOperatorRetirementReceipt(
          Buffer.from(JSON.stringify({ ...value, ...change })),
          key
        )
      ).toThrow("INVALID_OPERATOR_RETIREMENT");
    for (const invalidBytes of [
      Buffer.from("null"),
      Buffer.from("[]"),
      Buffer.from("{}"),
      Buffer.from("invalid"),
      Buffer.alloc(16 * 1024 + 1),
    ])
      expect(() => verifyOperatorRetirementReceipt(invalidBytes, key)).toThrow(
        "INVALID_OPERATOR_RETIREMENT"
      );
    for (const invalidKey of [
      Buffer.alloc(0),
      Buffer.alloc(31),
      Buffer.alloc(33),
    ]) {
      expect(() =>
        createOperatorRetirementReceipt(payload, invalidKey)
      ).toThrow("INVALID_OPERATOR_RETIREMENT");
      expect(() => verifyOperatorRetirementReceipt(bytes, invalidKey)).toThrow(
        "INVALID_OPERATOR_RETIREMENT"
      );
    }
  });
});
