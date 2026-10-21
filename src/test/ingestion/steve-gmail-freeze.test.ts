import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { assertNoPendingSteveGmailBatches } from "../../lib/ingestion/steve-gmail-freeze.js";
import {
  captureSteveGmailWindow,
  replaySteveGmailBatch,
} from "../../lib/ingestion/steve-gmail-handoff.js";
import {
  listRetainedSteveEmailSources,
  type SteveEmailReceipt,
} from "../../lib/ingestion/steve-email-intake.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
  type StageEvidence,
} from "../../lib/ingestion/weekly-run-state.js";

vi.setConfig({ testTimeout: process.platform === "win32" ? 90_000 : 10_000 });

const scope = "prodigic/zivv/production";
const accountId = "batch-freeze@fixture.invalid";
const editionId = "2026-10-16";
const receivedAt = Date.parse("2026-10-16T17:00:00Z");
const observedAt = receivedAt + 60_000;
const editionText =
  "THE LIST\n" +
  "funk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\n" +
  "Synthetic Artist at Fixture Club\n";
const roots: string[] = [];

function message(id: string, text = editionText, authenticated = true) {
  const body = Buffer.from(text.replace(/\r?\n/g, "\r\n"));
  const headers = [
    "From: Steve Fixture <skoepke@stevelist.com>",
    "Sender: noreply@sp.eocampaign1.com",
    "Date: Fri, 16 Oct 2026 10:00:00 -0700",
    "Subject: Steve's List 10/16/2026",
    `Message-ID: <${id}@fixture.invalid>`,
    `Authentication-Results: mx.google.com; dkim=${authenticated ? "pass" : "fail"} header.i=@sp.eocampaign1.com; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com`,
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
      internalDate: String(receivedAt),
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
        body: { size: body.length, data: body.toString("base64url") },
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
    const root = "/gmail/v1/users/me";
    if (url.origin !== "https://gmail.googleapis.com")
      throw new Error("Unexpected fixture request");
    if (url.pathname === root + "/profile")
      return Response.json({ emailAddress: accountId });
    if (url.pathname === root + "/messages")
      return Response.json({ messages: messages.map(({ id }) => ({ id })) });
    const found = messages.find(
      (item) => url.pathname === root + "/messages/" + item.id
    );
    if (!found) throw new Error("Unexpected fixture message");
    return Response.json(
      url.searchParams.get("format") === "FULL" ? found.full : found.raw
    );
  };
}

function fixture(withKey = true) {
  const root = mkdtempSync(join(tmpdir(), "zivv-gmail-freeze-"));
  roots.push(root);
  const operatorDirectory = join(root, "operator");
  mkdirSync(operatorDirectory);
  if (withKey) loadBackupKey(operatorDirectory, true);
  return { root, operatorDirectory };
}

function acquire(operatorDirectory: string, messages = [message("a1")]) {
  return captureSteveGmailWindow({
    operatorDirectory,
    expectedAccountId: accountId,
    expectedEditionId: editionId,
    startEpochMs: receivedAt - 60_000,
    endEpochMs: receivedAt + 3_600_000,
    getAccessToken: async () => "synthetic_token",
    fetcher: fakeGmail(messages),
  });
}

function batchPath(operatorDirectory: string) {
  const directory = join(operatorDirectory, "email-acquisition/batches");
  const names = readdirSync(directory).filter((name) =>
    /^[a-f0-9]{64}\.json$/.test(name)
  );
  if (names.length !== 1) throw new Error("Expected one real signed batch");
  return join(directory, names[0]);
}

async function check(operatorDirectory: string, cutoffEpochMs: number) {
  const journal = new WeeklyRunJournal(operatorDirectory);
  const lease = journal.acquire(scope);
  try {
    await journal.guardOperation(lease, async () =>
      assertNoPendingSteveGmailBatches({
        operatorDirectory,
        journal,
        scope,
        cutoffEpochMs,
      })
    );
  } finally {
    try {
      journal.release(lease);
    } finally {
      journal.close();
    }
  }
}

/** Persist valid journal states to exercise the existing exact load-proof predicate. */
function loaded(
  operatorDirectory: string,
  receipt: SteveEmailReceipt,
  source: Buffer,
  alter: { deliveryId?: string; observedAt?: number } = {}
) {
  const journal = new WeeklyRunJournal(operatorDirectory);
  const lease = journal.acquire(scope);
  try {
    const rawSha256 = sha256(source),
      deliveryId = alter.deliveryId ?? receipt.deliveryId;
    let state = journal.create(
      createWeeklyRunState({
        editionId: receipt.editionId,
        deliveryId,
        rawSha256,
        importObservedAtEpochMs:
          alter.observedAt ?? receipt.firstObservedAtEpochMs,
        rulesSha256: "a".repeat(64),
      }),
      lease,
      source
    );
    const stages: Array<
      ["acquire" | "prepare" | "reconcile" | "load", StageEvidence]
    > = [
      ["acquire", { rawSha256, deliveryId }],
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
    for (const [stage, evidence] of stages) {
      state = journal.save(
        transitionWeeklyRun(
          state,
          state.revision,
          stage,
          { status: "running" },
          Date.now()
        ),
        state.revision,
        lease
      );
      state = journal.save(
        transitionWeeklyRun(
          state,
          state.revision,
          stage,
          { status: "succeeded", evidence },
          Date.now()
        ),
        state.revision,
        lease
      );
    }
  } finally {
    try {
      journal.release(lease);
    } finally {
      journal.close();
    }
  }
}

function retained(operatorDirectory: string) {
  return listRetainedSteveEmailSources({
    operatorDirectory,
    accountId,
    expectedEditionId: editionId,
  });
}

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(observedAt));
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const suffix = relative(resolve(tmpdir()), resolve(root));
    if (!suffix.startsWith("zivv-gmail-freeze-") || suffix.includes(".."))
      throw new Error("Unsafe Gmail freeze fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("durable Gmail batch freeze obligations", () => {
  it("leaves absent and artifact-empty storage readable without creating a key", async () => {
    const { operatorDirectory } = fixture(false);
    await check(operatorDirectory, observedAt);
    mkdirSync(join(operatorDirectory, "email-acquisition/batches"), {
      recursive: true,
    });
    await check(operatorDirectory, observedAt);
    expect(existsSync(join(operatorDirectory, "backup-key.bin"))).toBe(false);
    expect(existsSync(join(operatorDirectory, "backup-key.dpapi"))).toBe(false);
  });

  it("requires load after pre-cutoff registration even when actual capture was later", async () => {
    const { operatorDirectory } = fixture();
    const directory = join(operatorDirectory, "email-acquisition/batches");
    vi.mocked(Date.now).mockImplementation(() =>
      existsSync(directory) &&
      readdirSync(directory).some((name) => /^[a-f0-9]{64}\.json$/.test(name))
        ? observedAt + 2_000
        : observedAt
    );
    await acquire(operatorDirectory);
    const [saved] = retained(operatorDirectory);
    expect(saved.receipt.firstObservedAtEpochMs).toBe(observedAt + 2_000);
    await expect(
      check(operatorDirectory, observedAt + 1_000)
    ).rejects.toMatchObject({ code: "PENDING_STEVE_EMAIL_INTAKE" });
    loaded(operatorDirectory, saved.receipt, saved.source);
    await expect(
      check(operatorDirectory, observedAt + 1_000)
    ).resolves.toBeUndefined();
  });

  it("requires exact source, observation and delivery in the successful load", async () => {
    const { operatorDirectory } = fixture();
    await acquire(operatorDirectory);
    vi.mocked(Date.now).mockReturnValue(observedAt + 10);
    const [saved] = retained(operatorDirectory);
    const pending = () =>
      expect(check(operatorDirectory, observedAt + 1)).rejects.toMatchObject({
        code: "PENDING_STEVE_EMAIL_INTAKE",
      });
    loaded(
      operatorDirectory,
      saved.receipt,
      Buffer.concat([saved.source, Buffer.from("different source")])
    );
    await pending();
    loaded(operatorDirectory, saved.receipt, saved.source, {
      observedAt: saved.receipt.firstObservedAtEpochMs - 1,
    });
    await pending();
    loaded(operatorDirectory, saved.receipt, saved.source, {
      deliveryId: "another-delivery",
    });
    await pending();
    loaded(operatorDirectory, saved.receipt, saved.source);
    await expect(
      check(operatorDirectory, observedAt + 1)
    ).resolves.toBeUndefined();
  });

  it("does not treat a loaded review-required body as correction approval", async () => {
    const { operatorDirectory } = fixture();
    const report = await acquire(operatorDirectory, [
      message("a1"),
      message("a2", editionText + "Correction: synthetic show cancelled\n"),
    ]);
    const saved = retained(operatorDirectory);
    expect(saved.map((item) => item.receipt.disposition).sort()).toEqual([
      "ready",
      "review-required",
    ]);
    for (const item of saved)
      loaded(operatorDirectory, item.receipt, item.source);
    vi.mocked(Date.now).mockReturnValue(observedAt + 10);
    await expect(
      check(operatorDirectory, observedAt + 1)
    ).rejects.toMatchObject({ code: "PENDING_STEVE_EMAIL_INTAKE" });
    await replaySteveGmailBatch({
      operatorDirectory,
      expectedAccountId: accountId,
      expectedEditionId: editionId,
      batchId: report.batchIds[0],
      correctionOfByMessageId: {
        a2: saved.find((item) => item.receipt.disposition === "ready")!.receipt
          .receiptId,
      },
    });
    await expect(
      check(operatorDirectory, observedAt + 1)
    ).resolves.toBeUndefined();
  });

  it("accepts two Gmail message manifests mapped to one loaded canonical receipt", async () => {
    const { operatorDirectory } = fixture();
    await acquire(operatorDirectory, [message("a1"), message("a2")]);
    const saved = retained(operatorDirectory);
    expect(saved).toHaveLength(1);
    loaded(operatorDirectory, saved[0].receipt, saved[0].source);
    vi.mocked(Date.now).mockReturnValue(observedAt + 10);
    await expect(
      check(operatorDirectory, observedAt + 1)
    ).resolves.toBeUndefined();
  });

  it("excludes a valid post-cutoff batch while refusing an uncaptured pre-cutoff message", async () => {
    const { operatorDirectory } = fixture();
    await expect(
      acquire(operatorDirectory, [message("a1", editionText, false)])
    ).rejects.toThrow();
    expect(existsSync(batchPath(operatorDirectory))).toBe(true);
    await expect(check(operatorDirectory, observedAt)).resolves.toBeUndefined();
    vi.mocked(Date.now).mockReturnValue(observedAt + 10);
    await expect(
      check(operatorDirectory, observedAt + 1)
    ).rejects.toMatchObject({ code: "PENDING_STEVE_EMAIL_INTAKE" });
  });

  for (const damage of [
    "partial-stage",
    "tamper",
    "hard-link",
    "missing-key",
  ] as const) {
    it(`fails closed for ${damage} without repairing private storage`, async () => {
      const { root, operatorDirectory } = fixture();
      await acquire(operatorDirectory);
      const path = batchPath(operatorDirectory),
        bytes = readFileSync(path);
      if (damage === "partial-stage")
        writeFileSync(path + ".123." + "a".repeat(16) + ".tmp", "incomplete");
      else if (damage === "tamper")
        writeFileSync(path, Buffer.concat([bytes, Buffer.from(" ")]));
      else if (damage === "hard-link")
        linkSync(path, join(root, "external-batch-link"));
      else
        rmSync(
          join(
            operatorDirectory,
            process.platform === "win32" ? "backup-key.dpapi" : "backup-key.bin"
          )
        );
      vi.mocked(Date.now).mockReturnValue(observedAt + 10);
      await expect(
        check(operatorDirectory, observedAt + 1)
      ).rejects.toMatchObject({ code: "PENDING_STEVE_EMAIL_INTAKE" });
      if (damage === "partial-stage")
        expect(
          readFileSync(path + ".123." + "a".repeat(16) + ".tmp", "utf8")
        ).toBe("incomplete");
      if (damage !== "tamper") expect(readFileSync(path)).toEqual(bytes);
    });
  }
});
