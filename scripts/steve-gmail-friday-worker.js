#!/usr/bin/env node
import {
  readFridayGmailWorkerInput,
  runFridayGmailWorker,
} from "../dist/lib/ingestion/steve-gmail-friday-supervised.js";

let input;
try {
  if (process.stdin.isTTY || process.argv.length !== 2)
    throw Error("INVALID_FRIDAY_GMAIL_WORKER_INPUT");
  input = await readFridayGmailWorkerInput(process.stdin);
  console.log(JSON.stringify(await runFridayGmailWorker(input)));
} catch (error) {
  const safe =
    error instanceof Error && /^[A-Z][A-Z0-9_]{2,95}$/.test(error.message);
  console.error(
    JSON.stringify({
      pollError: safe ? error.message : "FRIDAY_GMAIL_WORKER_FAILED",
    })
  );
  process.exitCode = 1;
} finally {
  input?.fill(0);
}
