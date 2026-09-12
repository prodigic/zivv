import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bootstrapLedger,
  saveLedgerAtomic,
} from "../../lib/ingestion/ledger.js";
import { runVenuePilot } from "../../lib/ingestion/venue-pilot.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), "zivv-pilot-test-")))
      throw new Error("Unsafe test directory");
    rmSync(directory, { recursive: true, force: true });
  }
});

it("retains per-source failures and continues after malformed source configuration without writing the ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "zivv-pilot-test-"));
  directories.push(root);
  mkdirSync(join(root, "data/ingestion"), { recursive: true });
  const ledgerPath = join(root, "data/ingestion/ledger.json");
  await saveLedgerAtomic(
    ledgerPath,
    bootstrapLedger({ events: [], artists: [], venues: [] }, Date.now())
  );
  const source = {
    sourceId: "malformed",
    website: "invalid URL",
    calendarUrl: "https://venue.example/calendar",
  };
  writeFileSync(
    join(root, "data/venue-sources.json"),
    JSON.stringify({
      schemaVersion: 1,
      sources: [
        source,
        { ...source, sourceId: "next", website: "https://venue.example/" },
      ],
    })
  );
  const before = readFileSync(ledgerPath, "utf8");
  let reachedNext = false;
  const result = await runVenuePilot(root, {
    malformed: async () => {
      throw new Error("Should fail configuration first");
    },
    next: async () => {
      reachedNext = true;
      throw new Error("Second adapter failure retained");
    },
  });
  expect(reachedNext).toBe(true);
  expect(result.summary.map((row) => row.sourceStatus)).toEqual([
    "failed",
    "failed",
  ]);
  expect(
    result.summary.every((row) => !row.importEligible && row.requests === 0)
  ).toBe(true);
  expect(readFileSync(join(result.directory, "report.json"), "utf8")).toContain(
    "Second adapter failure retained"
  );
  expect(readFileSync(ledgerPath, "utf8")).toBe(before);
});
