import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  captureOperatorRecoveryCheckpoint,
  decryptOperatorRecovery,
  encryptOperatorRecovery,
  retireAndCaptureOperatorRecovery,
  stageOperatorRecovery,
  type OperatorRecoveryCheckpoint,
} from "../../lib/ingestion/operator-recovery.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { proveRecoveryGmailBatchInventory } from "../../lib/ingestion/recovery-gmail-batch-proof.js";
import {
  captureSteveGmailWindow,
  readAuthenticatedSteveGmailBatches,
} from "../../lib/ingestion/steve-gmail-handoff.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  canonicalJson,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";

vi.setConfig({ testTimeout: process.platform === "win32" ? 120_000 : 30_000 });
const account = "capsule@fixture.invalid";
const received = Date.parse("2026-10-16T17:00:00Z");
const observed = received + 60_000;
const text =
  "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\nSynthetic Artist at Fixture Club\n";
let directory: string, root: string, operator: string, key: Buffer;
let checkpoint: OperatorRecoveryCheckpoint,
  emptyCheckpoint: OperatorRecoveryCheckpoint;
let batchPath: string, batchBytes: Buffer;

function write(path: string, bytes: string | Buffer) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
}
function apiMessage(id: string, source = text) {
  const body = Buffer.from(source.replace(/\n/g, "\r\n"));
  const headers = [
    "From: Steve Fixture <skoepke@stevelist.com>",
    "Sender: noreply@sp.eocampaign1.com",
    "Date: Fri, 16 Oct 2026 10:00:00 -0700",
    "Subject: Steve's List 10/16/2026",
    `Message-ID: <${id}@fixture.invalid>`,
    "Authentication-Results: mx.google.com; dkim=pass header.i=@sp.eocampaign1.com; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com",
    "DKIM-Signature: v=1; a=rsa-sha256; d=sp.eocampaign1.com; s=fixture; h=from:sender:subject:date; bh=c3ludGhldGlj; b=c3ludGhldGlj",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
  ];
  const raw = Buffer.concat([
    Buffer.from(headers.join("\r\n") + "\r\n\r\n"),
    body,
  ]);
  return {
    id,
    raw: { id, raw: raw.toString("base64url") },
    full: {
      id,
      internalDate: String(received),
      payload: {
        mimeType: "text/plain",
        filename: "",
        headers: headers.map((header) => {
          const colon = header.indexOf(":");
          return {
            name: header.slice(0, colon),
            value: header.slice(colon + 1).trim(),
          };
        }),
        body: { size: body.length, data: body.toString("base64url") },
      },
    },
  };
}
function fakeGmail(): typeof fetch {
  const messages = [
    apiMessage("b1"),
    apiMessage("b2", text + "Second source\n"),
  ];
  return async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    );
    const base = "/gmail/v1/users/me";
    if (url.origin !== "https://gmail.googleapis.com")
      throw new Error("Unexpected fixture origin");
    if (url.pathname === base + "/profile")
      return Response.json({ emailAddress: account });
    if (url.pathname === base + "/messages")
      return Response.json({ messages: messages.map(({ id }) => ({ id })) });
    const message = messages.find(
      (message) => url.pathname === base + "/messages/" + message.id
    );
    if (!message) throw new Error("Unexpected fixture message");
    return Response.json(
      url.searchParams.get("format") === "FULL" ? message.full : message.raw
    );
  };
}
function signedBatch(change: (batch: Record<string, unknown>) => void): Buffer {
  const batch = JSON.parse(batchBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  change(batch);
  const { signature: _signature, ...unsigned } = batch;
  batch.signature = createHmac("sha256", key)
    .update("zivv-steve-gmail-batch/v1\0")
    .update(canonicalJson(unsigned))
    .digest("hex");
  return Buffer.from(canonicalJson(batch) + "\n");
}
function changedCheckpoint(bytes: Buffer): OperatorRecoveryCheckpoint {
  const result = structuredClone(checkpoint);
  const file = result.files.find(
    (file) => file.area === "operator" && file.path === batchPath
  )!;
  file.bytes = bytes.toString("base64");
  file.sha256 = sha256(bytes);
  return result;
}
/** Negative-only authenticated outer envelope, bypassing the public encrypt verifier. */
function envelope(value: OperatorRecoveryCheckpoint): Buffer {
  const header = {
    format: "zivv-operator-recovery",
    version: 1,
    cipher: "aes-256-gcm",
    compression: "gzip",
    keyId: sha256(key),
  };
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonicalJson(header)));
  const ciphertext = Buffer.concat([
    cipher.update(gzipSync(Buffer.from(canonicalJson(value)))),
    cipher.final(),
  ]);
  return Buffer.from(
    canonicalJson({
      ...header,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }) + "\n"
  );
}
function output(name: string) {
  return join(directory, name + ".enc");
}
function expectNoFence(out: string) {
  expect(existsSync(out)).toBe(false);
  expect(existsSync(out + ".retirement.json")).toBe(false);
  expect(existsSync(join(operator, "operator-retired.json"))).toBe(false);
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "zivv-gmail-capsule-"));
  root = join(directory, "checkout");
  operator = join(directory, "operator");
  vi.stubEnv("ZIVV_LEDGER_HOME", operator);
  write(
    join(root, "data/ingestion/store.json"),
    canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
  );
  write(join(root, "package-lock.json"), "fixture lock\n");
  write(join(root, "package.json"), "{}\n");
  write(
    join(root, "dist/lib/ingestion/weekly-import-runner.js"),
    "// retained fixture runtime\n"
  );
  write(join(root, "dist/types/fixture.js"), "// retained fixture type\n");
  write(join(root, "dist/utils/fixture.js"), "// retained fixture utility\n");
  await writeSqliteLedger(
    join(operator, "ledger.sqlite"),
    bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
    true
  );
  mkdirSync(join(operator, "email-acquisition/batches"), { recursive: true });
  emptyCheckpoint = await captureOperatorRecoveryCheckpoint(root);
  expect(existsSync(join(operator, "backup-key.bin"))).toBe(false);
  expect(existsSync(join(operator, "backup-key.dpapi"))).toBe(false);
  key = loadBackupKey(operator, true);
  const clock = vi.spyOn(Date, "now").mockReturnValue(observed);
  const save = WeeklyRunJournal.prototype.saveIntakeEvidence;
  let interrupted = false;
  const interrupt = vi
    .spyOn(WeeklyRunJournal.prototype, "saveIntakeEvidence")
    .mockImplementation(function (
      this: WeeklyRunJournal,
      kind,
      id,
      bytes,
      lease
    ) {
      const receipt = JSON.parse(bytes.toString("utf8")) as {
        messageId?: string;
      };
      if (kind === "source" && receipt.messageId === "b2") {
        interrupted = true;
        throw new Error("CAPSULE_FIXTURE_SECOND_CAPTURE_INTERRUPTION");
      }
      return save.call(this, kind, id, bytes, lease);
    });
  try {
    await expect(
      captureSteveGmailWindow({
        operatorDirectory: operator,
        expectedAccountId: account,
        expectedEditionId: "2026-10-16",
        startEpochMs: received - 60_000,
        endEpochMs: received + 3_600_000,
        getAccessToken: async () => "synthetic_token",
        fetcher: fakeGmail(),
      })
    ).rejects.toThrow();
    expect(interrupted).toBe(true);
  } finally {
    interrupt.mockRestore();
    clock.mockRestore();
  }
  const names = readdirSync(join(operator, "email-acquisition/batches"));
  expect(names).toHaveLength(1);
  batchPath = "email-acquisition/batches/" + names[0]!;
  batchBytes = readFileSync(join(operator, batchPath));
  checkpoint = await captureOperatorRecoveryCheckpoint(root);
}, 180_000);
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (!directory) return;
  const suffix = relative(resolve(tmpdir()), resolve(directory));
  if (
    !suffix.startsWith("zivv-gmail-capsule-") ||
    suffix.includes("..") ||
    suffix.includes("\\") ||
    suffix.includes("/")
  )
    throw new Error("Unsafe fixture cleanup");
  rmSync(directory, { recursive: true, force: true });
});

describe("authenticated Gmail batch capsule preservation", () => {
  it("keeps empty acquisition capsules compatible without key creation", async () => {
    const decoded = decryptOperatorRecovery(
      encryptOperatorRecovery(emptyCheckpoint, key),
      key
    );
    expect(decoded).toEqual(emptyCheckpoint);
    const target = join(directory, "empty-stage");
    await stageOperatorRecovery(decoded, target, key);
    expect(
      readAuthenticatedSteveGmailBatches({
        operatorDirectory: join(target, "operator"),
      })
    ).toEqual([]);
    expect(existsSync(join(target, "operator/backup-key.bin"))).toBe(false);
    expect(existsSync(join(target, "operator/backup-key.dpapi"))).toBe(false);
  });
  it("checks batch proof in encrypt, authenticated decrypt and stage before target creation", async () => {
    const malformed = Buffer.from(batchBytes);
    malformed[10] = malformed[10]! ^ 1;
    const variants = [
      malformed,
      signedBatch((batch) => {
        batch.operatorDirectory = "/different/original";
      }),
      signedBatch((batch) => {
        batch.firstSavedAtEpochMs = checkpoint.createdAtEpochMs + 1;
      }),
    ];
    for (const [index, bytes] of variants.entries()) {
      const value = changedCheckpoint(bytes),
        target = join(directory, "invalid-stage-" + index);
      expect(() => encryptOperatorRecovery(value, key)).toThrow();
      expect(() => decryptOperatorRecovery(envelope(value), key)).toThrow();
      await expect(stageOperatorRecovery(value, target, key)).rejects.toThrow();
      expect(existsSync(target)).toBe(false);
    }
    expect(() =>
      encryptOperatorRecovery(checkpoint, randomBytes(32))
    ).toThrow();
    expect(() =>
      decryptOperatorRecovery(
        encryptOperatorRecovery(checkpoint, key),
        randomBytes(32)
      )
    ).toThrow();
    const target = join(directory, "wrong-key-stage");
    await expect(
      stageOperatorRecovery(checkpoint, target, randomBytes(32))
    ).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });
  it("refuses physical wrong-root/time/tamper batches before capture finalization or fencing", async () => {
    const variants = [
      Buffer.from("partial\n"),
      signedBatch((batch) => {
        batch.operatorDirectory = "/wrong/root";
      }),
      signedBatch((batch) => {
        batch.firstSavedAtEpochMs = Date.now() + 60_000;
      }),
    ];
    for (const [index, bytes] of variants.entries()) {
      writeFileSync(join(operator, batchPath), bytes);
      try {
        await expect(captureOperatorRecoveryCheckpoint(root)).rejects.toThrow();
        const out = output("invalid-capture-" + index);
        await expect(
          retireAndCaptureOperatorRecovery({ root, out })
        ).rejects.toThrow();
        expectNoFence(out);
        expect(readFileSync(join(operator, batchPath))).toEqual(bytes);
      } finally {
        writeFileSync(join(operator, batchPath), batchBytes);
      }
    }
  });
  it("repairs only a unique authenticated orphan or exact hard-link alias before capture locks", async () => {
    const canonical = join(operator, batchPath),
      stage = canonical + ".123." + "a".repeat(16) + ".tmp";
    for (const alias of [false, true]) {
      if (alias) linkSync(canonical, stage);
      else renameSync(canonical, stage);
      const value = await captureOperatorRecoveryCheckpoint(root);
      expect(readFileSync(canonical)).toEqual(batchBytes);
      expect(existsSync(stage)).toBe(false);
      expect(lstatSync(canonical).nlink).toBe(1);
      expect(value.files.find((file) => file.path === batchPath)?.bytes).toBe(
        batchBytes.toString("base64")
      );
      expect(
        proveRecoveryGmailBatchInventory({
          checkpoint: value,
          recoveryKey: key,
        }).batches[0]!.messages.map((message) => message.status)
      ).toEqual(["captured", "pending"]);
    }
  });
  it("preserves partial, ambiguous, foreign-link and late-stage evidence without a fence", async () => {
    const canonical = join(operator, batchPath),
      stage = canonical + ".123." + "a".repeat(16) + ".tmp",
      other = canonical + ".124." + "b".repeat(16) + ".tmp",
      foreign = join(directory, "foreign-link");
    for (const kind of ["partial", "ambiguous", "foreign"] as const) {
      if (kind === "partial") writeFileSync(stage, "partial stage\n");
      else {
        writeFileSync(stage, batchBytes);
        if (kind === "ambiguous") writeFileSync(other, batchBytes);
        else linkSync(stage, foreign);
      }
      try {
        const out = output(kind);
        await expect(
          retireAndCaptureOperatorRecovery({ root, out })
        ).rejects.toThrow();
        expectNoFence(out);
        expect(existsSync(stage)).toBe(true);
        expect(readFileSync(canonical)).toEqual(batchBytes);
      } finally {
        if (existsSync(stage)) unlinkSync(stage);
        if (existsSync(other)) unlinkSync(other);
        if (existsSync(foreign)) unlinkSync(foreign);
      }
    }
    const original = WeeklyRunJournal.prototype.exportRecoverySnapshot;
    const hook = vi
      .spyOn(WeeklyRunJournal.prototype, "exportRecoverySnapshot")
      .mockImplementation(function (this: WeeklyRunJournal, lease) {
        const result = original.call(this, lease);
        writeFileSync(stage, batchBytes);
        return result;
      });
    const out = output("late-stage");
    try {
      await expect(
        retireAndCaptureOperatorRecovery({ root, out })
      ).rejects.toThrow();
      expectNoFence(out);
      expect(readFileSync(stage)).toEqual(batchBytes);
    } finally {
      hook.mockRestore();
      if (existsSync(stage)) unlinkSync(stage);
    }
    const proofModule =
      await import("../../lib/ingestion/recovery-gmail-batch-proof.js");
    const originalProof = proofModule.proveRecoveryGmailBatchInventory;
    const proofHook = vi
      .spyOn(proofModule, "proveRecoveryGmailBatchInventory")
      .mockImplementation((input) => {
        const result = originalProof(input);
        writeFileSync(stage, batchBytes);
        return result;
      });
    const postProofOut = output("post-proof-stage");
    try {
      await expect(
        retireAndCaptureOperatorRecovery({ root, out: postProofOut })
      ).rejects.toThrow();
      expect(proofHook).toHaveBeenCalledOnce();
      expectNoFence(postProofOut);
      expect(readFileSync(stage)).toEqual(batchBytes);
    } finally {
      proofHook.mockRestore();
      if (existsSync(stage)) unlinkSync(stage);
    }
  });
  it("retires, deletes the old host and stages exact original bytes without ordinary relocated-read authority", async () => {
    const out = output("complete");
    const result = await retireAndCaptureOperatorRecovery({ root, out });
    expect(
      result.checkpoint.files.find((file) => file.path === batchPath)?.bytes
    ).toBe(batchBytes.toString("base64"));
    const keyName =
      process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin";
    const keyFile = readFileSync(join(operator, keyName));
    rmSync(operator, { recursive: true });
    rmSync(root, { recursive: true });
    const decoded = decryptOperatorRecovery(readFileSync(out), key),
      target = join(directory, "new-host");
    await stageOperatorRecovery(decoded, target, key);
    const stagedOperator = join(target, "operator"),
      stagedBatch = join(stagedOperator, batchPath);
    expect(readFileSync(stagedBatch)).toEqual(batchBytes);
    expect(lstatSync(stagedBatch).nlink).toBe(1);
    expect(existsSync(join(stagedOperator, keyName))).toBe(false);
    expect(() => assertOperatorNotQuarantined(stagedOperator)).toThrow();
    // Even supplying the exact temporary original key does not rewrite the signed root.
    writeFileSync(join(stagedOperator, keyName), keyFile);
    try {
      expect(() =>
        readAuthenticatedSteveGmailBatches({
          operatorDirectory: stagedOperator,
        })
      ).toThrow();
    } finally {
      unlinkSync(join(stagedOperator, keyName));
    }
    expect(
      proveRecoveryGmailBatchInventory({
        checkpoint: decoded,
        recoveryKey: key,
      }).batches[0]!.messages.map((message) => message.status)
    ).toEqual(["captured", "pending"]);
  });
});
