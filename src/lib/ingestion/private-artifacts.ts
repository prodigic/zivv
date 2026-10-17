import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Restored checkpoints remain offline until a separately reviewed installation cutover. */
export function assertOperatorNotQuarantined(directory: string): void {
  const marker = join(
    dirname(resolvePrivateCandidateDirectory(directory)),
    "recovery-state.json"
  );
  if (existsSync(marker)) {
    // No marker value grants activation: this staging format has no activation operation.
    throw new Error("RECOVERY_INSTALLATION_NOT_ACTIVATED");
  }
}

/** Resolve local private staging outside all Git checkouts, including junction targets. */
export function resolvePrivateCandidateDirectory(path: string): string {
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
