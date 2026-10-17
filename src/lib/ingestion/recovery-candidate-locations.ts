import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OperatorRecoveryCheckpoint } from "./operator-recovery.js";
import type { WeeklyJournalRecoverySnapshot } from "./weekly-run-journal.js";

function fail(): never {
  throw new Error("INVALID_RECOVERY_CANDIDATE_LOCATION");
}
function absolute(path: string): string {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.startsWith("\\\\") ||
    path.startsWith("//") ||
    path.includes("\0")
  )
    fail();
  return path;
}
function inside(root: string, path: string): string | null {
  const suffix = relative(root, path);
  return suffix === "" ||
    (suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix))
    ? suffix.replaceAll("\\", "/")
    : null;
}
function privateDirectory(path: string): void {
  absolute(path);
  for (let item = path; ; item = dirname(item)) {
    const stat = lstatSync(item);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      existsSync(join(item, ".git"))
    )
      fail();
    if (dirname(item) === item) break;
  }
  if (realpathSync(path) !== path) fail();
}

/**
 * Map retained export locations after checkpoint authentication. This read-only
 * mapper grants no import/publication authority and never inspects live SQLite.
 */
export function createRecoveryCandidateLocations(
  checkpoint: OperatorRecoveryCheckpoint,
  preparedRoot: string
): { resolveExportWorkDirectory(original: string): string } {
  const root = absolute(preparedRoot);
  const originalRoots = [
    absolute(checkpoint.originalOperatorDirectory),
    absolute(checkpoint.originalCheckout),
  ];
  if (
    inside(originalRoots[0], originalRoots[1]) !== null ||
    inside(originalRoots[1], originalRoots[0]) !== null ||
    originalRoots.some(
      (old) => inside(old, root) !== null || inside(root, old) !== null
    )
  )
    fail();
  privateDirectory(root);
  // The caller already authenticated/validated this canonical checkpoint. Only
  // its captured export intents establish the role of an original directory.
  const journal = JSON.parse(
    Buffer.from(checkpoint.journal, "base64").toString("utf8")
  ) as WeeklyJournalRecoverySnapshot;
  const exports = new Set(
    journal.stageArtifacts
      .filter((artifact) => artifact.stage === "export")
      .map((artifact) => {
        const intent = JSON.parse(
          Buffer.from(artifact.bytes, "base64").toString("utf8")
        ) as { schemaVersion?: unknown; workDirectory?: unknown };
        if (
          intent.schemaVersion !== 1 ||
          typeof intent.workDirectory !== "string"
        )
          fail();
        return absolute(intent.workDirectory);
      })
  );
  // Copy the retained inventory so mutations of the caller's checkpoint object
  // cannot change which paths or bytes this resolver accepts later.
  const directories = checkpoint.directories.map((entry) => ({ ...entry }));
  const files = checkpoint.files.map((entry) => ({ ...entry }));
  function resolveExportWorkDirectory(original: string): string {
    absolute(original);
    if (!exports.has(original)) fail();
    const matches = originalRoots.flatMap((old, index) => {
      const path = inside(old, original);
      return path === null
        ? []
        : [{ area: index === 0 ? "operator" : "checkout", path }];
    });
    if (matches.length !== 1) fail();
    const mapped = matches[0];
    if (
      mapped.area !== "operator" ||
      !/^weekly-candidates\/candidate-work-[A-Za-z0-9_-]+$/.test(mapped.path) ||
      directories.filter(
        (entry) => entry.area === mapped.area && entry.path === mapped.path
      ).length !== 1
    )
      fail();
    const prefix = mapped.path + "/";
    const retainedDirectories = directories.filter(
      (entry) =>
        entry.area === "operator" &&
        (entry.path === mapped.path || entry.path.startsWith(prefix))
    );
    const retainedFiles = files.filter(
      (entry) => entry.area === "operator" && entry.path.startsWith(prefix)
    );
    const names = new Set<string>();
    for (const entry of [...retainedDirectories, ...retainedFiles]) {
      if (
        entry.path
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              part.includes("\\") ||
              part.includes(":")
          ) ||
        names.has(entry.path.toLowerCase())
      )
        fail();
      names.add(entry.path.toLowerCase());
    }
    const wantedDirectories = new Set(
      retainedDirectories.map((entry) => entry.path)
    );
    const wantedFiles = new Map(
      retainedFiles.map((entry) => [entry.path, entry])
    );
    const seenDirectories = new Set<string>();
    const seenFiles = new Set<string>();
    function walk(path: string): void {
      const physical = join(root, "operator", path);
      privateDirectory(physical);
      if (!wantedDirectories.has(path)) fail();
      seenDirectories.add(path);
      for (const name of readdirSync(physical)) {
        const child = path + "/" + name;
        const location = join(physical, name);
        const stat = lstatSync(location);
        if (stat.isSymbolicLink()) fail();
        if (stat.isDirectory()) walk(child);
        else {
          const retained = wantedFiles.get(child);
          if (
            !retained ||
            retained.bytes === null ||
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size !== Buffer.byteLength(retained.bytes, "base64")
          )
            fail();
          const bytes = readFileSync(location);
          if (
            bytes.length !== stat.size ||
            createHash("sha256").update(bytes).digest("hex") !== retained.sha256
          )
            fail();
          seenFiles.add(child);
        }
      }
    }
    walk(mapped.path);
    if (
      seenDirectories.size !== wantedDirectories.size ||
      seenFiles.size !==
        retainedFiles.filter((entry) => entry.bytes !== null).length
    )
      fail();
    return join(root, "operator", mapped.path);
  }
  return Object.freeze({ resolveExportWorkDirectory });
}
