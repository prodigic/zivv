import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadBackupKey } from "../../lib/ingestion/encrypted-backup.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import { retireAndCaptureOperatorRecovery } from "../../lib/ingestion/operator-recovery.js";
import { assertOperatorNotQuarantined } from "../../lib/ingestion/private-artifacts.js";
import { inspectOperatorRecoveryGmailBatches } from "../../lib/ingestion/recovery-gmail-inspector.js";
import {
  openPreparedRuntimeForAdmission,
  prepareOperatorRecoveryRuntime,
  type RecoveryRuntimeInput,
} from "../../lib/ingestion/recovery-runtime.js";
import {
  canonicalJson,
  writeSqliteLedger,
} from "../../lib/ingestion/sqlite-store.js";
import { listRetainedSteveEmailSources } from "../../lib/ingestion/steve-email-intake.js";
import { captureSteveGmailWindow } from "../../lib/ingestion/steve-gmail-handoff.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { runWeeklyImport } from "../../lib/ingestion/weekly-import-runner.js";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
  type WeeklyRunState,
} from "../../lib/ingestion/weekly-run-state.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });
const account = "inspector@fixture.invalid",
  edition = "2026-10-16";
const received = Date.parse("2026-10-16T17:00:00Z"),
  saved = received + 60_000;
const text =
  "THE LIST\nfunk-punk-thrash-ska Upcoming shows of Interest October 16, 2026\noct 23 fri Fixture Band at Test Room, Oakland a/a $20 8pm\nPlease feel free to forward The List on to your friends.\n";
const correction = text.replace(
  "Please feel free",
  "oct 24 sat Second Band at Test Room, Oakland a/a $20 8pm\nPlease feel free"
);
const third = text.replace(
  "Please feel free",
  "oct 25 sun Third Band at Test Room, Oakland a/a $20 8pm\nPlease feel free"
);
let base: string, input: RecoveryRuntimeInput, emptyInput: RecoveryRuntimeInput;
let firstRunId: string, reviewRunId: string, nonproductionRunId: string;
let wrongTimeRunId: string, wrongHashRunId: string;
let keyPath: string, archivePath: string, retirementPath: string;
let setupComplete = false,
  fixtureFailed = false;

function write(path: string, bytes: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
function message(id: string, source = text) {
  const headers: Array<[string, string]> = [
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
    ["MIME-Version", "1.0"],
    ["Content-Type", "text/plain; charset=UTF-8"],
    ["Content-Transfer-Encoding", "7bit"],
  ];
  const body = Buffer.from(source.replace(/\n/g, "\r\n"));
  const raw = Buffer.concat([
    Buffer.from(
      headers.map(([name, value]) => `${name}: ${value}`).join("\r\n") +
        "\r\n\r\n"
    ),
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
        headers: headers.map(([name, value]) => ({ name, value })),
        body: { size: body.length, data: body.toString("base64url") },
      },
    },
  };
}
function fakeGmail(): typeof fetch {
  const messages = [
    message("c1"),
    message("c2"),
    message("c3", correction),
    message("c4", third),
    message("c5", text + "Pending\n"),
  ];
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
      throw new Error("Unexpected fixture origin");
    if (url.pathname === root + "/profile")
      return Response.json({ emailAddress: account });
    if (url.pathname === root + "/messages")
      return Response.json({ messages: messages.map(({ id }) => ({ id })) });
    const found = messages.find(
      ({ id }) => url.pathname === root + "/messages/" + id
    );
    if (!found) throw new Error("Unexpected fixture message");
    return Response.json(
      url.searchParams.get("format") === "FULL" ? found.full : found.raw
    );
  };
}
function removeFixture(path: string): void {
  const suffix = relative(resolve(base), resolve(path));
  if (
    !suffix ||
    suffix === ".." ||
    suffix.startsWith("..\\") ||
    suffix.startsWith("../") ||
    resolve(path) === resolve(base)
  )
    throw new Error("Unsafe fixture cleanup");
  rmSync(path, { recursive: true, force: true });
}
/** Schema-valid negative history to isolate inspection predicates. Reused artifact
 * bytes are retained evidence, not a claim these modeled rows can resume a worker.
 */
function modeledLoad(
  operator: string,
  template: WeeklyRunState,
  raw: Buffer,
  observation: number
): string {
  const journal = new WeeklyRunJournal(operator),
    lease = journal.acquire("prodigic/zivv/production");
  try {
    let state = journal.create(
      createWeeklyRunState({
        ...template.source,
        rawSha256: sha256(raw),
        importObservedAtEpochMs: observation,
      }),
      lease,
      raw
    );
    for (const stage of ["acquire", "prepare", "reconcile", "load"] as const) {
      const savedStage = template.stages.find((item) => item.stage === stage)!;
      const bytes = journal.readArtifact(
        template.runId,
        stage,
        savedStage.attempt
      );
      if (!bytes || !savedStage.evidence)
        throw new Error("Missing genuine template evidence");
      const evidence =
        stage === "acquire"
          ? { rawSha256: sha256(raw), deliveryId: state.source.deliveryId }
          : savedStage.evidence;
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
      journal.writeArtifact(state.runId, stage, bytes, lease);
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
    return state.runId;
  } finally {
    try {
      journal.release(lease);
    } finally {
      journal.close();
    }
  }
}
async function fixture(
  name: string,
  batches: boolean
): Promise<RecoveryRuntimeInput> {
  const root = join(base, name + " checkout"),
    operator = join(base, name + " operator");
  const tool = join(base, name + " original npm"),
    npmCli = join(tool, "bin/npm-cli.js");
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
    canonicalJson({ schemaVersion: 1, backend: "sqlite", namespace: "zivv" })
  );
  await writeSqliteLedger(
    join(operator, "ledger.sqlite"),
    bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
    true
  );
  const recoveryKey = loadBackupKey(operator, true);
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
    import {dirname,join,resolve} from 'node:path'; import {fileURLToPath} from 'node:url';
    if(process.argv[2]==='--version') console.log('11.6.0'); else {
      const modules=join(process.cwd(),'node_modules');mkdirSync(modules);
      cpSync(resolve(dirname(fileURLToPath(import.meta.url)),'../node_modules/postal-mime'),join(modules,'postal-mime'),{recursive:true});
    }\n`
  );
  if (batches) {
    const batchDirectory = join(operator, "email-acquisition/batches");
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() =>
        existsSync(batchDirectory) &&
        readdirSync(batchDirectory).some((name) =>
          /^[a-f0-9]{64}\.json$/.test(name)
        )
          ? saved + 1000
          : saved
      );
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
            .messageId === "c5"
        ) {
          interrupted = true;
          throw new Error("INSPECTOR_FIXTURE_CAPTURE_INTERRUPTION");
        }
        return originalSave.call(this, kind, id, bytes, lease);
      });
    try {
      const parent = sha256(
        canonicalJson([
          sha256(account),
          edition,
          sha256(Buffer.from(text.replace(/\n/g, "\r\n"))),
        ])
      );
      await expect(
        captureSteveGmailWindow({
          operatorDirectory: operator,
          expectedAccountId: account,
          expectedEditionId: edition,
          startEpochMs: received - 1000,
          endEpochMs: received + 1000,
          getAccessToken: async () => "synthetic_token",
          fetcher: fakeGmail(),
          correctionOfByMessageId: { c4: parent },
        })
      ).rejects.toThrow();
      expect(interrupted).toBe(true);
    } finally {
      hook.mockRestore();
      clock.mockRestore();
    }
    const retained = listRetainedSteveEmailSources({
      operatorDirectory: operator,
      accountId: account,
      expectedEditionId: edition,
    });
    const first = retained.find(({ receipt }) => receipt.messageId === "c1")!;
    const review = retained.find(({ receipt }) => receipt.messageId === "c3")!;
    const unloaded = retained.find(
      ({ receipt }) => receipt.messageId === "c4"
    )!;
    expect(retained).toHaveLength(3);
    expect(review.receipt.disposition).toBe("review-required");
    const importClock = vi.spyOn(Date, "now").mockReturnValue(saved + 2000);
    try {
      const load = (
        entry: typeof first,
        alter: { raw?: Buffer; observation?: number } = {}
      ) =>
        runWeeklyImport({
          root,
          stopAfter: "load",
          source: {
            editionId: edition,
            deliveryId: entry.receipt.deliveryId,
            raw: alter.raw ?? entry.source,
            importObservedAtEpochMs:
              alter.observation ?? entry.receipt.firstObservedAtEpochMs,
          },
        });
      firstRunId = (await load(first)).runId;
      // A successful manual load never grants email correction approval.
      reviewRunId = (await load(review)).runId;
      const completed = await load(unloaded);
      nonproductionRunId = completed.runId;
      wrongTimeRunId = modeledLoad(
        operator,
        completed,
        unloaded.source,
        unloaded.receipt.firstObservedAtEpochMs + 1
      );
      wrongHashRunId = modeledLoad(
        operator,
        completed,
        Buffer.concat([unloaded.source, Buffer.from("\n")]),
        unloaded.receipt.firstObservedAtEpochMs
      );
      // Model an otherwise exact successful delivery recorded for a different destination.
      const journal = new WeeklyRunJournal(operator),
        lease = journal.acquire("fixture/alternate");
      journal.release(lease);
      journal.close();
      const db = new DatabaseSync(join(operator, "weekly-runs.sqlite"));
      try {
        db.prepare("UPDATE run_state SET scope=? WHERE id=?").run(
          "fixture/alternate",
          nonproductionRunId
        );
      } finally {
        db.close();
      }
    } finally {
      importClock.mockRestore();
    }
  }
  const out = join(base, name + ".enc");
  await retireAndCaptureOperatorRecovery({ root, out, npmCli });
  const archive = readFileSync(out),
    retirementReceipt = readFileSync(out + ".retirement.json");
  const replacement = join(base, name + " relocated npm");
  cpSync(tool, replacement, { recursive: true });
  for (const path of [root, operator, tool]) removeFixture(path);
  const result = {
    archive,
    retirementReceipt,
    recoveryKey,
    destination: join(base, name + " prepared"),
    npmCli: join(replacement, "bin/npm-cli.js"),
  };
  await prepareOperatorRecoveryRuntime(result);
  if (batches) {
    keyPath = join(base, "external-key.txt");
    writeFileSync(keyPath, recoveryKey.toString("base64") + "\n");
    archivePath = out;
    retirementPath = out + ".retirement.json";
  }
  return result;
}
function tree() {
  return canonicalJson(openPreparedRuntimeForAdmission(input).inventory());
}
function cli(extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      resolve("scripts/operator-recovery.js"),
      "inspect-gmail",
      "--file",
      archivePath,
      "--key",
      keyPath,
      "--receipt",
      retirementPath,
      "--destination",
      input.destination,
      "--npm-cli",
      input.npmCli,
      ...extra,
    ],
    { encoding: "utf8", timeout: 90_000, windowsHide: true }
  );
}
beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "zivv-gmail-inspector-"));
  input = await fixture("batch", true);
  emptyInput = await fixture("empty", false);
  setupComplete = true;
}, 180_000);
afterEach((context) => {
  if (context.task.result?.state === "fail") fixtureFailed = true;
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (!base) return;
  if (!setupComplete || fixtureFailed) {
    console.error(`Retained Gmail inspector fixture: ${base}`);
    return;
  }
  const suffix = relative(resolve(tmpdir()), resolve(base));
  if (
    !suffix.startsWith("zivv-gmail-inspector-") ||
    suffix.includes("..") ||
    suffix.includes("/") ||
    suffix.includes("\\")
  )
    throw new Error("Unsafe fixture cleanup");
  rmSync(base, { recursive: true, force: true });
});

describe("read-only prepared Gmail batch inspection", () => {
  it("bounds caller buffers before copying or opening prepared inputs", async () => {
    const runtime = await import("../../lib/ingestion/recovery-runtime.js");
    const open = vi.spyOn(runtime, "openPreparedRuntimeForAdmission");
    // Test a declared oversized Buffer length without allocating a maximum capsule.
    const oversized = Buffer.alloc(1);
    Object.defineProperty(oversized, "length", {
      value: Math.floor(256 * 1024 * 1024 * 1.4) + 1,
    });
    try {
      for (const value of [
        { ...input, archive: oversized },
        { ...input, archive: new Uint8Array(1) },
        { ...input, retirementReceipt: Buffer.alloc(16 * 1024 + 1) },
        { ...input, recoveryKey: Buffer.alloc(33) },
      ])
        expect(() =>
          inspectOperatorRecoveryGmailBatches(value as RecoveryRuntimeInput)
        ).toThrow("INVALID_RECOVERY_GMAIL_INSPECTION");
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
  it("proves exact historical load obligations after old host/tool deletion without granting authority", () => {
    const before = tree(),
      result = inspectOperatorRecoveryGmailBatches(input);
    expect(result).toMatchObject({
      status: "inspected",
      activationAllowed: false,
      captureAllowed: false,
    });
    expect(result.batches).toHaveLength(1);
    const batch = result.batches[0]!;
    expect(batch.accountSha256).toBe(sha256(account));
    expect(batch.editionId).toBe(edition);
    expect(batch.messages.map((message) => message.status)).toEqual([
      "loaded",
      "loaded",
      "review-required",
      "load-pending",
      "capture-pending",
    ]);
    for (const message of batch.messages.slice(0, 2))
      expect(message).toMatchObject({ loadRunIds: [firstRunId] });
    expect(batch.messages[2]).toMatchObject({ loadRunIds: [] });
    expect(batch.messages[3]).toMatchObject({ loadRunIds: [] });
    // Neither the reviewed-state run nor mismatched time/hash/nonproduction runs count.
    expect(JSON.stringify(result)).not.toContain(reviewRunId);
    for (const run of [wrongTimeRunId, wrongHashRunId, nonproductionRunId])
      expect(JSON.stringify(result)).not.toContain(run);
    const late = batch.messages[3]!;
    if (late.status === "capture-pending")
      throw new Error("Expected captured fixture source");
    expect(batch.firstSavedAtEpochMs).toBeLessThan(saved + 500);
    expect(late.firstObservedAtEpochMs).toBeGreaterThanOrEqual(saved + 500);
    expect(tree()).toBe(before);
    expect(() =>
      assertOperatorNotQuarantined(join(input.destination, "operator"))
    ).toThrow();
    for (const name of ["backup-key.bin", "backup-key.dpapi"])
      expect(existsSync(join(input.destination, "operator", name))).toBe(false);
    const json = JSON.stringify(result);
    for (const secret of [
      account,
      base,
      text,
      "synthetic_token",
      input.recoveryKey.toString("base64"),
      "rawMessage",
      "snapshots",
    ])
      expect(json).not.toContain(secret);
  });
  it("supports unchanged batch-free prepared runtimes", () => {
    expect(inspectOperatorRecoveryGmailBatches(emptyInput)).toMatchObject({
      status: "inspected",
      activationAllowed: false,
      captureAllowed: false,
      batches: [],
    });
  });
  it("rejects archive/retirement/key/npm/preparation substitution without creating a target", () => {
    const archive = Buffer.from(input.archive);
    archive[10] = archive[10]! ^ 1;
    const retirementReceipt = Buffer.from(input.retirementReceipt);
    retirementReceipt[10] = retirementReceipt[10]! ^ 1;
    for (const changed of [
      { ...input, archive },
      { ...input, retirementReceipt },
      { ...input, recoveryKey: Buffer.alloc(32) },
      { ...input, destination: emptyInput.destination },
      { ...input, npmCli: emptyInput.npmCli },
    ]) {
      expect(() => inspectOperatorRecoveryGmailBatches(changed)).toThrow(
        "INVALID_RECOVERY_GMAIL_INSPECTION"
      );
    }
    const destination = join(base, "never-created");
    expect(() =>
      inspectOperatorRecoveryGmailBatches({ ...input, destination })
    ).toThrow();
    expect(existsSync(destination)).toBe(false);
  });
  it("rejects drift anywhere in the exact tree and in the external npm tool", () => {
    const files = [
      "operator/ledger.sqlite",
      "operator/weekly-runs.sqlite",
      "checkout/package-lock.json",
      "checkout/dist/lib/ingestion/weekly-import-runner.js",
      "checkout/node_modules/postal-mime/package.json",
      "bootstrap/module-boundary.mjs",
      "prepared-runtime.json",
    ];
    for (const path of [
      ...files.map((path) => join(input.destination, path)),
      input.npmCli,
    ]) {
      const bytes = readFileSync(path);
      writeFileSync(path, Buffer.concat([bytes, Buffer.from("changed")]));
      try {
        expect(() => inspectOperatorRecoveryGmailBatches(input)).toThrow();
      } finally {
        writeFileSync(path, bytes);
      }
    }
    const extra = join(input.destination, "operator/weekly-runs.sqlite-wal");
    writeFileSync(extra, "unexpected sidecar");
    try {
      expect(() => inspectOperatorRecoveryGmailBatches(input)).toThrow();
    } finally {
      unlinkSync(extra);
    }
  });
  it("refuses late tree drift after obligation computation", async () => {
    const module =
        await import("../../lib/ingestion/recovery-gmail-batch-proof.js"),
      original = module.proveRecoveryGmailBatchInventory;
    const extra = join(input.destination, "operator/late-artifact");
    let calls = 0;
    const hook = vi
      .spyOn(module, "proveRecoveryGmailBatchInventory")
      .mockImplementation((value) => {
        const result = original(value);
        // open + before-runtime + inspector proof: mutate after the inspector proof itself.
        if (++calls === 3) writeFileSync(extra, "late fixture drift");
        return result;
      });
    try {
      expect(() => inspectOperatorRecoveryGmailBatches(input)).toThrow();
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      hook.mockRestore();
      if (existsSync(extra)) unlinkSync(extra);
    }
  });
  it("executes the actual CLI with redacted output and leaves tree/quarantine/key state unchanged", () => {
    const before = tree(),
      result = cli();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "inspect-gmail",
      status: "inspected",
      activationAllowed: false,
      captureAllowed: false,
    });
    for (const secret of [
      base,
      account,
      text,
      input.recoveryKey.toString("base64"),
      "rawMessage",
      "snapshots",
    ])
      expect(result.stdout + result.stderr).not.toContain(secret);
    expect(tree()).toBe(before);
    expect(() =>
      assertOperatorNotQuarantined(join(input.destination, "operator"))
    ).toThrow();
    for (const name of ["backup-key.bin", "backup-key.dpapi"])
      expect(existsSync(join(input.destination, "operator", name))).toBe(false);
  });
  it.each(["--activate", "--source", "--token-env", "--controlled-publishing"])(
    "refuses unrelated effect flag %s at the CLI",
    (flag) => {
      const before = tree(),
        result = cli([flag, "forbidden"]);
      expect(result.status).toBe(1);
      expect(tree()).toBe(before);
      expect(result.stderr).not.toContain(base);
      expect(result.stderr).not.toContain(input.recoveryKey.toString("base64"));
    }
  );
});
