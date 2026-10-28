import { createHash } from "node:crypto";
import { canonicalJson } from "./sqlite-store.js";

export const IMPORT_CONFIGURATION_FILES = Object.freeze([
  "venue-aliases.json",
  "line-corrections.json",
  "venue-location-corrections.json",
  "ingestion/historical-batches.json",
  "ingestion/migration.json",
] as const);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const digest = /^[a-f0-9]{64}$/;
function fail(): never {
  throw new Error("INVALID_WEEKLY_RUN_CONTEXT");
}

/** Exact legacy import-policy commitment, including absent files and fixed order. */
export function importConfigurationInventoryDigest(
  entries: readonly { path: string; sha256: string | null }[]
): string {
  if (
    !Array.isArray(entries) ||
    entries.length !== IMPORT_CONFIGURATION_FILES.length
  )
    fail();
  const values = entries.map(
    (entry: { path: string; sha256: string | null }, index: number) => {
      if (
        entry.path !== IMPORT_CONFIGURATION_FILES[index] ||
        (entry.sha256 !== null &&
          (typeof entry.sha256 !== "string" || !digest.test(entry.sha256)))
      )
        fail();
      return { path: entry.path, sha256: entry.sha256 };
    }
  );
  return hash(canonicalJson(values));
}

/** Exact normal compiled worker digest over all lib/types/utils entries. */
export function compiledWorkerInventoryDigest(
  entries: readonly { path: string; size: number; sha256: string }[]
): string {
  if (!Array.isArray(entries) || entries.length > 50_000) fail();
  const seen = new Set<string>();
  const values = entries.map(
    (entry: { path: string; size: number; sha256: string }) => {
      if (
        typeof entry.path !== "string" ||
        !/^(lib|types|utils)\//.test(entry.path) ||
        entry.path.length > 4096 ||
        entry.path.includes("\\") ||
        entry.path
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        seen.has(entry.path.toLowerCase()) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        typeof entry.sha256 !== "string" ||
        !digest.test(entry.sha256)
      )
        fail();
      seen.add(entry.path.toLowerCase());
      return { path: entry.path, size: entry.size, sha256: entry.sha256 };
    }
  );
  if (
    !values.some(
      (entry) => entry.path === "lib/ingestion/weekly-import-runner.js"
    )
  )
    fail();
  return hash(
    canonicalJson(
      values.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    )
  );
}

export interface WeeklyRunRulesContext {
  runtimeSha256: string;
  packageLockSha256: string;
  configurationSha256: string;
  node: string;
  icu: string;
}
/** Shared with the normal runner: identical weekly-import-v1 bytes and run identity. */
export function weeklyRunRulesDigest(context: WeeklyRunRulesContext): string {
  for (const key of [
    "runtimeSha256",
    "packageLockSha256",
    "configurationSha256",
  ] as const)
    if (typeof context[key] !== "string" || !digest.test(context[key])) fail();
  if (
    typeof context.node !== "string" ||
    context.node.length > 128 ||
    !/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(context.node) ||
    typeof context.icu !== "string" ||
    context.icu.length > 128 ||
    [...context.icu].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    fail();
  return hash(
    canonicalJson({
      runner: "weekly-import-v1",
      runtimeSha256: context.runtimeSha256,
      packageLockSha256: context.packageLockSha256,
      configurationSha256: context.configurationSha256,
      node: context.node,
      icu: context.icu,
    })
  );
}
