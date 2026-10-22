#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { captureSteveEmail } from "../dist/lib/ingestion/steve-email-intake.js";
import { runWeeklyImport } from "../dist/lib/ingestion/weekly-import-runner.js";
import { projectLedgerLocation } from "../dist/lib/ingestion/store-location.js";

// Input is a private snapshot transferred programmatically from the authenticated
// Gmail connector, not a user-uploaded EML declared authenticated by a flag.
try {
  const options = {},
    args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2),
      value = args[index + 1];
    if (
      !args[index]?.startsWith("--") ||
      ![
        "file",
        "operator-dir",
        "expected-edition",
        "correction-of",
        "root",
        "through",
      ].includes(key) ||
      Object.hasOwn(options, key) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error("INVALID_EMAIL_CAPTURE_ARGUMENTS");
    options[key] = value;
  }
  if (
    !options.file ||
    !options["operator-dir"] ||
    !options["expected-edition"] ||
    !!options.through !== !!options.root ||
    (options.through &&
      !["acquire", "prepare", "reconcile", "load"].includes(options.through))
  )
    throw new Error("INVALID_EMAIL_CAPTURE_ARGUMENTS");
  const operatorDirectory = resolve(options["operator-dir"]),
    path = resolve(options.file),
    stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 20 * 1024 * 1024
  )
    throw new Error("UNSAFE_EMAIL_SNAPSHOT");
  if (options.root) {
    const location = projectLedgerLocation(resolve(options.root));
    if (
      location.backend !== "sqlite" ||
      realpathSync(location.directory) !== realpathSync(operatorDirectory)
    )
      throw new Error("EMAIL_HANDOFF_STORE_MISMATCH");
  }
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  const result = await captureSteveEmail({
    operatorDirectory,
    accountId: envelope.accountId,
    rawMessage: envelope.rawMessage,
    fullMessage: envelope.fullMessage,
    expectedEditionId: options["expected-edition"],
    observedAtEpochMs: envelope.observedAtEpochMs,
    correctionOf: options["correction-of"],
  });
  let state;
  if (options.through && result.disposition === "ready") {
    state = await runWeeklyImport({
      root: resolve(options.root),
      source: {
        editionId: result.receipt.editionId,
        deliveryId: result.receipt.deliveryId,
        importObservedAtEpochMs: result.receipt.firstObservedAtEpochMs,
        raw: result.source,
      },
      stopAfter: options.through,
    });
  }
  console.log(
    JSON.stringify({
      receiptId: result.receipt.receiptId,
      editionId: result.receipt.editionId,
      sourceSha256: result.receipt.sourceSha256,
      firstObservedAtEpochMs: result.receipt.firstObservedAtEpochMs,
      disposition: result.disposition,
      runId: state?.runId,
      stages: state?.stages.map(({ stage, status, attempt, errorCode }) => ({
        stage,
        status,
        attempt,
        errorCode,
      })),
    })
  );
  if (result.disposition !== "ready") process.exitCode = 2;
} catch (error) {
  const code =
    error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message)
      ? error.message
      : "EMAIL_CAPTURE_STOPPED";
  console.error(
    JSON.stringify({
      error: code,
      action:
        "Inspect the private intake evidence and resume the same message; do not backdate or bypass review.",
    })
  );
  process.exitCode = 1;
}
