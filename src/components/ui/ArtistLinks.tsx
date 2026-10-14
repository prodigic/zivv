import React, { useId, useState } from "react";
import { artistLinkLabels, type ArtistLink } from "@/types/artist-links.js";
import { isArtistLink } from "@/utils/artist-links.js";

/** Direct listening and social links, separate from review citations. */
export default function ArtistLinks({
  links,
  artistName,
}: {
  links?: ArtistLink[];
  artistName: string;
}): React.JSX.Element | null {
  // Keep every researched destination in the data, but one useful entry per platform here.
  const preference = (link: ArtistLink): number => {
    const path = new URL(link.url).pathname;
    if (path === "/" || path === "/music" || path.includes("/artist/"))
      return 0;
    return /\/(album|track|watch|release)(?:\/|$)/.test(path) ? 2 : 1;
  };
  const researched = links?.filter(isArtistLink) ?? [];
  const byPlatform = new Map<ArtistLink["kind"], ArtistLink>();
  for (const link of researched) {
    const current = byPlatform.get(link.kind);
    if (!current || preference(link) < preference(current))
      byPlatform.set(link.kind, link);
  }
  const valid = [...byPlatform.values()];
  if (!valid.length) return null;
  const album = researched.find(
    (link) =>
      link.kind === "bandcamp" &&
      link.embed &&
      /^\d+$/.test(link.embed.albumId) &&
      link.embed.title.trim()
  );
  return (
    <ArtistLinkList
      key={`${artistName}:${album?.embed?.albumId ?? "links"}`}
      links={valid}
      artistName={artistName}
      album={album}
    />
  );
}

/** Mount the official player only after the listener chooses to load it. */
function ArtistLinkList({
  links,
  artistName,
  album,
}: {
  links: ArtistLink[];
  artistName: string;
  album?: ArtistLink;
}): React.JSX.Element {
  const [listening, setListening] = useState(false);
  const playerId = useId();
  return (
    <nav aria-label={`${artistName} links`} className="my-3">
      <ul className="flex flex-wrap gap-x-3 gap-y-2 text-xs">
        {links.map((link) => (
          <li key={link.url}>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex items-center gap-1 rounded text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-current focus-visible:outline focus-visible:outline-2 dark:text-purple-300"
              aria-label={`${artistLinkLabels[link.kind]} (opens in a new tab)`}
            >
              {artistLinkLabels[link.kind]}
              <svg
                aria-hidden="true"
                className="h-3 w-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
              </svg>
            </a>
            {link.kind === "bandcamp" && album?.embed && (
              <button
                type="button"
                aria-expanded={listening}
                aria-controls={playerId}
                aria-label={`${listening ? "Close" : "Listen to"} ${album.embed.title} player`}
                onClick={(event) => {
                  event.stopPropagation();
                  setListening((current) => !current);
                }}
                className="ml-2 rounded border border-purple-300 px-2 py-1 text-purple-700 hover:bg-purple-50 focus-visible:outline focus-visible:outline-2 dark:border-purple-700 dark:text-purple-300 dark:hover:bg-purple-950"
              >
                {listening ? "Close player" : "Listen"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {listening && album?.embed && (
        <section
          id={playerId}
          aria-label={`${album.embed.title} album player`}
          onClick={(event) => event.stopPropagation()}
          className="mt-3 w-full max-w-[420px]"
        >
          <p className="mb-2 text-sm font-semibold">{album.embed.title}</p>
          <iframe
            title={`${artistName} — ${album.embed.title} on Bandcamp`}
            src={`https://bandcamp.com/EmbeddedPlayer/album=${album.embed.albumId}/size=large/bgcol=ffffff/linkcol=7137dc/artwork=small/tracklist=true/transparent=true/`}
            className="block h-[420px] w-full border-0"
            loading="lazy"
          />
          <a
            href={album.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs text-purple-700 underline dark:text-purple-300"
          >
            Open {album.embed.title} on Bandcamp (opens in a new tab)
          </a>
        </section>
      )}
    </nav>
  );
}
