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
} from "../../lib/ingestion/sqlite-store.js";
import {
  loadRetainedSteveEmailSources,
  SteveEmailLoadError,
} from "../../lib/ingestion/steve-email-load.js";
import { CURRENT_STEVE_IMPORTER } from "../../lib/ingestion/steve-import-review.js";

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
