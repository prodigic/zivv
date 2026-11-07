import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  linkSync,
  rmSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../../lib/ingestion/steve-preflight.js";
import { observeSelectedLoadStagedSnapshot } from "../../lib/ingestion/recovery-gmail-selected-staged-snapshot.js";
import type { RecoveryRuntimeEntry } from "../../lib/ingestion/recovery-runtime.js";

it("observes exact staged chunks and linked pairs without repairing them", () => {
  const base = mkdtempSync(join(tmpdir(), "zivv-staged-snapshot-"));
  const loadPath = "recovery-gmail-load/" + "a".repeat(64),
    name = "resume-snapshot-000.bin",
    target = loadPath + "/" + name,
    stage = target + "-stage",
    candidate = stage + "/" + name + ".123.0123456789abcdef.tmp",
    snapshot = Buffer.from("encrypted fixture");
  const file = (path: string): RecoveryRuntimeEntry => {
    const bytes = readFileSync(join(base, path));
    return { path, kind: "file", size: bytes.length, sha256: sha256(bytes) };
  };
  const dir = (path: string): RecoveryRuntimeEntry => ({
    path,
    kind: "directory",
  });
  try {
    mkdirSync(join(base, stage), { recursive: true });
    writeFileSync(join(base, candidate), snapshot);
    const staged = [dir(stage), file(candidate)];
    expect(
      observeSelectedLoadStagedSnapshot({
        destination: base,
        loadPath,
        snapshot,
        entries: staged,
      })
    ).toMatchObject({
      entries: [],
      partial: true,
      completeChunks: 0,
      loadAllowed: false,
    });
    linkSync(join(base, candidate), join(base, target));
    const linked = [...staged, file(target)];
    expect(
      observeSelectedLoadStagedSnapshot({
        destination: base,
        loadPath,
        snapshot,
        entries: linked,
      })
    ).toMatchObject({ entries: [], partial: true });
    expect(() =>
      observeSelectedLoadStagedSnapshot({
        destination: base,
        loadPath,
        snapshot,
        entries: linked.filter((entry) => entry.path !== target),
      })
    ).toThrow();
    const forged = linked.map((entry) =>
      entry.path === target && entry.kind === "file"
        ? { ...entry, sha256: "0".repeat(64) }
        : entry
    );
    expect(() =>
      observeSelectedLoadStagedSnapshot({
        destination: base,
        loadPath,
        snapshot,
        entries: forged,
      })
    ).toThrow();
    expect(lstatSync(join(base, target)).nlink).toBe(2);
    expect(() =>
      observeSelectedLoadStagedSnapshot({
        destination: base,
        loadPath,
        snapshot: Buffer.from("different"),
        entries: linked,
      })
    ).toThrow();
    expect(() =>
      observeSelectedLoadStagedSnapshot({
        destination: base,
        loadPath,
        snapshot,
        entries: [...linked, dir(loadPath + "/resume-snapshot-001.bin-stage")],
      })
    ).toThrow();
    expect(lstatSync(join(base, target)).nlink).toBe(2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
it("refuses a later chunk without the installed prefix", () => {
  const base = mkdtempSync(join(tmpdir(), "zivv-staged-order-"));
  const loadPath = "recovery-gmail-load/" + "b".repeat(64),
    name = "resume-snapshot-001.bin",
    stage = loadPath + "/" + name + "-stage",
    candidate = stage + "/" + name + ".123.0123456789abcdef.tmp",
    snapshot = Buffer.alloc(4 * 1024 * 1024 + 1, 3);
  try {
    mkdirSync(join(base, stage), { recursive: true });
    writeFileSync(join(base, candidate), snapshot.subarray(4 * 1024 * 1024));
    const bytes = readFileSync(join(base, candidate));
    const entries: RecoveryRuntimeEntry[] = [
      { path: stage, kind: "directory" },
      {
        path: candidate,
        kind: "file",
        size: bytes.length,
        sha256: sha256(bytes),
      },
    ];
    expect(() =>
      observeSelectedLoadStagedSnapshot({
        destination: base,
        loadPath,
        snapshot,
        entries,
      })
    ).toThrow();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it("identifies only an exact unlinked prefix and never removes it", () => {
  const base = mkdtempSync(join(tmpdir(), "zivv-partial-chunk-"));
  const loadPath = "recovery-gmail-load/" + "c".repeat(64),
    name = "resume-snapshot-000.bin",
    stage = loadPath + "/" + name + "-stage",
    candidate = stage + "/" + name + ".123.0123456789abcdef.tmp",
    snapshot = Buffer.from("encrypted fixture"),
    partial = snapshot.subarray(0, 5);
  try {
    mkdirSync(join(base, stage), { recursive: true });
    writeFileSync(join(base, candidate), partial);
    const entries: RecoveryRuntimeEntry[] = [
      { path: stage, kind: "directory" },
      {
        path: candidate,
        kind: "file",
        size: partial.length,
        sha256: sha256(partial),
      },
    ];
    expect(
      observeSelectedLoadStagedSnapshot({
        destination: base,
        loadPath,
        snapshot,
        entries,
      })
    ).toMatchObject({
      incompleteCandidate: { path: candidate },
      loadAllowed: false,
    });
    expect(readFileSync(join(base, candidate)).equals(partial)).toBe(true);
    const corrupt = Buffer.from("wrong");
    writeFileSync(join(base, candidate), corrupt);
    entries[1] = {
      path: candidate,
      kind: "file",
      size: corrupt.length,
      sha256: sha256(corrupt),
    };
    expect(() =>
      observeSelectedLoadStagedSnapshot({
        destination: base,
        loadPath,
        snapshot,
        entries,
      })
    ).toThrow();
    expect(readFileSync(join(base, candidate)).equals(corrupt)).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
