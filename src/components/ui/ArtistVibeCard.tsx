import React from "react";
import type { ArtistVibe } from "@/types/artist-reviews.js";
import { isPosterUrl } from "@/utils/event-poster.js";

/** An attributed guide that keeps recorded music distinct from live evidence. */
export default function ArtistVibeCard({
  vibe,
  compact = false,
}: {
  vibe?: ArtistVibe;
  compact?: boolean;
}): React.JSX.Element | null {
  if (!vibe) return null;
  const reviews = vibe.reviews.filter((review) => isPosterUrl(review.url));
  if (!reviews.length) return null;
  return (
    <section
      aria-label="Vibe check"
      className={
        compact
          ? "mb-3 text-xs"
          : "rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
      }
    >
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-purple-700 dark:text-purple-300">
        Vibe check
      </h2>
      <p
        className={
          compact
            ? "text-gray-600 dark:text-gray-300"
            : "text-sm leading-relaxed text-gray-700 dark:text-gray-200"
        }
      >
        {vibe.summary}
      </p>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        {vibe.basis === "release"
          ? "Based on release reviews"
          : vibe.basis === "live"
            ? "Based on past live reviews"
            : "Based on release and past live reviews"}
      </p>
      <ul className="mt-1 space-y-1 text-xs">
        {reviews.map((review) => (
          <li key={review.url}>
            <a
              href={review.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-current dark:text-purple-300"
            >
              {review.publication}: {review.reviewedWork} ↗
            </a>
            <span className="text-gray-500 dark:text-gray-400">
              {review.publishedOn
                ? ` · ${review.publishedOn}`
                : " · Date not stated"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
