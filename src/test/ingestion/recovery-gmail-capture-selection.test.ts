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
import { proveRecoveryGmailCaptureSelection } from "../../lib/ingestion/recovery-gmail-capture-selection.js";
import {
  captureSteveGmailWindow,
  readAuthenticatedSteveGmailBatches,
} from "../../lib/ingestion/steve-gmail-handoff.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  WeeklyRunJournal,
} from "../../lib/ingestion/weekly-run-journal.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });
type Checkpoint = Parameters<
  typeof proveRecoveryGmailCaptureSelection
>[0]["checkpoint"];
type Fixture = { checkpoint: Checkpoint; recoveryKey: Buffer; batchId: string };
const account = "selection@fixture.invalid",
  edition = "2026-10-16";
const body =
  "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\nSynthetic fixture source\n";
let retained: Fixture, prospective: Fixture;
let parent: string,
  ancestor: string,
  review: string,
  otherAccount: string,
  otherEdition: string;
function receiptId(source: string) {
  return sha256(
    canonicalJson([
      sha256(account),
      edition,
      sha256(Buffer.from(source.replace(/\n/g, "\r\n"))),
    ])
  );
}
function message(id: string, source: string, date: string) {
  const headers = [
    "From: Steve Fixture <skoepke@stevelist.com>",
    "Sender: noreply@sp.eocampaign1.com",
    `Date: Fri, ${date.slice(8)} Oct 2026 10:00:00 -0700`,
    "Subject: Steve fixture",
    `Message-ID: <${id}@fixture.invalid>`,
    "Authentication-Results: mx.google.com; dkim=pass header.i=@sp.eocampaign1.com; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com",
    "DKIM-Signature: v=1; a=rsa-sha256; d=sp.eocampaign1.com; s=fixture; h=from:sender:subject:date; bh=c3ludGhldGlj; b=c3ludGhldGlj",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
  ];
  const bytes = Buffer.from(source.replace(/\n/g, "\r\n"));
  const raw = Buffer.concat([
    Buffer.from(headers.join("\r\n") + "\r\n\r\n"),
    bytes,
  ]);
  return {
    id,
    raw: { id, raw: raw.toString("base64url") },
    full: {
      id,
      internalDate: String(Date.parse(date + "T17:00:00Z")),
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
        body: { size: bytes.length, data: bytes.toString("base64url") },
      },
    },
  };
}
async function window(
  operator: string,
  entries: Array<[string, string]>,
  options: {
    account?: string;
    edition?: string;
    corrections?: Record<string, string>;
    interrupt?: string;
  } = {}
) {
  const date = options.edition ?? edition,
    selectedAccount = options.account ?? account;
  const messages = entries.map(([id, source]) => message(id, source, date));
  const received = Date.parse(date + "T17:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(received + 60_000);
  const save = WeeklyRunJournal.prototype.saveIntakeEvidence;
  let interrupted = false;
  const hook = vi
    .spyOn(WeeklyRunJournal.prototype, "saveIntakeEvidence")
    .mockImplementation(function (
      this: WeeklyRunJournal,
      kind,
      id,
      bytes,
      lease
    ) {
      if (
        kind === "source" &&
        (JSON.parse(bytes.toString("utf8")) as { messageId?: string })
          .messageId === options.interrupt
      ) {
        interrupted = true;
        throw new Error("SELECTION_FIXTURE_CAPTURE_INTERRUPTION");
      }
      return save.call(this, kind, id, bytes, lease);
    });
  const fetcher: typeof fetch = async (request) => {
    const url = new URL(
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.href
          : request.url
    );
    if (url.origin !== "https://gmail.googleapis.com")
      throw new Error("Unexpected fixture origin");
    if (url.pathname.endsWith("/profile"))
      return Response.json({ emailAddress: selectedAccount });
    if (url.pathname.endsWith("/messages"))
      return Response.json({ messages: messages.map(({ id }) => ({ id })) });
    const found = messages.find(({ id }) =>
      url.pathname.endsWith("/messages/" + id)
    );
    if (!found) throw new Error("Unexpected fixture message");
    return Response.json(
      url.searchParams.get("format") === "FULL" ? found.full : found.raw
    );
  };
  try {
    const work = captureSteveGmailWindow({
      operatorDirectory: operator,
      expectedAccountId: selectedAccount,
      expectedEditionId: date,
      startEpochMs: received - 1000,
      endEpochMs: received + 1000,
      getAccessToken: async () => "synthetic_token",
      fetcher,
      correctionOfByMessageId: options.corrections,
    });
    if (options.interrupt) {
      await expect(work).rejects.toThrow();
      expect(interrupted).toBe(true);
      return null;
    }
    return await work;
  } finally {
    hook.mockRestore();
    clock.mockRestore();
  }
}
function captureInventory(operator: string): Checkpoint {
  const checkpoint: Checkpoint = {
    originalOperatorDirectory: operator,
    createdAtEpochMs: Date.now(),
    files: [],
    directories: [],
    journal: readWeeklyJournalRecoverySnapshotReadOnly(
      join(operator, "weekly-runs.sqlite")
    ).toString("base64"),
  };
  function walk(path: string) {
    checkpoint.directories.push({ area: "operator", path });
    for (const entry of readdirSync(join(operator, path), {
      withFileTypes: true,
    })) {
      const child = path + "/" + entry.name;
      if (entry.isDirectory()) walk(child);
      else {
        const bytes = readFileSync(join(operator, child));
        checkpoint.files.push({
          area: "operator",
          path: child,
          sha256: sha256(bytes),
          bytes: bytes.toString("base64"),
        });
      }
    }
  }
  walk("email-acquisition");
  if (readdirSync(operator).includes("email-intake")) walk("email-intake");
  return checkpoint;
}
beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), "zivv-gmail-selection-"));
  try {
    const operator = join(directory, "operator");
    mkdirSync(operator);
    const recoveryKey = loadBackupKey(operator, true);
    // Keep polling clocks chronological so older signed batches never look future-dated.
    otherEdition = (await window(
      operator,
      [["d1", body.replace("October 16", "October 9")]],
      { edition: "2026-10-09" }
    ))!.receipts[0]!.receiptId;
    ancestor = (await window(operator, [["a1", body]]))!.receipts[0]!.receiptId;
    parent = (await window(operator, [["a2", body + "Parent\n"]], {
      corrections: { a2: ancestor },
    }))!.receipts[0]!.receiptId;
    review = (await window(operator, [["a3", body + "Review\n"]]))!.receipts[0]!
      .receiptId;
    otherAccount = (await window(operator, [["c1", body]], {
      account: "other@fixture.invalid",
    }))!.receipts[0]!.receiptId;
    await window(
      operator,
      [
        ["b2", body + "Child\n"],
        ["b3", body + "Child\n"],
        ["b4", body + "Pending\n"],
      ],
      { interrupt: "b4" }
    );
    const selected = readAuthenticatedSteveGmailBatches({
      operatorDirectory: operator,
    }).find((batch) => batch.snapshots[0]!.rawMessage.id === "b2")!;
    retained = {
      checkpoint: captureInventory(operator),
      recoveryKey,
      batchId: selected.batchId,
    };
    const fresh = join(directory, "fresh");
    mkdirSync(fresh);
    const freshKey = loadBackupKey(fresh, true);
    await window(
      fresh,
      [
        ["e1", body],
        ["e2", body + "Two\n"],
        ["e3", body + "Three\n"],
      ],
      { interrupt: "e1" }
    );
    const batch = readAuthenticatedSteveGmailBatches({
      operatorDirectory: fresh,
    })[0]!;
    prospective = {
      checkpoint: captureInventory(fresh),
      recoveryKey: freshKey,
      batchId: batch.batchId,
    };
  } finally {
    const suffix = relative(resolve(tmpdir()), resolve(directory));
    cleanup(directory, suffix);
  }
}, 180_000);
function cleanup(directory: string, suffix: string) {
  if (
    !suffix.startsWith("zivv-gmail-selection-") ||
    suffix.includes("..") ||
    suffix.includes("/") ||
    suffix.includes("\\")
  )
    throw new Error("Unsafe fixture cleanup");
  rmSync(directory, { recursive: true, force: true });
}
function altered(
  fixture: Fixture,
  change: (batch: Record<string, unknown>) => void
): Fixture {
  const result = structuredClone(fixture);
  result.recoveryKey = Buffer.from(fixture.recoveryKey);
  const row = result.checkpoint.files.find(
    (file) => file.path === `email-acquisition/batches/${fixture.batchId}.json`
  )!;
  const batch = JSON.parse(
    Buffer.from(row.bytes!, "base64").toString("utf8")
  ) as Record<string, unknown>;
  change(batch);
  const { signature: _signature, ...unsigned } = batch;
  batch.signature = createHmac("sha256", fixture.recoveryKey)
    .update("zivv-steve-gmail-batch/v1\0")
    .update(canonicalJson(unsigned))
    .digest("hex");
  const bytes = Buffer.from(canonicalJson(batch) + "\n");
  row.bytes = bytes.toString("base64");
  row.sha256 = sha256(bytes);
  return result;
}
describe("pure cached-batch capture selection", () => {
  it("binds a historical ready parent outside selected batch after deleting roots, with no authority or newest inference", () => {
    const result = proveRecoveryGmailCaptureSelection({
      ...retained,
      correctionOfByMessageId: { b2: parent },
    });
    expect(result).toMatchObject({
      captureAllowed: false,
      activationAllowed: false,
      physicalValidationRequired: true,
    });
    expect(result.messages.map((message) => message.correctionOf)).toEqual([
      parent,
      null,
      null,
    ]);
    expect(
      proveRecoveryGmailCaptureSelection(retained).messages.every(
        (message) => message.correctionOf === null
      )
    ).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
    expect(result.messages.every(Object.isFrozen)).toBe(true);
    const alternative = proveRecoveryGmailCaptureSelection({
      ...retained,
      correctionOfByMessageId: { b3: parent },
    });
    expect(alternative.selectionSha256).not.toBe(result.selectionSha256);
    expect(
      proveRecoveryGmailCaptureSelection({
        ...retained,
        correctionOfByMessageId: { b2: parent },
      })
    ).toEqual(result);
  });
  it("supports earlier prospective parents conditionally without calling them admitted", () => {
    const result = proveRecoveryGmailCaptureSelection({
      ...prospective,
      correctionOfByMessageId: {
        e2: receiptId(body),
        e3: receiptId(body + "Two\n"),
      },
    });
    expect(
      result.messages.map((message) => message.prospectiveParentMessageId)
    ).toEqual([null, "e1", "e2"]);
    expect(
      result.messages.every((message) => message.existingReceiptId === null)
    ).toBe(true);
    expect(result.captureAllowed).toBe(false);
    const cases: Array<Record<string, string>> = [
      { e1: receiptId(body) },
      { e1: receiptId(body + "Two\n") },
      { e2: receiptId(body), e3: receiptId(body) },
    ];
    for (const corrections of cases)
      expect(() =>
        proveRecoveryGmailCaptureSelection({
          ...prospective,
          correctionOfByMessageId: corrections,
        })
      ).toThrow();
  });
  it("rejects unknown/wrong-account/wrong-edition/not-ready/self/competing parents", () => {
    const self = receiptId(body + "Child\n");
    for (const correctionOf of [
      "0".repeat(64),
      otherAccount,
      otherEdition,
      review,
      self,
      ancestor,
    ])
      expect(() =>
        proveRecoveryGmailCaptureSelection({
          ...retained,
          correctionOfByMessageId: { b2: correctionOf },
        })
      ).toThrow();
    expect(() =>
      proveRecoveryGmailCaptureSelection({
        ...retained,
        correctionOfByMessageId: { ff: parent },
      })
    ).toThrow();
    expect(() =>
      proveRecoveryGmailCaptureSelection({
        ...retained,
        correctionOfByMessageId: { b2: parent, b4: parent },
      })
    ).toThrow();
  });
  it("rejects malformed/oversized/accessor maps before trusting selection", () => {
    const malformed = [
      [],
      { b2: "bad" },
      { ["a".repeat(129)]: parent },
      Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [index.toString(16), parent])
      ),
      Object.defineProperty({}, "b2", {
        enumerable: true,
        get: () => {
          throw new Error("Getter must not run");
        },
      }),
    ];
    for (const map of malformed)
      expect(() =>
        proveRecoveryGmailCaptureSelection({
          ...retained,
          correctionOfByMessageId: map as Record<string, string>,
        })
      ).toThrow("INVALID_RECOVERY_GMAIL_CAPTURE_SELECTION");
    expect(() =>
      proveRecoveryGmailCaptureSelection({
        ...retained,
        batchId: "f".repeat(64),
      })
    ).toThrow();
    expect(() =>
      proveRecoveryGmailCaptureSelection({
        ...retained,
        recoveryKey: Buffer.alloc(31),
      })
    ).toThrow();
  });
  it("keeps unadmitted invalid plaintext cached evidence non-authoritative, never uses it as prospective parent", () => {
    const changed = altered(prospective, (batch) => {
      const snapshots = batch.snapshots as Array<{
        fullMessage: { payload: { mime_type: string } };
      }>;
      snapshots[0]!.fullMessage.payload.mime_type = "application/octet-stream";
    });
    expect(
      proveRecoveryGmailCaptureSelection(changed).messages[0]!.sourceSha256
    ).toBeNull();
    expect(() =>
      proveRecoveryGmailCaptureSelection({
        ...changed,
        correctionOfByMessageId: { e2: receiptId(body) },
      })
    ).toThrow();
  });
  it("rejects valid-HMAC captured FULL/source/time changes and binds exact batch bytes", () => {
    for (const change of [
      (batch: Record<string, unknown>) => {
        batch.firstSavedAtEpochMs = 0;
      },
      (batch: Record<string, unknown>) => {
        const snapshots = batch.snapshots as Array<{
          fullMessage: {
            payload: { body: { size: number; base64_url_content: string } };
          };
        }>;
        const bytes = Buffer.from("changed");
        snapshots[0]!.fullMessage.payload.body = {
          size: bytes.length,
          base64_url_content: bytes.toString("base64url"),
        };
      },
    ])
      expect(() =>
        proveRecoveryGmailCaptureSelection(altered(retained, change))
      ).toThrow();
    const changed = structuredClone(retained);
    changed.recoveryKey = Buffer.from(retained.recoveryKey);
    changed.checkpoint.files.find((file) =>
      file.path.endsWith(retained.batchId + ".json")
    )!.sha256 = "0".repeat(64);
    expect(() => proveRecoveryGmailCaptureSelection(changed)).toThrow();
  });
});
