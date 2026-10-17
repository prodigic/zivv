import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./sqlite-store.js";

/** Every effective ETL configuration input, including explicit absent files. */
export const CANDIDATE_CONFIG_FILES = [
  "venue-sources.json",
  "venue-location-corrections.json",
  "venue-details.json",
  "venue-maps.json",
  "event-posters.json",
  "artist-reviews.json",
  "artist-links.json",
  "event-slug-redirects.json",
  "local-artist-verification.json",
  "ingestion/weekly-editions.json",
  "events.txt",
  "venues.txt",
] as const;
export type CandidateConfiguration = Record<
  (typeof CANDIDATE_CONFIG_FILES)[number],
  Buffer | null
>;
export function configurationInventory(
  configuration: CandidateConfiguration
): { path: string; sha256: string | null }[] {
  const expected = [...CANDIDATE_CONFIG_FILES].sort();
  if (
    canonicalJson(Object.keys(configuration).sort()) !== canonicalJson(expected)
  )
    throw new Error("Candidate mismatch: configuration inventory");
  return CANDIDATE_CONFIG_FILES.map((path) => {
    const bytes = configuration[path];
    if (bytes !== null && !Buffer.isBuffer(bytes))
      throw new Error(
        "Configuration must contain captured bytes or explicit absence"
      );
    return {
      path,
      sha256:
        bytes === null
          ? null
          : createHash("sha256").update(bytes).digest("hex"),
    };
  });
}
export function configurationDigest(
  configuration: CandidateConfiguration
): string {
  return createHash("sha256")
    .update(canonicalJson(configurationInventory(configuration)))
    .digest("hex");
}
/** Snapshot exact configuration bytes; private email, ledger and keys are excluded. */
export function captureExportConfiguration(
  root: string
): CandidateConfiguration {
  return Object.fromEntries(
    CANDIDATE_CONFIG_FILES.map((name) => {
      const path = join(root, "data", name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [name, null];
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("Linked configuration file refused");
      return [name, readFileSync(path)];
    })
  ) as CandidateConfiguration;
}
