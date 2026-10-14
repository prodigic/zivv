#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflightSteveContent,
  sha256,
} from "../dist/lib/ingestion/steve-preflight.js";
import { loadLedger } from "../dist/lib/ingestion/ledger.js";
import { ledgerDigest } from "../dist/lib/ingestion/sqlite-store.js";
import {
  secureOperatorDirectory,
  writeDurableFile,
} from "../dist/lib/ingestion/encrypted-backup.js";

const options = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]?.slice(2);
  if (
    !args[index]?.startsWith("--") ||
    !["root", "file", "output-dir"].includes(key) ||
    !args[index + 1] ||
    args[index + 1].startsWith("--")
  )
    throw new Error(
      "Usage: node scripts/preflight-steveslist.js --file PRIVATE_TEXT --output-dir PRIVATE_DIRECTORY [--root CHECKOUT]"
    );
  options[key] = resolve(args[index + 1]);
}
if (!options.file || !options["output-dir"])
  throw new Error("--file and --output-dir are required");
const root = options.root || fileURLToPath(new URL("../", import.meta.url));
const output = options["output-dir"];
// Resolve existing ancestors so junctions cannot route private artifacts into Git.
let ancestor = output;
while (!existsSync(ancestor)) {
  const parent = dirname(ancestor);
  if (parent === ancestor) throw new Error("Invalid output directory");
  ancestor = parent;
}
const actualOutput = resolve(
  realpathSync(ancestor),
  relative(ancestor, output)
);
const actualRoot = realpathSync(root);
const rootRelative = relative(actualRoot, actualOutput);
if (
  !rootRelative ||
  (!rootRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rootRelative))
)
  throw new Error("Private preflight output must be outside the checkout");
for (let parent = actualOutput; ; parent = dirname(parent)) {
  if (existsSync(join(parent, ".git")))
    throw new Error(
      "Private preflight output must be outside Git repositories"
    );
  if (dirname(parent) === parent) break;
}
const bytes = readFileSync(options.file);
let raw;
let invalidEncoding = false;
try {
  raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
} catch {
  raw = bytes.toString("utf8");
  invalidEncoding = true;
}
const aliases = existsSync(join(root, "data/venue-aliases.json"))
  ? JSON.parse(readFileSync(join(root, "data/venue-aliases.json"), "utf8"))
  : {};
const corrections = existsSync(join(root, "data/line-corrections.json"))
  ? JSON.parse(readFileSync(join(root, "data/line-corrections.json"), "utf8"))
  : [];
const ledger = await loadLedger(join(root, "data/ingestion/ledger.json"));
const report = preflightSteveContent(raw, ledger, aliases, corrections);
if (invalidEncoding) {
  report.errors.unshift(
    "Source is not valid UTF-8 decoded plain text; raw bytes retained for review"
  );
  report.preparedContent = null;
  report.preparedSha256 = null;
}
// Preserve exact bytes even when UTF-8 decoding strips a BOM.
report.rawSha256 = sha256(bytes);
const ledgerRevision = ledgerDigest(ledger);
const identity = sha256(
  JSON.stringify({
    version: report.preflightVersion,
    raw: report.rawSha256,
    rules: report.rulesSha256,
    ledgerRevision,
  })
);
const directory = join(actualOutput, identity);
if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
  throw new Error("Preflight artifact directory must not be a link");
mkdirSync(directory, { recursive: true, mode: 0o700 });
secureOperatorDirectory(directory);
function preserve(name, content) {
  const path = join(directory, name);
  const buffer = typeof content === "string" ? Buffer.from(content) : content;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("Preflight artifact must be a regular unlinked file");
    if (!readFileSync(path).equals(buffer))
      throw new Error(
        "Existing preflight artifact differs; refusing overwrite"
      );
  } else writeDurableFile(path, buffer);
}
preserve("raw.txt", bytes);
preserve(
  "report.json",
  JSON.stringify({ ...report, ledgerRevision }, null, 2) + "\n"
);
if (report.preparedContent !== null)
  preserve("prepared.txt", report.preparedContent);
console.log(
  JSON.stringify(
    {
      directory,
      identity,
      rawSha256: report.rawSha256,
      preparedSha256: report.preparedSha256,
      counts: report.counts,
      valid: report.errors.length === 0,
      blockingErrors: report.errors.length,
    },
    null,
    2
  )
);
if (report.errors.length) process.exitCode = 1;
