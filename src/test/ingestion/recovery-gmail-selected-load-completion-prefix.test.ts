import { expect, it } from "vitest";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryRuntimeEntry } from "../../lib/ingestion/recovery-runtime.js";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { observeSelectedLoadCompletionPrefix } from "../../lib/ingestion/recovery-gmail-selected-load-completion-prefix.js";

const runId = "a".repeat(64);
const loadPath = "recovery-gmail-load/" + runId;
const files = [
  { name: "history-catalog-000.bin", bytes: Buffer.from("catalog bytes") },
  { name: "history-journal-000.bin", bytes: Buffer.from("journal bytes") },
  { name: "history-inventory-000.bin", bytes: Buffer.from("inventory bytes") },
  { name: "history-manifest.json", bytes: Buffer.from("manifest bytes") },
];
const result = Buffer.from("signed result bytes");
const suffix = ".123.0123456789abcdef.tmp";

function fixture() {
  const destination = mkdtempSync(join(tmpdir(), "zivv-completion-prefix-"));
  mkdirSync(join(destination, loadPath), { recursive: true });
  const stage = (name: string) => `${loadPath}/${name}-stage`;
  const target = (name: string) => `${loadPath}/${name}`;
  const candidate = (name: string) => `${stage(name)}/${name}${suffix}`;
  const makeStage = (name: string) => mkdirSync(join(destination, stage(name)));
  const settle = (name: string, bytes: Buffer) => {
    makeStage(name);
    writeFileSync(join(destination, target(name)), bytes);
  };
  const entries = () => {
    const found: RecoveryRuntimeEntry[] = [];
    const walk = (relative: string) => {
      for (const name of readdirSync(join(destination, relative)).sort()) {
        const path = relative ? `${relative}/${name}` : name;
        const stat = lstatSync(join(destination, path));
        if (stat.isDirectory()) {
          found.push({ path, kind: "directory" });
          walk(path);
        } else {
          const bytes = readFileSync(join(destination, path));
          found.push({
            path,
            kind: "file",
            size: bytes.length,
            sha256: sha256(bytes),
          });
        }
      }
    };
    walk("");
    return found;
  };
  const observe = () =>
    observeSelectedLoadCompletionPrefix({
      destination,
      runId,
      entries: entries(),
      files,
      result,
    });
  return { destination, stage, target, candidate, makeStage, settle, observe };
}

it("recognizes settled prefixes and requires the result after the manifest", () => {
  const f = fixture();
  try {
    expect(f.observe()).toMatchObject({
      settledCount: 0,
      next: { name: files[0]!.name, state: "absent" },
      loadAllowed: false,
    });
    f.settle(files[0]!.name, files[0]!.bytes);
    expect(f.observe()).toMatchObject({
      settledCount: 1,
      next: { name: files[1]!.name, state: "absent" },
      loadAllowed: false,
    });
    for (const item of files.slice(1)) f.settle(item.name, item.bytes);
    expect(f.observe()).toMatchObject({
      settledCount: files.length,
      next: { name: "load-result.json", state: "absent" },
      loadAllowed: false,
    });
    f.settle("load-result.json", result);
    const complete = f.observe();
    expect(complete).toMatchObject({
      settledCount: files.length + 1,
      loadAllowed: false,
    });
    expect(complete.next).toBeUndefined();
  } finally {
    rmSync(f.destination, { recursive: true, force: true });
  }
});

it("classifies one exact staged candidate, partial, and linked installation without changing it", () => {
  const f = fixture();
  try {
    f.settle(files[0]!.name, files[0]!.bytes);
    const next = files[1]!;
    f.makeStage(next.name);
    expect(f.observe()).toMatchObject({
      settledCount: 1,
      next: { name: next.name, state: "stage-only" },
    });
    const candidatePath = join(f.destination, f.candidate(next.name));
    writeFileSync(candidatePath, next.bytes.subarray(0, 4));
    expect(f.observe()).toMatchObject({
      settledCount: 1,
      next: { name: next.name, state: "partial" },
      loadAllowed: false,
    });
    writeFileSync(candidatePath, next.bytes);
    expect(f.observe()).toMatchObject({
      settledCount: 1,
      next: { name: next.name, state: "candidate" },
      loadAllowed: false,
    });
    linkSync(candidatePath, join(f.destination, f.target(next.name)));
    expect(f.observe()).toMatchObject({
      settledCount: 1,
      next: { name: next.name, state: "linked" },
      loadAllowed: false,
    });
    expect(lstatSync(candidatePath).nlink).toBe(2);
    expect(readFileSync(candidatePath)).toEqual(next.bytes);
  } finally {
    rmSync(f.destination, { recursive: true, force: true });
  }
});

it("refuses after-gap effects, unknown family members, and changed bytes", () => {
  for (const variant of [
    "gap",
    "unknown-file",
    "unknown-dir",
    "tamper",
    "foreign-candidate",
  ] as const) {
    const f = fixture();
    try {
      if (variant === "gap") f.settle(files[1]!.name, files[1]!.bytes);
      if (variant === "unknown-file")
        writeFileSync(
          join(f.destination, loadPath, "history-unknown.bin"),
          "unknown"
        );
      if (variant === "unknown-dir")
        mkdirSync(join(f.destination, loadPath, "history-unknown-stage"));
      if (variant === "tamper")
        f.settle(files[0]!.name, Buffer.from("different"));
      if (variant === "foreign-candidate") {
        f.makeStage(files[0]!.name);
        writeFileSync(
          join(f.destination, f.candidate(files[0]!.name)),
          "wrong"
        );
      }
      expect(() => f.observe(), variant).toThrow();
    } finally {
      rmSync(f.destination, { recursive: true, force: true });
    }
  }
});
