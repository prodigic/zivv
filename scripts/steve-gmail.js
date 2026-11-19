#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { captureSteveGmailWindowWithWindowsCredentials } from "../dist/lib/ingestion/steve-gmail-credential-poll.js";
import { pollFridayGmailWithWindowsCredentials } from "../dist/lib/ingestion/steve-gmail-friday-poll.js";
import {
  fridayDeliveryTimes,
  parseCutoffEpochMs,
  planFridayMailboxWake,
} from "../dist/lib/ingestion/weekly.js";
import { provisionWindowsGmailCredentials } from "../dist/lib/ingestion/windows-gmail-credentials.js";

const credentialLimit = 32 * 1024;

async function provision(directory) {
  if (process.stdin.isTTY) throw Error("GMAIL_CREDENTIAL_STDIN_REQUIRED");
  const chunks = [];
  let bytes;
  let length = 0;
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      length += chunk.length;
      if (length > credentialLimit)
        throw Error("GMAIL_CREDENTIAL_INPUT_TOO_LARGE");
    }
    bytes = Buffer.concat(chunks, length);
    let value;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      );
    } catch {
      throw Error("GMAIL_AUTH_CONFIGURATION_REQUIRED");
    }
    provisionWindowsGmailCredentials(directory, value);
  } finally {
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function options(args, expected) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !expected.includes(name) ||
      !value ||
      value.startsWith("--") ||
      result.has(name)
    )
      throw Error("INVALID_GMAIL_ACQUISITION_ARGUMENTS");
    result.set(name, value);
  }
  if (result.size !== expected.length)
    throw Error("INVALID_GMAIL_ACQUISITION_ARGUMENTS");
  return (name) => result.get(name);
}

function utcInstant(value) {
  const instant = parseCutoffEpochMs(value);
  if (new Date(instant).toISOString() !== value)
    throw Error("INVALID_GMAIL_ACQUISITION_ARGUMENTS");
  return instant;
}

async function loadRetained(root) {
  const invalid = () => {
    throw Error("INVALID_FRIDAY_GMAIL_LOAD_INPUT");
  };
  if (!isAbsolute(root) || process.stdin.isTTY) return invalid();
  const { readFridayGmailWorkerInput } =
    await import("../dist/lib/ingestion/steve-gmail-friday-supervised.js");
  const bytes = await readFridayGmailWorkerInput(process.stdin);
  let input;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 3
    )
      return invalid();
    const { operatorDirectory, expectedAccountId, expectedEditionId } = input;
    if (
      typeof operatorDirectory !== "string" ||
      operatorDirectory.length > 4096 ||
      !isAbsolute(operatorDirectory) ||
      typeof expectedAccountId !== "string" ||
      expectedAccountId.length > 320 ||
      !/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u.test(expectedAccountId) ||
      typeof expectedEditionId !== "string" ||
      expectedEditionId.length !== 10
    )
      return invalid();
    fridayDeliveryTimes(expectedEditionId);
  } catch {
    return invalid();
  } finally {
    bytes.fill(0);
  }
  const { loadRetainedSteveEmailSources } =
    await import("../dist/lib/ingestion/steve-email-load.js");
  const { editionId, counts } = await loadRetainedSteveEmailSources({
    root,
    operatorDirectory: input.operatorDirectory,
    accountId: input.expectedAccountId,
    expectedEditionId: input.expectedEditionId,
  });
  const needsAttention =
    counts.reviewRequired ||
    counts.blocked ||
    counts.failed ||
    counts.notProcessed;
  if (needsAttention) process.exitCode = 1;
  return {
    editionId,
    status: needsAttention
      ? "attention-required"
      : counts.loaded
        ? "loaded"
        : "no-retained-source",
    counts,
  };
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "provision") {
    const get = options(args, ["--credential-dir"]);
    const directory = get("--credential-dir");
    if (!isAbsolute(directory)) throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");
    await provision(directory);
    console.log(JSON.stringify({ status: "credential-provisioned" }));
  } else if (command === "plan-friday-wake") {
    const raw = options(args, ["--early-scan-days"])("--early-scan-days");
    if (raw.length !== 1 || !/^[0-4]$/.test(raw))
      throw Error("INVALID_FRIDAY_GMAIL_WAKE_LEAD");
    console.log(JSON.stringify(planFridayMailboxWake(Date.now(), Number(raw))));
  } else if (command === "poll-friday-supervised") {
    const raw = options(args, ["--worker-budget-ms"])("--worker-budget-ms");
    const deadlineMs = Number(raw);
    if (!/^[1-9][0-9]{0,5}$/.test(raw) || deadlineMs > 600_000)
      throw Error("INVALID_FRIDAY_GMAIL_WORKER_BUDGET");
    if (process.stdin.isTTY) throw Error("INVALID_FRIDAY_GMAIL_WORKER_INPUT");
    const { readFridayGmailWorkerInput, pollFridayGmailInWindowsJob } =
      await import("../dist/lib/ingestion/steve-gmail-friday-supervised.js");
    const frame = await readFridayGmailWorkerInput(process.stdin);
    try {
      console.log(
        JSON.stringify(await pollFridayGmailInWindowsJob(frame, deadlineMs))
      );
    } finally {
      frame.fill(0);
    }
  } else if (command === "load-retained") {
    const root = options(args, ["--root"])("--root");
    console.log(JSON.stringify(await loadRetained(root)));
  } else if (command === "poll" || command === "poll-friday") {
    const get = options(args, [
      "--credential-dir",
      "--operator-dir",
      "--account",
      "--edition",
      "--from",
      ...(command === "poll" ? ["--until"] : []),
    ]);
    const credentialDirectory = get("--credential-dir");
    const operatorDirectory = get("--operator-dir");
    if (!isAbsolute(credentialDirectory) || !isAbsolute(operatorDirectory))
      throw Error("INVALID_GMAIL_ACQUISITION_ARGUMENTS");
    const common = {
      credentialDirectory,
      operatorDirectory,
      expectedAccountId: get("--account"),
      expectedEditionId: get("--edition"),
    };
    const startEpochMs = utcInstant(get("--from"));
    const result =
      command === "poll"
        ? await captureSteveGmailWindowWithWindowsCredentials({
            ...common,
            startEpochMs,
            endEpochMs: utcInstant(get("--until")),
          })
        : await pollFridayGmailWithWindowsCredentials({
            ...common,
            scanStartsAtEpochMs: startEpochMs,
          });
    console.log(JSON.stringify(result));
  } else {
    throw Error("INVALID_GMAIL_ACQUISITION_ARGUMENTS");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const code = /^[A-Z][A-Z0-9_]{2,95}$/.test(message)
    ? message
    : "GMAIL_ACQUISITION_STOPPED";
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
}
