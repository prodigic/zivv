import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryCandidateLocations } from "../../lib/ingestion/recovery-candidate-locations.js";
import type { OperatorRecoveryCheckpoint } from "../../lib/ingestion/operator-recovery.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const work = "weekly-candidates/candidate-work-retained";
const bundle = work + "/candidate-retained";
const contents = "unchanged retained receipt\n";

describe("retained candidate location mapping without effect authority", () => {
  let home: string, root: string, original: string;
  let checkpoint: OperatorRecoveryCheckpoint;
  function exportsAt(path: string): void {
    // Authentication belongs to admission. This unit fixture supplies only the
    // already-validated journal projection consumed by the read-only mapper.
    checkpoint.journal = Buffer.from(
      JSON.stringify({
        stageArtifacts: [
          {
            stage: "export",
            bytes: Buffer.from(
              JSON.stringify({ schemaVersion: 1, workDirectory: path })
            ).toString("base64"),
          },
        ],
      })
    ).toString("base64");
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "zivv-candidate-locations-"));
    root = join(home, "prepared");
    original = join(home, "original-operator", work);
    mkdirSync(join(root, "operator", bundle), { recursive: true });
    writeFileSync(join(root, "operator", bundle, "candidate.json"), contents);
    checkpoint = {
      format: "zivv-operator-recovery",
      version: 2,
      createdAtEpochMs: 1000,
      originalOperatorDirectory: join(home, "original-operator"),
      originalCheckout: join(home, "original-checkout"),
      runtime: {
        node: process.version,
        icu: process.versions.icu ?? "",
        executableSha256: "a".repeat(64),
        workerSha256: "b".repeat(64),
        lockfileSha256: "c".repeat(64),
      },
      ledgerRevision: "d".repeat(64),
      ledger: bootstrapLedger({ events: [], artists: [], venues: [] }, 1000),
      journal: "",
      directories: [
        { area: "operator", path: work },
        { area: "operator", path: bundle },
      ],
      files: [
        {
          area: "operator",
          path: bundle + "/candidate.json",
          bytes: Buffer.from(contents).toString("base64"),
          sha256: hash(contents),
        },
      ],
    };
    exportsAt(original);
  });
  afterEach(() => {
    if (!home.startsWith(join(tmpdir(), "zivv-candidate-locations-")))
      throw new Error("Unsafe fixture cleanup");
    rmSync(home, { recursive: true, force: true });
  });
  const mapper = () => createRecoveryCandidateLocations(checkpoint, root);

  it("maps only the captured exact export role and preserves retained bytes while SQLite changes", () => {
    const context = mapper();
    writeFileSync(
      join(root, "operator", "weekly-runs.sqlite-wal"),
      "active journal"
    );
    expect(context.resolveExportWorkDirectory(original)).toBe(
      join(root, "operator", work)
    );
    expect(
      readFileSync(join(root, "operator", bundle, "candidate.json"), "utf8")
    ).toBe(contents);
    expect(() =>
      context.resolveExportWorkDirectory(join(original, "candidate-retained"))
    ).toThrow();
    expect(() => context.resolveExportWorkDirectory(original + "/.")).toThrow();
    expect(() =>
      context.resolveExportWorkDirectory(join(home, "outside"))
    ).toThrow();
  });

  it("refuses missing retained directories and files and extra unretained bundle paths", () => {
    checkpoint.directories = checkpoint.directories.filter(
      (entry) => entry.path !== work
    );
    expect(() => mapper().resolveExportWorkDirectory(original)).toThrow();
    checkpoint.directories.push({ area: "operator", path: work });
    const context = mapper();
    writeFileSync(join(root, "operator", bundle, "extra.txt"), "extra");
    expect(() => context.resolveExportWorkDirectory(original)).toThrow();
    rmSync(join(root, "operator", bundle, "extra.txt"));
    rmSync(join(root, "operator", bundle, "candidate.json"));
    expect(() => context.resolveExportWorkDirectory(original)).toThrow();
  });

  it("refuses duplicate or case-ambiguous retained directory inventory", () => {
    checkpoint.directories.push({ area: "operator", path: work });
    expect(() => mapper().resolveExportWorkDirectory(original)).toThrow();
    checkpoint.directories.pop();
    checkpoint.directories.push({
      area: "operator",
      path: work + "/CANDIDATE-RETAINED",
    });
    expect(() => mapper().resolveExportWorkDirectory(original)).toThrow();
  });

  it("rejects observed paths in another role or original checkout", () => {
    const source = join(original, "source-build-retained");
    exportsAt(source);
    checkpoint.directories.push({
      area: "operator",
      path: work + "/source-build-retained",
    });
    expect(() => mapper().resolveExportWorkDirectory(source)).toThrow();
    const checkoutPath = join(checkpoint.originalCheckout, work);
    exportsAt(checkoutPath);
    checkpoint.directories.push({ area: "checkout", path: work });
    expect(() => mapper().resolveExportWorkDirectory(checkoutPath)).toThrow();
  });

  it("rejects overlapping original roots and prepared paths or noncanonical input", () => {
    checkpoint.originalCheckout = join(
      checkpoint.originalOperatorDirectory,
      "checkout"
    );
    expect(mapper).toThrow();
    checkpoint.originalCheckout = join(home, "original-checkout");
    expect(() =>
      createRecoveryCandidateLocations(
        checkpoint,
        checkpoint.originalOperatorDirectory
      )
    ).toThrow();
    expect(() =>
      createRecoveryCandidateLocations(checkpoint, root + "/.")
    ).toThrow();
    expect(() =>
      createRecoveryCandidateLocations(checkpoint, resolve(root, "../missing"))
    ).toThrow();
  });

  it("rejects linked work directories, Git boundaries and changed retained bytes on reuse", () => {
    const context = mapper();
    writeFileSync(
      join(root, "operator", bundle, "candidate.json"),
      "changed receipt\n"
    );
    expect(() => context.resolveExportWorkDirectory(original)).toThrow();
    writeFileSync(join(root, "operator", bundle, "candidate.json"), contents);
    mkdirSync(join(root, "operator", ".git"));
    expect(() => context.resolveExportWorkDirectory(original)).toThrow();
    rmSync(join(root, "operator", ".git"), { recursive: true });
    rmSync(join(root, "operator", work), { recursive: true });
    const target = join(home, "linked-work");
    mkdirSync(target);
    symlinkSync(
      target,
      join(root, "operator", work),
      process.platform === "win32" ? "junction" : "dir"
    );
    expect(() => context.resolveExportWorkDirectory(original)).toThrow();
  });
});
