import { describe, expect, it } from "vitest";
import { prepareSteveBatch, steveRunId } from "../../lib/ingestion/imports.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";

function emptyLedger() {
  return bootstrapLedger({ events: [], artists: [], venues: [] }, 1_000);
}

describe("Steve's List ingestion input", () => {
  it("normalizes headers and multiline rows into a valid candidate batch", () => {
    const content = [
      "THE LIST",
      "",
      "funk-punk-thrash-ska  Upcoming shows of Interest August 21, 2026",
      "",
      "aug 21 fri Test Band,",
      "  Second Act",
      "  at Test Room, Oakland a/a $10 7pm/8pm",
      "",
      "Please feel free to forward The List on to your friends.",
    ].join("\n");

    const batch = prepareSteveBatch(emptyLedger(), content, 2_000);

    expect(batch.runId).toBe(steveRunId(content, {}));
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({
      date: "2026-08-21",
      timeBasis: "instant",
    });
    expect(batch.artists).toHaveLength(2);
    expect(batch.venues).toHaveLength(1);
  });

  it("rejects incomplete source rows with bounded diagnostics", () => {
    const content = [
      "THE LIST",
      "funk-punk-thrash-ska  Upcoming shows of Interest August 21, 2026",
      "aug 21 fri Valid Band at Test Room, Oakland a/a $10 7pm",
      "aug 22 sat Missing Venue",
    ].join("\n");

    expect(() => prepareSteveBatch(emptyLedger(), content, 2_000)).toThrow(
      /Steve's List parse is incomplete; no events accepted \(2 entries, 1 parsed\).*line 2 \[incomplete\].*Missing Venue/u
    );
  });

  it("changes the deterministic run identity when aliases change", () => {
    const content =
      "funk-punk-thrash-ska Upcoming shows of Interest August 21, 2026\n" +
      "aug 21 fri Test Band at Test Room, Oakland a/a 7pm\n";

    expect(steveRunId(content, { "test room": "Test Room" })).not.toBe(
      steveRunId(content, { "test room": "Other Room" })
    );
  });
});
