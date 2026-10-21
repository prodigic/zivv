import {
  existsSync,
  closeSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureSteveGmailWindow,
  readAuthenticatedSteveGmailBatches,
  readSteveGmailHandoffStatus,
  replaySteveGmailBatch,
} from "../../lib/ingestion/steve-gmail-handoff.js";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import { writeSqliteLedger } from "../../lib/ingestion/sqlite-store.js";
import { loadRetainedSteveEmailSources } from "../../lib/ingestion/steve-email-load.js";
import { readSqliteLedger } from "../../lib/ingestion/sqlite-store.js";
import { runWeeklyImport } from "../../lib/ingestion/weekly-import-runner.js";

const accountId = "synthetic-account@fixture.invalid";
const editionId = "2026-10-16";
const receivedAt = Date.parse("2026-10-16T17:00:00Z");
const observedAt = Date.parse("2026-10-16T17:05:00Z");
const startEpochMs = receivedAt - 1000;
const endEpochMs = receivedAt + 1000;
const bodyText =
  "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\noct 23 fri Fixture Band at Test Room, Oakland a/a $20 8pm\nPlease feel free to forward The List on to your friends.\n";
const authentication =
  "mx.google.com; dkim=pass header.i=@sp.eocampaign1.com; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com";
const roots: string[] = [];
vi.setConfig({ testTimeout: 60_000 });

function message(id: string, text = bodyText) {
  const headers: Array<[string, string]> = [
    ["From", "Steve Fixture <skoepke@stevelist.com>"],
    ["Sender", "noreply@sp.eocampaign1.com"],
    ["Date", "Fri, 16 Oct 2026 10:00:00 -0700"],
    ["Subject", "Steve's List 10/16/2026"],
    ["Message-ID", `<${id}@fixture.invalid>`],
    ["Authentication-Results", authentication],
    [
      "DKIM-Signature",
      "v=1; a=rsa-sha256; d=sp.eocampaign1.com; s=fixture; h=from:sender:subject:date; bh=c3ludGhldGlj; b=c3ludGhldGlj",
    ],
  ];
  const raw = Buffer.from(
    [
      ...headers.map(([name, value]) => `${name}: ${value}`),
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      text.replace(/\r?\n/g, "\r\n"),
    ].join("\r\n")
  );
  const body = Buffer.from(text.replace(/\r?\n/g, "\r\n"));
  return {
    id,
    rawMessage: { id, raw: raw.toString("base64url") },
    fullMessage: {
      id,
      internalDate: String(receivedAt),
      payload: {
        mimeType: "text/plain",
        filename: "",
        headers: headers.map(([name, value]) => ({ name, value })),
        body: { size: body.length, data: body.toString("base64url") },
      },
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zivv-gmail-handoff-"));
  roots.push(root);
  const operatorDirectory = join(root, "operator");
  requireKey(operatorDirectory);
  return { root, operatorDirectory };
}

function requireKey(operatorDirectory: string) {
  loadBackupKey(operatorDirectory, true);
}

function fakeFetcher(
  messages: ReturnType<typeof message>[],
  calls?: string[],
  paginated = false
) {
  const byId = new Map(messages.map((item) => [item.id, item]));
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls?.push(`${url.pathname}${url.search}`);
    let value: unknown;
    if (url.pathname.endsWith("/profile")) {
      value = { emailAddress: accountId };
    } else if (url.pathname.endsWith("/messages")) {
      value =
        paginated && messages.length > 1
          ? url.searchParams.has("pageToken")
            ? { messages: messages.slice(1).map(({ id }) => ({ id })) }
            : {
                messages: [{ id: messages[0]!.id }],
                nextPageToken: "fixture-next",
              }
          : { messages: messages.map(({ id }) => ({ id })) };
    } else {
      const match = url.pathname.match(/\/messages\/([a-f0-9]+)$/);
      const item = match ? byId.get(decodeURIComponent(match[1]!)) : undefined;
      if (!item) return new Response("{}", { status: 404 });
      value =
        url.searchParams.get("format") === "RAW"
          ? item.rawMessage
          : {
              id: item.id,
              internalDate: item.fullMessage.internalDate,
              payload: item.fullMessage.payload,
            };
    }
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function input(
  operatorDirectory: string,
  messages: ReturnType<typeof message>[],
  extra: { getAccessToken?: () => Promise<string>; calls?: string[] } = {}
) {
  return {
    operatorDirectory,
    expectedAccountId: accountId,
    expectedEditionId: editionId,
    startEpochMs,
    endEpochMs,
    getAccessToken:
      extra.getAccessToken ?? vi.fn(async () => "synthetic-token"),
    fetcher: fakeFetcher(messages, extra.calls),
  };
}

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(observedAt));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    const resolved = resolve(root);
    if (
      !resolved.startsWith(resolve(tmpdir(), "zivv-gmail-handoff-")) &&
      !resolved.startsWith(resolve(tmpdir(), "zivv-gmail-empty-"))
    )
      throw new Error("Unsafe Gmail handoff fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("durable Steve Gmail handoff", () => {
  it("stores a complete fake API window before capture and exposes redacted capture/load status", async () => {
    const { operatorDirectory } = fixture();
    const calls: string[] = [];
    const result = await captureSteveGmailWindow(
      input(operatorDirectory, [message("a1"), message("b2")], { calls })
    );
    expect(result.status).toBe("captured");
    expect(result.replayed).toBe(false);
    expect(result.messageCount).toBe(2);
    expect(result.receipts).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/profile"))).toHaveLength(2);
    expect(
      readAuthenticatedSteveGmailBatches({ operatorDirectory })
    ).toHaveLength(1);
    const status = readSteveGmailHandoffStatus({
      operatorDirectory,
      expectedAccountId: accountId,
      expectedEditionId: editionId,
    });
    expect(status.batches).toHaveLength(1);
    expect(status.batches[0]).toMatchObject({
      messageCount: 2,
      capturedCount: 2,
      capturePendingCount: 0,
      loadPendingCount: 1,
      status: "load-pending",
    });
    expect(JSON.stringify(status)).not.toContain(accountId);
    expect(JSON.stringify(result)).not.toContain("Synthetic Artist");
  });

  it("preserves first batch bytes across repeat polls with fresh observation times", async () => {
    const { operatorDirectory } = fixture();
    const first = await captureSteveGmailWindow(
      input(operatorDirectory, [message("a1")])
    );
    const batchDirectory = join(
      operatorDirectory,
      "email-acquisition",
      "batches"
    );
    const batchPath = join(batchDirectory, `${first.batchIds[0]}.json`);
    const bytes = readFileSync(batchPath);
    vi.spyOn(Date, "now").mockReturnValue(observedAt + 1000);
    const second = await captureSteveGmailWindow(
      input(operatorDirectory, [message("a1")])
    );
    expect(second.batchIds).toEqual(first.batchIds);
    expect(readFileSync(batchPath)).toEqual(bytes);
  });

  it("replays a stored batch without token access and repairs a missing capture manifest", async () => {
    const { operatorDirectory } = fixture();
    const first = await captureSteveGmailWindow(
      input(operatorDirectory, [message("a1")])
    );
    const batch = readAuthenticatedSteveGmailBatches({ operatorDirectory })[0]!;
    const capturePath = join(
      operatorDirectory,
      "email-intake",
      sha256(accountId),
      "messages",
      sha256("a1"),
      "capture.json"
    );
    unlinkSync(capturePath);
    const result = await replaySteveGmailBatch({
      operatorDirectory,
      batchId: batch.batchId,
      expectedAccountId: accountId,
      expectedEditionId: editionId,
    });
    expect(result).toMatchObject({ status: "captured", replayed: true });
    expect(result.receipts[0]?.receiptId).toBe(first.receipts[0]?.receiptId);
    expect(existsSync(capturePath)).toBe(true);
  });

  it("continues polling after a completed capture-only batch", async () => {
    const { operatorDirectory } = fixture();
    const first = await captureSteveGmailWindow(
      input(operatorDirectory, [message("a1")])
    );
    const getAccessToken = vi.fn(async () => {
      throw new Error("should not be requested");
    });
    await expect(
      captureSteveGmailWindow({
        ...input(operatorDirectory, []),
        getAccessToken,
      })
    ).rejects.toThrow("GMAIL_AUTH_REQUIRED");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(first.batchIds).toHaveLength(1);
  });

  it("creates no key or batch when a complete remote window is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "zivv-gmail-empty-"));
    roots.push(root);
    const operatorDirectory = join(root, "operator");
    const result = await captureSteveGmailWindow(input(operatorDirectory, []));
    expect(result).toEqual({
      status: "missing",
      replayed: false,
      batchIds: [],
      messageCount: 0,
      receipts: [],
    });
    expect(existsSync(operatorDirectory)).toBe(false);
  });

  it("rejects a changed signed batch before capture", async () => {
    const { operatorDirectory } = fixture();
    const result = await captureSteveGmailWindow(
      input(operatorDirectory, [message("a1")])
    );
    const batchPath = join(
      operatorDirectory,
      "email-acquisition",
      "batches",
      `${result.batchIds[0]}.json`
    );
    const value = JSON.parse(readFileSync(batchPath, "utf8")) as Record<
      string,
      unknown
    >;
    value.firstSavedAtEpochMs = observedAt - 1;
    writeFileSync(batchPath, `${canonicalJson(value)}\n`);
    const fetcher = fakeFetcher([message("b2")]);
    await expect(
      captureSteveGmailWindow({
        ...input(operatorDirectory, [message("b2")]),
        fetcher,
      })
    ).rejects.toThrow(/PENDING_STEVE_EMAIL_INTAKE/);
  });

  it("adopts a unique authenticated stage and removes only its hard-link alias", async () => {
    const { operatorDirectory } = fixture();
    const result = await captureSteveGmailWindow(
      input(operatorDirectory, [message("a1")])
    );
    const batchPath = join(
      operatorDirectory,
      "email-acquisition",
      "batches",
      `${result.batchIds[0]}.json`
    );
    const stagePath = `${batchPath}.${process.pid}.0123456789abcdef.tmp`;
    renameSync(batchPath, stagePath);
    expect(() =>
      readAuthenticatedSteveGmailBatches({ operatorDirectory })
    ).toThrow("PENDING_STEVE_EMAIL_INTAKE");
    expect(existsSync(stagePath)).toBe(true);
    const noToken = vi.fn(async () => {
      throw new Error("GMAIL_AUTH_REQUIRED");
    });
    await expect(
      captureSteveGmailWindow({
        ...input(operatorDirectory, []),
        getAccessToken: noToken,
      })
    ).rejects.toThrow("GMAIL_AUTH_REQUIRED");
    expect(existsSync(batchPath)).toBe(true);
    expect(existsSync(stagePath)).toBe(false);

    const aliasPath = `${batchPath}.${process.pid}.fedcba9876543210.tmp`;
    linkSync(batchPath, aliasPath);
    await expect(
      captureSteveGmailWindow({
        ...input(operatorDirectory, []),
        getAccessToken: noToken,
      })
    ).rejects.toThrow("GMAIL_AUTH_REQUIRED");
    expect(existsSync(aliasPath)).toBe(false);
    expect(
      readAuthenticatedSteveGmailBatches({ operatorDirectory })
    ).toHaveLength(1);
  });

  it("preserves an invalid partial stage and refuses before fetching", async () => {
    const { operatorDirectory } = fixture();
    const result = await captureSteveGmailWindow(
      input(operatorDirectory, [message("a1")])
    );
    const batchPath = join(
      operatorDirectory,
      "email-acquisition",
      "batches",
      `${result.batchIds[0]}.json`
    );
    const stagePath = `${batchPath}.${process.pid}.0123456789abcdef.tmp`;
    renameSync(batchPath, stagePath);
    writeFileSync(stagePath, "partial");
    const getAccessToken = vi.fn(async () => "synthetic-token");
    await expect(
      captureSteveGmailWindow({
        ...input(operatorDirectory, [message("b2")]),
        getAccessToken,
      })
    ).rejects.toThrow("PENDING_STEVE_EMAIL_INTAKE");
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(existsSync(stagePath)).toBe(true);
    expect(existsSync(batchPath)).toBe(false);
  });

  it("reports complete only after a real retained-source load is journaled", async () => {
    const { root, operatorDirectory } = fixture();
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, "data", "ingestion"), { recursive: true });
    writeFileSync(
      join(checkout, "data", "ingestion", "store.json"),
      canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    await writeSqliteLedger(
      join(operatorDirectory, "ledger.sqlite"),
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
      true
    );
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    const messages = [message("a1"), message("b2")];
    const calls: string[] = [];
    const result = await captureSteveGmailWindow({
      ...input(operatorDirectory, messages),
      fetcher: fakeFetcher(messages, calls, true),
    });
    expect(calls.some((url) => url.includes("pageToken=fixture-next"))).toBe(
      true
    );
    expect(result.receipts).toHaveLength(1);
    const loaded = await loadRetainedSteveEmailSources({
      root: checkout,
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
    });
    expect(loaded.counts.loaded).toBe(1);
    const status = readSteveGmailHandoffStatus({
      operatorDirectory,
      expectedAccountId: accountId,
      expectedEditionId: editionId,
    });
    expect(status.batches[0]).toMatchObject({
      batchId: result.batchIds[0],
      capturedCount: 2,
      capturePendingCount: 0,
      loadPendingCount: 0,
      status: "complete",
    });
    const before = readSqliteLedger(join(operatorDirectory, "ledger.sqlite"));
    const repeated = await loadRetainedSteveEmailSources({
      root: checkout,
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
    });
    expect(repeated.entries).toEqual(loaded.entries);
    expect(readSqliteLedger(join(operatorDirectory, "ledger.sqlite"))).toEqual(
      before
    );
    expect(before.runs).toHaveLength(1);
    expect(before.events).toHaveLength(1);
    expect(before.events[0]!.firstObservedAtEpochMs).toBe(observedAt);
  }, 60_000);

  it("refuses cached FULL text inconsistent with a retained RAW before fresh HTTP", async () => {
    const { operatorDirectory } = fixture();
    await captureSteveGmailWindow(input(operatorDirectory, [message("a1")]));
    const altered = message("a1");
    const wrongBody = Buffer.from(
      bodyText
        .replace("Fixture Band", "Different Act")
        .replace(/\r?\n/g, "\r\n")
    );
    altered.fullMessage.payload.body = {
      size: wrongBody.length,
      data: wrongBody.toString("base64url"),
    };
    await expect(
      captureSteveGmailWindow({
        ...input(operatorDirectory, [altered]),
        startEpochMs: startEpochMs - 1000,
      })
    ).rejects.toThrow("GMAIL_MIME_TEXT_MISMATCH");
    const status = readSteveGmailHandoffStatus({
      operatorDirectory,
      expectedAccountId: accountId,
      expectedEditionId: editionId,
    });
    expect(
      status.batches.some((batch) => batch.status === "capture-pending")
    ).toBe(true);
    const token = vi.fn(async () => "never-request");
    await expect(
      captureSteveGmailWindow({
        ...input(operatorDirectory, []),
        getAccessToken: token,
      })
    ).rejects.toThrow("GMAIL_MIME_TEXT_MISMATCH");
    expect(token).not.toHaveBeenCalled();
  });

  it.each(["missing", "found"] as const)(
    "repairs late valid staging before returning a %s remote window",
    async (kind) => {
      const { operatorDirectory } = fixture();
      const incoming = kind === "found" ? [message("b2")] : [];
      const baseFetcher = fakeFetcher(incoming);
      let profiles = 0;
      const fetcher = async (request: RequestInfo | URL) => {
        if (String(request).endsWith("/profile") && ++profiles === 2) {
          const older = await captureSteveGmailWindow(
            input(operatorDirectory, [message("a1")])
          );
          const path = join(
            operatorDirectory,
            "email-acquisition/batches",
            `${older.batchIds[0]}.json`
          );
          renameSync(path, `${path}.123.0123456789abcdef.tmp`);
          unlinkSync(
            join(
              operatorDirectory,
              "email-intake",
              sha256(accountId),
              "messages",
              sha256("a1"),
              "capture.json"
            )
          );
        }
        return baseFetcher(request);
      };
      const result = await captureSteveGmailWindow({
        ...input(operatorDirectory, incoming),
        fetcher,
      });
      expect(result.status).toBe("captured");
      const batches = readSteveGmailHandoffStatus({
        operatorDirectory,
        expectedAccountId: accountId,
        expectedEditionId: editionId,
      }).batches;
      expect(batches).toHaveLength(kind === "found" ? 2 : 1);
      expect(batches.every((batch) => batch.capturePendingCount === 0)).toBe(
        true
      );
    }
  );

  it("checks aggregate storage before parsing or requesting a token", async () => {
    const { operatorDirectory } = fixture();
    const directory = join(operatorDirectory, "email-acquisition/batches");
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 8; index++) {
      const fd = openSync(
        join(directory, `${index.toString(16).padStart(64, "0")}.json`),
        "wx"
      );
      try {
        ftruncateSync(fd, 32 * 1024 * 1024 + 64 * 1024);
      } finally {
        closeSync(fd);
      }
    }
    expect(() =>
      readAuthenticatedSteveGmailBatches({ operatorDirectory })
    ).toThrow("GMAIL_BATCH_RETENTION_LIMIT");
    const token = vi.fn(async () => "never-request");
    await expect(
      captureSteveGmailWindow({
        ...input(operatorDirectory, []),
        getAccessToken: token,
      })
    ).rejects.toThrow("GMAIL_BATCH_RETENTION_LIMIT");
    expect(token).not.toHaveBeenCalled();
  });

  it("blocks actual freeze for an unapproved acquired correction, then resumes the same freeze after explicit approval and load", async () => {
    const { root, operatorDirectory } = fixture();
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, "data/ingestion"), { recursive: true });
    writeFileSync(
      join(checkout, "data/ingestion/store.json"),
      canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
    );
    await writeSqliteLedger(
      join(operatorDirectory, "ledger.sqlite"),
      bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
      true
    );
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    const messages = [
      message("a1"),
      message(
        "b2",
        bodyText.replace(
          "Please feel free",
          "oct 24 sat Second Band at Test Room, Oakland a/a $20 8pm\nPlease feel free"
        )
      ),
    ];
    const captured = await captureSteveGmailWindow(
      input(operatorDirectory, messages)
    );
    const loaded = await loadRetainedSteveEmailSources({
      root: checkout,
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
    });
    expect(loaded.counts).toMatchObject({ loaded: 1, reviewRequired: 1 });
    const runId = loaded.entries.find(
      (entry) => entry.disposition === "loaded"
    )!.runId!;
    vi.mocked(Date.now).mockReturnValue(observedAt + 1000);
    const freeze = () =>
      runWeeklyImport({
        root: checkout,
        runId,
        stopAfter: "freeze",
        freezeCutoffEpochMs: observedAt + 500,
      });
    await expect(freeze()).rejects.toMatchObject({
      code: "PENDING_STEVE_EMAIL_INTAKE",
    });
    const parent = captured.receipts.find(
      (receipt) => receipt.disposition === "ready"
    )!;
    await replaySteveGmailBatch({
      operatorDirectory,
      batchId: captured.batchIds[0]!,
      expectedAccountId: accountId,
      expectedEditionId: editionId,
      correctionOfByMessageId: { b2: parent.receiptId },
    });
    const complete = await loadRetainedSteveEmailSources({
      root: checkout,
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
    });
    expect(complete.counts.loaded, JSON.stringify(complete)).toBe(2);
    const frozen = await freeze();
    expect(frozen.runId).toBe(runId);
    expect(
      frozen.stages.find((stage) => stage.stage === "freeze")?.status
    ).toBe("succeeded");
  }, 90_000);
});
