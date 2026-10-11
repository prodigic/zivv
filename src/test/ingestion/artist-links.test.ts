import { describe, expect, it } from "vitest";
import {
  applyArtistLinks,
  decodeArtistLinks,
} from "../../lib/ingestion/artist-links.js";
import type { Artist } from "../../types/events.js";
import { isArtistLink } from "../../utils/artist-links.js";

const link = {
  kind: "bandcamp",
  url: "https://exampleband.bandcamp.com/album/demo",
  sourceUrl: "https://exampleband.bandcamp.com/album/demo",
  checkedOn: "2026-10-10",
  evidence: "Artist name and release match the reviewed identity.",
};
const row = { artistId: 1, artistName: "Example Band", links: [link] };
const artist = () =>
  ({
    id: 1,
    name: "Example Band",
    slug: "stable-slug",
    createdAtEpochMs: 123,
    updatedAtEpochMs: 456,
  }) as Artist;

describe("reviewed artist links", () => {
  it("adds links without requiring a review or changing identity and history", () => {
    const a = artist();
    const before = structuredClone(a);
    expect(applyArtistLinks([a], { schemaVersion: 1, artists: [row] })).toEqual(
      []
    );
    const { links, ...rest } = a;
    expect(rest).toEqual(before);
    expect(links).toEqual([{ kind: "bandcamp", url: link.url }]);
  });
  it("withholds links after an identity rename", () => {
    const a = artist();
    applyArtistLinks([a], { schemaVersion: 1, artists: [row] });
    a.name = "A Different Artist";
    expect(applyArtistLinks([a], { schemaVersion: 1, artists: [row] })).toEqual(
      [1]
    );
    expect(a.links).toBeUndefined();
  });
  it.each([
    { ...link, url: "javascript:alert(1)" },
    { ...link, url: "https://user:secret@exampleband.bandcamp.com/" },
    { ...link, url: "https://bandcamp.com/" },
    { ...link, url: "https://bandcamp.com.attacker.example/band" },
    { ...link, kind: "instagram", url: "https://www.instagram.com/p/123/" },
    { ...link, kind: "x", url: "https://twitter.com/intent/tweet" },
    { ...link, sourceUrl: "data:text/html,unsafe" },
    { ...link, checkedOn: "2026-02-30" },
  ])("rejects malformed links before any artist changes", (bad) => {
    const a = artist();
    expect(() =>
      applyArtistLinks([a], {
        schemaVersion: 1,
        artists: [row, { ...row, artistId: 2, links: [bad] }],
      })
    ).toThrow("Invalid artist link source");
    expect(a).toEqual(artist());
  });
  it("rejects duplicated artists and destinations", () => {
    expect(() =>
      decodeArtistLinks({ schemaVersion: 1, artists: [row, row] })
    ).toThrow();
    expect(() =>
      decodeArtistLinks({
        schemaVersion: 1,
        artists: [{ ...row, links: [link, link] }],
      })
    ).toThrow();
  });
  it("accepts directly observed music releases and profile links", () => {
    expect(isArtistLink(link)).toBe(true);
    expect(
      isArtistLink({
        kind: "instagram",
        url: "https://www.instagram.com/exampleband/",
      })
    ).toBe(true);
    expect(
      isArtistLink({
        kind: "spotify",
        url: "https://open.spotify.com/artist/123",
      })
    ).toBe(true);
  });
});
