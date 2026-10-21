import { createHmac } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { proveRecoveryGmailBatchInventory } from "../../lib/ingestion/recovery-gmail-batch-proof.js";
import {
  authenticateSteveGmailBatchBytes,
  captureSteveGmailWindow,
  replaySteveGmailBatch,
} from "../../lib/ingestion/steve-gmail-handoff.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { readWeeklyJournalRecoverySnapshotReadOnly } from "../../lib/ingestion/weekly-run-journal.js";

vi.setConfig({ testTimeout: process.platform === "win32" ? 90_000 : 15_000 });
type Checkpoint = Parameters<
  typeof proveRecoveryGmailBatchInventory
>[0]["checkpoint"];
const account = "batch-proof@fixture.invalid";
const received = Date.parse("2026-10-16T17:00:00Z");
const now = received + 60_000;
const text =
  "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\nSynthetic Artist at Fixture Club\n";

function message(id: string, bodyText = text, mismatch = false) {
  const body = Buffer.from(bodyText.replace(/\r?\n/g, "\r\n"));
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
  const projected = mismatch ? Buffer.from("Untrusted FULL text\n") : body;
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
          const split = header.indexOf(":");
          return {
            name: header.slice(0, split),
            value: header.slice(split + 1).trim(),
          };
        }),
        body: { size: projected.length, data: projected.toString("base64url") },
      },
    },
  };
}
function fakeGmail(messages: ReturnType<typeof message>[]): typeof fetch {
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
    const item = messages.find(
      (item) => url.pathname === base + "/messages/" + item.id
    );
    if (!item) throw new Error("Unexpected fixture message");
    return Response.json(
      url.searchParams.get("format") === "FULL" ? item.full : item.raw
    );
  };
}
let checkpoint: Checkpoint;
let approvedCheckpoint: Checkpoint;
let recoveryKey: Buffer;
let batchPath: string;
function cleanFixture(root: string, setupFailure?: { error: unknown }): void {
  try {
    const suffix = relative(resolve(tmpdir()), resolve(root));
    if (
      !suffix.startsWith("zivv-gmail-proof-") ||
      suffix.includes("..") ||
      suffix.includes("\\") ||
      suffix.includes("/")
    )
      throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if (setupFailure)
      throw new AggregateError(
        [setupFailure.error, error],
        "Fixture setup and cleanup failed",
        { cause: setupFailure.error }
      );
    throw error;
  }
}
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "zivv-gmail-proof-"));
  const operator = join(root, "operator");
  mkdirSync(operator);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let setupFailure: { error: unknown } | undefined;
  try {
    recoveryKey = loadBackupKey(operator, true);
    // The whole window is genuinely signed before intake reaches the refused fourth message.
    await expect(
      captureSteveGmailWindow({
        operatorDirectory: operator,
        expectedAccountId: account,
        expectedEditionId: "2026-10-16",
        startEpochMs: received - 60_000,
        endEpochMs: received + 3_600_000,
        getAccessToken: async () => "synthetic_token",
        fetcher: fakeGmail([
          message("a1"),
          message("a2"),
          message("a3", text + "Correction\n"),
          message("a4", text, true),
        ]),
      })
    ).rejects.toThrow();
    function capturedCheckpoint(): Checkpoint {
      const value: Checkpoint = {
        originalOperatorDirectory: operator,
        createdAtEpochMs: now,
        files: [],
        directories: [],
        journal: readWeeklyJournalRecoverySnapshotReadOnly(
          join(operator, "weekly-runs.sqlite")
        ).toString("base64"),
      };
      function walk(path: string) {
        value.directories.push({ area: "operator", path });
        for (const entry of readdirSync(join(operator, path), {
          withFileTypes: true,
        })) {
          const child = path + "/" + entry.name;
          if (entry.isDirectory()) walk(child);
          else {
            const bytes = readFileSync(join(operator, child));
            value.files.push({
              area: "operator",
              path: child,
              sha256: sha256(bytes),
              bytes: bytes.toString("base64"),
            });
          }
        }
      }
      walk("email-acquisition");
      walk("email-intake");
      return value;
    }
    checkpoint = capturedCheckpoint();
    batchPath = checkpoint.files.find((row) =>
      row.path.startsWith("email-acquisition/")
    )!.path;
    const first = proveRecoveryGmailBatchInventory({ checkpoint, recoveryKey })
      .batches[0]!.messages[0]!;
    if (first.status !== "captured")
      throw new Error("Fixture first message was not captured");
    await expect(
      replaySteveGmailBatch({
        operatorDirectory: operator,
        expectedAccountId: account,
        expectedEditionId: "2026-10-16",
        batchId: batchPath.split("/").at(-1)!.slice(0, -5),
        correctionOfByMessageId: { a3: first.receiptId },
      })
    ).rejects.toThrow();
    approvedCheckpoint = capturedCheckpoint();
    // Every test subsequently runs with the entire original physical root gone.
  } catch (error) {
    setupFailure = { error };
    throw error;
  } finally {
    clock.mockRestore();
    cleanFixture(root, setupFailure);
  }
}, 180_000);

function copy(): Checkpoint {
  return structuredClone(checkpoint);
}
function row(value: Checkpoint) {
  return value.files.find((row) => row.path === batchPath)!;
}
function batchBytes(value = checkpoint) {
  return Buffer.from(row(value).bytes!, "base64");
}
function modifyBatch(
  value: Checkpoint,
  change: (batch: Record<string, unknown>) => void
) {
  const batch = JSON.parse(batchBytes(value).toString("utf8")) as Record<
    string,
    unknown
  >;
  change(batch);
  const { signature: _signature, ...unsigned } = batch;
  batch.signature = createHmac("sha256", recoveryKey)
    .update("zivv-steve-gmail-batch/v1\0")
    .update(canonicalJson(unsigned))
    .digest("hex");
  const bytes = Buffer.from(canonicalJson(batch) + "\n");
  row(value).bytes = bytes.toString("base64");
  row(value).sha256 = sha256(bytes);
}

describe("detached recovery Gmail acquisition proof", () => {
  it("authenticates exact saved bytes after old-root deletion and preserves pending, duplicate and review states", () => {
    const result = proveRecoveryGmailBatchInventory({
      checkpoint,
      recoveryKey,
    });
    expect(result).toMatchObject({
      activationAllowed: false,
      captureAllowed: false,
      physicalValidationRequired: true,
    });
    expect(result.batches[0]!.messages).toEqual([
      {
        messageId: "a1",
        status: "captured",
        receiptId: expect.any(String),
        disposition: "ready",
      },
      {
        messageId: "a2",
        status: "captured",
        receiptId: expect.any(String),
        disposition: "ready",
      },
      {
        messageId: "a3",
        status: "captured",
        receiptId: expect.any(String),
        disposition: "review-required",
      },
      { messageId: "a4", status: "pending" },
    ]);
    expect(result.batches[0]!.messages[0]).toMatchObject({
      receiptId:
        result.batches[0]!.messages[1]!.status === "captured"
          ? result.batches[0]!.messages[1]!.receiptId
          : "missing",
    });
    result.batches[0]!.batch.snapshots[0]!.rawMessage.raw = "changed";
    expect(
      proveRecoveryGmailBatchInventory({ checkpoint, recoveryKey }).batches[0]!
        .batch.snapshots[0]!.rawMessage.raw
    ).not.toBe("changed");
  });
  it("keeps legacy and empty acquisition inventories keyless", () => {
    const value = copy();
    value.files = [];
    value.directories = [];
    value.journal = "not read";
    expect(
      proveRecoveryGmailBatchInventory({ checkpoint: value }).batches
    ).toEqual([]);
    value.directories = [
      { area: "operator", path: "email-acquisition" },
      { area: "operator", path: "email-acquisition/batches" },
    ];
    expect(
      proveRecoveryGmailBatchInventory({ checkpoint: value }).batches
    ).toEqual([]);
  });
  it("resolves only exact journal-anchored explicit correction approval", () => {
    expect(
      proveRecoveryGmailBatchInventory({
        checkpoint: approvedCheckpoint,
        recoveryKey,
      }).batches[0]!.messages[2]
    ).toMatchObject({ status: "captured", disposition: "ready" });
    const value = structuredClone(approvedCheckpoint);
    const approval = value.files.find((file) =>
      file.path.endsWith("/correction-approval.json")
    )!;
    const json = JSON.parse(
      Buffer.from(approval.bytes!, "base64").toString("utf8")
    ) as Record<string, unknown>;
    json.correctionOf = "0".repeat(64);
    const bytes = Buffer.from(canonicalJson(json) + "\n");
    approval.bytes = bytes.toString("base64");
    approval.sha256 = sha256(bytes);
    expect(() =>
      proveRecoveryGmailBatchInventory({ checkpoint: value, recoveryKey })
    ).toThrow();
  });
  it("checks canonical logical Windows/POSIX roots without filesystem lookup", () => {
    for (const root of ["/nonexistent/operator", "C:\\nonexistent\\operator"]) {
      const value = copy();
      modifyBatch(value, (batch) => {
        batch.operatorDirectory = root;
      });
      expect(
        authenticateSteveGmailBatchBytes({
          bytes: batchBytes(value),
          fileName: batchPath.split("/").at(-1)!,
          originalOperatorDirectory: root,
          recoveryKey,
        }).operatorDirectory
      ).toBe(root);
    }
    for (const root of [
      "relative",
      "/nonexistent/../operator",
      "\\\\host\\share",
      "/bad\0root",
    ]) {
      expect(() =>
        authenticateSteveGmailBatchBytes({
          bytes: batchBytes(),
          fileName: batchPath.split("/").at(-1)!,
          originalOperatorDirectory: root,
          recoveryKey,
        })
      ).toThrow();
    }
  });
  it("rejects wrong/missing key, filename binding, tampering and valid-HMAC wrong-root members", () => {
    expect(() => proveRecoveryGmailBatchInventory({ checkpoint })).toThrow();
    for (const key of [Buffer.alloc(32), Buffer.alloc(31)])
      expect(() =>
        proveRecoveryGmailBatchInventory({ checkpoint, recoveryKey: key })
      ).toThrow();
    expect(() =>
      authenticateSteveGmailBatchBytes({
        bytes: batchBytes(),
        fileName: "0".repeat(64) + ".json",
        originalOperatorDirectory: checkpoint.originalOperatorDirectory,
        recoveryKey,
      })
    ).toThrow();
    const changed = copy();
    modifyBatch(changed, (batch) => {
      batch.operatorDirectory = "/different/operator";
    });
    expect(() =>
      proveRecoveryGmailBatchInventory({ checkpoint: changed, recoveryKey })
    ).toThrow();
    const tampered = copy();
    const bytes = batchBytes(tampered);
    bytes[10] = bytes[10]! ^ 1;
    row(tampered).bytes = bytes.toString("base64");
    row(tampered).sha256 = sha256(bytes);
    expect(() =>
      proveRecoveryGmailBatchInventory({ checkpoint: tampered, recoveryKey })
    ).toThrow();
  });
  it("refuses unknown, staged, aliased, absent and malformed inventory roles", () => {
    for (const path of [
      batchPath + ".123." + "a".repeat(16) + ".tmp",
      "email-acquisition/unexpected.json",
      batchPath.replace("email-acquisition", "Email-Acquisition"),
    ]) {
      const value = copy();
      row(value).path = path;
      expect(() =>
        proveRecoveryGmailBatchInventory({ checkpoint: value, recoveryKey })
      ).toThrow();
    }
    const duplicate = copy();
    duplicate.files.push({ ...row(duplicate) });
    expect(() =>
      proveRecoveryGmailBatchInventory({ checkpoint: duplicate, recoveryKey })
    ).toThrow();
    const absent = copy();
    row(absent).bytes = null;
    row(absent).sha256 = null;
    expect(() =>
      proveRecoveryGmailBatchInventory({ checkpoint: absent, recoveryKey })
    ).toThrow();
    const directory = copy();
    directory.directories.push({
      area: "operator",
      path: "email-acquisition/batches/unknown",
    });
    expect(() =>
      proveRecoveryGmailBatchInventory({ checkpoint: directory, recoveryKey })
    ).toThrow();
  });
  it("bounds aggregate encoded capacity before any JSON parsing", () => {
    const value = copy();
    const oversized = "!".repeat(
      Math.ceil((32 * 1024 * 1024 + 64 * 1024) / 3) * 4
    );
    value.files = Array.from({ length: 8 }, (_, index) => ({
      area: "operator",
      path: `email-acquisition/batches/${index.toString(16).padStart(64, "0")}.json`,
      sha256: "a".repeat(64),
      bytes: oversized,
    }));
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(() =>
        proveRecoveryGmailBatchInventory({ checkpoint: value, recoveryKey })
      ).toThrow();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
  it("refuses valid-HMAC capture-time, order, and captured FULL/source inconsistencies", () => {
    for (const change of [
      (batch: Record<string, unknown>) => {
        batch.firstSavedAtEpochMs = now + 1;
      },
      (batch: Record<string, unknown>) => {
        batch.firstSavedAtEpochMs = now - 1;
      },
      (batch: Record<string, unknown>) => {
        (batch.snapshots as unknown[]).reverse();
      },
      (batch: Record<string, unknown>) => {
        const snapshots = batch.snapshots as Array<{
          fullMessage: {
            payload: { body: { size: number; base64_url_content: string } };
          };
        }>;
        const bytes = Buffer.from("Changed FULL text\n");
        snapshots[0]!.fullMessage.payload.body = {
          size: bytes.length,
          base64_url_content: bytes.toString("base64url"),
        };
      },
    ]) {
      const value = copy();
      modifyBatch(value, change);
      expect(() =>
        proveRecoveryGmailBatchInventory({ checkpoint: value, recoveryKey })
      ).toThrow();
    }
    const invalid = copy();
    invalid.createdAtEpochMs = Number.MAX_SAFE_INTEGER;
    expect(() =>
      proveRecoveryGmailBatchInventory({ checkpoint: invalid, recoveryKey })
    ).toThrow();
  });
  it("refuses captured raw, receipt, manifest, approval and journal changes even with updated inventory hashes", () => {
    for (const suffix of [
      "/message.eml",
      "/receipt.json",
      "/capture.json",
      "/source.txt",
    ]) {
      const value = copy();
      const file = value.files.find((file) => file.path.endsWith(suffix))!;
      const bytes = Buffer.concat([
        Buffer.from(file.bytes!, "base64"),
        Buffer.from("changed"),
      ]);
      file.bytes = bytes.toString("base64");
      file.sha256 = sha256(bytes);
      expect(() =>
        proveRecoveryGmailBatchInventory({ checkpoint: value, recoveryKey })
      ).toThrow();
    }
    const approval = copy();
    const receipt = approval.files.find((file) =>
      file.path.endsWith("/receipt.json")
    )!;
    approval.files.push({
      ...receipt,
      path: receipt.path.replace("/receipt.json", "/correction-approval.json"),
    });
    expect(() =>
      proveRecoveryGmailBatchInventory({ checkpoint: approval, recoveryKey })
    ).toThrow();
    const partial = copy();
    partial.files = partial.files.filter(
      (file) => !file.path.endsWith("/capture.json")
    );
    expect(() =>
      proveRecoveryGmailBatchInventory({ checkpoint: partial, recoveryKey })
    ).toThrow();
    const journal = copy();
    journal.journal = Buffer.from("{}\n").toString("base64");
    expect(() =>
      proveRecoveryGmailBatchInventory({ checkpoint: journal, recoveryKey })
    ).toThrow();
  });
});
