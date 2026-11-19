import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { FridayNoticeOutbox } from "../../lib/ingestion/friday-notice-outbox.js";

it("serializes concurrent claims and preserves an unknown delivery after the winner dies", async () => {
  const prefix = "zivv-friday-outbox-race-";
  const root = mkdtempSync(join(tmpdir(), prefix));
  const children: ChildProcess[] = [];
  const path = join(root, "outbox.sqlite");
  const due = Date.parse("2026-10-31T01:00:00.000Z");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    const store = FridayNoticeOutbox.initialize(database);
    const original = store.record({
      editionId: "2026-10-30",
      nowEpochMs: due,
      maxEvidenceAgeMs: 0,
      evidence: {
        kind: "mailbox-scan",
        status: "absent",
        scannedThroughEpochMs: due,
      },
    });
    expect(original?.status).toBe("pending");
    const key = original!.notice.key;
    database.close();
    database = undefined;

    const moduleUrl = pathToFileURL(
      resolve("dist/lib/ingestion/friday-notice-outbox.js")
    ).href;
    const worker = `
      import { DatabaseSync } from 'node:sqlite';
      import { FridayNoticeOutbox } from ${JSON.stringify(moduleUrl)};
      const db = new DatabaseSync(process.argv[1], { timeout: 10000 });
      const outbox = new FridayNoticeOutbox(db);
      process.send({ kind: 'ready' });
      process.on('message', message => {
        if (message !== 'go') return;
        try {
          const claim = outbox.claim(process.argv[2]);
          process.send({ kind: 'result', claim });
          if (!claim) { db.close(); process.disconnect(); }
        } catch {
          process.send({ kind: 'error' });
          db.close(); process.disconnect(); process.exitCode = 1;
        }
      });
    `;
    type Message = {
      kind: string;
      claim?: {
        status: string;
        attemptId: string;
        notice: { key: string };
      } | null;
    };
    function launch() {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", worker, path, key],
        {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          windowsHide: true,
        }
      );
      children.push(child);
      let diagnostic = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        diagnostic += chunk.toString("utf8");
      });
      const messages: Message[] = [];
      const waiters: Array<(value: Message) => void> = [];
      child.on("message", (value: unknown) => {
        const message = value as Message;
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else messages.push(message);
      });
      const closed = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveClose, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolveClose({ code, signal }));
      });
      const next = () =>
        new Promise<Message>((resolveMessage, reject) => {
          const available = messages.shift();
          if (available) return resolveMessage(available);
          const timer = setTimeout(
            () => reject(new Error("OUTBOX_CHILD_TIMEOUT")),
            15_000
          );
          waiters.push((message) => {
            clearTimeout(timer);
            resolveMessage(message);
          });
          void closed.then(() => {
            clearTimeout(timer);
            reject(new Error("OUTBOX_CHILD_CLOSED"));
          }, reject);
        });
      return { child, next, closed, diagnostic: () => diagnostic };
    }
    const bounded = <T>(promise: Promise<T>) =>
      new Promise<T>((resolveWait, reject) => {
        const timer = setTimeout(
          () => reject(new Error("OUTBOX_CHILD_CLOSE_TIMEOUT")),
          10_000
        );
        void promise.then(
          (value) => {
            clearTimeout(timer);
            resolveWait(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          }
        );
      });
    const left = launch();
    const right = launch();
    expect(await Promise.all([left.next(), right.next()])).toEqual([
      { kind: "ready" },
      { kind: "ready" },
    ]);
    left.child.send("go");
    right.child.send("go");
    const results = await Promise.all([left.next(), right.next()]);
    expect(results.every((result) => result.kind === "result")).toBe(true);
    const claims = results.map((result) => result.claim);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    const winnerIndex = claims.findIndex(Boolean);
    const winner = winnerIndex === 0 ? left : right;
    const loser = winnerIndex === 0 ? right : left;
    const claim = claims[winnerIndex]!;
    expect(claim).toMatchObject({
      status: "delivery-unknown",
      notice: { key },
      attemptId: expect.any(String),
    });
    expect((await bounded(loser.closed)).code).toBe(0);
    expect(winner.child.kill()).toBe(true);
    const death = await bounded(winner.closed);
    expect(
      death.code === null || death.code !== 0 || death.signal !== null
    ).toBe(true);
    expect(left.diagnostic() + right.diagnostic()).not.toContain(root);

    database = new DatabaseSync(path);
    const reopened = new FridayNoticeOutbox(database);
    expect(reopened.inspect(key)).toEqual(claim);
    expect(reopened.claim(key)).toBeNull();
  } finally {
    database?.close();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((done) =>
          child.once("close", () => done())
        );
        child.kill();
        await Promise.race([
          closed,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("OUTBOX_CLEANUP_TIMEOUT")),
              10_000
            )
          ),
        ]);
      }
    }
    const absolute = resolve(root);
    if (
      dirname(absolute) !== resolve(tmpdir()) ||
      !basename(absolute).startsWith(prefix)
    )
      throw new Error("UNSAFE_TEST_CLEANUP");
    rmSync(absolute, { recursive: true, force: true });
  }
}, 45_000);
