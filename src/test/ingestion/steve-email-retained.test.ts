import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureSteveEmail,
  listRetainedSteveEmailSources,
} from "../../lib/ingestion/steve-email-intake.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  validateWeeklyJournalRecoverySnapshot,
} from "../../lib/ingestion/weekly-run-journal.js";

const accountId = "synthetic-account@fixture.invalid";
const editionId = "2026-10-16";
const observedAt = Date.parse("2026-10-16T17:05:00Z");
const roots: string[] = [];

const editionText =
  "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\nSynthetic Artist at Fixture Club\n";

function message(id: string, text = editionText) {
  const raw = Buffer.from(
    [
      `From: Steve Fixture <skoepke@stevelist.com>`,
      "Sender: noreply@sp.eocampaign1.com",
      "Date: Fri, 16 Oct 2026 10:00:00 -0700",
      "Subject: Steve's List 10/16/2026",
      `Message-ID: <${id}@fixture.invalid>`,
      "Authentication-Results: mx.google.com; dkim=pass header.i=@sp.eocampaign1.com; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com",
      "DKIM-Signature: v=1; a=rsa-sha256; d=sp.eocampaign1.com; s=fixture; h=from:sender:subject:date; bh=c3ludGhldGlj; b=c3ludGhldGlj",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      text.replace(/\r?\n/g, "\r\n"),
    ].join("\r\n")
  );
  const body = Buffer.from(text.replace(/\r?\n/g, "\r\n"));
  const headers = [
    ["From", "Steve Fixture <skoepke@stevelist.com>"],
    ["Sender", "noreply@sp.eocampaign1.com"],
    ["Date", "Fri, 16 Oct 2026 10:00:00 -0700"],
    ["Subject", "Steve's List 10/16/2026"],
    ["Message-ID", `<${id}@fixture.invalid>`],
    [
      "Authentication-Results",
      "mx.google.com; dkim=pass header.i=@sp.eocampaign1.com; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com",
    ],
    [
      "DKIM-Signature",
      "v=1; a=rsa-sha256; d=sp.eocampaign1.com; s=fixture; h=from:sender:subject:date; bh=c3ludGhldGlj; b=c3ludGhldGlj",
    ],
  ].map(([name, value]) => ({ name, value }));
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
  const root = mkdtempSync(join(tmpdir(), "zivv-retained-email-"));
  roots.push(root);
  return { root, operatorDirectory: join(root, "operator") };
}

async function capture(
  operatorDirectory: string,
  id = "a1",
  text?: string,
  correctionOf?: string
) {
  return captureSteveEmail({
    operatorDirectory,
    accountId,
    ...message(id, text),
    expectedEditionId: editionId,
    observedAtEpochMs: observedAt,
    ...(correctionOf ? { correctionOf } : {}),
  });
}

function bodyDirectory(operatorDirectory: string, receiptId: string) {
  return join(
    operatorDirectory,
    "email-intake",
    sha256(accountId),
    "bodies",
    receiptId
  );
}

function inventory(path: string): string[] {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  return entries.flatMap((entry) => {
    const child = join(path, entry.name);
    const stat = lstatSync(child);
    const own = `${child}|${stat.mode}|${stat.size}|${stat.mtimeMs}`;
    if (entry.isDirectory() && !entry.isSymbolicLink())
      return [own, ...inventory(child)];
    if (entry.isFile() && !entry.isSymbolicLink())
      return [`${own}|${sha256(readFileSync(child))}`];
    return [own];
  });
}

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(observedAt));
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), "zivv-retained-email-")))
      throw new Error("Unsafe retained-source fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("read-only retained Steve email lookup", () => {
  it("returns detached ready sources, including an explicitly approved correction, and supports replay", async () => {
    const { operatorDirectory } = fixture();
    const first = await capture(operatorDirectory);
    const replay = await capture(operatorDirectory);
    expect(replay.receipt.firstObservedAtEpochMs).toBe(
      first.receipt.firstObservedAtEpochMs
    );
    const corrected = await capture(
      operatorDirectory,
      "a2",
      "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\nCorrected synthetic show\n",
      first.receipt.receiptId
    );
    const found = listRetainedSteveEmailSources({
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
    });
    expect(found.map(({ receipt }) => receipt.receiptId)).toEqual([
      first.receipt.receiptId,
      corrected.receipt.receiptId,
    ]);
    expect(found.map(({ receipt }) => receipt.disposition)).toEqual([
      "ready",
      "ready",
    ]);
    expect(found[1]?.receipt.correctionOf).toBe(first.receipt.receiptId);
    found[0]!.source.fill(0);
    expect(
      listRetainedSteveEmailSources({
        operatorDirectory,
        accountId,
        expectedEditionId: editionId,
      })[0]?.source.toString("utf8")
    ).toContain("Synthetic Artist");
  });

  it("converges distinct Gmail IDs with the same source to one retained receipt", async () => {
    const { operatorDirectory } = fixture();
    const first = await capture(operatorDirectory, "a1");
    const duplicate = await capture(operatorDirectory, "b2");
    expect(duplicate.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(duplicate.receipt.firstObservedAtEpochMs).toBe(
      first.receipt.firstObservedAtEpochMs
    );
    const found = listRetainedSteveEmailSources({
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(found[0]?.source.toString("utf8")).toContain("Synthetic Artist");
  });

  it("preserves the journal and intake tree while allowing SQLite WAL/SHM coordination", async () => {
    const { operatorDirectory } = fixture();
    await capture(operatorDirectory);
    const journalPath = join(operatorDirectory, "weekly-runs.sqlite");
    const mainBefore = readFileSync(journalPath);
    const mainMtimeBefore = lstatSync(journalPath).mtimeMs;
    const before = inventory(operatorDirectory).filter(
      (entry) =>
        !entry.includes("weekly-runs.sqlite-wal|") &&
        !entry.includes("weekly-runs.sqlite-shm|")
    );
    const first = listRetainedSteveEmailSources({
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
    });
    const snapshotAfterFirst = validateWeeklyJournalRecoverySnapshot(
      readWeeklyJournalRecoverySnapshotReadOnly(journalPath)
    );
    listRetainedSteveEmailSources({
      operatorDirectory,
      accountId,
      expectedEditionId: editionId,
    });
    const snapshotAfterSecond = validateWeeklyJournalRecoverySnapshot(
      readWeeklyJournalRecoverySnapshotReadOnly(journalPath)
    );
    const after = inventory(operatorDirectory).filter(
      (entry) =>
        !entry.includes("weekly-runs.sqlite-wal|") &&
        !entry.includes("weekly-runs.sqlite-shm|")
    );
    expect(after).toEqual(before);
    expect(readFileSync(journalPath)).toEqual(mainBefore);
    expect(lstatSync(journalPath).mtimeMs).toBe(mainMtimeBefore);
    expect(snapshotAfterSecond).toEqual(snapshotAfterFirst);
    expect(first).toHaveLength(1);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = journalPath + suffix;
      if (existsSync(sidecar) && suffix === "-wal")
        expect(lstatSync(sidecar).size).toBe(0);
    }
  });

  it("returns empty for a missing pristine store without creating it", () => {
    const { operatorDirectory } = fixture();
    expect(
      listRetainedSteveEmailSources({
        operatorDirectory,
        accountId,
        expectedEditionId: editionId,
      })
    ).toEqual([]);
    expect(existsSync(operatorDirectory)).toBe(false);
  });

  it.each(["-wal", "-shm"] as const)(
    "refuses a missing journal with an existing %s sidecar without changing it",
    (suffix) => {
      const { operatorDirectory } = fixture();
      mkdirSync(operatorDirectory);
      const journalPath = join(operatorDirectory, "weekly-runs.sqlite");
      const sidecar = journalPath + suffix;
      const bytes = Buffer.from("pending synthetic SQLite sidecar");
      writeFileSync(sidecar, bytes);
      const mtime = lstatSync(sidecar).mtimeMs;
      expect(() =>
        listRetainedSteveEmailSources({
          operatorDirectory,
          accountId,
          expectedEditionId: editionId,
        })
      ).toThrow(/PENDING_STEVE_EMAIL_INTAKE/);
      expect(readFileSync(sidecar)).toEqual(bytes);
      expect(lstatSync(sidecar).mtimeMs).toBe(mtime);
      expect(existsSync(journalPath)).toBe(false);
    }
  );

  it.each(["source", "raw"] as const)(
    "refuses tampered %s bytes",
    async (kind) => {
      const { operatorDirectory } = fixture();
      const result = await capture(operatorDirectory);
      const body = bodyDirectory(operatorDirectory, result.receipt.receiptId);
      const target =
        kind === "source"
          ? join(body, "source.txt")
          : join(
              operatorDirectory,
              "email-intake",
              sha256(accountId),
              "messages",
              sha256(result.receipt.messageId),
              "message.eml"
            );
      writeFileSync(
        target,
        Buffer.concat([readFileSync(target), Buffer.from("tamper")])
      );
      expect(() =>
        listRetainedSteveEmailSources({
          operatorDirectory,
          accountId,
          expectedEditionId: editionId,
        })
      ).toThrow(/CHANGED_INTAKE_(TEXT|MIME)/);
    }
  );

  it("refuses altered approval evidence and linked source files", async () => {
    const { operatorDirectory, root } = fixture();
    const first = await capture(operatorDirectory);
    const corrected = await capture(
      operatorDirectory,
      "a2",
      "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\nCorrected synthetic show\n",
      first.receipt.receiptId
    );
    const approval = join(
      bodyDirectory(operatorDirectory, corrected.receipt.receiptId),
      "correction-approval.json"
    );
    writeFileSync(approval, Buffer.from("{}\n"));
    expect(() =>
      listRetainedSteveEmailSources({
        operatorDirectory,
        accountId,
        expectedEditionId: editionId,
      })
    ).toThrow(/INTAKE_EVIDENCE_CHANGED|CHANGED_CORRECTION_APPROVAL/);

    const linkedOperator = join(root, "linked-operator");
    symlinkSync(operatorDirectory, linkedOperator, "junction");
    expect(() =>
      listRetainedSteveEmailSources({
        operatorDirectory: linkedOperator,
        accountId,
        expectedEditionId: editionId,
      })
    ).toThrow(/UNSAFE_INTAKE_DIRECTORY/);
  });

  it("refuses unindexed body directories and incomplete journal snapshots", async () => {
    const { operatorDirectory } = fixture();
    const result = await capture(operatorDirectory);
    const bodyRoot = join(
      operatorDirectory,
      "email-intake",
      sha256(accountId),
      "bodies"
    );
    const orphan = join(bodyRoot, "f".repeat(64));
    writeFileSync(
      join(
        bodyDirectory(operatorDirectory, result.receipt.receiptId),
        "source.txt"
      ),
      "removed"
    );
    expect(() =>
      listRetainedSteveEmailSources({
        operatorDirectory,
        accountId,
        expectedEditionId: editionId,
      })
    ).toThrow(/CHANGED_INTAKE_TEXT/);
    rmSync(
      join(
        bodyDirectory(operatorDirectory, result.receipt.receiptId),
        "source.txt"
      )
    );
    rmSync(
      join(
        bodyDirectory(operatorDirectory, result.receipt.receiptId),
        "receipt.json"
      )
    );
    // Removing a committed body record is a partial capture, not an empty inbox.
    expect(() =>
      listRetainedSteveEmailSources({
        operatorDirectory,
        accountId,
        expectedEditionId: editionId,
      })
    ).toThrow();
    // Keep a deliberately unindexed nonempty body tree for the no-journal case.
    rmSync(join(operatorDirectory, "weekly-runs.sqlite"), { force: true });
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "source.txt"), "orphan fixture\n");
    expect(() =>
      listRetainedSteveEmailSources({
        operatorDirectory,
        accountId,
        expectedEditionId: editionId,
      })
    ).toThrow(/PENDING_STEVE_EMAIL_INTAKE/);
  });
});
