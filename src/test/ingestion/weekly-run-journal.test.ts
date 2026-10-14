import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { WeeklyRunJournal } from "../../lib/ingestion/weekly-run-journal.js";
import {
  createWeeklyRunState,
  transitionWeeklyRun,
} from "../../lib/ingestion/weekly-run-state.js";

const roots: string[] = [];
const opened: WeeklyRunJournal[] = [];
const source = {
  editionId: "2026-10-16",
  deliveryId: "fixture",
  rawSha256: "a".repeat(64),
  rulesSha256: "b".repeat(64),
  importObservedAtEpochMs: 1000,
};
function fixture(clock: () => number) {
  const root = mkdtempSync(join(tmpdir(), "zivv-journal-test-"));
  roots.push(root);
  const directory = join(root, "operator");
  const journal = new WeeklyRunJournal(directory, clock);
  opened.push(journal);
  return { root, directory, journal };
}
afterEach(() => {
  for (const journal of opened.splice(0)) journal.close();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), "zivv-journal-test-")))
      throw new Error("Unsafe journal fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("private weekly journal", () => {
  it("serializes concurrent process initialization and recovers an empty pre-schema file", async () => {
    const root = mkdtempSync(join(tmpdir(), "zivv-journal-test-"));
    roots.push(root);
    const directory = join(root, "operator");
    mkdirSync(directory);
    writeFileSync(join(directory, "weekly-runs.sqlite"), Buffer.alloc(0));
    const moduleUrl = pathToFileURL(
      resolve("dist/lib/ingestion/weekly-run-journal.js")
    ).href;
    const code = `import {WeeklyRunJournal} from ${JSON.stringify(moduleUrl)};const j=new WeeklyRunJournal(process.argv[1]);j.acquire('scope/'+process.pid);j.close();`;
    await Promise.all(
      Array.from(
        { length: 3 },
        () =>
          new Promise<void>((resolveExit, reject) => {
            const child = spawn(
              process.execPath,
              ["--input-type=module", "-e", code, directory],
              { windowsHide: true }
            );
            let errors = "";
            child.stderr.on("data", (data) => {
              errors += String(data);
            });
            child.once("error", reject);
            child.once("exit", (status) =>
              status === 0 ? resolveExit() : reject(new Error(errors))
            );
          })
      )
    );
    const journal = new WeeklyRunJournal(directory);
    opened.push(journal);
    expect(journal.acquire("production").fence).toBe(1);
  });

  it("rejects corrupt ownership values without issuing a negative fence", () => {
    const { journal } = fixture(() => 2000);
    const lease = journal.acquire("production");
    const corrupt = new DatabaseSync(journal.path);
    try {
      corrupt.exec(
        "PRAGMA ignore_check_constraints=ON; UPDATE ownership SET fence=-5, expires_at=0;"
      );
    } finally {
      corrupt.close();
    }
    expect(() => journal.acquire("production")).toThrow(
      "Corrupt journal ownership"
    );
    expect(() => journal.renew(lease)).toThrow("Corrupt journal ownership");
  });

  it.skipIf(process.platform === "win32")(
    "restricts pre-existing POSIX directories and rejects dangling links",
    () => {
      const root = mkdtempSync(join(tmpdir(), "zivv-journal-test-"));
      roots.push(root);
      const directory = join(root, "operator");
      mkdirSync(directory, { mode: 0o755 });
      const journal = new WeeklyRunJournal(directory);
      opened.push(journal);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(journal.path).mode & 0o777).toBe(0o600);
      const linked = join(root, "linked");
      mkdirSync(linked);
      symlinkSync(
        join(root, "absent.sqlite"),
        join(linked, "weekly-runs.sqlite")
      );
      expect(() => new WeeklyRunJournal(linked)).toThrow("must not be linked");
    }
  );

  it("persists a running checkpoint across reopen and refuses stale/skip writes", () => {
    const { directory, journal } = fixture(() => 2000);
    const lease = journal.acquire("production");
    const initial = journal.create(createWeeklyRunState(source), lease);
    const running = transitionWeeklyRun(
      initial,
      0,
      "acquire",
      { status: "running" },
      2000
    );
    journal.save(running, 0, lease);
    const second = new WeeklyRunJournal(directory, () => 2000);
    opened.push(second);
    expect(second.load(initial.runId)).toEqual(running);
    expect(second.create(initial, lease)).toEqual(running);
    expect(() => second.save(running, 0, lease)).toThrow("Stale");
    const done = transitionWeeklyRun(
      running,
      1,
      "acquire",
      {
        status: "succeeded",
        evidence: {
          rawSha256: source.rawSha256,
          deliveryId: source.deliveryId,
        },
      },
      2000
    );
    const skipped = transitionWeeklyRun(
      done,
      2,
      "prepare",
      { status: "running" },
      2000
    );
    expect(() => second.save(skipped, 1, lease)).toThrow("Stale");
    second.save(done, 1, lease);
    expect(journal.load(initial.runId)?.stages[0].status).toBe("succeeded");
  });

  it("serializes owners, renews a lease and fences an expired owner after takeover", () => {
    let now = 2000;
    const { directory, journal } = fixture(() => now);
    const other = new WeeklyRunJournal(directory, () => now);
    opened.push(other);
    const lease = journal.acquire("production", 1000);
    expect(() => other.acquire("production")).toThrow("active owner");
    const initial = journal.create(createWeeklyRunState(source), lease);
    now = 2500;
    const renewed = journal.renew(lease, 1000);
    now = 3000;
    expect(() => other.acquire("production")).toThrow("active owner");
    now = 3500;
    const successor = other.acquire("production", 1000);
    expect(successor.fence).toBe(lease.fence + 1);
    expect(() => journal.renew(renewed)).toThrow("fenced");
    expect(() => journal.release(renewed)).toThrow("fenced");
    const running = transitionWeeklyRun(
      initial,
      0,
      "acquire",
      { status: "running" },
      now
    );
    expect(() => journal.save(running, 0, renewed)).toThrow("fenced");
    other.save(running, 0, successor);
    other.release(successor);
    expect(journal.acquire("production").fence).toBe(successor.fence + 1);
  });

  it("binds runs to destinations and rejects journal placement inside Git", () => {
    const { root, journal } = fixture(() => 2000);
    const lease = journal.acquire("production");
    const initial = journal.create(createWeeklyRunState(source), lease);
    const preview = journal.acquire("preview");
    expect(() => journal.create(initial, preview)).toThrow(
      "another destination"
    );
    const git = join(root, "git");
    mkdirSync(join(git, ".git"), { recursive: true });
    expect(() => new WeeklyRunJournal(join(git, "private"))).toThrow(
      "outside Git"
    );
  });

  it("recovers a process-killed running journal without resetting the stage", async () => {
    const { directory, journal } = fixture(() => 3000);
    const moduleUrl = pathToFileURL(
      resolve("dist/lib/ingestion/weekly-run-journal.js")
    ).href;
    const stateUrl = pathToFileURL(
      resolve("dist/lib/ingestion/weekly-run-state.js")
    ).href;
    const code = `import {WeeklyRunJournal} from ${JSON.stringify(moduleUrl)}; import {createWeeklyRunState,transitionWeeklyRun} from ${JSON.stringify(stateUrl)}; const journal=new WeeklyRunJournal(process.argv[1],()=>1000);const lease=journal.acquire('production',1000);const state=journal.create(createWeeklyRunState(${JSON.stringify(source)}),lease);journal.save(transitionWeeklyRun(state,0,'acquire',{status:'running'},1000),0,lease);console.log('READY');setInterval(()=>{},1000);`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", code, directory],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Child did not checkpoint")),
          10000
        );
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("READY")) {
            clearTimeout(timer);
            resolveReady();
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (status) => {
          clearTimeout(timer);
          reject(new Error(`Child exited before checkpoint: ${status}`));
        });
      });
      const exited = new Promise<void>((resolveExit) =>
        child.once("exit", () => resolveExit())
      );
      child.kill("SIGKILL");
      await exited;
      const recovered = journal.load(createWeeklyRunState(source).runId);
      expect(recovered?.stages[0]).toMatchObject({
        status: "running",
        attempt: 1,
      });
      const lease = journal.acquire("production");
      expect(lease.fence).toBe(2);
      expect(() =>
        transitionWeeklyRun(
          recovered!,
          1,
          "acquire",
          { status: "running" },
          3000
        )
      ).toThrow("blind retry");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  });
});
