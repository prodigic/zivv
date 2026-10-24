/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ArtistCardHero from "@/components/ui/ArtistCardHero";
import * as photoRegistry from "@/data/artist-photos";
import type { ApprovedArtistPhoto } from "@/data/artist-photos";
import type { Artist, ArtistId, EventId, VenueId } from "@/types/events";
const artist: Artist = {
  id: 1 as ArtistId,
  name: "Fixture Band",
  normalizedName: "fixture band",
  slug: "fixture-band",
  aliases: [],
  upcomingEventCount: 1,
  totalEventCount: 1,
  createdAtEpochMs: 1,
  updatedAtEpochMs: 1,
  upcomingEvents: [
    {
      id: 2 as EventId,
      slug: "fixture-show",
      dateEpochMs: Date.parse("2026-10-25T20:00:00Z"),
      venueId: 3 as VenueId,
      venueName: "Fixture Room",
      venueCity: "Oakland",
      headlinerName: "Fixture Band",
      isFree: false,
      isSoldOut: false,
      poster: {
        imageUrl: "https://venue.example/show.jpg",
        eventUrl: "https://venue.example/show",
        kind: "poster",
        checkedOn: "2026-10-20",
      },
    },
  ],
};
const approved = (): ApprovedArtistPhoto => ({
  artistId: 1,
  artistName: "Fixture Band",
  status: "approved",
  assetPath: "artist-photos/fixture.jpg",
  sourceUrl: "https://artist.example/photo",
  rightsUrl: "https://artist.example/terms",
  credit: "Photo: Fixture Photographer",
  reviewedOn: "2026-10-20",
  approvedUse: "artist-directory",
  reuseBasis: "explicit-permission",
  croppingAllowed: false,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("uses approved exact-identity photos with visible credit and rights", () => {
  const photo = approved();
  expect(photoRegistry.findApprovedArtistPhoto(artist, [photo])).toBe(photo);
  vi.spyOn(photoRegistry, "findApprovedArtistPhoto").mockReturnValue(photo);
  render(<ArtistCardHero artist={artist} />);
  expect(screen.getByRole("img", { name: "Fixture Band" })).toHaveAttribute(
    "src",
    "/artist-photos/fixture.jpg"
  );
  expect(screen.getByText(photo.credit)).toBeVisible();
  expect(screen.getByRole("link", { name: "Photo rights" })).toHaveAttribute(
    "href",
    photo.rightsUrl
  );
});
it.each([
  ["artistName", "Different Band"],
  ["artistId", 999],
  ["status", "revoked"],
  ["credit", ""],
  ["rightsUrl", "http://artist.example/terms"],
  ["assetPath", "artist-photos/../private.jpg"],
  ["expiresOn", "2026-10-01"],
  ["reviewedOn", "2025-02-30"],
])("refuses unusable photo metadata: %s", (key, value) => {
  const photo = approved();
  Reflect.set(photo, key, value);
  expect(
    photoRegistry.findApprovedArtistPhoto(artist, [photo])
  ).toBeUndefined();
});
it("falls back to labelled official show artwork", () => {
  render(<ArtistCardHero artist={artist} />);
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    artist.upcomingEvents[0].poster!.imageUrl
  );
  expect(screen.getByText("Upcoming show artwork ↗")).toHaveAttribute(
    "href",
    artist.upcomingEvents[0].poster!.eventUrl
  );
});
it("falls back after photo failure and removes a failed final image", () => {
  vi.spyOn(photoRegistry, "findApprovedArtistPhoto").mockReturnValue(
    approved()
  );
  const { container } = render(<ArtistCardHero artist={artist} />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    artist.upcomingEvents[0].poster!.imageUrl
  );
  fireEvent.error(screen.getByRole("img"));
  expect(container.querySelector("figure")).toBeNull();
});
it("renders no fake picture when neither approved photo nor show artwork exists", () => {
  const { container } = render(
    <ArtistCardHero artist={{ ...artist, upcomingEvents: [] }} />
  );
  expect(container).toBeEmptyDOMElement();
});
