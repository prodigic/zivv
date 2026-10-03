import { describe, expect, it } from "vitest";
import { prepareSteveBatch, steveRunId } from "../../lib/ingestion/imports.js";
import { bootstrapLedger } from "../../lib/ingestion/ledger.js";

function emptyLedger() {
  return bootstrapLedger({ events: [], artists: [], venues: [] }, 1_000);
}

describe("Steve's List ingestion input", () => {
  it("keeps upcoming dates beyond six months in the year after the issue", () => {
    const batch = prepareSteveBatch(
      emptyLedger(),
      [
        "funk-punk-thrash-ska Upcoming shows of Interest October 2, 2026",
        "oct 2 fri Current Band at Test Room, Oakland a/a 8pm",
        "apr 6 tue Spring Band at Test Room, Oakland a/a 8pm",
        "jun 4 fri Summer Band at Test Room, Oakland a/a 8pm",
        "aug 15 sun Late Summer Band at Test Room, Oakland a/a 8pm",
      ].join("\n"),
      Date.parse("2026-10-02T23:43:30Z")
    );
    expect(
      batch.events.map((event) => ("event" in event ? event.event : event).date)
    ).toEqual(["2026-10-02", "2027-04-06", "2027-06-04", "2027-08-15"]);
  });
  it("unifies Hopmonk aliases within a city while keeping Novato and Sebastopol separate", () => {
    const batch = prepareSteveBatch(
      emptyLedger(),
      [
        "oct 1 2026 First Band at Hopmonk Tavern, Sebastopol 21+ 8pm",
        "oct 4 2026 Second Band at Hopmonk Tavern, Novato a/a 7pm",
        "oct 8 2026 Third Band at Hopmonk, Novato a/a 6pm",
      ].join("\n"),
      Date.parse("2026-10-01T19:00:00Z")
    );
    expect(batch.venues.map((v) => [v.name, v.city])).toEqual([
      ["Hopmonk Tavern (Sebastopol)", "Sebastopol"],
      ["Hopmonk Tavern (Novato)", "Novato"],
    ]);
    expect(
      batch.events.map((e) => ("event" in e ? e.event : e).venueId)
    ).toEqual([batch.venues[0].id, batch.venues[1].id, batch.venues[1].id]);
  });
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
