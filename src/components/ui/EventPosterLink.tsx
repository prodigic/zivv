import React, { useState } from "react";
import type { EventPoster } from "@/types/events.js";
import { isEventPoster } from "@/utils/event-poster.js";

/** A show's official artwork, separate from the internal event navigation link. */
export default function EventPosterLink({
  poster,
  showName,
}: {
  poster?: EventPoster;
  showName: string;
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
      onClick={(event) => event.stopPropagation()}
      className="relative flex h-11 w-9 shrink-0 items-center justify-center overflow-hidden rounded border border-gray-200 bg-gray-100 text-gray-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400"
    >
      {failedUrl !== poster.imageUrl ? (
        <img
          src={poster.imageUrl}
          alt=""
          width={36}
          height={44}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-contain"
          onError={() => setFailedUrl(poster.imageUrl)}
        />
      ) : (
        <span className="text-[9px]">Show</span>
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
