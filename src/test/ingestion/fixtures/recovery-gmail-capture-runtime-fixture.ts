import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { vi } from "vitest";
import {
  loadBackupKey,
  secureOperatorDirectory,
} from "../../../lib/ingestion/encrypted-backup.js";
import { bootstrapLedger } from "../../../lib/ingestion/ledger.js";
import { retireAndCaptureOperatorRecovery } from "../../../lib/ingestion/operator-recovery.js";
import { prepareOperatorRecoveryRuntime } from "../../../lib/ingestion/recovery-runtime.js";
import { writeSqliteLedger } from "../../../lib/ingestion/sqlite-store.js";
import { listRetainedSteveEmailSources } from "../../../lib/ingestion/steve-email-intake.js";
import {
  captureSteveGmailWindow,
  readAuthenticatedSteveGmailBatches,
  replaySteveGmailBatch,
} from "../../../lib/ingestion/steve-gmail-handoff.js";
import { WeeklyRunJournal } from "../../../lib/ingestion/weekly-run-journal.js";
import { createRecoveryGmailCaptureProbeControls } from "../../../lib/ingestion/recovery-gmail-capture-probe-controls.js";
import type { RecoveryRuntimeInput } from "../../../lib/ingestion/recovery-runtime.js";

const account = "capture-runtime@fixture.invalid";
const interruption = "CAPTURE_RUNTIME_FIXTURE_PENDING_SOURCE";

export interface RecoveryGmailCaptureRuntimeFixture {
  input: RecoveryRuntimeInput;
  batchIds: string[];
  base: string;
  sourceReceipts: ReturnType<typeof listRetainedSteveEmailSources>;
  cleanup(preserve: boolean): void;
}

function write(path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function nextFriday(now: number): { editionId: string; titleDate: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)!.value;
  const date = new Date(
    Date.UTC(
      Number(part("year")),
      Number(part("month")) - 1,
      Number(part("day")),
      12
    )
  );
  const offset = (5 - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + offset);
  const editionId = date.toISOString().slice(0, 10);
  const titleDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
  return { editionId, titleDate };
}

function fixtureMessage(
  id: string,
  receivedAtEpochMs: number,
  bodyText: string
) {
  const date = new Date(receivedAtEpochMs).toUTCString();
  const headers = [
    "From: Steve Fixture <skoepke@stevelist.com>",
    "Sender: noreply@sp.eocampaign1.com",
    `Date: ${date}`,
    "Subject: Steve's List fixture",
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
      internalDate: String(receivedAtEpochMs),
      payload: {
        mimeType: "text/plain",
        filename: "",
        headers: headers.map((header) => {
          const separator = header.indexOf(":");
          return {
            name: header.slice(0, separator),
            value: header.slice(separator + 1).trim(),
          };
        }),
        body: { size: body.length, data: body.toString("base64url") },
      },
    },
  };
}

function fakeGmail(
  messages: ReturnType<typeof fixtureMessage>[]
): typeof fetch {
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
    const item = messages.find(
      ({ id }) => url.pathname === `${root}/messages/${id}`
    );
    if (!item) throw new Error("Unexpected synthetic Gmail message");
    return Response.json(
      url.searchParams.get("format") === "FULL" ? item.full : item.raw
    );
  };
}

function cleanupFixture(base: string, preserve: boolean): void {
  if (preserve) return;
  const suffix = relative(resolve(tmpdir()), resolve(base));
  if (
    !suffix.startsWith("zivv-recovery-gmail-capture-runtime-") ||
    suffix.includes("..") ||
    suffix.includes("\\") ||
    suffix.includes("/")
  )
    throw new Error("Unsafe recovery Gmail capture fixture cleanup");
  rmSync(base, { recursive: true, force: true });
}

function assertOwnedDirectory(base: string, target: string): string {
  const root = resolve(base);
  const path = resolve(target);
  const suffix = relative(root, path);
  if (
    !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
  )
    throw new Error("Unsafe recovery Gmail capture fixture removal");
  return path;
}

/** Prepare an offline retained worker, normally with one captured and one pending
 * message. The optional review mode normally replays the second message before
 * retirement so recovery can exercise explicit approval of an existing receipt. */
export async function createRecoveryGmailCaptureRuntimeFixture(
  options: {
    reviewSecondMessage?: boolean;
    seedAuthorityControls?: boolean;
  } = {}
): Promise<RecoveryGmailCaptureRuntimeFixture> {
  const base = mkdtempSync(
    join(tmpdir(), "zivv-recovery-gmail-capture-runtime-")
  );
  const root = join(base, "original checkout");
  const operator = join(base, "original operator");
  const tool = join(base, "original npm");
  const npmCli = join(tool, "bin/npm-cli.js");
  mkdirSync(root, { recursive: true });
  mkdirSync(operator, { recursive: true });
  mkdirSync(tool, { recursive: true });

  try {
    vi.stubEnv("ZIVV_LEDGER_HOME", operator);
    for (const path of [
      "package.json",
      "package-lock.json",
      "dist/lib",
      "dist/types",
      "dist/utils",
    ])
      cpSync(resolve(path), join(root, path), { recursive: true });
    write(
      join(root, "data/ingestion/store.json"),
      '{"schemaVersion":1,"backend":"sqlite","namespace":"zivv"}'
    );
    await writeSqliteLedger(
      join(operator, "ledger.sqlite"),
      bootstrapLedger({ events: [], artists: [], venues: [] }, Date.now()),
      true
    );
    const recoveryKey = loadBackupKey(operator, true);
    // Synthetic fixture evidence remains decryptable if a failed test preserves
    // this private directory after deleting the original operator installation.
    secureOperatorDirectory(base);
    writeFileSync(
      join(base, "fixture-recovery-key.base64"),
      recoveryKey.toString("base64") + "\n",
      { mode: 0o600, flag: "wx" }
    );

    cpSync(
      resolve("node_modules/postal-mime"),
      join(tool, "node_modules/postal-mime"),
      { recursive: true }
    );
    write(
      join(tool, "package.json"),
      '{"name":"npm","version":"11.6.0","type":"module"}\n'
    );
    write(
      npmCli,
      `import {cpSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.argv[2]==='--version') console.log('11.6.0'); else {
 const modules=join(process.cwd(),'node_modules'); mkdirSync(modules);
 cpSync(resolve(dirname(fileURLToPath(import.meta.url)),'../node_modules/postal-mime'),join(modules,'postal-mime'),{recursive:true});
}\n`
    );

    const now = Date.now();
    const { editionId, titleDate } = nextFriday(now);
    const firstReceived = now - 60_000;
    const secondReceived = now - 30_000;
    const body = (label: string) =>
      `THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest ${titleDate}\nSynthetic ${label} capture fixture\n`;
    const messages = [
      fixtureMessage("a1", firstReceived, body("completed")),
      fixtureMessage("b1", secondReceived, body("pending")),
    ];

    const originalSave = WeeklyRunJournal.prototype.saveIntakeEvidence;
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
            .messageId === "b1"
        ) {
          interrupted = true;
          throw new Error(interruption);
        }
        return originalSave.call(this, kind, id, bytes, lease);
      });
    try {
      await captureSteveGmailWindow({
        operatorDirectory: operator,
        expectedAccountId: account,
        expectedEditionId: editionId,
        startEpochMs: firstReceived - 1_000,
        endEpochMs: now,
        getAccessToken: async () => "synthetic_fixture_token",
        fetcher: fakeGmail(messages),
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(interruption))
        throw error;
    } finally {
      hook.mockRestore();
    }
    if (!interrupted)
      throw new Error("Expected pending Gmail source interruption");

    if (options.reviewSecondMessage) {
      // Replay the authenticated saved batch through ordinary intake without a
      // correction choice. Its second body is genuinely retained for review;
      // recovery can later approve it while preserving its original source row.
      const batch = readAuthenticatedSteveGmailBatches({
        operatorDirectory: operator,
      })[0];
      if (!batch) throw new Error("Expected retained Gmail batch");
      const replay = await replaySteveGmailBatch({
        operatorDirectory: operator,
        batchId: batch.batchId,
        expectedAccountId: account,
        expectedEditionId: editionId,
      });
      if (replay.status !== "captured")
        throw new Error("Expected normal capture of the review-only message");
    }

    const sourceReceipts = listRetainedSteveEmailSources({
      operatorDirectory: operator,
      accountId: account,
      expectedEditionId: editionId,
    });
    if (
      sourceReceipts.length !== (options.reviewSecondMessage ? 2 : 1) ||
      !sourceReceipts.some(({ receipt }) => receipt.messageId === "a1") ||
      (options.reviewSecondMessage &&
        !sourceReceipts.some(
          ({ receipt }) =>
            receipt.messageId === "b1" &&
            receipt.disposition === "review-required"
        ))
    )
      throw new Error("Unexpected captured/review-only Gmail fixture sources");
    const batchDirectory = join(operator, "email-acquisition/batches");
    const batchIds = readdirSync(batchDirectory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => name.slice(0, -5));

    if (options.seedAuthorityControls) {
      // Ordinary production journal APIs establish the valid running control
      // before retirement. The retained probe may refuse its next transition;
      // it must not pass merely because the run or artifact attempt is invalid.
      const controls = createRecoveryGmailCaptureProbeControls();
      const journal = new WeeklyRunJournal(operator);
      try {
        const lease = journal.acquire("prodigic/zivv/production", 60_000);
        try {
          journal.create(
            controls.seed.initialState,
            lease,
            controls.seed.rawSource
          );
          journal.save(
            controls.seed.runningState,
            controls.seed.initialState.revision,
            lease
          );
        } finally {
          journal.release(lease);
        }
      } finally {
        journal.close();
      }
    }

    const out = join(base, "retired-operator.enc");
    await retireAndCaptureOperatorRecovery({ root, out, npmCli });
    const archive = readFileSync(out);
    const retirementReceipt = readFileSync(`${out}.retirement.json`);
    const replacement = join(base, "relocated npm");
    cpSync(tool, replacement, { recursive: true });
    const ownedRoot = assertOwnedDirectory(base, root);
    const ownedOperator = assertOwnedDirectory(base, operator);
    const ownedTool = assertOwnedDirectory(base, tool);
    rmSync(ownedRoot, { recursive: true, force: true });
    rmSync(ownedOperator, { recursive: true, force: true });
    rmSync(ownedTool, { recursive: true, force: true });

    const input: RecoveryRuntimeInput = {
      archive,
      retirementReceipt,
      recoveryKey,
      destination: join(base, "prepared runtime"),
      npmCli: join(replacement, "bin/npm-cli.js"),
    };
    await prepareOperatorRecoveryRuntime(input);
    return {
      input,
      batchIds,
      base,
      sourceReceipts,
      cleanup: (preserve) => cleanupFixture(base, preserve),
    };
  } catch (error) {
    throw new Error(
      `Recovery Gmail capture runtime fixture failed; retained artifacts at ${base}`,
      { cause: error }
    );
  } finally {
    vi.unstubAllEnvs();
  }
}
