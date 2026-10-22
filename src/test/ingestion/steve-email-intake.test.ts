import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WeeklyRunJournal,
  type WeeklyRunLease,
} from "../../lib/ingestion/weekly-run-journal.js";
import {
  assertNoPendingSteveEmail,
  captureSteveEmail,
  type SteveEmailReceipt,
} from "../../lib/ingestion/steve-email-intake.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
  type StageEvidence,
} from "../../lib/ingestion/weekly-run-state.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { freezeWeeklyImport } from "../../lib/ingestion/weekly-edition-freeze.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";

const roots: string[] = [];
const journals: WeeklyRunJournal[] = [];
const scope = "prodigic/zivv/production";
const receivedAt = Date.parse("2026-10-16T17:00:00Z");
const observedAt = Date.parse("2026-10-16T17:05:00Z");
const plain =
  "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\nSynthetic Artist at Fixture Club\n";
const authentication =
  "mx.google.com; dkim=pass header.i=@sp.eocampaign1.com; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com";

interface MessageOptions {
  id?: string;
  text?: string;
  encoding?: "7bit" | "quoted-printable" | "base64";
  headers?: string[];
  from?: string;
  sender?: string;
  auth?: string;
  date?: string;
  receivedAt?: number;
  gmailText?: string;
  charset?: "UTF-8" | "ISO-8859-1";
}

/** Entirely synthetic message; no real newsletter or subscriber data. */
function message(options: MessageOptions = {}) {
  const text = options.text ?? plain;
  const encoding = options.encoding ?? "7bit";
  const crlf = text.replace(/\r?\n/g, "\r\n");
  const wireBytes = Buffer.from(
    crlf,
    options.charset === "ISO-8859-1" ? "latin1" : "utf8"
  );
  const wireBody =
    encoding === "base64"
      ? wireBytes.toString("base64") + "\r\n"
      : encoding === "quoted-printable"
        ? [...wireBytes]
            .map((byte) =>
              byte === 10 ||
              byte === 13 ||
              (byte >= 33 && byte <= 126 && byte !== 61)
                ? String.fromCharCode(byte)
                : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`
            )
            .join("")
        : crlf;
  const headers = [
    `From: ${options.from ?? "Steve Fixture <skoepke@stevelist.com>"}`,
    `Sender: ${options.sender ?? "noreply@sp.eocampaign1.com"}`,
    `Date: ${options.date ?? "Fri, 16 Oct 2026 10:00:00 -0700"}`,
    "Subject: Steve's List 10/16/2026",
    "Message-ID: <synthetic@fixture.invalid>",
    `Authentication-Results: ${options.auth ?? authentication}`,
    "DKIM-Signature: v=1; a=rsa-sha256; d=sp.eocampaign1.com; s=fixture; h=from:sender:subject:date; bh=c3ludGhldGlj; b=c3ludGhldGlj",
    "MIME-Version: 1.0",
    `Content-Type: text/plain; charset=${options.charset ?? "UTF-8"}`,
    `Content-Transfer-Encoding: ${encoding}`,
    ...(options.headers ?? []),
  ];
  const raw = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + wireBody);
  const decoded = Buffer.from(options.gmailText ?? crlf);
  const id = options.id ?? "a1";
  return {
    rawBytes: raw,
    rawMessage: { id, raw: raw.toString("base64url") },
    fullMessage: {
      id,
      internal_date: String(options.receivedAt ?? receivedAt),
      payload: {
        mime_type: "text/plain",
        filename: "",
        headers: headers.map((header) => {
          const split = header.indexOf(":");
          return {
            name: header.slice(0, split),
            value: header.slice(split + 1).trim(),
          };
        }),
        body: {
          size: decoded.length,
          base64_url_content: decoded.toString("base64url"),
        },
      },
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zivv-steve-email-test-"));
  roots.push(root);
  return { root, operatorDirectory: join(root, "operator") };
}

function input(operatorDirectory: string, email = message()) {
  return {
    operatorDirectory,
    accountId: "synthetic-account@fixture.invalid",
    ...email,
    expectedEditionId: "2026-10-16",
    observedAtEpochMs: observedAt,
  };
}

function openJournal(operatorDirectory: string) {
  const journal = new WeeklyRunJournal(operatorDirectory);
  journals.push(journal);
  return journal;
}

function loadedDelivery(
  journal: WeeklyRunJournal,
  lease: WeeklyRunLease,
  receipt: SteveEmailReceipt,
  source: Buffer
) {
  let state = journal.create(
    createWeeklyRunState({
      editionId: receipt.editionId,
      deliveryId: receipt.deliveryId,
      rawSha256: receipt.sourceSha256,
      rulesSha256: "a".repeat(64),
      importObservedAtEpochMs: receipt.firstObservedAtEpochMs,
    }),
    lease,
    source
  );
  const evidence: Array<
    ["acquire" | "prepare" | "reconcile" | "load", StageEvidence]
  > = [
    [
      "acquire",
      { rawSha256: receipt.sourceSha256, deliveryId: receipt.deliveryId },
    ],
    [
      "prepare",
      { preparedSha256: "b".repeat(64), rulesSha256: "a".repeat(64) },
    ],
    [
      "reconcile",
      {
        ledgerRevision: "c".repeat(64),
        reportSha256: "d".repeat(64),
        preparedSha256: "b".repeat(64),
      },
    ],
    [
      "load",
      {
        ledgerRevision: "e".repeat(64),
        importRunId: "synthetic-import",
        reviewedLedgerRevision: "c".repeat(64),
        reportSha256: "d".repeat(64),
        preparedSha256: "b".repeat(64),
      },
    ],
  ];
  for (const [stage, fields] of evidence) {
    state = journal.save(
      transitionWeeklyRun(
        state,
        state.revision,
        stage,
        { status: "running" },
        observedAt
      ),
      state.revision,
      lease
    );
    state = journal.save(
      transitionWeeklyRun(
        state,
        state.revision,
        stage,
        { status: "succeeded", evidence: fields },
        observedAt
      ),
      state.revision,
      lease
    );
  }
  return state;
}

function privatePaths(
  operatorDirectory: string,
  receipt: SteveEmailReceipt,
  messageId = receipt.messageId
) {
  const root = join(operatorDirectory, "email-intake", receipt.accountSha256);
  const messageDirectory = join(
    root,
    "messages",
    createHash("sha256").update(messageId).digest("hex")
  );
  return {
    messageDirectory,
    bodyDirectory: join(root, "bodies", receipt.receiptId),
  };
}

function capture(
  operatorDirectory: string,
  options: MessageOptions = {},
  extra: {
    expectedEditionId?: string;
    observedAtEpochMs?: number;
    correctionOf?: string;
  } = {}
) {
  return captureSteveEmail({
    ...input(operatorDirectory, message(options)),
    ...extra,
  });
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(observedAt);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), "zivv-steve-email-test-")))
      throw new Error("Unsafe intake fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("private Steve email acquisition", () => {
  it("captures synthetic Gmail RAW and decoded plain text as a stable private delivery", async () => {
    const { operatorDirectory } = fixture();
    const email = message();
    const result = await captureSteveEmail({
      operatorDirectory,
      accountId: "synthetic-account@fixture.invalid",
      ...email,
      expectedEditionId: "2026-10-16",
      observedAtEpochMs: observedAt,
    });
    expect(result.disposition).toBe("ready");
    expect(result.source.toString("utf8")).toBe(plain.replace(/\n/g, "\r\n"));
    expect(result.receipt).toMatchObject({
      schemaVersion: 1,
      editionId: "2026-10-16",
      messageId: email.rawMessage.id,
      receivedAtEpochMs: receivedAt,
      firstObservedAtEpochMs: observedAt,
      correctionOf: null,
      disposition: "ready",
    });
    expect(result.receipt.deliveryId).toBe(`gmail-${result.receipt.receiptId}`);
    const paths = privatePaths(operatorDirectory, result.receipt);
    expect(
      readFileSync(join(paths.messageDirectory, "message.eml")).equals(
        email.rawBytes
      )
    ).toBe(true);
    expect(
      readFileSync(join(paths.bodyDirectory, "source.txt")).equals(
        result.source
      )
    ).toBe(true);
    expect(result.receipt.receiverProfile).toEqual({
      policy: "steve-gmail-eocampaign-v1",
      parser: "postal-mime-4.0.7/gmail-text-v1",
      issuer: "mx.google.com",
      dkimIdentityDomain: "sp.eocampaign1.com",
      dkimSigningDomains: ["sp.eocampaign1.com"],
      spfMailFromDomain: "sp.eocampaign1.com",
      dmarcResult: null,
    });
  });

  it.each(["7bit", "quoted-printable", "base64"] as const)(
    "agrees on exact UTF-8 text after decoding %s and normalizing line endings",
    async (encoding) => {
      const { operatorDirectory } = fixture();
      const text = plain + "Café Synthetic = fixture\n";
      const result = await capture(operatorDirectory, { text, encoding });
      expect(result.source.toString("utf8")).toBe(text.replace(/\n/g, "\r\n"));
      expect(result.disposition).toBe("ready");
    }
  );

  it("accepts connector decoded-content-only UTF-8 while retaining exact matching bytes", async () => {
    const { operatorDirectory } = fixture();
    const text = plain + "Café Synthetic 🎸\n";
    const args: Parameters<typeof captureSteveEmail>[0] = input(
      operatorDirectory,
      message({ text })
    );
    const content = text.replace(/\n/g, "\r\n");
    args.fullMessage.payload.body = {
      size: Buffer.byteLength(content),
      base64_url_content: null,
      content,
    };
    const result = await captureSteveEmail(args);
    expect(result.source.equals(Buffer.from(content))).toBe(true);
    expect(result.disposition).toBe("ready");
  });

  it("accepts identical decoded-content and base64 projections", async () => {
    const { operatorDirectory } = fixture();
    const args: Parameters<typeof captureSteveEmail>[0] =
      input(operatorDirectory);
    args.fullMessage.payload.body!.content = plain.replace(/\n/g, "\r\n");
    expect((await captureSteveEmail(args)).disposition).toBe("ready");
  });

  it.each([
    "content-raw-mismatch",
    "dual-projection-mismatch",
    "decoded-content-size",
  ] as const)("rejects decoded-content projection %s", async (problem) => {
    const { operatorDirectory } = fixture();
    const args: Parameters<typeof captureSteveEmail>[0] =
      input(operatorDirectory);
    const content = plain.replace(/\n/g, "\r\n");
    if (problem === "content-raw-mismatch") {
      const changed = content + "Injected decoded text\r\n";
      args.fullMessage.payload.body = {
        size: Buffer.byteLength(changed),
        base64_url_content: null,
        content: changed,
      };
    } else if (problem === "dual-projection-mismatch") {
      args.fullMessage.payload.body!.content =
        content + "Contradicting projection\r\n";
    } else
      args.fullMessage.payload.body = {
        size: content.length - 1,
        base64_url_content: null,
        content,
      };
    await expect(captureSteveEmail(args)).rejects.toThrow(
      problem === "decoded-content-size"
        ? "TRUNCATED_STEVE_TEXT"
        : "GMAIL_MIME_TEXT_MISMATCH"
    );
  });

  it("decodes a quoted-printable legacy MIME charset and retains Gmail's matching UTF-8 bytes", async () => {
    const { operatorDirectory } = fixture();
    const text = plain + "Café Synthetic\n";
    const result = await capture(operatorDirectory, {
      text,
      charset: "ISO-8859-1",
      encoding: "quoted-printable",
    });
    expect(result.source.toString("utf8")).toBe(text.replace(/\n/g, "\r\n"));
  });

  it("selects the one inline plain part of a real multipart alternative message", async () => {
    const { operatorDirectory } = fixture();
    const email = message();
    const [headers] = email.rawBytes.toString("utf8").split("\r\n\r\n");
    const multipartHeaders = headers
      .replace(
        "Content-Type: text/plain; charset=UTF-8",
        'Content-Type: multipart/alternative; boundary="synthetic-boundary"'
      )
      .replace("\r\nContent-Transfer-Encoding: 7bit", "");
    const raw = Buffer.from(
      multipartHeaders +
        "\r\n\r\n" +
        [
          "--synthetic-boundary",
          "Content-Type: text/plain; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(plain.replace(/\n/g, "\r\n")).toString("base64"),
          "--synthetic-boundary",
          "Content-Type: text/html; charset=UTF-8",
          "",
          "<p>Synthetic newsletter HTML</p>",
          "--synthetic-boundary--",
          "",
        ].join("\r\n")
    );
    const result = await captureSteveEmail({
      ...input(operatorDirectory, email),
      rawMessage: { id: email.rawMessage.id, raw: raw.toString("base64url") },
      fullMessage: {
        ...email.fullMessage,
        payload: {
          mime_type: "multipart/alternative",
          parts: [
            email.fullMessage.payload,
            { mime_type: "text/html", body: { size: 0 } },
          ],
        },
      },
    });
    expect(result.receipt.partPath).toEqual([0]);
    expect(result.source.toString("utf8")).toBe(plain.replace(/\n/g, "\r\n"));
  });

  it.each([
    "multiple-inline-parts",
    "truncated-body",
    "invalid-utf8",
    "different-message-id",
  ] as const)("rejects Gmail projection %s", async (problem) => {
    const { operatorDirectory } = fixture();
    const args: Parameters<typeof captureSteveEmail>[0] =
      input(operatorDirectory);
    if (problem === "multiple-inline-parts")
      args.fullMessage.payload = {
        mime_type: "multipart/mixed",
        parts: [
          structuredClone(args.fullMessage.payload),
          structuredClone(args.fullMessage.payload),
        ],
      };
    if (problem === "truncated-body") args.fullMessage.payload.body!.size++;
    if (problem === "invalid-utf8")
      args.fullMessage.payload.body = {
        size: 2,
        base64_url_content: Buffer.from([0xc3, 0x28]).toString("base64url"),
      };
    if (problem === "different-message-id") args.fullMessage.id = "aa";
    await expect(captureSteveEmail(args)).rejects.toThrow();
  });

  it.each([
    ["different From", { from: "Attacker <other@stevelist.com>" }],
    [
      "Sender domain suffix",
      { sender: "noreply@sp.eocampaign1.com.attacker.invalid" },
    ],
    ["duplicate From", { headers: ["From: other@fixture.invalid"] }],
    [
      "duplicate receiver results",
      { headers: [`Authentication-Results: ${authentication}`] },
    ],
    [
      "untrusted auth issuer",
      { auth: authentication.replace("mx.google.com", "attacker.invalid") },
    ],
    ["SPF fail", { auth: authentication.replace("spf=pass", "spf=fail") }],
    ["DKIM fail", { auth: authentication.replace("dkim=pass", "dkim=fail") }],
    [
      "wrong SPF service domain",
      {
        auth: authentication.replace(
          "smtp.mailfrom=bounce@sp.eocampaign1.com",
          "smtp.mailfrom=bounce@other.invalid"
        ),
      },
    ],
    [
      "wrong DKIM service domain",
      {
        auth: authentication.replace(
          "header.i=@sp.eocampaign1.com",
          "header.i=@other.invalid"
        ),
      },
    ],
    [
      "identity hidden inside quoted reason",
      {
        auth: 'mx.google.com; dkim=pass reason="x header.i=@sp.eocampaign1.com x"; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com',
      },
    ],
    [
      "comment-only SPF result",
      {
        auth: "mx.google.com; dkim=pass header.i=@sp.eocampaign1.com (spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com)",
      },
    ],
    [
      "duplicate conflicting SPF method",
      {
        auth:
          authentication + "; spf=fail smtp.mailfrom=bounce@sp.eocampaign1.com",
      },
    ],
    ["Gmail decoded-body mismatch", { gmailText: plain + "Injected text\n" }],
    ["Gmail trailing-whitespace mismatch", { gmailText: plain + "\t" }],
    [
      "dated body mismatch",
      { text: plain.replace("October 16, 2026", "October 9, 2026") },
    ],
    ["duplicate dated body", { text: plain + plain }],
  ] satisfies Array<[string, MessageOptions]>)(
    "rejects %s",
    async (_label, options) => {
      const { operatorDirectory } = fixture();
      await expect(capture(operatorDirectory, options)).rejects.toThrow();
    }
  );

  it("retains the first observation and delivery identity across retry and duplicate Gmail IDs", async () => {
    const { operatorDirectory } = fixture();
    const initial = await capture(operatorDirectory);
    vi.mocked(Date.now).mockReturnValue(observedAt + 120_000);
    const retry = await capture(
      operatorDirectory,
      {},
      { observedAtEpochMs: observedAt + 60_000 }
    );
    const duplicate = await capture(
      operatorDirectory,
      { id: "a2" },
      { observedAtEpochMs: observedAt + 120_000 }
    );
    expect(retry.receipt).toEqual(initial.receipt);
    expect(duplicate.receipt).toEqual(initial.receipt);
    expect(duplicate.source.equals(initial.source)).toBe(true);
  });

  it("rejects changed raw bytes for a previously captured Gmail message ID", async () => {
    const { operatorDirectory } = fixture();
    await capture(operatorDirectory);
    await expect(
      capture(operatorDirectory, { headers: ["X-Synthetic-Change: yes"] })
    ).rejects.toThrow();
  });

  it("quarantines a different body for the same edition until explicitly linked as a correction", async () => {
    const { operatorDirectory } = fixture();
    const first = await capture(operatorDirectory);
    const revised = {
      id: "a3",
      text: plain + "Correction: Synthetic show cancelled\n",
    };
    vi.mocked(Date.now).mockReturnValue(observedAt + 60_000);
    const pending = await capture(operatorDirectory, revised, {
      observedAtEpochMs: observedAt + 60_000,
    });
    expect(pending.disposition).toBe("review-required");
    expect(pending.receipt.receiptId).not.toBe(first.receipt.receiptId);
    vi.mocked(Date.now).mockReturnValue(observedAt + 120_000);
    const approved = await capture(operatorDirectory, revised, {
      correctionOf: first.receipt.receiptId,
      observedAtEpochMs: observedAt + 120_000,
    });
    expect(approved.disposition).toBe("ready");
    expect(approved.receipt.correctionOf).toBe(first.receipt.receiptId);
    expect(approved.receipt.firstObservedAtEpochMs).toBe(
      pending.receipt.firstObservedAtEpochMs
    );
    expect((await capture(operatorDirectory, revised)).receipt).toEqual(
      approved.receipt
    );
    await expect(
      capture(operatorDirectory, revised, { correctionOf: "f".repeat(64) })
    ).rejects.toThrow();
  });

  it("serializes capture with the production weekly worker lease", async () => {
    const { operatorDirectory } = fixture();
    const journal = openJournal(operatorDirectory);
    const lease = journal.acquire(scope);
    await expect(capture(operatorDirectory)).rejects.toThrow("active owner");
    journal.release(lease);
    await expect(capture(operatorDirectory)).resolves.toMatchObject({
      disposition: "ready",
    });
  });

  it("supports a correction chain and rejects a competing child of the same parent", async () => {
    const { operatorDirectory } = fixture();
    const first = await capture(operatorDirectory);
    const second = await capture(
      operatorDirectory,
      { id: "b1", text: plain + "Revision B\n" },
      { correctionOf: first.receipt.receiptId }
    );
    const third = await capture(
      operatorDirectory,
      { id: "c1", text: plain + "Revision C\n" },
      { correctionOf: second.receipt.receiptId }
    );
    expect(third.receipt.correctionOf).toBe(second.receipt.receiptId);
    expect(third.disposition).toBe("ready");
    await expect(
      capture(
        operatorDirectory,
        { id: "d1", text: plain + "Competing revision\n" },
        { correctionOf: first.receipt.receiptId }
      )
    ).rejects.toThrow("COMPETING_CORRECTION_BRANCH");
    await expect(
      capture(
        operatorDirectory,
        { id: "e1", text: plain + "Unknown parent revision\n" },
        { correctionOf: "f".repeat(64) }
      )
    ).rejects.toThrow("UNKNOWN_CORRECTION_PARENT");
  });

  it.each(["fail", "temperror", "permerror", "unknown"])(
    "rejects an explicit DMARC %s instead of inventing success from SPF/DKIM",
    async (result) => {
      const { operatorDirectory } = fixture();
      await expect(
        capture(operatorDirectory, {
          auth: authentication + `; dmarc=${result} header.from=stevelist.com`,
        })
      ).rejects.toThrow();
    }
  );

  it("rejects duplicate contradictory DMARC clauses", async () => {
    const { operatorDirectory } = fixture();
    await expect(
      capture(operatorDirectory, {
        auth:
          authentication +
          "; dmarc=pass header.from=stevelist.com; dmarc=fail header.from=stevelist.com",
      })
    ).rejects.toThrow();
  });

  it("accepts early arrivals for an explicitly selected Friday edition", async () => {
    const { operatorDirectory } = fixture();
    const thursday = Date.parse("2026-10-15T17:05:00Z");
    vi.mocked(Date.now).mockReturnValue(thursday);
    const result = await capture(
      operatorDirectory,
      { receivedAt: thursday - 60_000 },
      { observedAtEpochMs: thursday }
    );
    expect(result.disposition).toBe("ready");
    expect(result.receipt.editionId).toBe("2026-10-16");
  });

  it("uses Los Angeles Monday midnight across the autumn DST change as the latest new-capture boundary", async () => {
    const { operatorDirectory } = fixture();
    const mondayMidnight = Date.parse("2026-11-02T08:00:00Z");
    const options: MessageOptions = {
      text: plain.replace("October 16, 2026", "October 30, 2026"),
      receivedAt: Date.parse("2026-10-30T17:00:00Z"),
    };
    vi.mocked(Date.now).mockReturnValue(mondayMidnight - 1);
    const accepted = await capture(operatorDirectory, options, {
      expectedEditionId: "2026-10-30",
      observedAtEpochMs: mondayMidnight - 1,
    });
    expect(accepted.disposition).toBe("ready");
    vi.mocked(Date.now).mockReturnValue(mondayMidnight);
    const lateDirectory = fixture().operatorDirectory;
    await expect(
      capture(lateDirectory, options, {
        expectedEditionId: "2026-10-30",
        observedAtEpochMs: mondayMidnight,
      })
    ).rejects.toThrow("SOURCE_WINDOW_REQUIRES_REVIEW");
    const retry = await capture(operatorDirectory, options, {
      expectedEditionId: "2026-10-30",
      observedAtEpochMs: mondayMidnight,
    });
    expect(retry.receipt).toEqual(accepted.receipt);
  });

  it("rejects an expected-edition mismatch and a non-Friday dated body", async () => {
    const { operatorDirectory } = fixture();
    await expect(
      capture(operatorDirectory, {}, { expectedEditionId: "2026-10-09" })
    ).rejects.toThrow("WRONG_EXPECTED_EDITION");
    await expect(
      capture(
        operatorDirectory,
        { text: plain.replace("October 16, 2026", "October 15, 2026") },
        { expectedEditionId: "2026-10-15" }
      )
    ).rejects.toThrow("INVALID_STEVE_EDITION");
  });

  it("uses the local acquisition clock instead of a caller-backdated observation", async () => {
    const { operatorDirectory } = fixture();
    const result = await capture(
      operatorDirectory,
      {},
      { observedAtEpochMs: receivedAt }
    );
    expect(result.receipt.firstObservedAtEpochMs).toBe(observedAt);
  });

  it("recovers a body committed before the message manifest without changing first observation", async () => {
    const { operatorDirectory } = fixture();
    const first = await capture(operatorDirectory);
    const paths = privatePaths(operatorDirectory, first.receipt);
    unlinkSync(join(paths.messageDirectory, "capture.json"));
    vi.mocked(Date.now).mockReturnValue(observedAt + 120_000);
    const recovered = await capture(
      operatorDirectory,
      {},
      { observedAtEpochMs: observedAt + 120_000 }
    );
    expect(recovered.receipt).toEqual(first.receipt);
    expect(recovered.source.equals(first.source)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(paths.messageDirectory, "capture.json"), "utf8")
      )
    ).toMatchObject({ receiptId: first.receipt.receiptId });
  });

  it("recovers a DB-admitted delivery with all intake files absent using its original observation", async () => {
    const { operatorDirectory } = fixture();
    const first = await capture(operatorDirectory);
    const journal = openJournal(operatorDirectory);
    expect(
      journal.readIntakeEvidence(scope, "source", first.receipt.receiptId)
    ).not.toBeNull();
    const intakePath = join(operatorDirectory, "email-intake");
    if (
      !resolve(intakePath).startsWith(resolve(operatorDirectory) + "/") &&
      !resolve(intakePath).startsWith(resolve(operatorDirectory) + "\\")
    )
      throw new Error("Unsafe intake removal");
    rmSync(intakePath, { recursive: true });
    expect(() =>
      assertNoPendingSteveEmail(
        operatorDirectory,
        journal,
        scope,
        observedAt + 1
      )
    ).toThrow("PENDING_STEVE_EMAIL_INTAKE");
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-20T17:00:00Z"));
    const recovered = await capture(
      operatorDirectory,
      {},
      { observedAtEpochMs: Date.now() }
    );
    expect(recovered.receipt).toEqual(first.receipt);
    expect(recovered.source.equals(first.source)).toBe(true);
    expect(
      readFileSync(
        join(
          privatePaths(operatorDirectory, first.receipt).messageDirectory,
          "message.eml"
        )
      ).equals(message().rawBytes)
    ).toBe(true);
  });

  it("rejects a canonical filesystem timestamp edit that would move loaded intake past cutoff", async () => {
    const { operatorDirectory } = fixture();
    const result = await capture(operatorDirectory);
    const journal = openJournal(operatorDirectory);
    const lease = journal.acquire(scope);
    loadedDelivery(journal, lease, result.receipt, result.source);
    journal.release(lease);
    vi.mocked(Date.now).mockReturnValue(observedAt + 120_000);
    const receiptPath = join(
      privatePaths(operatorDirectory, result.receipt).bodyDirectory,
      "receipt.json"
    );
    writeFileSync(
      receiptPath,
      canonicalJson({
        ...result.receipt,
        firstObservedAtEpochMs: observedAt + 60_000,
      }) + "\n"
    );
    expect(() =>
      assertNoPendingSteveEmail(
        operatorDirectory,
        journal,
        scope,
        observedAt + 1
      )
    ).toThrow("INTAKE_EVIDENCE_CHANGED");
    await expect(capture(operatorDirectory)).rejects.toThrow(
      "INTAKE_EVIDENCE_CHANGED"
    );
  });

  it("recovers a DB-committed correction approval whose filesystem copy is missing", async () => {
    const { operatorDirectory } = fixture();
    const first = await capture(operatorDirectory);
    const revision = { id: "ab", text: plain + "Approved correction\n" };
    await capture(operatorDirectory, revision);
    const approved = await capture(operatorDirectory, revision, {
      correctionOf: first.receipt.receiptId,
    });
    unlinkSync(
      join(
        privatePaths(operatorDirectory, approved.receipt).bodyDirectory,
        "correction-approval.json"
      )
    );
    vi.mocked(Date.now).mockReturnValue(observedAt + 120_000);
    const recovered = await capture(operatorDirectory, revision);
    expect(recovered.receipt).toEqual(approved.receipt);
  });

  it("rejects correction recovery when an ancestor's primary raw evidence changed", async () => {
    const { operatorDirectory } = fixture();
    const first = await capture(operatorDirectory);
    const revision = { id: "ac", text: plain + "Correction child\n" };
    await capture(operatorDirectory, revision, {
      correctionOf: first.receipt.receiptId,
    });
    writeFileSync(
      join(
        privatePaths(operatorDirectory, first.receipt).messageDirectory,
        "message.eml"
      ),
      "changed ancestor raw MIME"
    );
    await expect(capture(operatorDirectory, revision)).rejects.toThrow(
      "CHANGED_INTAKE_MIME"
    );
  });

  it("blocks freeze for a pre-cutoff capture until the exact delivery has a completed load", async () => {
    const { operatorDirectory } = fixture();
    const result = await capture(operatorDirectory);
    const journal = openJournal(operatorDirectory);
    const lease = journal.acquire(scope);
    expect(() =>
      assertNoPendingSteveEmail(operatorDirectory, journal, scope, observedAt)
    ).not.toThrow();
    expect(() =>
      assertNoPendingSteveEmail(
        operatorDirectory,
        journal,
        scope,
        observedAt + 1
      )
    ).toThrow("PENDING_STEVE_EMAIL_INTAKE");
    journal.create(
      createWeeklyRunState({
        editionId: result.receipt.editionId,
        deliveryId: result.receipt.deliveryId,
        rawSha256: result.receipt.sourceSha256,
        rulesSha256: "a".repeat(64),
        importObservedAtEpochMs: result.receipt.firstObservedAtEpochMs,
      }),
      lease,
      result.source
    );
    expect(() =>
      assertNoPendingSteveEmail(
        operatorDirectory,
        journal,
        scope,
        observedAt + 1
      )
    ).toThrow("PENDING_STEVE_EMAIL_INTAKE");
    loadedDelivery(journal, lease, result.receipt, result.source);
    expect(() =>
      assertNoPendingSteveEmail(
        operatorDirectory,
        journal,
        scope,
        observedAt + 1
      )
    ).not.toThrow();
    journal.release(lease);
  });

  it("blocks freeze when retained source bytes disappear even after the delivery loaded", async () => {
    const { operatorDirectory } = fixture();
    const result = await capture(operatorDirectory);
    const journal = openJournal(operatorDirectory);
    const lease = journal.acquire(scope);
    loadedDelivery(journal, lease, result.receipt, result.source);
    unlinkSync(
      join(
        privatePaths(operatorDirectory, result.receipt).bodyDirectory,
        "source.txt"
      )
    );
    expect(() =>
      assertNoPendingSteveEmail(
        operatorDirectory,
        journal,
        scope,
        observedAt + 1
      )
    ).toThrow();
    journal.release(lease);
  });

  it.each(["source.txt", "message.eml"] as const)(
    "rejects corrupted retained %s during pending evaluation",
    async (name) => {
      const { operatorDirectory } = fixture();
      const result = await capture(operatorDirectory);
      const journal = openJournal(operatorDirectory);
      const paths = privatePaths(operatorDirectory, result.receipt);
      writeFileSync(
        join(
          name === "source.txt" ? paths.bodyDirectory : paths.messageDirectory,
          name
        ),
        "tampered synthetic evidence"
      );
      expect(() =>
        assertNoPendingSteveEmail(
          operatorDirectory,
          journal,
          scope,
          observedAt + 1
        )
      ).toThrow(
        name === "source.txt" ? "CHANGED_INTAKE_TEXT" : "CHANGED_INTAKE_MIME"
      );
    }
  );

  it("blocks freeze when an interrupted body directory has source bytes but no manifest", async () => {
    const { operatorDirectory } = fixture();
    const result = await capture(operatorDirectory);
    const journal = openJournal(operatorDirectory);
    unlinkSync(
      join(
        privatePaths(operatorDirectory, result.receipt).bodyDirectory,
        "receipt.json"
      )
    );
    expect(() =>
      assertNoPendingSteveEmail(
        operatorDirectory,
        journal,
        scope,
        observedAt + 1
      )
    ).toThrow();
  });

  it("runs the actual CLI in capture-only mode without starting a weekly worker", () => {
    const { root, operatorDirectory } = fixture();
    const args = input(operatorDirectory);
    const snapshot = join(root, "snapshot.json"),
      clock = join(root, "clock.mjs");
    writeFileSync(
      snapshot,
      JSON.stringify({
        accountId: args.accountId,
        rawMessage: args.rawMessage,
        fullMessage: args.fullMessage,
        observedAtEpochMs: args.observedAtEpochMs,
      })
    );
    writeFileSync(clock, `Date.now = () => ${observedAt};\n`);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(clock).href,
        resolve("scripts/capture-steve-email.js"),
        "--file",
        snapshot,
        "--operator-dir",
        operatorDirectory,
        "--expected-edition",
        "2026-10-16",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10000 }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output: unknown = JSON.parse(result.stdout.trim());
    expect(output).toMatchObject({
      editionId: "2026-10-16",
      disposition: "ready",
      firstObservedAtEpochMs: observedAt,
    });
    expect(output).not.toHaveProperty("runId");
    expect(result.stdout).not.toContain("Synthetic Artist");
    expect(openJournal(operatorDirectory).listRuns(scope)).toEqual([]);
  });

  it.each([
    ["--through", "freeze"],
    ["--through", "load"],
    ["--root", "synthetic-root"],
    ["--trusted", "true"],
    ["--expected-edition", "2026-10-16"],
  ])(
    "CLI rejects unsupported or incomplete flag pair %s %s before capture",
    (flag, value) => {
      const { root, operatorDirectory } = fixture();
      const snapshot = join(root, "snapshot.json");
      writeFileSync(snapshot, "{}");
      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts/capture-steve-email.js"),
          "--file",
          snapshot,
          "--operator-dir",
          operatorDirectory,
          "--expected-edition",
          "2026-10-16",
          flag,
          value,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 }
      );
      expect(result.status, result.stderr).toBe(1);
      expect(JSON.parse(result.stderr.trim())).toMatchObject({
        error: "INVALID_EMAIL_CAPTURE_ARGUMENTS",
      });
      expect(existsSync(operatorDirectory)).toBe(false);
    }
  );

  it("blocks the real freeze stage for acquired intake, then freezes after the exact delivery loads", async () => {
    const { root, operatorDirectory } = fixture();
    const result = await capture(operatorDirectory);
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, "data/ingestion"), { recursive: true });
    writeFileSync(
      join(checkout, "data/ingestion/ledger.json"),
      JSON.stringify(
        bootstrapLedger({ events: [], artists: [], venues: [] }, 1000)
      )
    );
    const weeklyPath = join(checkout, "data/ingestion/weekly-editions.json");
    const cutoff = observedAt + 60_000;
    vi.mocked(Date.now).mockReturnValue(cutoff);
    const journal = openJournal(operatorDirectory);
    const lease = journal.acquire(scope);
    const current = loadedDelivery(
      journal,
      lease,
      { ...result.receipt, deliveryId: "synthetic-current-worker" },
      result.source
    );
    const args = {
      root: checkout,
      journal,
      lease,
      cutoffEpochMs: cutoff,
      verifyContext: () => journal.checkOwnership(lease),
      onProgress: async () => {},
    };
    await expect(
      freezeWeeklyImport({ ...args, state: current })
    ).rejects.toThrow("PENDING_STEVE_EMAIL_INTAKE");
    const blocked = journal.loadOwned(current.runId, lease);
    expect(
      blocked.stages.find((stage) => stage.stage === "freeze")
    ).toMatchObject({
      status: "blocked",
      errorCode: "PENDING_STEVE_EMAIL_INTAKE",
    });
    expect(existsSync(weeklyPath)).toBe(false);
    loadedDelivery(journal, lease, result.receipt, result.source);
    const frozen = await freezeWeeklyImport({ ...args, state: blocked });
    expect(
      frozen.stages.find((stage) => stage.stage === "freeze")
    ).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(JSON.parse(readFileSync(weeklyPath, "utf8"))).toMatchObject({
      publishedCutoffEpochMs: null,
      editions: [
        { editionId: "2026-10-16", endEpochMs: cutoff, status: "draft" },
      ],
    });
    journal.release(lease);
  });
});
