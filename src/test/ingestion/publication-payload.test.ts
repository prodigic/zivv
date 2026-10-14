import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import {
  encryptLedgerSnapshot,
  loadBackupKey,
} from "../../lib/ingestion/encrypted-backup.js";
import { buildCandidateBundle } from "../../lib/ingestion/candidate-bundle.js";
import {
  CANDIDATE_CONFIG_FILES,
  type CandidateConfiguration,
} from "../../lib/ingestion/export-configuration.js";
import {
  createEmptyWeeklyEditionLedger,
  prepareWeeklyEdition,
  serializeWeeklyLedger,
} from "../../lib/ingestion/weekly.js";
import { canonicalJson } from "../../lib/ingestion/sqlite-store.js";
import type { ApplicationBuildReceipt } from "../../lib/ingestion/source-build.js";
import {
  readPublicationPayloadGit,
  writePublicationPayloadGit,
} from "../../lib/ingestion/publication-git.js";
import {
  createPublicationPayload,
  readPublicationPayload,
  verifyPublicationPayload,
  type PublicationExpectation,
  type PublicationPayload,
  type PublicationReceipt,
} from "../../lib/ingestion/publication-payload.js";

const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const key = Buffer.alloc(32, 17);
const sourceCommit = "a".repeat(40);
let root: string;
let bundle: string;
let payload: PublicationPayload;
let expected: PublicationExpectation;
let preview: PublicationPayload;
let previewExpected: PublicationExpectation;

async function fixture(
  purpose: "release" | "preview",
  basePath: string,
  recoveryKey = key
) {
  const ledger = bootstrapLedger(
    { events: [], artists: [], venues: [] },
    Date.parse("2026-10-09T19:00:00Z")
  );
  const weekly = prepareWeeklyEdition(createEmptyWeeklyEditionLedger(), [], {
    editionId: "week-2026-10-09",
    cutoff: "2026-10-09T19:00:00Z",
    datasetVersion: "captured-empty-edition",
  });
  const configuration = Object.fromEntries(
    CANDIDATE_CONFIG_FILES.map((path) => [path, null])
  ) as CandidateConfiguration;
  configuration["venue-sources.json"] = Buffer.from('{"sources":[]}\n');
  configuration["ingestion/weekly-editions.json"] = Buffer.from(
    serializeWeeklyLedger(weekly.ledger)
  );
  const applicationFiles = new Map([
    [
      "index.html",
      Buffer.from(`<script src="${basePath}assets/app.js"></script>\n`),
    ],
    [
      "404.html",
      Buffer.from(`<script src="${basePath}assets/app.js"></script>\n`),
    ],
    ["assets/app.js", Buffer.from("console.log('captured application');\n")],
    [
      "manifest.json",
      Buffer.from(
        JSON.stringify({ scope: basePath, start_url: basePath }) + "\n"
      ),
    ],
    [".nojekyll", Buffer.alloc(0)],
  ]);
  const applicationBuildManifest = Buffer.from(
    JSON.stringify({ "index.html": { file: "assets/app.js", isEntry: true } }) +
      "\n"
  );
  const receipt: ApplicationBuildReceipt = {
    schemaVersion: 1,
    purpose,
    sourceRepository: "prodigic/zivv",
    sourceCommit,
    sourceTree: "b".repeat(40),
    sourceInventorySha256: "c".repeat(64),
    archiveSha256: "d".repeat(64),
    packageLockSha256: "e".repeat(64),
    etlInventorySha256: "f".repeat(64),
    basePath,
    nodeVersion: process.version,
    npmVersion: "11.6.0",
    buildManifestSha256: hash(applicationBuildManifest),
    applicationFiles: [...applicationFiles]
      .map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: hash(bytes),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  const built = await buildCandidateBundle({
    privateDirectory: join(root, "private-bundles"),
    sourceCommit,
    basePath,
    editionId: weekly.edition.editionId,
    ledger,
    snapshot: encryptLedgerSnapshot(ledger, recoveryKey),
    recoveryKey,
    configuration,
    applicationFiles,
    applicationBuildManifest,
    applicationBuildReceipt: Buffer.from(canonicalJson(receipt) + "\n"),
  });
  const expectation: PublicationExpectation = {
    expectedCandidateId: built.candidate.candidateId,
    expectedSourceCommit: sourceCommit,
    purpose,
    basePath,
  };
  return {
    directory: built.directory,
    expected: expectation,
    payload: await createPublicationPayload({
      ...expectation,
      directory: built.directory,
      recoveryKey,
    }),
  };
}

function files() {
  return new Map(
    [...payload.files].map(([path, bytes]) => [path, Buffer.from(bytes)])
  );
}

function rewrittenReceipt(
  source: ReadonlyMap<string, Buffer>,
  mutate: (receipt: PublicationReceipt) => void
): Map<string, Buffer> {
  const changed = new Map(source);
  const receipt: PublicationReceipt = JSON.parse(
    changed.get("receipt.json")!.toString()
  );
  mutate(receipt);
  const { receiptId: _old, ...identity } = receipt;
  receipt.receiptId = hash(canonicalJson(identity));
  changed.set("receipt.json", Buffer.from(canonicalJson(receipt) + "\n"));
  return changed;
}

function checkout() {
  const directory = mkdtempSync(join(root, "checkout-"));
  for (const [path, bytes] of payload.files) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return directory;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "zivv-publication-payload-"));
  const release = await fixture("release", "/zivv/");
  bundle = release.directory;
  payload = release.payload;
  expected = release.expected;
  const previewFixture = await fixture("preview", "/zivv-test/");
  preview = previewFixture.payload;
  previewExpected = previewFixture.expected;
});

afterAll(() => {
  if (
    !root ||
    !resolve(root).startsWith(resolve(tmpdir(), "zivv-publication-payload-"))
  )
    throw new Error("Unsafe publication fixture cleanup");
  rmSync(root, { recursive: true, force: true });
});

describe("exact publication payload", () => {
  it("preserves authenticated candidate/site/snapshot bytes without private inputs", () => {
    const verified = verifyPublicationPayload(payload.files, expected);
    expect(verified.receipt.candidate.candidateId).toBe(
      expected.expectedCandidateId
    );
    expect(verified.files).toEqual(payload.files);
    expect(verified.publicFiles).toEqual(payload.publicFiles);
    expect(verified.snapshot).toEqual(payload.snapshot);
    expect(
      [...verified.files.keys()].every(
        (path) =>
          path === "receipt.json" ||
          path === "recovery/ledger.snapshot.enc" ||
          path.startsWith("site/")
      )
    ).toBe(true);
    const metadata = JSON.stringify(verified.receipt);
    expect(metadata).not.toContain(root);
    expect(metadata).not.toContain(key.toString("hex"));
    expect(verified.files.has("workspace/data/ingestion/ledger.json")).toBe(
      false
    );
    const reversed = new Map([...payload.files].reverse());
    expect(verifyPublicationPayload(reversed, expected).receipt).toEqual(
      payload.receipt
    );
  });

  it("detaches checked buffers from caller-owned maps and buffers", () => {
    const supplied = files();
    const verified = verifyPublicationPayload(supplied, expected);
    supplied.get("site/index.html")!.fill(0);
    verified.publicFiles.get("index.html")!.fill(0);
    verified.snapshot.fill(0);
    expect(verified.files.get("site/index.html")).toEqual(
      payload.files.get("site/index.html")
    );
    expect(verified.files.get("recovery/ledger.snapshot.enc")).toEqual(
      payload.snapshot
    );
  });

  it("authenticates snapshot with the private key before emitting a receipt", async () => {
    await expect(
      createPublicationPayload({
        ...expected,
        directory: bundle,
        recoveryKey: Buffer.alloc(32, 19),
      })
    ).rejects.toThrow();
  });

  it.each([
    { expectedCandidateId: "1".repeat(64) },
    { expectedSourceCommit: "b".repeat(40) },
    { basePath: "/zivv-test/" },
    { purpose: "preview" as const },
  ])("rejects an independently trusted identity mismatch %j", (override) => {
    expect(() =>
      verifyPublicationPayload(payload.files, { ...expected, ...override })
    ).toThrow(/trusted identity/);
  });

  it("accepts preview siblings but rejects promotion as the release candidate", () => {
    expect(
      verifyPublicationPayload(preview.files, previewExpected).receipt.purpose
    ).toBe("preview");
    expect(() => verifyPublicationPayload(preview.files, expected)).toThrow(
      /trusted identity/
    );
  });

  it.each([
    "site/index.html",
    "site/data/manifest.json",
    "recovery/ledger.snapshot.enc",
  ])("rejects changed bytes in %s", (path) => {
    const changed = files();
    changed.get(path)![0] ^= 1;
    expect(() => verifyPublicationPayload(changed, expected)).toThrow(
      /mismatch/
    );
  });

  it.each(["site/404.html", "recovery/ledger.snapshot.enc", "receipt.json"])(
    "rejects missing file %s",
    (path) => {
      const changed = files();
      changed.delete(path);
      expect(() => verifyPublicationPayload(changed, expected)).toThrow();
    }
  );

  it.each([
    "site/assets/stale.js",
    "recovery/clear-ledger.json",
    "private.key",
    "build/script.js",
    "site/../private.key",
    "/site/index.html",
    "site\\index.html",
    "site/CON.txt",
    "site/index.html:stream",
    "site/index.html.",
    "site/\u0000file",
    "SITE/index.html",
  ])("rejects extra, unsafe or colliding path %s", (path) => {
    const changed = files().set(path, Buffer.from("unreviewed"));
    expect(() => verifyPublicationPayload(changed, expected)).toThrow();
  });

  it("rejects receipt edits, extra keys and noncanonical serialization", () => {
    const original = payload.files.get("receipt.json")!;
    const receipt: PublicationReceipt = JSON.parse(original.toString());
    for (const bytes of [
      Buffer.from(JSON.stringify(receipt)),
      Buffer.from(canonicalJson({ ...receipt, unexpected: true }) + "\n"),
      Buffer.from(canonicalJson({ ...receipt, purpose: "preview" }) + "\n"),
    ]) {
      expect(() =>
        verifyPublicationPayload(files().set("receipt.json", bytes), expected)
      ).toThrow();
    }
  });

  it("recomputes candidate identity even when a tampered receipt is rehashed", () => {
    const changed = rewrittenReceipt(files(), (receipt) => {
      receipt.candidate.ledgerRevision = "2".repeat(64);
    });
    expect(() => verifyPublicationPayload(changed, expected)).toThrow(
      /candidate/i
    );
  });

  it("rejects a rehashed receipt that adds an inventoried private file", () => {
    const extra = Buffer.from("clear private ledger");
    const changed = rewrittenReceipt(
      files().set("recovery/ledger.json", extra),
      (receipt) => {
        receipt.files.push({
          path: "recovery/ledger.json",
          size: extra.length,
          sha256: hash(extra),
        });
      }
    );
    expect(() => verifyPublicationPayload(changed, expected)).toThrow(
      /inventory mismatch/
    );
  });

  it("rejects changed purpose even when the attacker rehashes the receipt", () => {
    const changed = rewrittenReceipt(preview.files, (receipt) => {
      receipt.purpose = "release";
    });
    expect(() =>
      verifyPublicationPayload(changed, {
        ...previewExpected,
        purpose: "release",
      })
    ).toThrow(/Build purpose/);
    const forgedBuild = rewrittenReceipt(preview.files, (receipt) => {
      receipt.purpose = "release";
      const build: ApplicationBuildReceipt = JSON.parse(
        Buffer.from(receipt.applicationBuildReceipt, "base64").toString()
      );
      build.purpose = "release";
      receipt.applicationBuildReceipt = Buffer.from(
        canonicalJson(build) + "\n"
      ).toString("base64");
    });
    expect(() =>
      verifyPublicationPayload(forgedBuild, {
        ...previewExpected,
        purpose: "release",
      })
    ).toThrow(/build metadata mismatch/);
  });

  it("rejects noncanonical base64 and modified build manifests", () => {
    for (const mutate of [
      (receipt: PublicationReceipt) => {
        receipt.applicationBuildManifest += "\n";
      },
      (receipt: PublicationReceipt) => {
        receipt.applicationBuildManifest = Buffer.from("{}").toString("base64");
      },
    ]) {
      expect(() =>
        verifyPublicationPayload(rewrittenReceipt(files(), mutate), expected)
      ).toThrow();
    }
  });

  it("reads exact materialized payload without requiring a recovery key", () => {
    expect(readPublicationPayload(checkout(), expected).files).toEqual(
      payload.files
    );
  });

  it("persists privately authenticated bytes through raw Git and rechecks them without keys", () => {
    const repositoryRoot = join(root, "payload-repository");
    mkdirSync(repositoryRoot);
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    git(["init", "--quiet"]);
    git(["remote", "add", "origin", "https://github.com/prodigic/zivv.git"]);
    git(["config", "core.autocrlf", "true"]);
    const createdAt = "2026-10-09T19:00:00.000Z";
    const stored = writePublicationPayloadGit({
      repositoryRoot,
      files: payload.files,
      createdAt,
    });
    const restored = readPublicationPayloadGit({
      repositoryRoot,
      payloadCommit: stored.payloadCommit,
      createdAt,
    });
    expect(restored.files).toEqual(payload.files);
    expect(verifyPublicationPayload(restored.files, expected).receipt).toEqual(
      payload.receipt
    );
    expect(restored.tree).toBe(stored.tree);
  }, 30_000);

  it("prepares and verifies the exact payload through the operator CLI", async () => {
    const operatorDirectory = join(root, "cli-operator");
    const recoveryKey = loadBackupKey(operatorDirectory, true);
    const candidate = await fixture("release", "/zivv/", recoveryKey);
    const repositoryRoot = join(root, "cli-repository");
    mkdirSync(repositoryRoot);
    execFileSync("git", ["init", "--quiet", repositoryRoot], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/prodigic/zivv.git"],
      {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    const script = resolve("scripts/prepare-publication-payload.js");
    const common = [
      "--root",
      repositoryRoot,
      "--candidate-id",
      candidate.expected.expectedCandidateId,
      "--source-commit",
      candidate.expected.expectedSourceCommit,
      "--purpose",
      "release",
      "--base",
      "/zivv/",
    ];
    const invoke = (command: string, args: string[]) =>
      JSON.parse(
        execFileSync(process.execPath, [script, command, ...common, ...args], {
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      ) as {
        verified: boolean;
        payloadCommit: string;
        receiptId: string;
        candidateId: string;
      };
    const prepared = invoke("prepare", [
      "--directory",
      candidate.directory,
      "--operator-dir",
      operatorDirectory,
      "--created-at",
      "2026-10-09T19:00:00.000Z",
    ]);
    expect(prepared.verified).toBe(true);
    expect(prepared.candidateId).toBe(candidate.expected.expectedCandidateId);
    const checked = invoke("verify", [
      "--payload-commit",
      prepared.payloadCommit,
    ]);
    expect(checked).toEqual(prepared);
    const remoteBuffers = readPublicationPayloadGit({
      repositoryRoot,
      payloadCommit: prepared.payloadCommit,
    });
    expect(remoteBuffers.files).toEqual(candidate.payload.files);
    expect(prepared.receiptId).toBe(candidate.payload.receipt.receiptId);
  }, 60_000);

  it("rejects extra empty directories", () => {
    const directory = checkout();
    mkdirSync(join(directory, "site/empty"));
    expect(() => readPublicationPayload(directory, expected)).toThrow(
      /Unexpected.*directory/
    );
  });

  it("rejects hard-linked public files", () => {
    const directory = checkout();
    const target = join(directory, "site/index.html");
    linkSync(target, join(root, "hardlink"));
    expect(() => readPublicationPayload(directory, expected)).toThrow(
      /unlinked regular files/
    );
    unlinkSync(join(root, "hardlink"));
  });

  it.each(["site", "payload-root"])("rejects linked directory %s", (name) => {
    const directory = checkout();
    const linked = join(root, "linked-" + name);
    if (name === "site") {
      rmSync(join(directory, "site"), { recursive: true });
      symlinkSync(
        join(root, "private-bundles"),
        join(directory, "site"),
        process.platform === "win32" ? "junction" : "dir"
      );
      expect(() => readPublicationPayload(directory, expected)).toThrow(
        /unlinked regular files|Linked/
      );
    } else {
      symlinkSync(
        directory,
        linked,
        process.platform === "win32" ? "junction" : "dir"
      );
      expect(() => readPublicationPayload(linked, expected)).toThrow(/Linked/);
    }
  });
});
