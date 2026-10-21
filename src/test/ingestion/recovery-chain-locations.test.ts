import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createRecoveryCandidateLocations,
  createRecoveryResultChainCandidateLocations,
} from "../../lib/ingestion/recovery-candidate-locations.js";
import {
  decryptRecoveryResultChain,
  encryptRecoveryResultChain,
} from "../../lib/ingestion/recovery-result-chain.js";
import { createRecoveryResultChainFixture } from "./fixtures/recovery-result-chain-fixture.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedParts(path: string): string[] {
  const parts = path.split("/");
  if (
    !path ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        part.includes(":")
    )
  )
    throw new Error("Unsafe authenticated fixture path");
  return parts;
}

describe("authenticated recovery chain candidate location mapping", () => {
  // The chain fixture uses a synthetic app-build receipt. This verifies only
  // the authenticated mapping contract, not genuine new-host acceptance.
  let setup: Awaited<ReturnType<typeof createRecoveryResultChainFixture>>;
  let chain: Buffer;
  let proof: ReturnType<typeof decryptRecoveryResultChain>;
  const roots: string[] = [];

  beforeAll(async () => {
    setup = await createRecoveryResultChainFixture();
    chain = encryptRecoveryResultChain({
      members: setup.members,
      recoveryKey: setup.key,
    });
    proof = decryptRecoveryResultChain(chain, setup.key);
  }, 120_000);

  afterEach(() => {
    for (const root of roots.splice(0)) {
      if (!root.startsWith(join(tmpdir(), "zivv-chain-locations-")))
        throw new Error("Unsafe recovery chain location cleanup");
      rmSync(root, { recursive: true, force: true });
    }
  });

  afterAll(() => setup?.cleanup());

  const exportRole = () => proof.certificate.exportRole;

  function stagePreparedRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "zivv-chain-locations-"));
    roots.push(root);
    const operator = join(root, "operator");
    mkdirSync(operator);
    const relativeWork = exportRole().workRelative;
    const directories = proof.successorCheckpoint.directories.filter(
      (entry) =>
        entry.area === "operator" &&
        (entry.path === relativeWork ||
          entry.path.startsWith(relativeWork + "/"))
    );
    const files = proof.successorCheckpoint.files.filter(
      (entry) =>
        entry.area === "operator" && entry.path.startsWith(relativeWork + "/")
    );
    for (const entry of directories.sort(
      (left, right) => left.path.length - right.path.length
    )) {
      const target = join(operator, ...checkedParts(entry.path));
      const suffix = relative(operator, target);
      if (suffix === ".." || suffix.startsWith(".." + sep))
        throw new Error("Authenticated directory escaped operator root");
      mkdirSync(target, { recursive: true });
    }
    for (const entry of files) {
      if (entry.bytes === null) continue;
      const target = join(operator, ...checkedParts(entry.path));
      const suffix = relative(operator, target);
      if (suffix === ".." || suffix.startsWith(".." + sep))
        throw new Error("Authenticated file escaped operator root");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(entry.bytes, "base64"), { flag: "wx" });
    }
    return root;
  }

  function mapper(root: string) {
    return createRecoveryResultChainCandidateLocations({
      chain,
      recoveryKey: setup.key,
      preparedRoot: root,
    });
  }

  function physicalPath(root: string): string {
    return join(root, "operator", ...checkedParts(exportRole().workRelative));
  }

  it("maps the authenticated namespaced export to the prepared tree with exact retained bytes", () => {
    const root = stagePreparedRoot();
    const resolved = mapper(root).resolveExportWorkDirectory(
      exportRole().workDirectory
    );
    expect(resolved).toBe(physicalPath(root));
    for (const entry of proof.successorCheckpoint.files) {
      if (
        entry.area !== "operator" ||
        !entry.path.startsWith(exportRole().workRelative + "/") ||
        entry.bytes === null
      )
        continue;
      expect(
        readFileSync(join(root, "operator", ...checkedParts(entry.path)))
      ).toEqual(Buffer.from(entry.bytes, "base64"));
    }
    expect(() =>
      createRecoveryCandidateLocations(
        proof.successorCheckpoint,
        root
      ).resolveExportWorkDirectory(exportRole().workDirectory)
    ).toThrow();
  });

  it("rejects enrich, unselected and changed work-directory paths", () => {
    const root = stagePreparedRoot();
    const context = mapper(root);
    const role = exportRole();
    const sibling = dirname(role.workDirectory);
    const rejectedPaths = [
      join(sibling, "candidate-work-enrich"),
      join(sibling, "candidate-work-unselected"),
      join(role.workDirectory, "changed"),
    ];
    for (const path of rejectedPaths)
      expect(() => context.resolveExportWorkDirectory(path)).toThrow();
  });

  it("refuses extra, missing and changed retained files on resolver reuse", () => {
    const root = stagePreparedRoot();
    const context = mapper(root);
    const role = exportRole();
    const retained = proof.successorCheckpoint.files.find(
      (entry) =>
        entry.area === "operator" &&
        entry.path.startsWith(role.workRelative + "/") &&
        entry.bytes !== null
    );
    if (!retained?.bytes) throw new Error("Fixture needs a retained work file");
    const retainedPath = join(root, "operator", ...checkedParts(retained.path));
    const originalBytes = Buffer.from(retained.bytes, "base64");
    const extraPath = join(physicalPath(root), "unretained-extra.txt");
    writeFileSync(extraPath, "extra", { flag: "wx" });
    expect(() =>
      context.resolveExportWorkDirectory(role.workDirectory)
    ).toThrow();
    rmSync(extraPath);
    rmSync(retainedPath);
    expect(() =>
      context.resolveExportWorkDirectory(role.workDirectory)
    ).toThrow();
    writeFileSync(retainedPath, originalBytes, { flag: "wx" });
    writeFileSync(retainedPath, Buffer.from("changed"));
    expect(() =>
      context.resolveExportWorkDirectory(role.workDirectory)
    ).toThrow();
    expect(sha256(originalBytes)).toBe(retained.sha256);
  });

  it("refuses symlinked export roots and Git boundaries", () => {
    const linkedRoot = stagePreparedRoot();
    const target = join(linkedRoot, "linked-target");
    mkdirSync(target);
    const exportRoot = physicalPath(linkedRoot);
    rmSync(exportRoot, { recursive: true });
    symlinkSync(
      target,
      exportRoot,
      process.platform === "win32" ? "junction" : "dir"
    );
    expect(() =>
      mapper(linkedRoot).resolveExportWorkDirectory(exportRole().workDirectory)
    ).toThrow();

    const gitRoot = stagePreparedRoot();
    mkdirSync(join(gitRoot, "operator", ".git"));
    expect(() =>
      mapper(gitRoot).resolveExportWorkDirectory(exportRole().workDirectory)
    ).toThrow();
  });

  it("rejects wrong keys and tampered chains before inspecting prepared paths", () => {
    const absentRoot = join(tmpdir(), "zivv-chain-locations-not-created");
    expect(existsSync(absentRoot)).toBe(false);
    expect(() =>
      createRecoveryResultChainCandidateLocations({
        chain,
        recoveryKey: Buffer.alloc(setup.key.length, 7),
        preparedRoot: absentRoot,
      })
    ).toThrow();
    const tampered = Buffer.from(chain);
    tampered[tampered.length - 1] ^= 1;
    expect(() =>
      createRecoveryResultChainCandidateLocations({
        chain: tampered,
        recoveryKey: setup.key,
        preparedRoot: absentRoot,
      })
    ).toThrow();
    expect(existsSync(absentRoot)).toBe(false);
  });
});
