import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import {
  inspectRetiredOperatorLeaseFence,
  verifyOperatorRetirementEvidence,
} from "./operator-recovery.js";
import { observeReplacementAcknowledgedWatermarkForTest } from "./recovery-import-remote.js";
import {
  verifyPreparedOperatorRuntime,
  type RecoveryRuntimeInput,
} from "./recovery-runtime.js";
import { canonicalJson } from "./sqlite-store.js";

interface ReplacementPreflightFixtureInput {
  oldRoot: string;
  oldNpmCli: string;
  prepared: RecoveryRuntimeInput;
  repositoryRoot: string;
  bareDirectory: string;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function invalid(): never {
  throw Error("REPLACEMENT_HOST_PREFLIGHT_UNVERIFIED");
}

/**
 * Compose the cooperative fence, exact pristine replacement tree and canonical
 * published watermark using a genuine isolated bare Git authority.
 */
export function inspectReplacementPreflightForTest({
  oldRoot,
  oldNpmCli,
  prepared,
  repositoryRoot,
  bareDirectory,
}: ReplacementPreflightFixtureInput) {
  try {
    const { checkpoint } = verifyOperatorRetirementEvidence(prepared);
    const replacement = realpathSync(prepared.destination);
    for (const original of [
      checkpoint.originalCheckout,
      checkpoint.originalOperatorDirectory,
    ]) {
      if (contains(original, replacement) || contains(replacement, original))
        return invalid();
    }
    const old = {
      root: oldRoot,
      npmCli: oldNpmCli,
      archive: prepared.archive,
      retirementReceipt: prepared.retirementReceipt,
      recoveryKey: prepared.recoveryKey,
    };
    const oldFence = inspectRetiredOperatorLeaseFence(old);
    const successor = verifyPreparedOperatorRuntime(prepared);
    if (
      successor.checkpointSha256 !== oldFence.checkpointSha256 ||
      successor.ledgerRevision !== oldFence.ledgerRevision
    )
      return invalid();
    const watermark = observeReplacementAcknowledgedWatermarkForTest({
      repositoryRoot,
      bareDirectory,
      checkpoint,
      recoveryKey: prepared.recoveryKey,
    });
    if (
      watermark.binding.acknowledgedLedgerRevision !==
        oldFence.ledgerRevision ||
      canonicalJson(verifyPreparedOperatorRuntime(prepared)) !==
        canonicalJson(successor) ||
      canonicalJson(inspectRetiredOperatorLeaseFence(old)) !==
        canonicalJson(oldFence)
    )
      return invalid();
    watermark.assertCurrent();
    return {
      status: "replacement-preflight-observed" as const,
      activationAllowed: false as const,
      oldFence,
      successor,
      watermark: watermark.binding,
    };
  } catch {
    return invalid();
  }
}
