import React, { useState } from "react";
import type { Artist } from "@/types/events.js";
import { findApprovedArtistPhoto } from "@/data/artist-photos.js";
import { isEventPoster } from "@/utils/event-poster.js";
import { isEventUpcoming } from "@/lib/discovery.js";

/** Prefer an approved portrait, then explicitly labelled official show artwork. */
export default function ArtistCardHero({
  artist,
}: {
  artist: Artist;
}): React.JSX.Element | null {
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const photo = findApprovedArtistPhoto(artist);
  const photoUrl = photo
    ? import.meta.env.BASE_URL + photo.assetPath
    : undefined;
  const show = artist.upcomingEvents.find(
    (event) =>
      isEventUpcoming(event) &&
      isEventPoster(event.poster) &&
      !failedImages.includes(event.poster.imageUrl)
  );
  const usePhoto = Boolean(
    photo && photoUrl && !failedImages.includes(photoUrl)
  );
  const imageUrl = usePhoto ? photoUrl : show?.poster?.imageUrl;
  if (!imageUrl) return null;
  const sourceUrl = usePhoto ? photo!.sourceUrl : show!.poster!.eventUrl;
  return (
    <figure className="artist-card-hero mb-3 overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-950">
      <a
        href={sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
        className="block aspect-[16/10] overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500"
        aria-label={
          usePhoto
            ? "View " + artist.name + " photo source (opens in a new tab)"
            : "View official artwork for " +
              show!.headlinerName +
              " at " +
              show!.venueName +
              " (opens in a new tab)"
        }
      >
        <img
          src={imageUrl}
          alt={
            usePhoto
              ? artist.name
              : "Show artwork: " +
                show!.headlinerName +
                " at " +
                show!.venueName
          }
          width={640}
          height={400}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={
            "h-full w-full " +
            (usePhoto && photo!.croppingAllowed
              ? "object-cover"
              : "object-contain")
          }
          onError={() => setFailedImages((previous) => [...previous, imageUrl])}
        />
      </a>
      <figcaption
        className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400"
        onClick={(event) => event.stopPropagation()}
      >
        {usePhoto ? (
          <>
            <span>{photo!.credit}</span>
            {" · "}
            <a
              href={photo!.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Source
            </a>
            {" · "}
            <a
              href={photo!.rightsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Photo rights
            </a>
          </>
        ) : (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            Upcoming show artwork ↗
          </a>
        )}
      </figcaption>
    </figure>
  );
}
