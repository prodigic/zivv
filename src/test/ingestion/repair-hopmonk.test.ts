import { describe, expect, it } from "vitest";
import { prepareSteveBatch } from "../../lib/ingestion/imports.js";
import {
  bootstrapLedger,
  reconcileCandidates,
} from "../../lib/ingestion/ledger.js";
import { repairHopmonk } from "../../lib/ingestion/repair-hopmonk.js";

const source = [
  "oct 1 2026 First Band at Hopmonk Tavern, Sebastopol 21+ 8pm",
  "oct 4 2026 Second Band at Hopmonk Tavern, Novato a/a 7pm",
  "oct 8 2026 Third Band at Hopmonk, Novato a/a 6pm",
].join("\n");
const now = Date.parse("2026-10-01T19:00:00Z");
function legacyCatalog() {
  const empty = bootstrapLedger({ events: [], artists: [], venues: [] }, now);
  const batch = prepareSteveBatch(empty, source, now);
  const venue = {
    ...batch.venues[0],
    name: "Hopmonk Tavern",
    normalizedName: "hopmonk tavern",
  };
  return bootstrapLedger(
    {
      artists: batch.artists,
      venues: [venue],
      events: batch.events.map((e) => ({
        ...("event" in e ? e.event : e),
        venueId: venue.id,
      })),
    },
    now
  );
}

describe("HopMonk city repair", () => {
  it("preserves identity and added dates, is repeatable, and does not duplicate shows on reimport", () => {
    const legacy = legacyCatalog();
    // The old name must not occupy either corrected location's ID.
    const oldId = legacy.venues[0].id;
    legacy.venues[0].id = 42 as typeof oldId;
    legacy.events.forEach((e) => {
      e.venueId = legacy.venues[0].id;
    });
    const before = structuredClone(legacy);
    const result = repairHopmonk(legacy, source, {}, now + 1);
    expect(legacy).toEqual(before);
    expect(result.changes).toHaveLength(3);
    expect(result.unresolved).toEqual([]);
    expect(
      result.ledger.events.map((e) => [
        e.id,
        e.slug,
        e.createdAtEpochMs,
        e.sources,
      ])
    ).toEqual(
      before.events.map((e) => [e.id, e.slug, e.createdAtEpochMs, e.sources])
    );
    expect(
      result.ledger.events.map(
        (e) => result.ledger.venues.find((v) => v.id === e.venueId)?.city
      )
    ).toEqual(["Sebastopol", "Novato", "Novato"]);
    expect(repairHopmonk(result.ledger, source, {}, now + 2).ledger).toEqual(
      result.ledger
    );
    const reimport = reconcileCandidates(
      result.ledger,
      prepareSteveBatch(result.ledger, source, now + 3)
    );
    expect(reimport.ledger.events).toHaveLength(3);
    expect(reimport.report.newEventIds).toEqual([]);
  });

  it("leaves events without source evidence unchanged", () => {
    const legacy = legacyCatalog();
    const result = repairHopmonk(legacy, "", {}, now);
    expect(result.ledger).toEqual(legacy);
    expect(result.unresolved).toHaveLength(3);
  });

  it("rejects conflicting cities for the same artist and date", () => {
    expect(() =>
      repairHopmonk(
        legacyCatalog(),
        source + "\noct 1 2026 First Band at Hopmonk, Novato a/a 8pm",
        {},
        now
      )
    ).toThrow(/Conflicting HopMonk cities/);
  });
});
