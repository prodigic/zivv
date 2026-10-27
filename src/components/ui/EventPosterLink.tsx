import React, { useState } from "react";
import type { EventPoster } from "@/types/events.js";
import { isEventPoster } from "@/utils/event-poster.js";

const frameClasses =
  "relative flex shrink-0 items-center justify-center overflow-hidden rounded border border-gray-200 bg-gray-100 text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400";

/** A show's official artwork, separate from the internal event navigation link. */
export default function EventPosterLink({
  poster,
  showName,
  reserve = false,
  size = "compact",
}: {
  poster?: EventPoster;
  showName: string;
  /** Keep the artwork slot aligned when neighboring rows have artwork. */
  reserve?: boolean;
  /** Larger artwork for the roomier venue show cards. */
  size?: "compact" | "large";
}): React.JSX.Element | null {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const frame = `${frameClasses} ${size === "large" ? "h-28 w-20" : "h-11 w-9"}`;
  if (!isEventPoster(poster)) {
    if (!reserve) return null;
    return (
      <span aria-hidden="true" className={frame}>
        {size === "large" ? (
          <span className="px-2 text-center text-xs">No artwork</span>
        ) : null}
      </span>
    );
  }
  const label = poster.kind === "poster" ? "poster" : "artwork";
  return (
    <a
      href={poster.eventUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View ${showName} ${label} on the official show page (opens in a new tab)`}
      title={`Official show ${label} ↗`}
      onClick={(event) => event.stopPropagation()}
      className={
        frame +
        " focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500"
      }
    >
      {failedUrl !== poster.imageUrl ? (
        <img
          src={poster.imageUrl}
          alt=""
          width={size === "large" ? 80 : 36}
          height={size === "large" ? 112 : 44}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-contain"
          onError={() => setFailedUrl(poster.imageUrl)}
        />
      ) : (
        <span className="px-1 text-center text-[10px]">
          {size === "large" ? "Artwork unavailable" : "Show"}
        </span>
      )}
      <span
        aria-hidden="true"
        className="absolute bottom-0 right-0 rounded-tl bg-gray-900/80 px-0.5 text-[10px] leading-3 text-white"
      >
        ↗
      </span>
    </a>
  );
}

/** Large official artwork shown under the show details hero. */
export function EventPosterArt({
  poster,
  showName,
  className = "",
}: {
  poster?: EventPoster;
  showName: string;
  className?: string;
}): React.JSX.Element | null {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!isEventPoster(poster)) return null;
  const label = poster.kind === "poster" ? "poster" : "artwork";
  return (
    <a
      href={poster.eventUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View ${showName} ${label} on the official show page (opens in a new tab)`}
      title={`Official show ${label} ↗`}
      className={
        "relative flex max-h-[560px] overflow-hidden rounded-lg border border-gray-200 bg-white items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500 dark:border-gray-700 dark:bg-gray-900 " +
        className
      }
    >
      {failedUrl !== poster.imageUrl ? (
        <img
          src={poster.imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="max-h-[560px] w-full object-contain"
          onError={() => setFailedUrl(poster.imageUrl)}
        />
      ) : (
        <span className="text-xs text-gray-500 dark:text-gray-400">Show ↗</span>
      )}
      <span
        aria-hidden="true"
        className="absolute bottom-0 right-0 rounded-tl bg-gray-900/80 px-1 text-[10px] leading-4 text-white"
      >
        ↗
      </span>
    </a>
  );
}
