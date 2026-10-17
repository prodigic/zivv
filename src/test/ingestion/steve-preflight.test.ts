import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { preflightSteveContent } from "../../lib/ingestion/steve-preflight.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";
import { importSteveContent } from "../../lib/ingestion/imports.js";

const header =
  "funk-punk-thrash-ska Upcoming shows of Interest October 2, 2026";
const show = "oct 2 fri Fixture Band at Test Room, Oakland a/a $10 8pm";
const empty = () =>
  bootstrapLedger({ events: [], artists: [], venues: [] }, 1000);
const directories: string[] = [];
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "zivv-preflight-test-"));
  directories.push(path);
  const root = join(path, "checkout");
  mkdirSync(join(root, "data/ingestion"), { recursive: true });
  writeFileSync(
    join(root, "data/ingestion/ledger.json"),
    JSON.stringify(empty())
  );
  return { path, root };
}
afterEach(() => {
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir(), "zivv-preflight-test-")))
      throw new Error("Unsafe fixture cleanup");
    rmSync(path, { recursive: true, force: true });
  }
});

describe("audited Steve preflight", () => {
  it("accounts for every physical line, unindented wraps, programming and exact duplicates", () => {
    const source = [
      "THE LIST",
      "",
      header,
      "oct 4 sun Fixture Band,",
      "Second Act",
      "at Test Room, Oakland a/a $10 8pm",
      show,
      show,
      "oct 3 sat Volunteer Orientation at Test Room, Oakland a/a 8pm",
      "CLUB INFO",
      "private club details",
      "Please feel free to forward The List on to your friends.",
      "subscriber@example.invalid",
      "",
    ].join("\r\n");
    const report = preflightSteveContent(source, empty());
    expect(report.errors).toEqual([]);
    expect(report.counts).toEqual({
      rows: 4,
      accepted: 2,
      programming: 1,
      duplicates: 1,
      invalid: 0,
    });
    expect(report.sourceLines.map((line) => line.line)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1)
    );
    expect(report.rows[0].sourceLines).toEqual([4, 5, 6]);
    expect(report.rows[2]).toMatchObject({
      disposition: "duplicate",
      duplicateOf: 2,
    });
    expect(report.preparedContent).not.toContain("subscriber");
    expect(report.preparedContent).not.toContain("Volunteer Orientation");
    expect(report.sourceLines[12].disposition).toBe("wrapper");
  });

  it("corrects collapsed rows before parsing and classifying, including a short weekday", () => {
    const report = preflightSteveContent(
      [
        header,
        show,
        "nov 13 ri Other",
        "Lives at Test Room, Oakland a/a 8pm",
        "oct 3 sat Voluneer",
        "Orentation at Test Room, Oakland a/a 8pm",
      ].join("\n"),
      empty(),
      {},
      [
        {
          pattern: "^nov\\s+13\\s+ri\\s+Other Lives",
          replacement: "nov 13 fri Other Lives",
        },
        {
          pattern: "Voluneer Orentation",
          replacement: "Volunteer Orientation",
        },
      ]
    );
    expect(report.errors).toEqual([]);
    expect(report.counts).toMatchObject({ accepted: 2, programming: 1 });
    expect(report.rows[1].corrections).toEqual([0]);
    expect(report.preparedContent).toContain("nov 13 fri Other Lives");
  });

  it.each([
    "oct 3 sat Missing Venue",
    "oct 3 Missing Weekday at Test Room, Oakland a/a 8pm",
    "zzz 3 sat Wrong Month at Test Room, Oakland a/a 8pm",
    "oct 3 sat Volunteer Orientation without venue",
    "nov 31 sat Volunteer Orientation at Test Room, Oakland a/a 8pm",
    "oct 3 xyz Fixture Band at Test Room, Oakland a/a 8pm",
    "nov x sat Other Band at Other Room, Oakland a/a 8pm",
    "oct 3 sat Volunteer Orientation at , Oakland a/a 8pm",
    "oct 3 sat Volunteer Orientation at Test Room,",
    "oct 3 sat Fixture Band at , Oakland a/a 8pm",
    "oct 3 sat Fixture Band at Test Room,",
  ])("withholds the entire prepared batch for malformed row: %s", (bad) => {
    const report = preflightSteveContent(
      `${header}\n${show}\n${bad}\n`,
      empty()
    );
    expect(report.preparedContent).toBeNull();
    expect(report.counts.invalid).toBe(1);
    expect(report.errors).toContain("Invalid source rows require review");
  });

  it("keeps a real performer on mixed programming bills", () => {
    const report = preflightSteveContent(
      `${header}\noct 2 fri Emo Night, Fixture Band at Test Room, Oakland a/a 8pm\n`,
      empty()
    );
    expect(report.errors).toEqual([]);
    expect(report.counts.programming).toBe(0);
    expect(report.rows[0].excludedNames).toEqual(["Emo Night"]);
  });

  it("does not treat numeric performer names or CLUB INFO band names as section boundaries", () => {
    const report = preflightSteveContent(
      `${header}\noct 2 fri Fixture Band,\nSum 41\nat Test Room, Oakland a/a 8pm\noct 3 sat CLUB INFO Band at Other Room, Oakland a/a 8pm\n`,
      empty()
    );
    expect(report.errors).toEqual([]);
    expect(report.counts.accepted).toBe(2);
    expect(report.preparedContent).toContain("Sum 41");
  });

  it("blocks dated rows outside the listing and unknown post-venue continuations", () => {
    for (const ending of [
      "Please feel free to forward The List on to your friends.\noct 3 sat Missing Venue",
      "CLUB INFO\noct 3 sat Missing Venue",
      "malformed forgotten event text",
    ]) {
      const report = preflightSteveContent(
        `${header}\n${show}\n${ending}\n`,
        empty()
      );
      expect(report.preparedContent).toBeNull();
    }
    const valid = preflightSteveContent(
      `${header}\noct 2 fri Fixture Band\nat Test Room, Oakland\na/a $10 8pm\n`,
      empty()
    );
    expect(valid.errors).toEqual([]);
  });

  it.each([
    "Sum 41 at Test Room, Oakland a/a 8pm",
    "May Erlewine\nat Test Room, Oakland a/a 8pm",
    "April March\nat Test Room, Oakland a/a 8pm",
  ])("keeps month-like and numeric wrapped performers: %s", (continuation) => {
    const report = preflightSteveContent(
      `${header}\noct 2 fri Fixture Band,\n${continuation}\n`,
      empty()
    );
    expect(report.errors).toEqual([]);
    expect(report.counts.rows).toBe(1);
    expect(report.counts.accepted).toBe(1);
  });

  it("rejects normalization loss from non-exact duplicate bills", () => {
    const report = preflightSteveContent(
      `${header}\n${show}\n${show.replace("Fixture Band", "Fixture Band, Second Act")}\n`,
      empty()
    );
    expect(report.preparedContent).toBeNull();
    expect(report.errors).toContain(
      "Non-exact duplicate or normalization loss requires review"
    );
  });

  it("blocks non-idempotent corrections and unrecognized delivery text", () => {
    const unstable = preflightSteveContent(
      `${header}\n${show}\n`,
      empty(),
      {},
      [{ pattern: "Fixture", replacement: "Fixture Extra" }]
    );
    expect(unstable.errors).toContain(
      "Corrections are not idempotent under the maintained importer"
    );
    const footer = preflightSteveContent(
      `${header}\n${show}\nPlease feel free to forward this list\n`,
      empty()
    );
    expect(footer.preparedContent).toBeNull();
  });

  it("requires a dated header and at least one performer show", () => {
    expect(preflightSteveContent(show, empty()).preparedContent).toBeNull();
    expect(
      preflightSteveContent(
        `Upcoming shows of Interest February 30, 2026\n${show}\n`,
        empty()
      ).errors
    ).toContain("Missing or invalid dated issue header");
    const report = preflightSteveContent(
      `${header}\noct 2 fri Emo Night at Test Room, Oakland a/a 8pm\n`,
      empty()
    );
    expect(report.errors).toContain("No performer events remain");
  });

  it("preserves source bytes privately, repeats deterministically and imports with receipt replay", async () => {
    const { path, root } = fixture();
    const input = join(path, "incoming.txt");
    const source = Buffer.from(
      `THE LIST\r\n${header}\r\n${show}\r\n${show}\r\nPlease feel free to forward The List on to your friends.\r\nprivate@example.invalid\r\n`
    );
    writeFileSync(input, source);
    const output = join(path, "operator/preflight");
    const args = [
      resolve("scripts/preflight-steveslist.js"),
      "--root",
      root,
      "--file",
      input,
      "--output-dir",
      output,
    ];
    const before = readFileSync(join(root, "data/ingestion/ledger.json"));
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(first.status, first.stderr).toBe(0);
    const summary = JSON.parse(first.stdout);
    expect(first.stdout).not.toContain("private@example");
    expect(readFileSync(join(summary.directory, "raw.txt"))).toEqual(source);
    expect(readFileSync(join(root, "data/ingestion/ledger.json"))).toEqual(
      before
    );
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    const prepared = readFileSync(
      join(summary.directory, "prepared.txt"),
      "utf8"
    );
    const imported = await importSteveContent(root, prepared, {
      observedAtEpochMs: 2000,
    });
    const replay = await importSteveContent(root, prepared, {
      observedAtEpochMs: 9000,
    });
    expect(imported.report.newEventIds).toHaveLength(1);
    expect(replay.report.replay).toBe(true);
    expect(replay.ledger.events[0].createdAtEpochMs).toBe(2000);
    expect(replay.ledger.events[0].id).toBe(imported.ledger.events[0].id);
  });

  it("CLI writes a failure audit without prepared text and refuses Git/public output", () => {
    const { path, root } = fixture();
    const input = join(path, "incoming.txt");
    writeFileSync(input, `${header}\n${show}\noct 3 sat Missing Venue\n`);
    const output = join(path, "private");
    const base = [
      resolve("scripts/preflight-steveslist.js"),
      "--root",
      root,
      "--file",
      input,
    ];
    const failed = spawnSync(
      process.execPath,
      [...base, "--output-dir", output],
      { encoding: "utf8" }
    );
    expect(failed.status).toBe(1);
    const directory = JSON.parse(failed.stdout).directory;
    expect(readdirSync(directory).sort()).toEqual(["raw.txt", "report.json"]);
    const forbidden = spawnSync(
      process.execPath,
      [...base, "--output-dir", join(root, "public/preflight")],
      { encoding: "utf8" }
    );
    expect(forbidden.status).toBe(1);
    expect(forbidden.stderr).toContain("outside the checkout");
    // Existing artifacts are never silently overwritten on retry.
    writeFileSync(join(directory, "raw.txt"), "corrupted");
    const corrupt = spawnSync(
      process.execPath,
      [...base, "--output-dir", output],
      { encoding: "utf8" }
    );
    expect(corrupt.status).toBe(1);
    expect(corrupt.stderr).toContain("refusing overwrite");
  });

  it("archives invalid UTF-8 without an importable batch and rejects artifact junctions", () => {
    const { path, root } = fixture();
    const input = join(path, "incoming.txt");
    const bytes = Buffer.concat([
      Buffer.from(`${header}\n${show}\n`),
      Buffer.from([0xff]),
    ]);
    writeFileSync(input, bytes);
    const args = [
      resolve("scripts/preflight-steveslist.js"),
      "--root",
      root,
      "--file",
      input,
      "--output-dir",
      join(path, "private"),
    ];
    const failed = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(failed.status, failed.stderr).toBe(1);
    const directory = JSON.parse(failed.stdout).directory;
    expect(readFileSync(join(directory, "raw.txt"))).toEqual(bytes);
    expect(readdirSync(directory).sort()).toEqual(["raw.txt", "report.json"]);
    const report = JSON.parse(
      readFileSync(join(directory, "report.json"), "utf8")
    );
    expect(report.errors[0]).toContain("not valid UTF-8");
    // Only remove the generated directory inside this isolated fixture.
    expect(
      resolve(directory).startsWith(
        resolve(path) + (process.platform === "win32" ? "\\" : "/")
      )
    ).toBe(true);
    rmSync(directory, { recursive: true });
    const forbidden = join(root, "public");
    mkdirSync(forbidden);
    symlinkSync(
      forbidden,
      directory,
      process.platform === "win32" ? "junction" : "dir"
    );
    const redirected = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(redirected.status).toBe(1);
    expect(redirected.stderr).toContain("directory must not be a link");
    expect(readdirSync(forbidden)).toEqual([]);
  });
});
