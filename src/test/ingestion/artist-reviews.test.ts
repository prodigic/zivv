import { expect, it } from "vitest";
import {
  applyArtistReviews,
  decodeArtistReviews,
  type ReviewedArtistVibe,
} from "../../lib/ingestion/artist-reviews.js";
import type { Artist } from "../../types/events.js";
const row: ReviewedArtistVibe = {
  artistId: 1,
  artistName: "Local Band",
  summary: "Patient guitar music with bursts of noise.",
  basis: "release",
  checkedOn: "2026-10-10",
  identityEvidence: "Review links the band's official site.",
  reviews: [
    {
      url: "https://review.example/album",
      title: "Album review",
      publication: "Music Journal",
      author: "A Critic",
      publishedOn: "2024-01-01",
      kind: "release",
      reviewedWork: "The Album (2024)",
    },
  ],
};
const artist = () =>
  ({
    id: 1,
    name: "Local Band",
    createdAtEpochMs: 100,
    updatedAtEpochMs: 200,
    upcomingEvents: [],
  }) as unknown as Artist;
it("attaches cited reviews without changing identity or first-added dates", () => {
  const artists = [artist()];
  expect(
    applyArtistReviews(artists, { schemaVersion: 1, artists: [row] })
  ).toEqual([]);
  const { vibe, ...rest } = artists[0];
  expect(rest).toEqual(artist());
  expect(vibe?.reviews[0].url).toBe(row.reviews[0].url);
});
it("skips a different artist identity even if the numeric ID matches", () => {
  const artists = [artist()];
  artists[0].name = "Other Band";
  expect(
    applyArtistReviews(artists, { schemaVersion: 1, artists: [row] })
  ).toEqual([1]);
  expect(artists[0].vibe).toBeUndefined();
});
it.each([
  { ...row, basis: "live" },
  { ...row, reviews: [] },
  { ...row, reviews: [{ ...row.reviews[0], publishedOn: "2026-11-01" }] },
  { ...row, checkedOn: "2026-02-30" },
  { ...row, reviews: [{ ...row.reviews[0], publishedOn: "2024-02-30" }] },
  { ...row, reviews: [{ ...row.reviews[0], url: "javascript:alert(1)" }] },
  {
    ...row,
    reviews: [
      { ...row.reviews[0], url: "https://user:secret@review.example/album" },
    ],
  },
  { ...row, identityEvidence: "" },
  { ...row, reviews: [row.reviews[0], row.reviews[0]] },
])(
  "rejects unsafe, unsupported or contradictory evidence before applying any row",
  (bad) => {
    const artists = [artist()];
    expect(() =>
      applyArtistReviews(artists, {
        schemaVersion: 1,
        artists: [row, { ...bad, artistId: 2 }],
      })
    ).toThrow();
    expect(artists).toEqual([artist()]);
  }
);
it("rejects conflicting duplicate artist records", () => {
  expect(() =>
    decodeArtistReviews({ schemaVersion: 1, artists: [row, row] })
  ).toThrow();
});
