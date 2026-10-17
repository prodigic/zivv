import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { IngestionLedger } from "../../types/ingestion.js";
import { ETLProcessor } from "../etl/processor.js";
import { validateLedger } from "./ledger.js";
import { canonicalJson } from "./sqlite-store.js";
import {
  secureOperatorDirectory,
  writeDurableFile,
} from "./encrypted-backup.js";
import {
  CANDIDATE_CONFIG_FILES,
  configurationInventory,
  type CandidateConfiguration,
} from "./export-configuration.js";
import {
  sealReleaseCandidate,
  verifySealedCandidate,
  type CandidateInputs,
  type ReleaseCandidate,
} from "./release-candidate.js";

function privateDirectory(path: string): string {
  const requested = resolve(path);
  let ancestor = requested;
  while (!existsSync(ancestor)) {
    if (dirname(ancestor) === ancestor)
      throw new Error("Invalid private directory");
    ancestor = dirname(ancestor);
  }
  const actual = resolve(realpathSync(ancestor), relative(ancestor, requested));
  if (actual.startsWith("\\\\"))
    throw new Error("Candidate requires local private storage");
  for (let parent = actual; ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git")))
      throw new Error("Candidate bundle must be outside Git repositories");
    if (dirname(parent) === parent) break;
  }
  return actual;
}
function readRegular(path: string): Buffer {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (lstatSync(parent).isSymbolicLink())
      throw new Error("Linked candidate parent refused");
    if (dirname(parent) === parent) break;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("Linked candidate file refused");
  return readFileSync(path);
}
function publicTree(directory: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  function walk(path: string, prefix: string) {
    if (lstatSync(path).isSymbolicLink())
      throw new Error("Linked candidate directory refused");
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const key = prefix + name;
      const stat = lstatSync(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(child, key + "/");
      else files.set(key, readRegular(child));
    }
  }
  walk(directory, "");
  return files;
}
export interface BuildCandidateBundleInput {
  privateDirectory: string;
  sourceCommit: string;
  basePath: string;
  editionId: string;
  ledger: IngestionLedger;
  snapshot: Buffer;
  recoveryKey: Buffer;
  configuration: CandidateConfiguration;
  /** Compiled app files only; the captured ETL generates every data file. */
  applicationFiles: ReadonlyMap<string, Buffer>;
  applicationBuildManifest: Buffer;
}

/** Export from captured private inputs, then persist a checked public/private pair. */
export async function buildCandidateBundle(
  input: BuildCandidateBundleInput
): Promise<{ directory: string; candidate: ReleaseCandidate }> {
  configurationInventory(input.configuration);
  // Copy before the first await: caller mutations cannot change this export.
  const configuration = Object.fromEntries(
    CANDIDATE_CONFIG_FILES.map((path) => [
      path,
      input.configuration[path] === null
        ? null
        : Buffer.from(input.configuration[path]!),
    ])
  ) as CandidateConfiguration;
  const captured = {
    sourceCommit: input.sourceCommit,
    basePath: input.basePath,
    editionId: input.editionId,
    ledger: structuredClone(input.ledger),
    snapshot: Buffer.from(input.snapshot),
    recoveryKey: Buffer.from(input.recoveryKey),
    configuration,
    applicationBuildManifest: Buffer.from(input.applicationBuildManifest),
  };
  const files = new Map(
    [...input.applicationFiles].map(([path, bytes]) => [
      path,
      Buffer.from(bytes),
    ])
  );
  if ([...files.keys()].some((path) => path.startsWith("data/")))
    throw new Error("Application input must exclude stale data files");
  const parent = privateDirectory(input.privateDirectory);
  secureOperatorDirectory(parent);
  const directory = mkdtempSync(join(parent, "candidate-"));
  secureOperatorDirectory(directory);
  const workspace = join(directory, "workspace");
  writeDurableFile(
    join(workspace, "data/ingestion/ledger.json"),
    Buffer.from(canonicalJson(captured.ledger) + "\n")
  );
  for (const path of CANDIDATE_CONFIG_FILES) {
    const bytes = configuration[path];
    if (bytes !== null) writeDurableFile(join(workspace, "data", path), bytes);
  }
  const result = await new ETLProcessor(workspace).processData();
  if (!result.success)
    throw new Error(
      "Captured candidate ETL failed: " +
        result.errors.map((item) => item.message).join("; ")
    );
  for (const [path, bytes] of publicTree(join(workspace, "public/data")))
    files.set("data/" + path, bytes);
  const candidate = sealReleaseCandidate({ ...captured, publicFiles: files });
  // Sealing checked every path before any supplied app file is materialized.
  for (const [path, bytes] of files)
    writeDurableFile(join(workspace, "public", path), bytes);
  writeDurableFile(
    join(directory, "recovery/ledger.snapshot.enc"),
    captured.snapshot
  );
  writeDurableFile(
    join(directory, "candidate.json"),
    Buffer.from(canonicalJson(candidate) + "\n")
  );
  writeDurableFile(
    join(directory, "build/vite-manifest.json"),
    captured.applicationBuildManifest
  );
  // This marker is the last write. Interrupted partial bundles are ineligible.
  writeDurableFile(
    join(directory, "complete.json"),
    Buffer.from(
      canonicalJson({ schemaVersion: 1, candidateId: candidate.candidateId }) +
        "\n"
    )
  );
  return { directory, candidate };
}

/** Load and verify into memory; publishers must upload these verified bytes. */
export async function readVerifiedCandidateBundle(
  path: string,
  recoveryKey: Buffer,
  expectedCandidateId: string
): Promise<{
  candidate: ReleaseCandidate;
  publicFiles: Map<string, Buffer>;
  snapshot: Buffer;
}> {
  const directory = privateDirectory(path);
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Linked candidate directory refused");
  const candidate: ReleaseCandidate = JSON.parse(
    readRegular(join(directory, "candidate.json")).toString("utf8")
  );
  if (
    !/^[a-f0-9]{64}$/.test(expectedCandidateId) ||
    candidate.candidateId !== expectedCandidateId
  )
    throw new Error("Candidate does not match trusted run receipt");
  const complete: unknown = JSON.parse(
    readRegular(join(directory, "complete.json")).toString("utf8")
  );
  if (
    canonicalJson(complete) !==
    canonicalJson({ schemaVersion: 1, candidateId: candidate.candidateId })
  )
    throw new Error("Candidate incomplete or marker mismatch");
  const workspace = join(directory, "workspace");
  const configuration = Object.fromEntries(
    CANDIDATE_CONFIG_FILES.map((name) => {
      const file = join(workspace, "data", name);
      try {
        return [name, readRegular(file)];
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [name, null];
        throw error;
      }
    })
  ) as CandidateConfiguration;
  const publicFiles = publicTree(join(workspace, "public"));
  const snapshot = readRegular(join(directory, "recovery/ledger.snapshot.enc"));
  const ledger: unknown = JSON.parse(
    readRegular(join(workspace, "data/ingestion/ledger.json")).toString("utf8")
  );
  validateLedger(ledger);
  const inputs: CandidateInputs = {
    sourceCommit: candidate.sourceCommit,
    basePath: candidate.basePath,
    editionId: candidate.editionId,
    ledger,
    applicationBuildManifest: readRegular(
      join(directory, "build/vite-manifest.json")
    ),
    snapshot,
    recoveryKey,
    configuration,
    publicFiles,
  };
  verifySealedCandidate(candidate, inputs);
  return { candidate, publicFiles, snapshot };
}
