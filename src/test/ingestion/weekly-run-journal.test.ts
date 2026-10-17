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
import { createHash } from "node:crypto";
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

function legacyFixture(version: 1 | 2) {
  const root = mkdtempSync(join(tmpdir(), "zivv-journal-test-"));
  roots.push(root);
  const directory = join(root, "operator");
  mkdirSync(directory);
  const path = join(directory, "weekly-runs.sqlite");
  const state = createWeeklyRunState(source);
  const bytes = Buffer.from("legacy stage evidence");
  const lease = {
    scope: "production",
    owner: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    fence: 7,
    expiresAtEpochMs: 10000,
  };
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE ownership(scope TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence BETWEEN 1 AND 9007199254740991), expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 0 AND 9007199254740991)) STRICT;
      CREATE TABLE run_state(id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES ownership(scope), revision INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
      PRAGMA application_id=1514759762;
      PRAGMA user_version=${version};`);
    db.prepare("INSERT INTO ownership VALUES(?,?,?,?)").run(
      lease.scope,
      lease.owner,
      lease.fence,
      lease.expiresAtEpochMs
    );
    db.prepare("INSERT INTO run_state VALUES(?,?,?,?)").run(
      state.runId,
      lease.scope,
      state.revision,
      JSON.stringify(state)
    );
    if (version === 2) {
      db.exec(
        "CREATE TABLE stage_artifact(run_id TEXT NOT NULL REFERENCES run_state(id), stage TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 9007199254740991), identity TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(run_id,stage,attempt)) STRICT;"
      );
      db.prepare("INSERT INTO stage_artifact VALUES(?,?,?,?,?)").run(
        state.runId,
        "acquire",
        0,
        createHash("sha256").update(bytes).digest("hex"),
        bytes
      );
    }
  } finally {
    db.close();
  }
  return { directory, path, state, bytes, lease };
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
  it("persists immutable source and correction intake evidence independently of worker stages", () => {
    const { directory, journal } = fixture(() => 2000);
    const lease = journal.acquire("production");
    const id = "a".repeat(64);
    const sourceBytes = Buffer.from('{"firstObservedAtEpochMs":1000}\n');
    const correctionBytes = Buffer.from('{"correctionOf":"fixture"}\n');
    expect(journal.readIntakeEvidence("production", "source", id)).toBeNull();
    expect(
      journal.saveIntakeEvidence("source", id, sourceBytes, lease)
    ).toEqual(sourceBytes);
    expect(
      journal.saveIntakeEvidence("correction", id, correctionBytes, lease)
    ).toEqual(correctionBytes);
    expect(
      journal.saveIntakeEvidence("source", id, sourceBytes, lease)
    ).toEqual(sourceBytes);
    expect(() =>
      journal.saveIntakeEvidence("source", id, Buffer.from("changed"), lease)
    ).toThrow("overwrite");
    expect(journal.listIntakeEvidence("production", "source")).toEqual([
      { id, bytes: sourceBytes },
    ]);
    expect(journal.readIntakeEvidence("preview", "source", id)).toBeNull();
    const reopened = new WeeklyRunJournal(directory, () => 2000);
    opened.push(reopened);
    expect(reopened.readIntakeEvidence("production", "source", id)).toEqual(
      sourceBytes
    );
    expect(reopened.readIntakeEvidence("production", "correction", id)).toEqual(
      correctionBytes
    );
  });

  it.each([1, 2] as const)(
    "migrates schema %s without changing legacy ownership, state or stage bytes",
    (version) => {
      const legacy = legacyFixture(version);
      const journal = new WeeklyRunJournal(legacy.directory, () => 2000);
      opened.push(journal);
      expect(journal.load(legacy.state.runId)).toEqual(legacy.state);
      expect(() => journal.acquire("production")).toThrow("active owner");
      expect(journal.readArtifact(legacy.state.runId, "acquire", 0)).toEqual(
        version === 2 ? legacy.bytes : null
      );
      const sourceBytes = Buffer.from("new intake evidence");
      journal.saveIntakeEvidence(
        "source",
        "a".repeat(64),
        sourceBytes,
        legacy.lease
      );
      expect(
        journal.readIntakeEvidence("production", "source", "a".repeat(64))
      ).toEqual(sourceBytes);
      const native = new DatabaseSync(legacy.path, { readOnly: true });
      try {
        expect(native.prepare("PRAGMA user_version").get()?.user_version).toBe(
          3
        );
        expect(
          native
            .prepare(
              "SELECT owner,fence,expires_at FROM ownership WHERE scope='production'"
            )
            .get()
        ).toMatchObject({
          owner: legacy.lease.owner,
          fence: 7,
          expires_at: 10000,
        });
        expect(
          native
            .prepare("SELECT payload FROM run_state WHERE id=?")
            .get(legacy.state.runId)?.payload
        ).toBe(JSON.stringify(legacy.state));
        expect(
          native.prepare("PRAGMA table_list('intake_evidence')").get()?.strict
        ).toBe(1);
      } finally {
        native.close();
      }
    }
  );

  it("isolates intake evidence by destination and returns detached byte copies", () => {
    const { journal } = fixture(() => 2000);
    const production = journal.acquire("production"),
      preview = journal.acquire("preview");
    const bytes = Buffer.from("original"),
      id = "b".repeat(64);
    const saved = journal.saveIntakeEvidence("source", id, bytes, production);
    bytes.fill(0);
    saved.fill(1);
    journal.saveIntakeEvidence("source", id, Buffer.from("preview"), preview);
    const listed = journal.listIntakeEvidence("production", "source");
    expect(listed).toEqual([{ id, bytes: Buffer.from("original") }]);
    listed[0].bytes.fill(2);
    expect(journal.readIntakeEvidence("production", "source", id)).toEqual(
      Buffer.from("original")
    );
    expect(journal.readIntakeEvidence("preview", "source", id)).toEqual(
      Buffer.from("preview")
    );
  });

  it("fences intake writes, including exact replay, after ownership expires", () => {
    let now = 2000;
    const { directory, journal } = fixture(() => now);
    const original = journal.acquire("production", 1000);
    const id = "c".repeat(64),
      bytes = Buffer.from("first observation");
    journal.saveIntakeEvidence("source", id, bytes, original);
    now = 3000;
    expect(() =>
      journal.saveIntakeEvidence("source", id, bytes, original)
    ).toThrow("fenced");
    const successor = new WeeklyRunJournal(directory, () => now);
    opened.push(successor);
    const lease = successor.acquire("production", 1000);
    expect(() =>
      journal.saveIntakeEvidence("correction", id, bytes, original)
    ).toThrow("fenced");
    expect(successor.saveIntakeEvidence("source", id, bytes, lease)).toEqual(
      bytes
    );
    expect(
      successor.readIntakeEvidence("production", "correction", id)
    ).toBeNull();
  });

  it("allows guarded evidence reads but refuses nested writes without disturbing the guard", async () => {
    const { journal } = fixture(() => 2000);
    const lease = journal.acquire("production");
    const id = "d".repeat(64),
      bytes = Buffer.from("durable before files");
    journal.saveIntakeEvidence("source", id, bytes, lease);
    await journal.guardOperation(lease, async () => {
      expect(journal.readIntakeEvidence("production", "source", id)).toEqual(
        bytes
      );
      expect(journal.listIntakeEvidence("production", "source")).toEqual([
        { id, bytes },
      ]);
      expect(() =>
        journal.saveIntakeEvidence("correction", id, bytes, lease)
      ).toThrow("Nested");
      journal.checkOwnership(lease);
    });
    expect(journal.saveIntakeEvidence("correction", id, bytes, lease)).toEqual(
      bytes
    );
  });

  it("rejects changed evidence bytes on reads, enumeration and replay", () => {
    const { journal } = fixture(() => 2000);
    const lease = journal.acquire("production");
    const id = "e".repeat(64),
      bytes = Buffer.from("immutable acquisition intent");
    journal.saveIntakeEvidence("source", id, bytes, lease);
    const corrupt = new DatabaseSync(journal.path);
    try {
      corrupt
        .prepare(
          "UPDATE intake_evidence SET bytes=? WHERE scope=? AND kind=? AND id=?"
        )
        .run(Buffer.from("changed"), "production", "source", id);
    } finally {
      corrupt.close();
    }
    expect(() =>
      journal.readIntakeEvidence("production", "source", id)
    ).toThrow("Changed intake evidence");
    expect(() => journal.listIntakeEvidence("production", "source")).toThrow(
      "Changed intake evidence"
    );
    expect(() =>
      journal.saveIntakeEvidence("source", id, bytes, lease)
    ).toThrow("Changed intake evidence");
  });

  it("enforces the private evidence limit and rejects malformed input without recording it", () => {
    const { journal } = fixture(() => 2000);
    const lease = journal.acquire("production"),
      id = "f".repeat(64);
    expect(() =>
      journal.saveIntakeEvidence(
        "source",
        id,
        Buffer.alloc(8 * 1024 * 1024 + 1),
        lease
      )
    ).toThrow("limit");
    for (const badId of ["", "a".repeat(63), "A".repeat(64), "../outside"]) {
      expect(() =>
        journal.saveIntakeEvidence(
          "source",
          badId,
          Buffer.from("invalid"),
          lease
        )
      ).toThrow("key");
      expect(() =>
        journal.readIntakeEvidence("production", "source", badId)
      ).toThrow("key");
    }
    expect(() =>
      // @ts-expect-error Runtime callers can bypass the closed evidence-kind type.
      journal.saveIntakeEvidence("other", id, Buffer.from("invalid"), lease)
    ).toThrow("key");
    expect(() => journal.listIntakeEvidence("", "source")).toThrow("key");
    expect(journal.listIntakeEvidence("production", "source")).toEqual([]);
    const maximum = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    expect(
      journal.saveIntakeEvidence("source", id, maximum, lease).equals(maximum)
    ).toBe(true);
  });

  it.each(["future-version", "unexpected-table", "malformed-intake-table"])(
    "refuses an unsupported journal %s without accepting its evidence",
    (problem) => {
      const { directory, journal } = fixture(() => 2000);
      const corrupt = new DatabaseSync(journal.path);
      try {
        if (problem === "future-version") corrupt.exec("PRAGMA user_version=4");
        if (problem === "unexpected-table")
          corrupt.exec("CREATE TABLE unknown(value TEXT) STRICT");
        if (problem === "malformed-intake-table")
          corrupt.exec(
            "DROP TABLE intake_evidence; CREATE TABLE intake_evidence(scope TEXT,kind TEXT,id TEXT,identity TEXT,bytes TEXT)"
          );
      } finally {
        corrupt.close();
      }
      expect(() => new WeeklyRunJournal(directory, () => 2000)).toThrow(
        "Unsupported"
      );
    }
  );

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
