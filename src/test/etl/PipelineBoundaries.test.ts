import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { runPurePipeline } from "@/lib/etl/pipeline/run.js";
import { eventIdentityKey, stableEventIdentityKey } from "@/lib/etl/identity/keys.js";

const root = join(process.cwd());
const fixedTimestamp = Date.UTC(2026, 7, 7, 12);

describe("ETL pipeline boundaries", () => {
  it("supports a weekly snapshot without writing to the input directory", () => {
    const result = runPurePipeline(root, {
      inputDir: join(root, "data", "steve"),
      eventsFile: "week-260807.txt",
      venuesPath: join(root, "data", "venues.txt"),
      processingTimestamp: fixedTimestamp,
      asOfEpochMs: fixedTimestamp,
    });

    expect(result.model.events.length).toBeGreaterThan(0);
    expect(result.model.artists.every((artist) => !("upcomingEvents" in artist))).toBe(true);
    expect(result.model.venues.every((venue) => !("upcomingEvents" in venue))).toBe(true);
    expect(result.projections.asOfEpochMs).toBe(fixedTimestamp);
  });

  it("produces the same canonical model for repeated fixed-time processing", () => {
    const config = {
      inputDir: join(root, "data", "steve"),
      eventsFile: "week-260807.txt",
      venuesPath: join(root, "data", "venues.txt"),
      processingTimestamp: fixedTimestamp,
      asOfEpochMs: fixedTimestamp,
    };
    const first = runPurePipeline(root, config);
    const second = runPurePipeline(root, config);

    expect(JSON.stringify(first.model)).toBe(JSON.stringify(second.model));
  });

  it("keeps event identity independent from source formatting", () => {
    expect(eventIdentityKey("2026-08-07", 12, 34)).toBe(
      stableEventIdentityKey({ date: "2026-08-07", venueId: 12 as never, headlinerArtistId: 34 as never })
    );
  });
});
