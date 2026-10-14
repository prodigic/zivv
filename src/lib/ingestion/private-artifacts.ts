import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

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
