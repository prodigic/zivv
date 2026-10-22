import { createHmac } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  openPreparedRuntimeForAdmission,
  prepareOperatorRecoveryRuntime,
} from "./recovery-runtime.js";
import { decryptRecoveryResultChain } from "./recovery-result-chain.js";
import {
  captureNpmExecutionTool,
  verifyNpmExecutionTool,
} from "./execution-tool-identity.js";
import {
  installRecoveryIntent,
  readRecoveryInstalledFile,
} from "./encrypted-backup.js";
import { resolvePrivateCandidateDirectory } from "./private-artifacts.js";
import { canonicalJson } from "./sqlite-store.js";
import { sha256 } from "./steve-preflight.js";

export interface RecoveryChainHostInput {
  chain: Buffer;
  recoveryKey: Buffer;
  destination: string;
  npmCli: string;
}
function fail(code: string): never {
  throw new Error("RECOVERY_CHAIN_PREPARATION_" + code);
}
function same(a: unknown, b: unknown): void {
  if (canonicalJson(a) !== canonicalJson(b)) fail("CONTEXT_CHANGED");
}
function overlaps(a: string, b: string): boolean {
  const path = relative(a, b);
  return (
    path === "" ||
    (!isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith("../") &&
      !path.startsWith("..\\"))
  );
}
function regular(path: string): Buffer {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH");
    if (dirname(parent) === parent) break;
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 64 * 1024
  )
    fail("UNSAFE_FILE");
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) fail("FILE_CHANGED");
  return bytes;
}
function context(supplied: RecoveryChainHostInput) {
  const chain = Buffer.from(supplied.chain),
    recoveryKey = Buffer.from(supplied.recoveryKey),
    proof = decryptRecoveryResultChain(chain, recoveryKey),
    root = resolve(supplied.destination),
    npmCli = resolve(supplied.npmCli);
  if (resolvePrivateCandidateDirectory(root) !== root)
    fail("UNSAFE_DESTINATION");
  const historical = [
    proof.originalCheckpoint.originalCheckout,
    proof.originalCheckpoint.originalOperatorDirectory,
    proof.successorCheckpoint.originalCheckout,
    proof.successorCheckpoint.originalOperatorDirectory,
    dirname(proof.successorCheckpoint.originalCheckout),
  ];
  for (const old of historical)
    if (!isAbsolute(old) || overlaps(old, root) || overlaps(root, old))
      fail("DESTINATION_OVERLAP");
  verifyNpmExecutionTool(
    proof.successorCheckpoint.runtime.bootstrapNpm!,
    npmCli
  );
  const physicalTool = captureNpmExecutionTool(npmCli),
    runtimeInput = {
      archive: proof.members.successorArchive,
      retirementReceipt: proof.members.successorRetirementReceipt,
      recoveryKey,
      destination: root,
      npmCli,
    },
    companionPath = root + ".chain-preparation.json",
    stagingDirectory = join(
      dirname(root),
      ".zivv-recovery-install-" + sha256(root)
    );
  const binding = {
    kind: "zivv-recovery-chain-preparation",
    version: 1,
    activationAllowed: false,
    chainId: proof.chainId,
    chainSha256: sha256(chain),
    chainSize: chain.length,
    successorArchiveSha256: sha256(proof.members.successorArchive),
    successorRetirementSha256: sha256(proof.members.successorRetirementReceipt),
    successorCheckpointSha256: proof.certificate.successorCheckpointSha256,
    root,
    operator: join(root, "operator"),
    checkout: join(root, "checkout"),
    physicalNpmCli: npmCli,
    physicalNpmIdentitySha256: physicalTool.identitySha256,
    historicalNpmIdentitySha256:
      proof.successorCheckpoint.runtime.bootstrapNpm!.identitySha256,
    runId: proof.certificate.runId,
    sourceCommit: proof.certificate.sourceCommit,
    candidateId: proof.candidate.candidateId,
    candidateSha256: sha256(proof.candidateBytes),
    exportRole: proof.certificate.exportRole,
  };
  return {
    chain,
    recoveryKey,
    proof,
    root,
    runtimeInput,
    companionPath,
    stagingDirectory,
    binding,
  };
}
function companion(
  binding: ReturnType<typeof context>["binding"],
  preparedReceipt: Buffer,
  recoveryKey: Buffer
): Buffer {
  const payload = {
    ...binding,
    preparedReceiptSha256: sha256(preparedReceipt),
  };
  return Buffer.from(
    canonicalJson({
      payload,
      signature: createHmac("sha256", recoveryKey)
        .update("zivv-recovery-chain-preparation/v1\0")
        .update(canonicalJson(payload))
        .digest("hex"),
    }) + "\n"
  );
}

/** Read-only physical evidence, never a scope mint or execution permission. */
export function openRecoveryResultChainPreparation(
  input: RecoveryChainHostInput
) {
  const opened = context(input),
    prepared = openPreparedRuntimeForAdmission(opened.runtimeInput),
    receipt = regular(join(opened.root, "prepared-runtime.json")),
    expected = companion(opened.binding, receipt, opened.recoveryKey);
  const check = (current: Buffer) => {
    if (!current.equals(expected)) fail("COMPANION_CHANGED");
  };
  const bytes = readRecoveryInstalledFile(
    opened.companionPath,
    opened.stagingDirectory,
    check
  );
  const assertCurrent = () => {
    prepared.assertRuntime();
    same(
      sha256(regular(join(opened.root, "prepared-runtime.json"))),
      sha256(receipt)
    );
    check(regular(opened.companionPath));
  };
  assertCurrent();
  return {
    ...opened,
    prepared,
    companionBytes: Buffer.from(bytes),
    companionSha256: sha256(bytes),
    assertCurrent,
  };
}

/** Prepare the exact successor through the existing standard quarantine path. */
export async function prepareOperatorRecoveryResultChain(
  input: RecoveryChainHostInput
) {
  const opened = context(input);
  // Refuse a conflicting established host binding before any provisioning work.
  if (existsSync(opened.companionPath))
    openRecoveryResultChainPreparation(input);
  const report = await prepareOperatorRecoveryRuntime(opened.runtimeInput),
    preparedReceipt = regular(join(opened.root, "prepared-runtime.json")),
    expected = companion(opened.binding, preparedReceipt, opened.recoveryKey);
  installRecoveryIntent(
    opened.companionPath,
    expected,
    opened.stagingDirectory
  );
  openRecoveryResultChainPreparation({
    ...input,
    chain: opened.chain,
    recoveryKey: opened.recoveryKey,
  });
  return {
    ...report,
    chainId: opened.proof.chainId,
    chainSha256: opened.binding.chainSha256,
  };
}

/** Same real preparation path; this entry grants no test transport or effect bypass. */
export const prepareOperatorRecoveryResultChainForTest =
  prepareOperatorRecoveryResultChain;
