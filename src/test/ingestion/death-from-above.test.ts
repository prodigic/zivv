import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareSteveBatch } from "../../lib/ingestion/imports.js";
import {
  bootstrapLedger,
  reconcileCandidates,
} from "../../lib/ingestion/ledger.js";
import { repairDeathFromAbove } from "../../lib/ingestion/repair-death-from-above.js";

const now = Date.parse("2026-10-01T19:00:00Z");
const source = [
  "oct 2 2026 Death From Above, 1979 at the UC Theater, Berkeley a/a $39.50 7pm/8pm til 11pm #",
  "oct 2 2026 Death From Above 1979, Rickshaw Billie's Burger Patrol at the UC Theater, Berkeley a/a $39.50 7pm/8pm til 11pm #",
].join("\n");
const movedSource =
  "feb 11 2027 Death From Above 1979 at August Hall, S.F. 5+ $44.45 7pm/8pm";
function corrected(content: string) {
  const corrections: { pattern: string; replacement: string }[] = JSON.parse(
    readFileSync("data/line-corrections.json", "utf8")
  );
  return corrections.reduce(
    (text, c) => text.replace(new RegExp(c.pattern, "gim"), c.replacement),
    content
  );
}

describe("Death From Above source identity", () => {
  it("imports both stale UC Theatre bills as the single moved show without a phantom 1979 act", () => {
    const empty = bootstrapLedger({ events: [], artists: [], venues: [] }, now);
    const result = reconcileCandidates(
      empty,
      prepareSteveBatch(empty, corrected(source), now)
    );
    expect(result.ledger.events).toHaveLength(1);
    expect(result.ledger.artists.map((a) => a.name)).toEqual([
      "Death From Above 1979",
    ]);
    expect(result.ledger.events[0].date).toBe("2027-02-11");
    expect(result.ledger.events[0].priceMin).toBe(44.45);
    expect(result.ledger.venues.map((v) => v.name)).toEqual(["August Hall"]);
  });
  it("leaves other dates and standalone 1979 acts untouched", () => {
    const different = [
      source.replaceAll("oct 2", "oct 3"),
      "oct 2 2026 1979 at the UC Theater, Berkeley a/a 8pm",
      "oct 2 2026 Death From Above 1979 at Different Hall, Berkeley a/a 8pm",
    ].join("\n");
    expect(corrected(different)).toBe(different);
  });
  function legacy() {
    const empty = bootstrapLedger({ events: [], artists: [], venues: [] }, now);
    const result = reconcileCandidates(
      empty,
      prepareSteveBatch(empty, source + "\n" + movedSource, now)
    ).ledger;
    result.events.forEach((e, i) => {
      e.createdAtEpochMs = now + i;
    });
    return result;
  }
  it("preserves the oldest ID, URL and added date, combines observations, and redirects both retired events", () => {
    const before = legacy();
    const original = structuredClone(before);
    before.venues.find((v) => v.name === "August Hall")!.city = "S.f";
    original.venues.find((v) => v.name === "August Hall")!.city = "S.f";
    const keeper = before.events[0];
    const result = repairDeathFromAbove(before, now + 100);
    expect(before).toEqual(original);
    expect(result.ledger.events).toHaveLength(1);
    const event = result.ledger.events[0];
    expect([
      event.id,
      event.slug,
      event.createdAtEpochMs,
      event.firstImportedBy,
      event.addedDateProvenance,
      event.firstImportRunId,
    ]).toEqual([
      keeper.id,
      keeper.slug,
      keeper.createdAtEpochMs,
      keeper.firstImportedBy,
      keeper.addedDateProvenance,
      keeper.firstImportRunId,
    ]);
    expect(event.date).toBe("2027-02-11");
    expect(event.firstObservedAtEpochMs).toBe(keeper.firstObservedAtEpochMs);
    expect(event.venueId).toBe(before.events[2].venueId);
    expect(event.status).toBe("confirmed");
    expect(event.notes).toContain("Original ticket purchases remain valid.");
    expect(event.artistIds).toEqual(before.events[2].artistIds);
    expect(event.sources).toEqual(before.events.flatMap((e) => e.sources));
    expect(
      result.ledger.redirects.map((r) => [r.fromEventId, r.toEventId])
    ).toEqual(before.events.slice(1).map((e) => [e.id, keeper.id]));
    expect(result.changes[0].retiredEvents).toEqual(before.events.slice(1));
    expect(repairDeathFromAbove(result.ledger, now + 200).ledger).toEqual(
      result.ledger
    );
    const imported = reconcileCandidates(
      result.ledger,
      prepareSteveBatch(
        result.ledger,
        corrected(source + "\n" + movedSource),
        now + 300
      )
    );
    expect(imported.ledger.events).toHaveLength(1);
    expect(imported.report.newEventIds).toEqual([]);
  });
  it("requires review when listings may represent separate sessions", () => {
    const before = legacy();
    before.events[1].startTimeEpochMs! += 3600000;
    expect(() => repairDeathFromAbove(before, now)).toThrow(
      /different sessions/
    );
  });
  it("repairs the real corrupt legacy time only with retained source proof of the same session", () => {
    const before = legacy();
    before.events[0].startTimeEpochMs = 1791039600000;
    before.events[0].timeBasis = "legacy-wall-clock";
    before.events[1].startTimeEpochMs = 1790996400000;
    expect(() => repairDeathFromAbove(before, now)).toThrow(
      /different sessions/
    );
    expect(
      repairDeathFromAbove(before, now, source).ledger.events
    ).toHaveLength(1);
    expect(() =>
      repairDeathFromAbove(before, now, source.replaceAll("7pm/8pm", "6pm/7pm"))
    ).toThrow(/different sessions/);
    before.events[0].timeBasis = "instant";
    expect(() => repairDeathFromAbove(before, now, source)).toThrow(
      /different sessions/
    );
  });
  it("requires review when destination evidence is absent or ambiguous", () => {
    const before = legacy();
    before.events.pop();
    expect(() => repairDeathFromAbove(before, now)).toThrow(
      /Missing or ambiguous/
    );
  });
});
