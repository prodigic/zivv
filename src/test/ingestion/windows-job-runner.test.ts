import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const prefix = "zivv-windows-job-runner-test-";
let root = "";
let runner = "";

function observedPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf8").trim();
  return /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

async function waitForObservation<T>(read: () => T | undefined): Promise<T> {
  const end = performance.now() + 8_000;
  while (performance.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((complete) => setTimeout(complete, 25));
  }
  throw Error("WINDOWS_JOB_TEST_OBSERVATION_TIMED_OUT");
}

function watchExits(processIds: number[]) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$identities = $env:ZIVV_JOB_FIXTURE_PIDS.Split(',')",
    "$workers = foreach ($identity in $identities) {",
    "  $worker = [Diagnostics.Process]::GetProcessById([int]$identity)",
    "  $null = $worker.Handle",
    "  if ($worker.HasExited) { exit 8 }",
    "  $worker",
    "}",
    "[Console]::WriteLine('watching')",
    "foreach ($worker in $workers) {",
    "  if (!$worker.WaitForExit(10000)) { exit 7 }",
    "  [Console]::WriteLine($worker.ExitCode)",
    "}",
  ].join("\n");
  const observer = spawn(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    ),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      env: { ...process.env, ZIVV_JOB_FIXTURE_PIDS: processIds.join(",") },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let output = "";
  observer.stdout.setEncoding("utf8").on("data", (part: string) => {
    output += part;
  });
  const result = once(observer, "close");
  return {
    async ready() {
      await waitForObservation(
        () => output.startsWith("watching") || undefined
      );
    },
    async exits() {
      const [status] = await result;
      expect(status).toBe(0);
      const codes = output.trim().split(/\r?\n/).slice(1);
      expect(codes).toHaveLength(processIds.length);
      expect(codes.every((part) => /^-?\d+$/.test(part))).toBe(true);
      return codes.map(Number);
    },
  };
}

const liveWorker = [
  "const fs=require('node:fs'); const {spawn}=require('node:child_process');",
  "fs.writeFileSync(process.argv[1],String(process.pid));",
  "const descendant=\"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);\";",
  "spawn(process.execPath,['-e',descendant,process.argv[2]],{detached:true,windowsHide:true,stdio:'ignore'});",
  "setInterval(()=>{},1000);",
].join("");

describe.skipIf(process.platform !== "win32")("Windows job runner", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), prefix));
    runner = join(root, "windows-job-runner.exe");
    const compiler = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe"
    );
    const compiled = spawnSync(
      compiler,
      [
        "/nologo",
        "/target:exe",
        "/warnaserror+",
        "/out:" + runner,
        resolve("scripts/windows-job-runner.cs"),
      ],
      { windowsHide: true, timeout: 30_000, encoding: "utf8" }
    );
    expect(compiled.error).toBeUndefined();
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    expect(existsSync(runner)).toBe(true);
  }, 45_000);

  afterAll(() => {
    if (!root) return;
    const absolute = resolve(root);
    if (
      dirname(absolute) !== resolve(tmpdir()) ||
      !basename(absolute).startsWith(prefix)
    )
      throw new Error("UNSAFE_TEST_CLEANUP");
    rmSync(absolute, { recursive: true, force: true });
  });

  function run(deadline: number, args: string[], input = Buffer.alloc(0)) {
    return spawnSync(
      runner,
      [String(process.pid), String(deadline), process.execPath, root, ...args],
      { input, windowsHide: true, timeout: 20_000, maxBuffer: 128 * 1024 }
    );
  }

  it("preserves exact Windows argument boundaries and binary standard input", () => {
    const args = [
      "",
      "two words",
      'embedded"quote',
      "trailing\\",
      'a\\\\"b',
      "é音",
      "& | % !",
    ];
    const input = Buffer.from([0, 255, 13, 10, 128, 65, 0, 10]);
    const script = `const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(1),input:Buffer.concat(chunks).toString('hex'),cwd:process.cwd()})));`;
    const result = run(10_000, ["-e", script, ...args], input);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const observed = JSON.parse(result.stdout.toString()) as {
      args: string[];
      input: string;
      cwd: string;
    };
    expect(observed.args).toEqual(args);
    expect(observed.input).toBe(input.toString("hex"));
    expect(realpathSync.native(observed.cwd)).toBe(realpathSync.native(root));
  });

  it("reports a nonzero worker exit as a worker failure", () => {
    const result = run(10_000, ["-e", "process.exitCode=7"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(220);
  });

  it("joins repeated short worker exits and reports their exact result", () => {
    for (let read = 0; read < 16; read++) {
      const code = read % 2 === 0 ? 0 : 7;
      const result = run(10_000, ["-e", "process.exitCode=" + code]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(code === 0 ? 0 : 220);
    }
  }, 30_000);

  it("waits for and reaps a descendant after the root exits", async () => {
    const sentinel = join(root, "descendant-sentinel.txt");
    const rootDone = join(root, "root-exited.txt");
    const descendant = `const fs=require('node:fs');const p=process.argv[1];fs.writeFileSync(p,String(process.pid)+'\\n');process.send('ready');setInterval(()=>fs.appendFileSync(p,'tick\\n'),40);`;
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{detached:true,stdio:['ignore','inherit','inherit','ipc']});child.on('message',()=>{fs.writeFileSync(process.argv[3],'exited');process.exit(0)});`;
    const result = run(3_000, ["-e", script, descendant, sentinel, rootDone]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(221);
    expect(existsSync(rootDone)).toBe(true);
    const contents = readFileSync(sentinel, "utf8");
    const pid = Number(contents.split("\n")[0]);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    expect(readFileSync(sentinel, "utf8")).toBe(contents);
    // PID liveness is corroborating evidence only; runner 221 reflects the
    // owning job's accounting and an observed terminated root.
    expect(() => process.kill(pid, 0)).toThrow();
  }, 25_000);

  it("terminates both live generations when the launching process dies", async () => {
    const supervisorPath = join(root, "parent-death-supervisor.pid");
    const workerPath = join(root, "parent-death-worker.pid");
    const descendantPath = join(root, "parent-death-descendant.pid");
    const controller = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      "const worker=spawn(process.argv[1],[String(process.pid),'30000',process.execPath,process.argv[2],'-e',process.argv[3],process.argv[4],process.argv[5]],{detached:true,windowsHide:true,stdio:'ignore'});",
      "worker.on('spawn',()=>fs.writeFileSync(process.argv[6],String(worker.pid)));",
    ].join("");
    const parent = spawn(
      process.execPath,
      [
        "-e",
        controller,
        runner,
        root,
        liveWorker,
        workerPath,
        descendantPath,
        supervisorPath,
      ],
      { windowsHide: true, stdio: "ignore" }
    );
    const parentExit = once(parent, "exit");
    try {
      const supervisor = await waitForObservation(() =>
        observedPid(supervisorPath)
      );
      const worker = await waitForObservation(() => observedPid(workerPath));
      const descendant = await waitForObservation(() =>
        observedPid(descendantPath)
      );
      const observer = watchExits([supervisor, worker, descendant]);
      await observer.ready();
      expect(parent.kill("SIGKILL")).toBe(true);
      await parentExit;
      expect(await observer.exits()).toEqual([222, 1, 1]);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null)
        parent.kill("SIGKILL");
    }
  }, 35_000);

  it("closes the job and stops both live generations when the runner is killed", async () => {
    const workerPath = join(root, "supervisor-death-worker.pid");
    const descendantPath = join(root, "supervisor-death-descendant.pid");
    const supervisor = spawn(
      runner,
      [
        String(process.pid),
        "30000",
        process.execPath,
        root,
        "-e",
        liveWorker,
        workerPath,
        descendantPath,
      ],
      { windowsHide: true, stdio: "ignore" }
    );
    const supervisorExit = once(supervisor, "exit");
    try {
      const worker = await waitForObservation(() => observedPid(workerPath));
      const descendant = await waitForObservation(() =>
        observedPid(descendantPath)
      );
      const observer = watchExits([worker, descendant]);
      await observer.ready();
      expect(supervisor.kill("SIGKILL")).toBe(true);
      await supervisorExit;
      // Kill-on-close guarantees termination. The kernel chooses the exit status.
      expect(await observer.exits()).toEqual([
        expect.any(Number),
        expect.any(Number),
      ]);
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null)
        supervisor.kill("SIGKILL");
    }
  }, 35_000);
});
