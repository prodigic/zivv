#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  captureOperatorRecoveryCheckpoint,
  decryptOperatorRecovery,
  encryptOperatorRecovery,
  stageOperatorRecovery,
  retireAndCaptureOperatorRecovery,
  verifyOperatorRetirementEvidence,
} from "../dist/lib/ingestion/operator-recovery.js";
import { inspectOperatorRecoveryLocations } from "../dist/lib/ingestion/operator-recovery-location.js";
import {
  prepareOperatorRecoveryRuntime,
  verifyPreparedOperatorRuntime,
} from "../dist/lib/ingestion/recovery-runtime.js";
import { resumeOperatorRecoveryImport } from "../dist/lib/ingestion/recovery-import-admission.js";
import { resumeOperatorRecoveryCandidate } from "../dist/lib/ingestion/recovery-candidate-admission.js";
import { resumeOperatorRecoveryFrozen } from "../dist/lib/ingestion/recovery-frozen-admission.js";
import { resumeOperatorRecoveryDispatch } from "../dist/lib/ingestion/recovery-dispatch-admission.js";
import { resumeOperatorRecoveryVerified } from "../dist/lib/ingestion/recovery-verified-admission.js";
import { recaptureOperatorRecoveryFrozenResult } from "../dist/lib/ingestion/recovery-result-recapture.js";
import {
  loadBackupKey,
  secureOperatorDirectory,
} from "../dist/lib/ingestion/encrypted-backup.js";
import { projectLedgerLocation } from "../dist/lib/ingestion/store-location.js";
import { resolvePrivateCandidateDirectory } from "../dist/lib/ingestion/private-artifacts.js";

function privateInput(path, limit) {
  const absolute = resolve(path);
  resolvePrivateCandidateDirectory(dirname(absolute));
  const stat = lstatSync(absolute);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit
  )
    throw Error("UNSAFE_RECOVERY_INPUT");
  return readFileSync(absolute);
}

const selectedLoadCommands = [
  "inspect-selected-load",
  "install-selected-load",
  "execute-selected-load",
  "resume-selected-load",
  "inspect-selected-load-interruption",
];

async function runSelectedLoadCommand(command, input, selectorFile) {
  const { copyRecoveryGmailSelectedReceiptSelector } =
    await import("../dist/lib/ingestion/recovery-gmail-capture-admission-proof.js");
  const { canonicalJson } =
    await import("../dist/lib/ingestion/sqlite-store.js");
  const bytes = privateInput(selectorFile, 16 * 1024);
  let selector;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    selector = copyRecoveryGmailSelectedReceiptSelector(JSON.parse(text));
    const canonical = canonicalJson(selector);
    if (
      !bytes.equals(Buffer.from(canonical)) &&
      !bytes.equals(Buffer.from(canonical + "\n"))
    )
      throw Error("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_SELECTOR");
  } catch {
    throw Error("INVALID_RECOVERY_GMAIL_SELECTED_LOAD_SELECTOR");
  }
  const selected = { ...input, selector };
  if (
    command === "install-selected-load" ||
    command === "execute-selected-load" ||
    command === "resume-selected-load"
  ) {
    const launcher =
      await import("../dist/lib/ingestion/recovery-gmail-selected-load-launcher.js");
    try {
      if (command === "install-selected-load")
        return await launcher.resumeOperatorRecoveryGmailSelectedLoadEvidence(
          selected
        );
      if (command === "execute-selected-load")
        return await launcher.executeOperatorRecoveryGmailSelectedLoad(
          selected
        );
      return await launcher.resumeOperatorRecoveryGmailSelectedLoad(selected);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "RECOVERY_GMAIL_SELECTED_LOAD_EXECUTION_FAILED" &&
        error.cause instanceof Error &&
        /^[A-Z][A-Z0-9_]{2,79}$/.test(error.cause.message)
      )
        throw Error(error.cause.message);
      throw error;
    }
  }
  if (command === "inspect-selected-load-interruption") {
    const { inspectSelectedLoadInterruption } =
      await import("../dist/lib/ingestion/recovery-gmail-selected-load-interruption-inspection.js");
    return inspectSelectedLoadInterruption(selected);
  }
  const { inspectInstalledRecoveryGmailSelectedLoadEvidence } =
    await import("../dist/lib/ingestion/recovery-gmail-selected-load-installation.js");
  return inspectInstalledRecoveryGmailSelectedLoadEvidence(selected);
}

try {
  const [command, ...args] = process.argv.slice(2),
    options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2),
      value = args[index + 1];
    if (
      !args[index]?.startsWith("--") ||
      ![
        "root",
        "out",
        "file",
        "key",
        "destination",
        "receipt",
        "npm-cli",
        "repository",
        "run-id",
        "workflow-commit",
        "source-commit",
        "batch-id",
        "corrections-file",
        "selector-file",
      ].includes(key) ||
      Object.hasOwn(options, key) ||
      !value ||
      value.startsWith("--")
    )
      throw Error("INVALID_RECOVERY_ARGUMENTS");
    options[key] = value;
  }
  const chainCommand = ["prepare-chain", "resume-chain"].includes(command);
  const selectedLoadCommand = selectedLoadCommands.includes(command);
  const expected = chainCommand
    ? [
        "file",
        "key",
        "destination",
        "npm-cli",
        ...(command === "resume-chain"
          ? ["repository", "workflow-commit"]
          : []),
      ]
    : command === "capture" || command === "retire"
      ? ["root", "out", ...(options["npm-cli"] ? ["npm-cli"] : [])]
      : command === "verify"
        ? ["file", "key"]
        : command === "verify-retirement"
          ? ["file", "key", "receipt"]
          : command === "resume-import" ||
              command === "resume-candidate" ||
              command === "resume-dispatch" ||
              command === "resume-verified" ||
              command === "recapture-frozen" ||
              command === "resume-frozen"
            ? [
                "file",
                "key",
                "receipt",
                "destination",
                "npm-cli",
                "repository",
                "run-id",
                ...([
                  "resume-candidate",
                  "resume-dispatch",
                  "resume-verified",
                ].includes(command)
                  ? ["workflow-commit"]
                  : []),
                ...(["resume-frozen", "recapture-frozen"].includes(command)
                  ? ["source-commit"]
                  : []),
                ...(command === "recapture-frozen" ? ["out"] : []),
              ]
            : command === "capture-gmail"
              ? [
                  "file",
                  "key",
                  "receipt",
                  "destination",
                  "npm-cli",
                  "batch-id",
                  ...(options["corrections-file"] ? ["corrections-file"] : []),
                ]
              : command === "prepare-runtime" ||
                  command === "verify-prepared-runtime" ||
                  command === "inspect-gmail"
                ? ["file", "key", "receipt", "destination", "npm-cli"]
                : command === "stage" || command === "inspect"
                  ? ["file", "key", "destination"]
                  : selectedLoadCommand
                    ? [
                        "file",
                        "key",
                        "receipt",
                        "destination",
                        "npm-cli",
                        "selector-file",
                      ]
                    : [];
  if (
    !expected.length ||
    JSON.stringify(Object.keys(options).sort()) !==
      JSON.stringify(expected.sort())
  )
    throw Error("INVALID_RECOVERY_ARGUMENTS");
  let checkpoint, inspection;
  if (command === "retire") {
    ({ checkpoint } = await retireAndCaptureOperatorRecovery({
      root: resolve(options.root),
      out: resolve(options.out),
      ...(options["npm-cli"] ? { npmCli: resolve(options["npm-cli"]) } : {}),
    }));
  } else if (command === "capture") {
    const output = resolve(options.out);
    resolvePrivateCandidateDirectory(dirname(output));
    if (existsSync(output)) throw Error("RECOVERY_DESTINATION_EXISTS");
    const location = projectLedgerLocation(resolve(options.root));
    if (location.backend !== "sqlite") throw Error("SHARED_SQLITE_REQUIRED");
    const key = loadBackupKey(location.directory);
    checkpoint = await captureOperatorRecoveryCheckpoint(
      resolve(options.root),
      options["npm-cli"] ? { npmCli: resolve(options["npm-cli"]) } : undefined
    );
    const bytes = encryptOperatorRecovery(checkpoint, key);
    // Reauthenticate before durable output; never write a cleartext capsule.
    decryptOperatorRecovery(bytes, key);
    secureOperatorDirectory(dirname(output));
    const fd = openSync(output, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } else {
    resolvePrivateCandidateDirectory(dirname(resolve(options.key)));
    const encoded = privateInput(options.key, 1024).toString("utf8").trim(),
      key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded)
      throw Error("INVALID_RECOVERY_KEY");
    const archive = privateInput(
      options.file,
      (chainCommand ? 768 : 384) * 1024 * 1024
    );
    if (selectedLoadCommand) {
      try {
        inspection = await runSelectedLoadCommand(
          command,
          {
            archive,
            recoveryKey: key,
            retirementReceipt: privateInput(options.receipt, 16 * 1024),
            destination: resolve(options.destination),
            npmCli: resolve(options["npm-cli"]),
          },
          options["selector-file"]
        );
      } finally {
        key.fill(0);
      }
    } else if (chainCommand) {
      const {
        prepareOperatorRecoveryResultChain,
        resumeOperatorRecoveryResultChainCandidate,
      } = await import("../dist/lib/ingestion/recovery-chain-admission.js");
      const input = {
        chain: archive,
        recoveryKey: key,
        destination: resolve(options.destination),
        npmCli: resolve(options["npm-cli"]),
      };
      inspection =
        command === "prepare-chain"
          ? await prepareOperatorRecoveryResultChain(input)
          : await resumeOperatorRecoveryResultChainCandidate({
              ...input,
              repositoryRoot: resolve(options.repository),
              workflowCommit: options["workflow-commit"],
              githubToken: process.env.GITHUB_TOKEN,
              ...(process.env.GITHUB_TOKEN
                ? { credentials: { token: process.env.GITHUB_TOKEN } }
                : {}),
            });
    } else if (
      command === "resume-import" ||
      command === "resume-candidate" ||
      command === "resume-dispatch" ||
      command === "resume-verified" ||
      command === "recapture-frozen" ||
      command === "resume-frozen" ||
      command === "prepare-runtime" ||
      command === "verify-prepared-runtime" ||
      command === "capture-gmail" ||
      command === "inspect-gmail"
    ) {
      const input = {
        archive,
        recoveryKey: key,
        retirementReceipt: privateInput(options.receipt, 16 * 1024),
        destination: resolve(options.destination),
        npmCli: resolve(options["npm-cli"]),
      };
      inspection =
        command === "capture-gmail"
          ? await (
              await import("../dist/lib/ingestion/recovery-gmail-capture.js")
            ).resumeOperatorRecoveryGmailBatch({
              ...input,
              batchId: options["batch-id"],
              ...(options["corrections-file"]
                ? {
                    correctionOfByMessageId: JSON.parse(
                      new TextDecoder("utf-8", { fatal: true }).decode(
                        privateInput(options["corrections-file"], 64 * 1024)
                      )
                    ),
                  }
                : {}),
            })
          : command === "recapture-frozen"
            ? await recaptureOperatorRecoveryFrozenResult({
                ...input,
                repositoryRoot: resolve(options.repository),
                runId: options["run-id"],
                sourceCommit: options["source-commit"],
                out: resolve(options.out),
                ...(process.env.GITHUB_TOKEN
                  ? { credentials: { token: process.env.GITHUB_TOKEN } }
                  : {}),
              })
            : command === "resume-verified"
              ? await resumeOperatorRecoveryVerified({
                  ...input,
                  repositoryRoot: resolve(options.repository),
                  runId: options["run-id"],
                  workflowCommit: options["workflow-commit"],
                  ...(process.env.GITHUB_TOKEN
                    ? { credentials: { token: process.env.GITHUB_TOKEN } }
                    : {}),
                })
              : command === "resume-frozen"
                ? await resumeOperatorRecoveryFrozen({
                    ...input,
                    repositoryRoot: resolve(options.repository),
                    runId: options["run-id"],
                    sourceCommit: options["source-commit"],
                    ...(process.env.GITHUB_TOKEN
                      ? { credentials: { token: process.env.GITHUB_TOKEN } }
                      : {}),
                  })
                : command === "resume-candidate" ||
                    command === "resume-dispatch"
                  ? await (
                      command === "resume-dispatch"
                        ? resumeOperatorRecoveryDispatch
                        : resumeOperatorRecoveryCandidate
                    )({
                      ...input,
                      repositoryRoot: resolve(options.repository),
                      runId: options["run-id"],
                      workflowCommit: options["workflow-commit"],
                      githubToken: process.env.GITHUB_TOKEN,
                    })
                  : command === "resume-import"
                    ? await resumeOperatorRecoveryImport({
                        ...input,
                        repositoryRoot: resolve(options.repository),
                        runId: options["run-id"],
                      })
                    : command === "prepare-runtime"
                      ? await prepareOperatorRecoveryRuntime(input)
                      : command === "inspect-gmail"
                        ? (
                            await import("../dist/lib/ingestion/recovery-gmail-inspector.js")
                          ).inspectOperatorRecoveryGmailBatches(input)
                        : verifyPreparedOperatorRuntime(input);
    } else if (command === "verify-retirement") {
      ({ checkpoint } = verifyOperatorRetirementEvidence({
        archive,
        recoveryKey: key,
        retirementReceipt: privateInput(options.receipt, 16 * 1024),
      }));
    } else if (command === "inspect") {
      inspection = inspectOperatorRecoveryLocations({
        archive,
        recoveryKey: key,
        stagingRoot: resolve(options.destination),
      }).report;
    } else {
      checkpoint = decryptOperatorRecovery(archive, key);
    }
    if (command === "stage")
      await stageOperatorRecovery(
        checkpoint,
        resolve(options.destination),
        key
      );
  }
  if (inspection) console.log(JSON.stringify({ command, ...inspection }));
  else
    console.log(
      JSON.stringify({
        command,
        status:
          command === "stage"
            ? "staged"
            : command === "retire"
              ? "retired"
              : "verified",
        activationAllowed: false,
        ledgerRevision: checkpoint.ledgerRevision,
        fileCount: checkpoint.files.length,
      })
    );
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message)
          ? error.message
          : "OPERATOR_RECOVERY_STOPPED",
      action:
        "Inspect private evidence; preserve the original store and key. Staging never authorizes activation.",
    })
  );
  process.exitCode = 1;
}
