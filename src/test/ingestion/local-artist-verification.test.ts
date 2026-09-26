import { describe, expect, it } from "vitest";
import type { Artist, Event } from "../../types/events.js";
import {
  collectUnverifiedWeeklyArtists,
  seedLocalArtistVerificationLedger,
  normalizeVerifiedArtistName,
  upsertLocalArtistVerification,
} from "../../lib/ingestion/local-artist-verification.js";

const artist = (id: number, name: string) =>
  ({ id, name, normalizedName: name.toLowerCase(), slug: name.toLowerCase(), aliases: [], upcomingEventCount: 0, totalEventCount: 0, upcomingEvents: [], createdAtEpochMs: 1, updatedAtEpochMs: 1 }) as Artist;

const event = (id: number, artistIds: number[]) =>
  ({ id, artistIds, headlinerArtistId: artistIds[0], date: "2026-09-19", dateEpochMs: 1, slug: `event-${id}`, venueId: 1, timezone: "America/Los_Angeles", isFree: false, ageRestriction: "all-ages", status: "confirmed", tags: [], venueType: "club", createdAtEpochMs: 1, updatedAtEpochMs: 1, sourceLineNumber: 1 }) as Event;

describe("weekly local artist verification", () => {
  it("uses one key for role-marked lineup revisions", () => {
    expect(normalizeVerifiedArtistName("Kochina Rude (performance)")).toBe(
      "kochina rude"
    );
  });

  it("returns only unchecked artists from the selected weekly events", () => {
    const artists = [
      artist(1, "Checked Act"),
      artist(2, "Unknown Act"),
      artist(3, "Other Week"),
      artist(4, "Vendors"),
    ];
    const events = [event(10, [1, 2, 4]), event(11, [3])];
    const verification = seedLocalArtistVerificationLedger(["Checked Act"], [], 100);
    const candidates = collectUnverifiedWeeklyArtists(events, artists, [10], verification);

    expect(candidates.map((item) => item.name)).toEqual(["Unknown Act"]);
  });

  it("replaces a prior decision and keeps the decision keyed by normalized name", () => {
    const verification = seedLocalArtistVerificationLedger([], [], 100);
    upsertLocalArtistVerification(verification, {
      name: "Example (performance)",
      status: "non-local",
      verifiedAtEpochMs: 200,
      method: "manual",
    });
    upsertLocalArtistVerification(verification, {
      name: "Example",
      status: "local",
      verifiedAtEpochMs: 300,
      method: "manual",
    });

    expect(verification.entries).toHaveLength(1);
    expect(verification.entries[0]).toMatchObject({
      normalizedName: "example",
      status: "local",
    });
  });
});
