import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { vi } from "vitest";
import { loadBackupKey } from "../../../lib/ingestion/encrypted-backup.js";
import { proveRecoveryGmailBatchInventory } from "../../../lib/ingestion/recovery-gmail-batch-proof.js";
import {
  captureSteveGmailWindow,
  replaySteveGmailBatch,
} from "../../../lib/ingestion/steve-gmail-handoff.js";
import { sha256 } from "../../../lib/ingestion/steve-preflight.js";
import {
  readWeeklyJournalRecoverySnapshotReadOnly,
  WeeklyRunJournal,
} from "../../../lib/ingestion/weekly-run-journal.js";
import type { RecoveryGmailCaptureDeltaInput } from "../../../lib/ingestion/recovery-gmail-capture-admission-proof.js";

type Checkpoint = RecoveryGmailCaptureDeltaInput["checkpoint"];
type Inventory = RecoveryGmailCaptureDeltaInput["current"];
const editionBodies: Array<{
  edition: string;
  account: string;
  id: string;
  receivedAtEpochMs: number;
  body: string;
}> = [
  {
    edition: "2026-10-16",
    account: "capture-admission@fixture.invalid",
    id: "a1",
    receivedAtEpochMs: Date.parse("2026-10-16T17:00:00.000Z"),
    body: "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\nSynthetic fixture source A\n",
  },
  {
    edition: "2026-10-16",
    account: "capture-admission@fixture.invalid",
    id: "b1",
    receivedAtEpochMs: Date.parse("2026-10-16T17:10:00.000Z"),
    body: "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\nSynthetic fixture source B\n",
  },
  {
    edition: "2026-10-16",
    account: "capture-admission-second@fixture.invalid",
    id: "c1",
    receivedAtEpochMs: Date.parse("2026-10-16T17:20:00.000Z"),
    body: "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\nSynthetic fixture source C\n",
  },
];

function message(
  edition: string,
  id: string,
  received: number,
  bodyText: string
) {
  const date = new Date(received - 7 * 60 * 60 * 1000)
    .toUTCString()
    .replace(" GMT", " -0700");
  const headers = [
    "From: Steve Fixture <skoepke@stevelist.com>",
    "Sender: noreply@sp.eocampaign1.com",
    `Date: ${date}`,
    `Subject: Steve's List ${edition}`,
    `Message-ID: <${id}@fixture.invalid>`,
    "Authentication-Results: mx.google.com; dkim=pass header.i=@sp.eocampaign1.com; spf=pass smtp.mailfrom=bounce@sp.eocampaign1.com",
    "DKIM-Signature: v=1; a=rsa-sha256; d=sp.eocampaign1.com; s=fixture; h=from:sender:subject:date; bh=c3ludGhldGlj; b=c3ludGhldGlj",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
  ];
  const body = Buffer.from(bodyText.replace(/\r?\n/g, "\r\n"));
  const raw = Buffer.concat([
    Buffer.from(`${headers.join("\r\n")}\r\n\r\n`),
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

function fetcherFor(
  item: ReturnType<typeof message>,
  account: string,
  duplicate?: ReturnType<typeof message>
): typeof fetch {
  const messages = duplicate ? [item, duplicate] : [item];
  return async (request) => {
    const url = new URL(
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.href
          : request.url
    );
    const root = "/gmail/v1/users/me";
    if (url.origin !== "https://gmail.googleapis.com")
      throw new Error("Unexpected synthetic Gmail origin");
    if (url.pathname === `${root}/profile`)
      return Response.json({ emailAddress: account });
    if (url.pathname === `${root}/messages`)
      return Response.json({ messages: messages.map(({ id }) => ({ id })) });
    const found = messages.find(
      (value) => url.pathname === `${root}/messages/${value.id}`
    );
    if (!found) throw new Error("Unexpected synthetic Gmail message");
    return Response.json(
      url.searchParams.get("format") === "FULL" ? found.full : found.raw
    );
  };
}

function inventory(operator: string, createdAtEpochMs: number): Checkpoint {
  const value: Checkpoint = {
    originalOperatorDirectory: operator,
    createdAtEpochMs,
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
      const child = `${path}/${entry.name}`;
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
  if (readdirSync(operator).includes("email-intake")) walk("email-intake");
  return value;
}

function cleanupRoot(root: string, setupError?: unknown): void {
  try {
    const suffix = relative(resolve(tmpdir()), resolve(root));
    if (
      !suffix.startsWith("zivv-capture-admission-") ||
      suffix.includes("..") ||
      suffix.includes("\\") ||
      suffix.includes("/")
    )
      throw new Error("Unsafe capture-admission fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if (setupError !== undefined)
      throw new AggregateError(
        [setupError, error],
        "Fixture setup and cleanup failed",
        { cause: setupError }
      );
    throw error;
  }
}

export interface RecoveryGmailCaptureAdmissionFixture {
  checkpoint: Checkpoint;
  recoveryKey: Buffer;
  batchIds: [string, string];
  completedBatchId: string;
  approvedCheckpoint?: Checkpoint;
  correctionOfByMessageId: Record<string, string>;
  admittedAtEpochMs: number;
  secondAdmittedAtEpochMs: number;
  currentAfterFirstCapture: Inventory;
  currentAfterCapture: Inventory;
  sourceJournalOnly: Inventory;
  physicalRoot: string;
  physicalOperatorDirectory: string;
  cleanup(): void;
}

/** Build two real signed Gmail batches and their deterministic journal-first capture states in a private temp directory. */
export async function createRecoveryGmailCaptureAdmissionFixture(
  options: {
    firstBody?: string;
    reviewFirstCorrection?: boolean;
    duplicateOriginal?: boolean;
    approveReviewBeforeCheckpoint?: boolean;
  } = {}
): Promise<RecoveryGmailCaptureAdmissionFixture> {
  const root = mkdtempSync(join(tmpdir(), "zivv-capture-admission-"));
  const operator = join(root, "operator");
  mkdirSync(operator);
  const clockBase = Date.parse("2026-10-16T17:30:00.000Z");
  let now = clockBase;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  let setupError: unknown;
  try {
    const recoveryKey = loadBackupKey(operator, true);
    const originalSave = WeeklyRunJournal.prototype.saveIntakeEvidence;
    for (const item of editionBodies) {
      const email = message(
        item.edition,
        item.id,
        item.receivedAtEpochMs,
        item === editionBodies[0] && options.firstBody
          ? options.firstBody
          : item.body
      );
      const interruptAcquisition =
        item === editionBodies[0]
          ? undefined
          : vi
              .spyOn(WeeklyRunJournal.prototype, "saveIntakeEvidence")
              .mockImplementation(function (
                this: WeeklyRunJournal,
                kind,
                id,
                bytes,
                lease
              ) {
                if (kind === "source")
                  throw new Error("FIXTURE_PENDING_BATCH_INTERRUPTION");
                return originalSave.call(this, kind, id, bytes, lease);
              });
      try {
        await captureSteveGmailWindow({
          operatorDirectory: operator,
          expectedAccountId: item.account,
          expectedEditionId: item.edition,
          startEpochMs: item.receivedAtEpochMs - 60_000,
          endEpochMs: item.receivedAtEpochMs + 60_000,
          getAccessToken: async () => "synthetic_fixture_token",
          fetcher: fetcherFor(
            email,
            item.account,
            options.duplicateOriginal && item === editionBodies[0]
              ? message(item.edition, "a2", item.receivedAtEpochMs, item.body)
              : undefined
          ),
        });
        if (interruptAcquisition)
          throw new Error("Expected pending-batch interruption");
      } catch (error) {
        if (interruptAcquisition) {
          if (
            !(error instanceof Error) ||
            !error.message.includes("FIXTURE_PENDING_BATCH_INTERRUPTION")
          )
            throw error;
        } else throw error;
      } finally {
        interruptAcquisition?.mockRestore();
      }
      now += 1_000;
    }
    const createdAtEpochMs = now;
    const checkpoint = inventory(operator, createdAtEpochMs);
    const batches = proveRecoveryGmailBatchInventory({
      checkpoint,
      recoveryKey,
    }).batches;
    const batchByMessage = new Map(
      batches.map(({ batch }) => [
        batch.snapshots[0]!.rawMessage.id,
        batch.batchId,
      ])
    );
    const completedBatchId = batchByMessage.get(editionBodies[0]!.id);
    const firstBatchId = batchByMessage.get(editionBodies[1]!.id);
    const secondBatchId = batchByMessage.get(editionBodies[2]!.id);
    if (!completedBatchId || !firstBatchId || !secondBatchId)
      throw new Error(
        "Expected one captured predecessor and two pending batches"
      );
    const batchIds: [string, string] = [firstBatchId, secondBatchId];
    const predecessor = batches
      .find(({ batch }) => batch.batchId === completedBatchId)!
      .messages.find(({ messageId }) => messageId === editionBodies[0]!.id);
    if (!predecessor || predecessor.status !== "captured")
      throw new Error("Expected a captured same-account predecessor receipt");
    const correctionOfByMessageId = {
      [editionBodies[1]!.id]: predecessor.receiptId,
    };
    const admittedAtEpochMs = createdAtEpochMs + 1_000;
    now = admittedAtEpochMs + 1_000;
    const interrupt = vi
      .spyOn(WeeklyRunJournal.prototype, "saveIntakeEvidence")
      .mockImplementation(function (
        this: WeeklyRunJournal,
        kind,
        id,
        bytes,
        lease
      ) {
        const saved = originalSave.call(this, kind, id, bytes, lease);
        if (kind === "source") throw new Error("FIXTURE_SOURCE_JOURNAL_ONLY");
        return saved;
      });
    let sourceJournalOnly: Inventory;
    try {
      await replaySteveGmailBatch({
        operatorDirectory: operator,
        expectedAccountId: editionBodies[1]!.account,
        expectedEditionId: editionBodies[0]!.edition,
        batchId: batchIds[0],
        ...(options.reviewFirstCorrection ? {} : { correctionOfByMessageId }),
      });
      throw new Error("Expected source journal-only interruption");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("FIXTURE_SOURCE_JOURNAL_ONLY")
      )
        throw error;
      sourceJournalOnly = inventory(operator, createdAtEpochMs);
    } finally {
      interrupt.mockRestore();
    }
    now += 1_000;
    await replaySteveGmailBatch({
      operatorDirectory: operator,
      expectedAccountId: editionBodies[0]!.account,
      expectedEditionId: editionBodies[0]!.edition,
      batchId: batchIds[0],
      ...(options.reviewFirstCorrection ? {} : { correctionOfByMessageId }),
    });
    const currentAfterFirstCapture = inventory(operator, createdAtEpochMs);
    let approvedCheckpoint: Checkpoint | undefined;
    if (options.approveReviewBeforeCheckpoint) {
      if (!options.reviewFirstCorrection)
        throw new Error("Approval scenario requires a review receipt");
      now += 1_000;
      await replaySteveGmailBatch({
        operatorDirectory: operator,
        expectedAccountId: editionBodies[0]!.account,
        expectedEditionId: editionBodies[0]!.edition,
        batchId: batchIds[0],
        correctionOfByMessageId,
      });
      approvedCheckpoint = inventory(operator, now);
    }
    const secondAdmittedAtEpochMs = now + 1_000;
    now = secondAdmittedAtEpochMs + 1_000;
    await replaySteveGmailBatch({
      operatorDirectory: operator,
      expectedAccountId: editionBodies[2]!.account,
      expectedEditionId: editionBodies[1]!.edition,
      batchId: batchIds[1],
    });
    const currentAfterCapture = inventory(operator, createdAtEpochMs);
    return {
      checkpoint,
      recoveryKey,
      batchIds,
      completedBatchId,
      ...(approvedCheckpoint ? { approvedCheckpoint } : {}),
      correctionOfByMessageId,
      admittedAtEpochMs,
      secondAdmittedAtEpochMs,
      currentAfterFirstCapture,
      currentAfterCapture,
      sourceJournalOnly,
      physicalRoot: root,
      physicalOperatorDirectory: operator,
      cleanup: () => cleanupRoot(root),
    };
  } catch (error) {
    setupError = new AggregateError(
      [error],
      `Fixture setup failed; private fixture retained at ${root}`,
      { cause: error }
    );
    throw setupError;
  } finally {
    clock.mockRestore();
    if (setupError === undefined) cleanupRoot(root);
  }
}
