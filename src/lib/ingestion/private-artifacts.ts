import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { assertOperatorInstallationWritable } from "./operator-installation.js";
import { hasRecoveredImportAuthority } from "./recovery-import-admission.js";
import { hasRecoveredGmailCaptureAuthority } from "./recovery-gmail-capture-admission.js";

/** Restored checkpoints remain offline until a separately reviewed installation cutover. */
export function assertOperatorNotQuarantined(
  directory: string,
  operation?: "weekly-import" | "steve-email-capture"
): void {
  assertOperatorInstallationWritable(
    resolve(directory),
    operation === "steve-email-capture" ? operation : undefined
  );
  const marker = join(
    dirname(resolvePrivateCandidateDirectory(directory)),
    "recovery-state.json"
  );
  if (existsSync(marker)) {
    if (
      operation === "steve-email-capture" &&
      hasRecoveredGmailCaptureAuthority(resolve(directory))
    )
      return;
    if (
      operation === "weekly-import" &&
      hasRecoveredImportAuthority(resolve(directory))
    )
      return;
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
