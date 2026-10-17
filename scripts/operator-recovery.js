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
} from "../dist/lib/ingestion/operator-recovery.js";
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

try {
  const [command, ...args] = process.argv.slice(2),
    options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2),
      value = args[index + 1];
    if (
      !args[index]?.startsWith("--") ||
      !["root", "out", "file", "key", "destination"].includes(key) ||
      Object.hasOwn(options, key) ||
      !value ||
      value.startsWith("--")
    )
      throw Error("INVALID_RECOVERY_ARGUMENTS");
    options[key] = value;
  }
  const expected =
    command === "capture"
      ? ["root", "out"]
      : command === "verify"
        ? ["file", "key"]
        : command === "stage"
          ? ["file", "key", "destination"]
          : [];
  if (
    !expected.length ||
    JSON.stringify(Object.keys(options).sort()) !==
      JSON.stringify(expected.sort())
  )
    throw Error("INVALID_RECOVERY_ARGUMENTS");
  let checkpoint;
  if (command === "capture") {
    const output = resolve(options.out);
    resolvePrivateCandidateDirectory(dirname(output));
    if (existsSync(output)) throw Error("RECOVERY_DESTINATION_EXISTS");
    const location = projectLedgerLocation(resolve(options.root));
    if (location.backend !== "sqlite") throw Error("SHARED_SQLITE_REQUIRED");
    const key = loadBackupKey(location.directory);
    checkpoint = await captureOperatorRecoveryCheckpoint(resolve(options.root));
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
    checkpoint = decryptOperatorRecovery(
      privateInput(options.file, 384 * 1024 * 1024),
      key
    );
    if (command === "stage")
      await stageOperatorRecovery(
        checkpoint,
        resolve(options.destination),
        key
      );
  }
  console.log(
    JSON.stringify({
      command,
      status: command === "stage" ? "staged" : "verified",
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
