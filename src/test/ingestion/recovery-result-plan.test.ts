import { createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryResultChainFixture } from "./fixtures/recovery-result-chain-fixture.js";
import { encryptRecoveryResultChain } from "../../lib/ingestion/recovery-result-chain.js";
import {
  authenticateRecoveryResultPlan,
  createRecoveryResultPlan,
  installRecoveryResultPlan,
  publishRecoveryResultPlan,
  readRecoveryResultPlan,
  recoveryResultSourceFingerprint,
  type RecoveryResultPlanContext,
} from "../../lib/ingestion/recovery-result-plan.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import type { WeeklyJournalRecoverySnapshot } from "../../lib/ingestion/weekly-run-journal.js";

const magic = Buffer.from("ZIVV-RESULT-PLAN\0");
const headerBytes = magic.length + 9;

describe("recovery result plan binary boundaries", () => {
  const context: RecoveryResultPlanContext = {
    root: "unused",
    operator: "unused",
    repositoryRoot: "unused",
    npmCli: "unused",
    out: "unused",
    runId: "a".repeat(64),
    admissionSha256: "a".repeat(64),
    resultSha256: "a".repeat(64),
    preparedReceiptSha256: "a".repeat(64),
  };
  const reject = (bytes: Buffer, recoveryKey = Buffer.alloc(32)) =>
    expect(() =>
      authenticateRecoveryResultPlan({ bytes, recoveryKey, context })
    ).toThrow();
  it("rejects magic, version, truncation, trailing and bounded length declarations", () => {
    const frame = Buffer.alloc(headerBytes + 2);
    magic.copy(frame);
    frame[magic.length] = 1;
    frame.writeUInt32BE(1, magic.length + 1);
    frame.writeUInt32BE(1, magic.length + 5);
    reject(frame.subarray(0, headerBytes - 1));
    const badMagic = Buffer.from(frame);
    badMagic[0] ^= 1;
    reject(badMagic);
    const version = Buffer.from(frame);
    version[magic.length] = 2;
    reject(version);
    for (const [offset, value] of [
      [magic.length + 1, 0],
      [magic.length + 1, 65_537],
      [magic.length + 5, 0],
      [magic.length + 5, 752_242_216],
    ]) {
      const invalid = Buffer.from(frame);
      invalid.writeUInt32BE(value, offset);
      reject(invalid);
    }
    reject(Buffer.concat([frame, Buffer.from("trailing")]));
    reject(frame.subarray(0, frame.length - 1));
    reject(frame, Buffer.alloc(31));
  });
});

describe("durable private recovery result plan", () => {
  let setup: Awaited<ReturnType<typeof createRecoveryResultChainFixture>>;
  let chain: Buffer;
  let base: Omit<RecoveryResultPlanContext, "out">;
  let outputs: string;
  beforeAll(async () => {
    setup = await createRecoveryResultChainFixture();
    const admission = JSON.parse(
      setup.members.admissionReceipt.toString("utf8")
    ).payload;
    mkdirSync(admission.root, { recursive: true });
    mkdirSync(admission.operator, { recursive: true });
    mkdirSync(join(admission.root, "checkout"), { recursive: true });
    outputs = join(setup.directory, "private-handoff");
    mkdirSync(outputs);
    chain = encryptRecoveryResultChain({
      members: setup.members,
      recoveryKey: setup.key,
    });
    base = {
      root: admission.root,
      operator: admission.operator,
      repositoryRoot: admission.repositoryRoot,
      npmCli: admission.physicalNpmCli,
      runId: admission.runId,
      admissionSha256: sha256(setup.members.admissionReceipt),
      resultSha256: sha256(setup.members.resultReceipt),
      preparedReceiptSha256: sha256(setup.members.preparedReceipt),
    };
  }, 120_000);
  afterAll(() => setup?.cleanup());
  const planAt = (name: string, encryptedChain?: Buffer) => {
    const context = { ...base, out: join(outputs, name) },
      input = { context, recoveryKey: setup.key },
      bytes = createRecoveryResultPlan({
        ...input,
        chain: encryptedChain ?? chain,
      });
    return { ...input, bytes };
  };
  const orphan = (input: ReturnType<typeof planAt>, bytes = input.bytes) => {
    const stage = input.context.out + ".plan-stage";
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    const path = join(
      stage,
      basename(input.context.out + ".plan") +
        "." +
        process.pid +
        "." +
        randomBytes(8).toString("hex") +
        ".tmp"
    );
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    return path;
  };
  it("authenticates genuine provenance, installs exclusively, and publishes exact deterministic bytes", () => {
    const input = planAt("positive"),
      proof = authenticateRecoveryResultPlan(input);
    expect(proof.metadata).toMatchObject({
      activationAllowed: false,
      physicalValidationRequired: true,
      freshRemoteValidationRequired: true,
      context: input.context,
      chainSha256: sha256(chain),
      chainSize: chain.length,
    });
    expect(createRecoveryResultPlan({ ...input, chain })).toEqual(input.bytes);
    const installed = installRecoveryResultPlan(input);
    expect(installRecoveryResultPlan(input)).toEqual(installed);
    expect(readFileSync(input.context.out + ".plan")).toEqual(input.bytes);
    expect(lstatSync(input.context.out + ".plan").nlink).toBe(1);
    let checks = 0;
    const publish = () =>
      publishRecoveryResultPlan({ ...input, assertFenced: () => checks++ });
    expect(publish().planId).toBe(installed.planId);
    const receipt = readFileSync(input.context.out + ".receipt.json");
    expect(readFileSync(input.context.out)).toEqual(chain);
    expect(receipt).toEqual(proof.portableReceipt);
    expect(publish().planId).toBe(installed.planId);
    expect(readFileSync(input.context.out + ".receipt.json")).toEqual(receipt);
    expect(checks).toBeGreaterThanOrEqual(8);
    const portable = JSON.parse(receipt.toString("utf8"));
    expect(portable.payload).toEqual({
      kind: "zivv-recovery-result-portable-receipt",
      version: 1,
      activationAllowed: false,
      chainId: proof.metadata.chainId,
      chainSha256: sha256(chain),
      chainSize: chain.length,
      successorRetirementSha256: sha256(
        setup.members.successorRetirementReceipt
      ),
      runId: base.runId,
      candidateId: proof.metadata.candidateId,
    });
    expect(receipt.toString("utf8")).not.toContain(
      outputs.replaceAll("\\", "\\\\")
    );
    expect(portable.signature).toBe(
      createHmac("sha256", setup.key)
        .update("zivv-recovery-result-portable-receipt/v1\0")
        .update(canonicalJson(portable.payload))
        .digest("hex")
    );
  });
  it("binds signed context and refuses wrong keys, tampering and inconsistent valid-HMAC metadata", () => {
    const input = planAt("authentication");
    expect(() =>
      authenticateRecoveryResultPlan({
        ...input,
        context: { ...input.context, out: join(outputs, "different") },
      })
    ).toThrow("CONTEXT_MISMATCH");
    expect(() =>
      authenticateRecoveryResultPlan({ ...input, recoveryKey: randomBytes(32) })
    ).toThrow("INVALID_SIGNATURE");
    const metadataLength = input.bytes.readUInt32BE(magic.length + 1),
      signed = JSON.parse(
        input.bytes
          .subarray(headerBytes, headerBytes + metadataLength)
          .toString()
      );
    signed.payload.candidateId = "a".repeat(64);
    signed.signature = createHmac("sha256", setup.key)
      .update("zivv-recovery-result-plan/v1\0")
      .update(canonicalJson(signed.payload))
      .digest("hex");
    const metadata = Buffer.from(canonicalJson(signed) + "\n"),
      header = Buffer.from(input.bytes.subarray(0, headerBytes));
    header.writeUInt32BE(metadata.length, magic.length + 1);
    expect(() =>
      authenticateRecoveryResultPlan({
        ...input,
        bytes: Buffer.concat([header, metadata, chain]),
      })
    ).toThrow("PROVENANCE_MISMATCH");
    const tampered = Buffer.from(input.bytes);
    tampered[headerBytes + metadataLength - 4] ^= 1;
    expect(() =>
      authenticateRecoveryResultPlan({ ...input, bytes: tampered })
    ).toThrow();
    expect(() =>
      createRecoveryResultPlan({
        ...input,
        chain,
        context: { ...input.context, resultSha256: "0".repeat(64) },
      })
    ).toThrow("CONTEXT_MISMATCH");
  });
  it("adopts a unique complete orphan and cleans only a proven lost-link alias", () => {
    const input = planAt("orphan"),
      path = orphan(input);
    expect(readRecoveryResultPlan(input).chain).toEqual(chain);
    expect(existsSync(path)).toBe(false);
    expect(lstatSync(input.context.out + ".plan").nlink).toBe(1);
    const linked = planAt("lost-link"),
      alias = orphan(linked);
    linkSync(alias, linked.context.out + ".plan");
    expect(lstatSync(alias).nlink).toBe(2);
    expect(readRecoveryResultPlan(linked).chain).toEqual(chain);
    expect(existsSync(alias)).toBe(false);
    expect(lstatSync(linked.context.out + ".plan").nlink).toBe(1);
  });
  it("preserves partial evidence and refuses ambiguous authenticated complete plans", () => {
    const partial = planAt("partial"),
      path = orphan(partial, Buffer.from("partial bytes"));
    expect(() => readRecoveryResultPlan(partial)).toThrow("PLAN_MISSING");
    installRecoveryResultPlan(partial);
    expect(readFileSync(path)).toEqual(Buffer.from("partial bytes"));
    const ambiguous = planAt("ambiguous"),
      second = planAt(
        "ambiguous",
        encryptRecoveryResultChain({
          members: setup.members,
          recoveryKey: setup.key,
        })
      );
    const firstPath = orphan(ambiguous),
      secondPath = orphan(second);
    expect(() => readRecoveryResultPlan(ambiguous)).toThrow("AMBIGUOUS_PLAN");
    expect(() => installRecoveryResultPlan(ambiguous)).toThrow(
      "AMBIGUOUS_PLAN"
    );
    expect(existsSync(ambiguous.context.out + ".plan")).toBe(false);
    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(true);
  });
  it("never overwrites a conflicting installed plan or private output", () => {
    const input = planAt("conflict");
    installRecoveryResultPlan(input);
    const competing = planAt(
      "conflict",
      encryptRecoveryResultChain({
        members: setup.members,
        recoveryKey: setup.key,
      })
    );
    expect(() => installRecoveryResultPlan(competing)).toThrow("PLAN_CONFLICT");
    expect(readFileSync(input.context.out + ".plan")).toEqual(input.bytes);
    writeFileSync(input.context.out, "unrelated", { flag: "wx" });
    expect(() =>
      publishRecoveryResultPlan({ ...input, assertFenced: () => {} })
    ).toThrow("OUTPUT_CONFLICT");
    expect(readFileSync(input.context.out, "utf8")).toBe("unrelated");
    expect(existsSync(input.context.out + ".receipt.json")).toBe(false);
  });
  it("requires the fence before output writes and repairs an exact lost publication response", () => {
    const input = planAt("interrupted");
    installRecoveryResultPlan(input);
    expect(() =>
      publishRecoveryResultPlan({
        ...input,
        assertFenced: () => {
          throw new Error("fence unavailable");
        },
      })
    ).toThrow("fence unavailable");
    expect(existsSync(input.context.out)).toBe(false);
    expect(readdirSync(input.context.out + ".plan-stage")).toEqual([]);
    expect(() =>
      publishRecoveryResultPlan({
        ...input,
        assertFenced: () => {
          if (existsSync(input.context.out))
            throw new Error("lost link response");
        },
      })
    ).toThrow("lost link response");
    expect(readFileSync(input.context.out)).toEqual(chain);
    expect(lstatSync(input.context.out).nlink).toBe(2);
    expect(existsSync(input.context.out + ".receipt.json")).toBe(false);
    const repaired = publishRecoveryResultPlan({
      ...input,
      assertFenced: () => {},
    });
    expect(readFileSync(input.context.out)).toEqual(chain);
    expect(readFileSync(input.context.out + ".receipt.json")).toEqual(
      repaired.portableReceipt
    );
    expect(lstatSync(input.context.out).nlink).toBe(1);
    expect(readdirSync(input.context.out + ".plan-stage")).toEqual([]);
  });
  it("refuses unclassified hard links, directory links, prepared-root and Git-root output paths", () => {
    const input = planAt("hardlink");
    installRecoveryResultPlan(input);
    const outsideAlias = join(outputs, "unclassified-alias");
    linkSync(input.context.out + ".plan", outsideAlias);
    expect(() => readRecoveryResultPlan(input)).toThrow("UNCLASSIFIED_LINK");
    expect(existsSync(outsideAlias)).toBe(true);
    const junction = join(outputs, "directory-link");
    symlinkSync(
      outputs,
      junction,
      process.platform === "win32" ? "junction" : "dir"
    );
    for (const out of [
      join(junction, "unsafe"),
      join(base.root, "unsafe"),
      join(base.operator, "unsafe"),
      join(base.repositoryRoot, "unsafe"),
      ...(process.platform === "win32"
        ? [
            join(outputs, "trailing."),
            join(outputs, "stream:alternate"),
            join(outputs, "NUL"),
          ]
        : []),
    ])
      expect(() =>
        createRecoveryResultPlan({
          chain,
          recoveryKey: setup.key,
          context: { ...base, out },
        })
      ).toThrow();
    const gitRoot = join(outputs, "separate-git-root");
    mkdirSync(join(gitRoot, ".git"), { recursive: true });
    expect(() =>
      createRecoveryResultPlan({
        chain,
        recoveryKey: setup.key,
        context: { ...base, out: join(gitRoot, "unsafe") },
      })
    ).toThrow("GIT_OUTPUT_REFUSED");
    expect(() =>
      createRecoveryResultPlan({
        chain,
        recoveryKey: setup.key,
        context: { ...base, out: join(setup.fixture.bareDirectory, "unsafe") },
      })
    ).toThrow("GIT_OUTPUT_REFUSED");
  });
  it("fingerprints every captured field except capture time and production ownership bookkeeping", () => {
    const fingerprint = recoveryResultSourceFingerprint(setup.successor),
      changed = structuredClone(setup.successor);
    changed.createdAtEpochMs += 1000;
    const journal = JSON.parse(
      Buffer.from(changed.journal, "base64").toString()
    ) as WeeklyJournalRecoverySnapshot;
    const production = journal.ownership.find(
      (row) => row.scope === "prodigic/zivv/production"
    )!;
    production.owner = "11111111-1111-4111-8111-111111111111";
    production.fence += 1;
    production.expiresAtEpochMs += 2000;
    const save = () => {
      const { digest: _digest, ...body } = journal;
      changed.journal = Buffer.from(
        canonicalJson({ ...body, digest: sha256(canonicalJson(body)) }) + "\n"
      ).toString("base64");
    };
    save();
    expect(recoveryResultSourceFingerprint(changed)).toBe(fingerprint);
    journal.ownership.push({
      scope: "test/other",
      owner: "22222222-2222-4222-8222-222222222222",
      fence: 1,
      expiresAtEpochMs: 0,
    });
    journal.ownership.sort((a, b) => a.scope.localeCompare(b.scope, "en"));
    save();
    expect(recoveryResultSourceFingerprint(changed)).not.toBe(fingerprint);
    const content = structuredClone(setup.successor),
      file = content.files.find(
        (row) => row.area === "checkout" && row.path === "package.json"
      )!;
    const bytes = Buffer.from(
      Buffer.from(file.bytes!, "base64").toString() + "\n"
    );
    file.bytes = bytes.toString("base64");
    file.sha256 = sha256(bytes);
    expect(recoveryResultSourceFingerprint(content)).not.toBe(fingerprint);
  });
});
