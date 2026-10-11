import { describe, expect, it } from "vitest";
import {
  applyEventPosters,
  decodeEventPosters,
  type ReviewedEventPoster,
} from "../../lib/ingestion/event-posters.js";
import type { Artist, Event, Venue } from "../../types/events.js";

const row: ReviewedEventPoster = {
  eventId: 1,
  eventSlug: "2026-11-01-band-room",
  date: "2026-11-01",
  venueId: 2,
  venueName: "Room",
  headlinerArtistId: 3,
  headlinerName: "Band",
  imageUrl: "https://venue.example/flyer.jpg",
  eventUrl: "https://venue.example/show",
  kind: "poster",
  checkedOn: "2026-10-10",
  evidence: "Official listing gives the date and band.",
};
function fixture() {
  return {
    events: [
      {
        id: 1,
        slug: row.eventSlug,
        date: row.date,
        venueId: 2,
        headlinerArtistId: 3,
        createdAtEpochMs: 100,
        updatedAtEpochMs: 200,
        sources: [{ sourceId: "steveslist" }],
      },
    ] as Event[],
    venues: [{ id: 2, name: "Room" }] as Venue[],
    artists: [{ id: 3, name: "Band" }] as Artist[],
  };
}
describe("reviewed event posters", () => {
  it("preserves canonical identity, added dates and source observations", () => {
    const { events, venues, artists } = fixture();
    const original = structuredClone(events[0]);
    const registry = { schemaVersion: 1 as const, events: [row] };
    expect(applyEventPosters(events, venues, artists, registry)).toEqual({
      applied: [1],
      stale: [],
    });
    const { poster, ...rest } = events[0];
    expect(rest).toEqual(original);
    expect(poster).toEqual({
      imageUrl: row.imageUrl,
      eventUrl: row.eventUrl,
      kind: row.kind,
      checkedOn: row.checkedOn,
    });
    applyEventPosters(events, venues, artists, registry);
    expect(events[0].poster).toEqual(poster);
  });
  it.each([
    { date: "2026-11-02" },
    { venueId: 4 },
    { headlinerArtistId: 5 },
    { slug: "renamed" },
  ])("removes stale artwork after the show changes: %j", (change) => {
    const { events, venues, artists } = fixture();
    const registry = { schemaVersion: 1 as const, events: [row] };
    applyEventPosters(events, venues, artists, registry);
    Object.assign(events[0], change);
    expect(applyEventPosters(events, venues, artists, registry)).toEqual({
      applied: [],
      stale: [1],
    });
    expect(events[0].poster).toBeUndefined();
  });
  it("does not attach artwork to a differently named room or artist", () => {
    const { events, venues, artists } = fixture();
    venues[0].name = "Other Room";
    expect(
      applyEventPosters(events, venues, artists, {
        schemaVersion: 1,
        events: [row],
      }).applied
    ).toEqual([]);
    venues[0].name = "Room";
    artists[0].name = "Other Band";
    expect(
      applyEventPosters(events, venues, artists, {
        schemaVersion: 1,
        events: [row],
      }).applied
    ).toEqual([]);
  });
  it.each([
    { ...row, imageUrl: "javascript:alert(1)" },
    { ...row, eventUrl: "https://user:secret@venue.example/show" },
    { ...row, evidence: "" },
    { ...row, date: "2026-02-30" },
  ])("rejects malformed evidence before mutating any show", (badRow) => {
    const { events, venues, artists } = fixture();
    const before = structuredClone(events);
    expect(() =>
      applyEventPosters(events, venues, artists, {
        schemaVersion: 1,
        events: [row, { ...badRow, eventId: 99 }],
      })
    ).toThrow("Invalid event poster entry");
    expect(events).toEqual(before);
  });
  it("rejects conflicting duplicate event observations", () => {
    expect(() =>
      decodeEventPosters({ schemaVersion: 1, events: [row, row] })
    ).toThrow("Invalid event poster entry");
  });
  it("accepts newly reviewed artwork after a reschedule retains its original slug", () => {
    const { events, venues, artists } = fixture();
    events[0].date = "2027-02-11" as Event["date"];
    const reviewed = { ...row, date: "2027-02-11" };
    expect(
      applyEventPosters(events, venues, artists, {
        schemaVersion: 1,
        events: [reviewed],
      })
    ).toEqual({ applied: [1], stale: [] });
    expect(events[0].slug).toBe(row.eventSlug);
  });
});
