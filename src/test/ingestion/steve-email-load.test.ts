import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapLedger, loadLedger } from "../../lib/ingestion/ledger.js";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import {
  captureSteveEmail,
  listRetainedSteveEmailSources,
} from "../../lib/ingestion/steve-email-intake.js";
import {
  canonicalJson,
  writeSqliteLedger,
  readCanonicalSqliteLedgerReadOnly,
} from "../../lib/ingestion/sqlite-store.js";
import {
  loadRetainedSteveEmailSources,
  SteveEmailLoadError,
} from "../../lib/ingestion/steve-email-load.js";
import { CURRENT_STEVE_IMPORTER } from "../../lib/ingestion/steve-import-review.js";
import { runFridayMailboxWake } from "../../lib/ingestion/steve-gmail-friday-wake.js";
import {
  captureSteveGmailWindow,
  readSteveGmailHandoffStatus,
} from "../../lib/ingestion/steve-gmail-handoff.js";
import { planFridayMonitorNotice } from "../../lib/ingestion/friday-monitor-evidence.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";

const accountId = "synthetic-account@fixture.invalid";
const editionId = "2026-10-16";
const observedAt = Date.parse("2026-10-16T17:05:00Z");
const editionText =
  "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\noct 23 fri Fixture Band at Test Room, Oakland a/a $20 8pm\nPlease feel free to forward The List on to your friends.\n";
const authentication =
  "mx.google.com; dkim=pass header.i=@sp.eocampaign1.com; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com";
const directories: string[] = [];

function syntheticMessage(id: string, text = editionText) {
  const body = Buffer.from(text.replace(/\r?\n/g, "\r\n"));
  const headerLines = [
    "From: Steve Fixture <skoepke@stevelist.com>",
    "Sender: noreply@sp.eocampaign1.com",
    "Date: Fri, 16 Oct 2026 10:00:00 -0700",
    "Subject: Steve's List 10/16/2026",
    `Message-ID: <${id}@fixture.invalid>`,
    `Authentication-Results: ${authentication}`,
    "DKIM-Signature: v=1; a=rsa-sha256; d=sp.eocampaign1.com; s=fixture; h=from:sender:subject:date; bh=c3ludGhldGlj; b=c3ludGhldGlj",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
  ];
  const headers = headerLines.map((line) => {
    const colon = line.indexOf(":");
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  });
  const raw = Buffer.concat([
    Buffer.from(`${headerLines.join("\r\n")}\r\n\r\n`),
    body,
  ]);
  return {
    rawMessage: { id, raw: raw.toString("base64url") },
    fullMessage: {
      id,
      internal_date: String(Date.parse("2026-10-16T17:00:00Z")),
      payload: {
        mime_type: "text/plain",
        filename: "",
        headers,
        body: {
          size: body.length,
          base64_url_content: body.toString("base64url"),
        },
      },
    },
  };
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "zivv-steve-load-"));
  directories.push(base);
  const root = join(base, "checkout");
  const operatorDirectory = join(base, "operator");
  mkdirSync(join(root, "data/ingestion"), { recursive: true });
  mkdirSync(operatorDirectory, { recursive: true });
  writeFileSync(
    join(root, "data/ingestion/store.json"),
    canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
  );
  return { base, root, operatorDirectory };
}

async function initializeLedger(operatorDirectory: string) {
  loadBackupKey(operatorDirectory, true);
  await writeSqliteLedger(
    join(operatorDirectory, "ledger.sqlite"),
    bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
    true
  );
}

async function capture(
  operatorDirectory: string,
  id: string,
  text = editionText
) {
  return captureSteveEmail({
    operatorDirectory,
    accountId,
    ...syntheticMessage(id, text),
    expectedEditionId: editionId,
    observedAtEpochMs: observedAt,
  });
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(observedAt);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), "zivv-steve-load-")))
      throw new Error("Unsafe Steve email load fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local load of retained Steve email receipts", () => {
  it("loads clean ready receipts with stable source identity, run ID, and first-added provenance on replay", async () => {
    const { root, operatorDirectory } = fixture();
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    await initializeLedger(operatorDirectory);
    const captured = await capture(operatorDirectory, "a1");
    const progress: string[] = [];
    const input = {
      root,
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
      onProgress: (event: { runId: string; stage: string; phase: string }) => {
        progress.push(`${event.runId}:${event.stage}:${event.phase}`);
      },
    };

    const first = await loadRetainedSteveEmailSources(input);
    const firstLedger = await loadLedger(
      join(root, "data/ingestion/ledger.json")
    );
    const second = await loadRetainedSteveEmailSources(input);
    const secondLedger = await loadLedger(
      join(root, "data/ingestion/ledger.json")
    );
    const retained = listRetainedSteveEmailSources({
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
    });
    const event = firstLedger.events[0];

    expect(retained[0]?.source.toString("utf8")).toBe(
      captured.source.toString("utf8")
    );
    expect(first.entries[0]).toMatchObject({
      receiptId: captured.receipt.receiptId,
      disposition: "loaded",
      runId: expect.any(String),
    });
    expect(first.counts).toEqual({
      ready: 1,
      reviewRequired: 0,
      loaded: 1,
      blocked: 0,
      failed: 0,
      notProcessed: 0,
    });
    expect(first.entries[0]).toMatchObject({
      receiptId: captured.receipt.receiptId,
      disposition: "loaded",
    });
    expect(second.entries[0]).toEqual(first.entries[0]);
    expect(event).toBeDefined();
    expect(event?.firstObservedAtEpochMs).toBe(
      captured.receipt.firstObservedAtEpochMs
    );
    expect(event?.createdAtEpochMs).toBe(
      captured.receipt.firstObservedAtEpochMs
    );
    expect(event?.firstImportRunId).toMatch(
      new RegExp(`^${CURRENT_STEVE_IMPORTER}-`)
    );
    expect(event?.sources[0]?.firstSeenRunId).toMatch(
      new RegExp(`^${CURRENT_STEVE_IMPORTER}-`)
    );
    expect(canonicalJson(secondLedger)).toBe(canonicalJson(firstLedger));
    expect(progress.some((entry) => entry.endsWith(":load:completed"))).toBe(
      true
    );
    expect(JSON.stringify(first)).not.toContain(accountId);
    expect(JSON.stringify(first)).not.toContain(
      captured.source.toString("utf8")
    );
  }, 30_000);

  it("loads a retained receipt offline through the CLI and replays without extra effects", async () => {
    const { base, root, operatorDirectory } = fixture();
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    await initializeLedger(operatorDirectory);
    const retained = await capture(operatorDirectory, "a1");
    const preload = join(base, "forbid-network.cjs");
    writeFileSync(
      preload,
      "globalThis.fetch = async () => { throw Error('UNEXPECTED_NETWORK'); };\n"
    );
    const frame = {
      operatorDirectory,
      expectedAccountId: accountId,
      expectedEditionId: editionId,
    };
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "--require",
          preload,
          resolve("scripts/steve-gmail.js"),
          "load-retained",
          "--root",
          root,
        ],
        {
          cwd: resolve("."),
          env: { ...process.env, ZIVV_LEDGER_HOME: operatorDirectory },
          input: JSON.stringify(frame),
          encoding: "utf8",
          windowsHide: true,
          timeout: 60_000,
        }
      );
    const first = run();
    expect(first.error).toBeUndefined();
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      editionId,
      status: "loaded",
      counts: {
        ready: 1,
        reviewRequired: 0,
        loaded: 1,
        blocked: 0,
        failed: 0,
        notProcessed: 0,
      },
    });
    const ledgerPath = join(operatorDirectory, "ledger.sqlite");
    const journalPath = join(operatorDirectory, "weekly-runs.sqlite");
    const ledger = readCanonicalSqliteLedgerReadOnly(ledgerPath);
    const journal = readWeeklyJournalRecoverySnapshotReadOnly(journalPath);
    expect(ledger.ledger.runs).toHaveLength(1);
    expect(ledger.ledger.events).toHaveLength(1);
    const second = run();
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
    expect(readCanonicalSqliteLedgerReadOnly(ledgerPath)).toEqual(ledger);
    expect(
      validateWeeklyJournalRecoverySnapshot(
        readWeeklyJournalRecoverySnapshotReadOnly(journalPath)
      ).runState
    ).toEqual(validateWeeklyJournalRecoverySnapshot(journal).runState);
    expect(existsSync(join(root, "data/ingestion/weekly-editions.json"))).toBe(
      false
    );
    expect(existsSync(join(operatorDirectory, "weekly-publication"))).toBe(
      false
    );
    for (const result of [first, second]) {
      expect(result.stderr).toBe("");
      for (const secret of [
        accountId,
        root,
        operatorDirectory,
        retained.receipt.receiptId,
        retained.source.toString("utf8"),
      ])
        expect(result.stdout + result.stderr).not.toContain(secret);
    }
  }, 180_000);

  it("refuses a mismatched store and extra frame fields before ledger or journal effects", async () => {
    const { base, root, operatorDirectory } = fixture();
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    await initializeLedger(operatorDirectory);
    const other = join(base, "other-operator");
    mkdirSync(other);
    const ledgerPath = join(operatorDirectory, "ledger.sqlite");
    const before = readCanonicalSqliteLedgerReadOnly(ledgerPath);
    const frame = {
      operatorDirectory,
      expectedAccountId: accountId,
      expectedEditionId: editionId,
    };
    for (const input of [
      { ...frame, operatorDirectory: other },
      { ...frame, extra: "private-extra" },
    ]) {
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/steve-gmail.js"), "load-retained", "--root", root],
        {
          cwd: resolve("."),
          env: { ...process.env, ZIVV_LEDGER_HOME: operatorDirectory },
          input: JSON.stringify(input),
          encoding: "utf8",
          windowsHide: true,
          timeout: 60_000,
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^\{"error":"[A-Z][A-Z0-9_]+"\}\s*$/);
      for (const secret of [
        root,
        operatorDirectory,
        other,
        accountId,
        "private-extra",
      ])
        expect(result.stderr).not.toContain(secret);
      expect(readCanonicalSqliteLedgerReadOnly(ledgerPath)).toEqual(before);
      expect(existsSync(join(operatorDirectory, "weekly-runs.sqlite"))).toBe(
        false
      );
      expect(existsSync(join(other, "weekly-runs.sqlite"))).toBe(false);
    }
  }, 180_000);
  it("does not poll or create private effects before the configured opening", async () => {
    const { root, base, operatorDirectory } = fixture();
    const frame = Buffer.from(
      JSON.stringify({
        operatorDirectory,
        credentialDirectory: join(base, "absent-credentials"),
        expectedAccountId: accountId,
        earlyScanDays: 0,
      })
    );
    const poll = vi.fn(async () => ({ status: "missing", editionId }));
    const result = await runFridayMailboxWake(root, frame, 5000, {
      clock: () => Date.parse("2026-10-15T19:00:00Z"),
      poll,
    });
    expect(result).toMatchObject({
      status: "not-open",
      editionId,
      scanStartsAtEpochMs: Date.parse("2026-10-16T07:00:00Z"),
    });
    expect(poll).not.toHaveBeenCalled();
    expect(existsSync(join(operatorDirectory, "weekly-runs.sqlite"))).toBe(
      false
    );
    expect(existsSync(join(base, "absent-credentials"))).toBe(false);
  });

  it("passes one exact worker frame and loads the captured receipt without duplicate SQL effects", async () => {
    const { root, base, operatorDirectory } = fixture();
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    await initializeLedger(operatorDirectory);
    const captured = await capture(operatorDirectory, "a1");
    const credentialDirectory = join(base, "absent-credentials");
    const config = Buffer.from(
      JSON.stringify({
        operatorDirectory,
        credentialDirectory,
        expectedAccountId: accountId,
        earlyScanDays: 0,
      })
    );
    const frames: Array<{ frame: unknown; budget: number }> = [];
    const poll = vi.fn(async (bytes: Buffer, budget: number) => {
      frames.push({ frame: JSON.parse(bytes.toString("utf8")), budget });
      return {
        status: "captured",
        editionId,
        attempts: 1,
        batchCount: 1,
        messageCount: 1,
        readyCount: 1,
        reviewRequiredCount: 0,
        replayed: false,
      };
    });
    const deps = { clock: () => observedAt, poll };
    const result = await runFridayMailboxWake(root, config, 5000, deps);
    expect(result).toEqual({
      editionId,
      status: "loaded",
      mailboxStatus: "captured",
      counts: {
        ready: 1,
        reviewRequired: 0,
        loaded: 1,
        blocked: 0,
        failed: 0,
        notProcessed: 0,
      },
    });
    expect(frames).toEqual([
      {
        budget: 5000,
        frame: {
          operatorDirectory,
          credentialDirectory,
          expectedAccountId: accountId,
          expectedEditionId: editionId,
          scanStartsAt: "2026-10-16T07:00:00.000Z",
        },
      },
    ]);
    const path = join(operatorDirectory, "ledger.sqlite");
    const ledger = readCanonicalSqliteLedgerReadOnly(path);
    expect(ledger.ledger.runs).toHaveLength(1);
    expect(ledger.ledger.events).toHaveLength(1);
    expect(await runFridayMailboxWake(root, config, 5000, deps)).toEqual(
      result
    );
    expect(readCanonicalSqliteLedgerReadOnly(path)).toEqual(ledger);
    expect(existsSync(credentialDirectory)).toBe(false);
    expect(existsSync(join(root, "data/ingestion/weekly-editions.json"))).toBe(
      false
    );
    expect(existsSync(join(operatorDirectory, "weekly-publication"))).toBe(
      false
    );
    for (const value of [
      accountId,
      operatorDirectory,
      credentialDirectory,
      captured.receipt.receiptId,
      captured.source.toString("utf8"),
    ])
      expect(JSON.stringify(result)).not.toContain(value);
  }, 60_000);

  it("refuses a wrong operator before polling and a mismatched report before loading", async () => {
    const { root, base, operatorDirectory } = fixture();
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    await initializeLedger(operatorDirectory);
    await capture(operatorDirectory, "a1");
    const path = join(operatorDirectory, "ledger.sqlite");
    const ledger = readCanonicalSqliteLedgerReadOnly(path);
    const other = join(base, "other-operator");
    mkdirSync(other);
    const config = (operator: string) =>
      Buffer.from(
        JSON.stringify({
          operatorDirectory: operator,
          credentialDirectory: join(base, "credentials"),
          expectedAccountId: accountId,
          earlyScanDays: 0,
        })
      );
    const poll = vi.fn(async () => ({
      status: "captured",
      editionId: "2026-10-23",
    }));
    await expect(
      runFridayMailboxWake(root, config(other), 5000, {
        clock: () => observedAt,
        poll,
      })
    ).rejects.toThrow();
    expect(poll).not.toHaveBeenCalled();
    await expect(
      runFridayMailboxWake(root, config(operatorDirectory), 5000, {
        clock: () => observedAt,
        poll,
      })
    ).rejects.toThrow("FRIDAY_GMAIL_WORKER_REPORT_UNVERIFIED");
    expect(poll).toHaveBeenCalledTimes(1);
    expect(readCanonicalSqliteLedgerReadOnly(path)).toEqual(ledger);
    expect(ledger.ledger.runs).toHaveLength(0);
    expect(existsSync(join(root, "data/ingestion/weekly-editions.json"))).toBe(
      false
    );
  }, 60_000);
  it("forwards verified empty mailbox evidence at the exact missing-source deadline", async () => {
    const { root, base, operatorDirectory } = fixture();
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    await initializeLedger(operatorDirectory);
    const config = Buffer.from(
      JSON.stringify({
        operatorDirectory,
        credentialDirectory: join(base, "credentials"),
        expectedAccountId: accountId,
        earlyScanDays: 0,
      })
    );
    const due = Date.parse("2026-10-17T01:00:00.000Z");
    const wake = async (now: number, scannedThroughEpochMs: number) =>
      runFridayMailboxWake(root, config, 5000, {
        clock: () => now,
        poll: async () => ({
          status: "missing",
          editionId,
          attempts: 1,
          mailboxEvidence: {
            kind: "mailbox-scan",
            status: "absent",
            scannedThroughEpochMs,
          },
        }),
      });
    const exact = await wake(due, due);
    expect(exact).toMatchObject({
      status: "no-retained-source",
      mailboxStatus: "missing",
      missingSourceEvidence: {
        kind: "mailbox-scan",
        status: "absent",
        scannedThroughEpochMs: due,
      },
    });
    if (!("missingSourceEvidence" in exact) || !exact.missingSourceEvidence)
      throw Error("MISSING_FIXTURE_EVIDENCE");
    expect(
      planFridayMonitorNotice({
        editionId,
        nowEpochMs: due,
        maxEvidenceAgeMs: 0,
        evidence: exact.missingSourceEvidence,
      })
    ).toEqual({
      schemaVersion: 1,
      key: `friday/${editionId}/missing-source/${due}`,
      editionId,
      kind: "missing-source",
      dueAtEpochMs: due,
    });
    const early = await wake(due - 1, due - 1);
    if (!("missingSourceEvidence" in early) || !early.missingSourceEvidence)
      throw Error("MISSING_FIXTURE_EVIDENCE");
    expect(
      planFridayMonitorNotice({
        editionId,
        nowEpochMs: due - 1,
        maxEvidenceAgeMs: 0,
        evidence: early.missingSourceEvidence,
      })
    ).toBeNull();
    await expect(wake(due, due + 1)).rejects.toThrow(
      "FRIDAY_GMAIL_WORKER_REPORT_UNVERIFIED"
    );
  });

  it.each(["ready", "review-required"] as const)(
    "suppresses missing evidence for retained %s sources",
    async (mode) => {
      const { root, base, operatorDirectory } = fixture();
      vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
      await initializeLedger(operatorDirectory);
      await capture(operatorDirectory, "a1");
      if (mode === "review-required") {
        const review = await capture(
          operatorDirectory,
          "a2",
          editionText.replace("Fixture Band", "Other Fixture Band")
        );
        expect(review.disposition).toBe("review-required");
      }
      const due = Date.parse("2026-10-17T01:00:00.000Z");
      const result = await runFridayMailboxWake(
        root,
        Buffer.from(
          JSON.stringify({
            operatorDirectory,
            credentialDirectory: join(base, "credentials"),
            expectedAccountId: accountId,
            earlyScanDays: 0,
          })
        ),
        5000,
        {
          clock: () => due,
          poll: async () => ({
            status: "missing",
            editionId,
            attempts: 1,
            mailboxEvidence: {
              kind: "mailbox-scan",
              status: "absent",
              scannedThroughEpochMs: due,
            },
          }),
        }
      );
      expect(result).toMatchObject({
        mailboxStatus: "missing",
        status: mode === "ready" ? "loaded" : "attention-required",
      });
      expect(result).not.toHaveProperty("missingSourceEvidence");
    },
    60_000
  );

  it("withholds missing evidence when a signed batch still awaits capture", async () => {
    const { root, base, operatorDirectory } = fixture();
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    await initializeLedger(operatorDirectory);
    const { rawMessage, fullMessage } = syntheticMessage("a1");
    const wrongBody = Buffer.from(
      editionText
        .replace("Fixture Band", "Different Band")
        .replace(/\r?\n/g, "\r\n")
    );
    const fetcher: typeof fetch = async (request) => {
      const url = new URL(String(request));
      if (url.origin !== "https://gmail.googleapis.com")
        throw Error("UNEXPECTED_SYNTHETIC_ENDPOINT");
      if (url.pathname.endsWith("/profile"))
        return Response.json({ emailAddress: accountId });
      if (url.pathname.endsWith("/messages"))
        return Response.json({ messages: [{ id: "a1" }] });
      if (!url.pathname.endsWith("/messages/a1"))
        throw Error("UNEXPECTED_SYNTHETIC_ENDPOINT");
      return Response.json(
        url.searchParams.get("format") === "RAW"
          ? rawMessage
          : {
              id: "a1",
              internalDate: fullMessage.internal_date,
              payload: {
                mimeType: "text/plain",
                filename: "",
                headers: fullMessage.payload.headers,
                body: {
                  size: wrongBody.length,
                  data: wrongBody.toString("base64url"),
                },
              },
            }
      );
    };
    const receivedAt = Number(fullMessage.internal_date);
    const scope = {
      operatorDirectory,
      expectedAccountId: accountId,
      expectedEditionId: editionId,
    };
    await expect(
      captureSteveGmailWindow({
        ...scope,
        startEpochMs: receivedAt - 1000,
        endEpochMs: observedAt + 1,
        getAccessToken: async () => "synthetic-token",
        fetcher,
      })
    ).rejects.toThrow("GMAIL_MIME_TEXT_MISMATCH");
    expect(readSteveGmailHandoffStatus(scope).batches).toMatchObject([
      { status: "capture-pending" },
    ]);
    const due = Date.parse("2026-10-17T01:00:00.000Z");
    const outcome = await runFridayMailboxWake(
      root,
      Buffer.from(
        JSON.stringify({
          operatorDirectory,
          credentialDirectory: join(base, "credentials"),
          expectedAccountId: accountId,
          earlyScanDays: 0,
        })
      ),
      5000,
      {
        clock: () => due,
        poll: async () => ({
          status: "missing",
          editionId,
          attempts: 1,
          mailboxEvidence: {
            kind: "mailbox-scan",
            status: "absent",
            scannedThroughEpochMs: due,
          },
        }),
      }
    );
    expect(outcome).toMatchObject({
      status: "no-retained-source",
      mailboxStatus: "missing",
    });
    expect(outcome).not.toHaveProperty("missingSourceEvidence");
    expect(readSteveGmailHandoffStatus(scope).batches).toMatchObject([
      { status: "capture-pending" },
    ]);
  }, 60_000);

  it("withholds review-required receipts and never creates a load run for them", async () => {
    const { root, operatorDirectory } = fixture();
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    await initializeLedger(operatorDirectory);
    const ready = await capture(operatorDirectory, "a2");
    const reviewRequired = await capture(
      operatorDirectory,
      "a3",
      editionText.replace("Fixture Band", "Other Fixture Band")
    );

    expect(ready.disposition).toBe("ready");
    expect(reviewRequired.disposition).toBe("review-required");
    const result = await loadRetainedSteveEmailSources({
      root,
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
    });
    const ledger = await loadLedger(join(root, "data/ingestion/ledger.json"));
    const withheld = result.entries.find(
      (entry) => entry.receiptId === reviewRequired.receipt.receiptId
    );
    const loaded = result.entries.find(
      (entry) => entry.receiptId === ready.receipt.receiptId
    );

    expect(result.counts).toMatchObject({
      ready: 1,
      reviewRequired: 1,
      loaded: 1,
    });
    expect(withheld).toEqual({
      receiptId: reviewRequired.receipt.receiptId,
      disposition: "review-required",
    });
    expect(loaded?.disposition).toBe("loaded");
    expect(ledger.runs).toHaveLength(1);
    expect(ledger.runs[0]?.runId).toMatch(
      new RegExp(`^${CURRENT_STEVE_IMPORTER}-`)
    );
    expect(loaded?.runId).toEqual(expect.any(String));
  }, 30_000);

  it("refuses a physically different operator store before creating intake or ledger effects", async () => {
    const { root, base, operatorDirectory } = fixture();
    vi.stubEnv("ZIVV_LEDGER_HOME", operatorDirectory);
    await initializeLedger(operatorDirectory);
    const otherOperator = join(base, "other-operator");
    mkdirSync(otherOperator);
    const ledgerPath = join(operatorDirectory, "ledger.sqlite");
    const originalLedgerBytes = readFileSync(ledgerPath);

    await expect(
      loadRetainedSteveEmailSources({
        root,
        operatorDirectory: otherOperator,
        accountId,
        expectedEditionId: editionId,
      })
    ).rejects.toMatchObject({
      name: "SteveEmailLoadError",
      code: "OPERATOR_STORE_MISMATCH",
      message: "OPERATOR_STORE_MISMATCH",
    } satisfies Partial<SteveEmailLoadError>);
    expect(readFileSync(ledgerPath).equals(originalLedgerBytes)).toBe(true);
    expect(existsSync(join(operatorDirectory, "weekly-runs.sqlite"))).toBe(
      false
    );
    expect(existsSync(join(otherOperator, "weekly-runs.sqlite"))).toBe(false);
  });
});
