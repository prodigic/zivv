import React from "react";
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
  const byPlatform = new Map<ArtistLink["kind"], ArtistLink>();
  for (const link of links?.filter(isArtistLink) ?? []) {
    const current = byPlatform.get(link.kind);
    if (!current || preference(link) < preference(current))
      byPlatform.set(link.kind, link);
  }
  const valid = [...byPlatform.values()];
  if (!valid.length) return null;
  return (
    <nav aria-label={`${artistName} links`} className="my-3">
      <ul className="flex flex-wrap gap-x-3 gap-y-2 text-xs">
        {valid.map((link) => (
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
          </li>
        ))}
      </ul>
    </nav>
  );
}
