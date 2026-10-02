import { describe, expect, it } from "vitest";
import type { Artist, Event } from "../../types/events.js";
import {
  collectUnverifiedWeeklyArtists,
  seedLocalArtistVerificationLedger,
  normalizeVerifiedArtistName,
  upsertLocalArtistVerification,
  namesForVerificationStatus,
  weeklyPerformanceEventIds,
} from "../../lib/ingestion/local-artist-verification.js";

const artist = (id: number, name: string) =>
  ({
    id,
    name,
    normalizedName: name.toLowerCase(),
    slug: name.toLowerCase(),
    aliases: [],
    upcomingEventCount: 0,
    totalEventCount: 0,
    upcomingEvents: [],
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
  }) as Artist;

const event = (id: number, artistIds: number[]) =>
  ({
    id,
    artistIds,
    headlinerArtistId: artistIds[0],
    date: "2026-09-19",
    dateEpochMs: 1,
    slug: `event-${id}`,
    venueId: 1,
    timezone: "America/Los_Angeles",
    isFree: false,
    ageRestriction: "all-ages",
    status: "confirmed",
    tags: [],
    venueType: "club",
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
    sourceLineNumber: 1,
  }) as Event;

describe("weekly local artist verification", () => {
  it("excludes event labels and fragments without excluding similarly named performers", () => {
    const names = [
      "and the Cast",
      "Castro Street Fair",
      "Country Fair",
      " crafts ",
      "Emo Nite",
      "Emo Night",
      "Folsom Street Fair",
      "Divine Offering (tribute)",
      "Cholos vs. Vampires",
      "Cholos vs. Vampiers",
      "Hamdi FC vs. San Francisco",
      "membership meeting",
      "Street",
      "Street Eaters",
      "Hamdi",
    ];
    const artists = names.map((name, index) => artist(index + 1, name));
    const candidates = collectUnverifiedWeeklyArtists(
      [
        event(
          10,
          artists.map((item) => item.id)
        ),
      ],
      artists,
      [10],
      seedLocalArtistVerificationLedger([], [], 100)
    );
    expect(candidates.map((item) => item.name)).toEqual([
      "Hamdi",
      "Street Eaters",
    ]);
  });

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
    const verification = seedLocalArtistVerificationLedger(
      ["Checked Act"],
      [],
      100
    );
    upsertLocalArtistVerification(verification, {
      name: "Checked Act",
      status: "local",
      verifiedAtEpochMs: 101,
      method: "web-origin-check",
      evidence: "Artist biography: Oakland band.",
      sources: ["https://example.org/artist"],
      location: "Oakland",
    });
    const candidates = collectUnverifiedWeeklyArtists(
      events,
      artists,
      [10],
      verification
    );

    expect(candidates.map((item) => item.name)).toEqual(["Unknown Act"]);
  });

  it("rechecks legacy labels and unresolved searches instead of treating them as verified", () => {
    const verification = seedLocalArtistVerificationLedger(
      ["Legacy Local"],
      ["Legacy Visitor"],
      100
    );
    upsertLocalArtistVerification(verification, {
      name: "Ambiguous",
      status: "unresolved",
      verifiedAtEpochMs: 200,
      method: "web-origin-check",
      evidence: "Multiple artists share this name.",
      sources: ["https://example.org/artists"],
    });
    const candidates = collectUnverifiedWeeklyArtists(
      [event(10, [1, 2, 3])],
      [
        artist(1, "Legacy Local"),
        artist(2, "Legacy Visitor"),
        artist(3, "Ambiguous"),
      ],
      [10],
      verification
    );
    expect(candidates.map((item) => item.name)).toEqual([
      "Ambiguous",
      "Legacy Local",
      "Legacy Visitor",
    ]);
    expect(namesForVerificationStatus(verification, "local")).toEqual([]);
    expect(namesForVerificationStatus(verification, "non-local")).toEqual([]);
  });

  it("exports role-marked aliases only for an evidenced origin", () => {
    const verification = seedLocalArtistVerificationLedger([], [], 100);
    upsertLocalArtistVerification(verification, {
      name: "Local Act",
      status: "local",
      verifiedAtEpochMs: 200,
      method: "web-origin-check",
      evidence: "Official bio: based in Oakland.",
      location: "Oakland",
      sources: ["https://example.org/bio"],
    });
    expect(
      namesForVerificationStatus(verification, "local", [
        artist(1, "Local Act (acoustic)"),
        artist(2, "Visitor"),
      ])
    ).toEqual(["Local Act", "Local Act (acoustic)"]);
  });

  it("checks all performances in the week even when imported in an older edition", () => {
    const events = [
      { ...event(1, [1]), date: "2026-09-24" },
      { ...event(2, [1]), date: "2026-09-25" },
      { ...event(3, [1]), date: "2026-10-01" },
      { ...event(4, [1]), date: "2026-10-02" },
      { ...event(5, [1]), date: "2026-09-28", status: "cancelled" as const },
    ];
    expect(
      weeklyPerformanceEventIds(events, "2026-09-25", "2026-10-02")
    ).toEqual([2, 3]);
    expect(() =>
      weeklyPerformanceEventIds(events, "2026-02-30", "2026-03-04")
    ).toThrow();
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
