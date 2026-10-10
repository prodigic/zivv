import { useState } from "react";
import { Link } from "react-router-dom";
import type { Artist, Event, Venue } from "@/types/events.js";
import { formatAddedDateLabel } from "@/lib/discovery.js";
import { getVenueMapTile } from "@/utils/venue-map.js";
import VenueNameLink from "./VenueNameLink.js";
import "./EventAtlasCard.css";

/** The selected Transparent Atlas treatment, with show details over one map tile. */
export default function EventAtlasCard({
  event,
  venue,
  headlinerName,
  supportingArtists,
}: {
  event: Event;
  venue?: Venue | null;
  headlinerName: string;
  supportingArtists: Artist[];
}) {
  const tile = getVenueMapTile(venue?.mapLocation);
  const [failedTile, setFailedTile] = useState<string | null>(null);
  const mapVisible = tile && failedTile !== tile.url;
  const date = new Date(event.dateEpochMs).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = event.startTimeEpochMs
    ? new Date(event.startTimeEpochMs).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const addedLabel =
    event.addedDateProvenance === "unknown"
      ? null
      : formatAddedDateLabel(event.createdAtEpochMs);
  const soldOut =
    event.status === "sold-out" || event.tags?.includes("sold-out");
  const status =
    event.status && event.status !== "confirmed"
      ? event.status
      : soldOut
        ? "sold-out"
        : null;
  const price = event.isFree
    ? "FREE SHOW"
    : event.priceMin != null
      ? `$${event.priceMin}${event.priceMax != null && event.priceMax !== event.priceMin ? `–$${event.priceMax}` : ""}`
      : "LIVE SHOW";
  const mapUrl = venue
    ? (tile?.mapUrl ??
      `https://www.openstreetmap.org/search?query=${encodeURIComponent([venue.name, venue.address, venue.city].filter(Boolean).join(", "))}`)
    : null;
  const locationLabel = !tile
    ? "Location not mapped · search map ↗"
    : !mapVisible
      ? "Map preview unavailable · open map ↗"
      : venue?.mapLocation?.precision === "area"
        ? "Approximate area · open map ↗"
        : venue?.mapLocation?.precision === "site"
          ? "Venue site · open map ↗"
          : "Approximate location · open map ↗";

  return (
    <article className="event-atlas" aria-label="Show details and venue map">
      {mapVisible && venue && (
        <div className="event-atlas-map">
          <div className="event-atlas-plane">
            <img
              src={tile.url}
              alt={`Street map around ${venue.name}`}
              width={256}
              height={256}
              loading="lazy"
              decoding="async"
              onError={() => setFailedTile(tile.url)}
            />
            <span
              className="event-atlas-marker"
              aria-hidden="true"
              style={{
                left: `${(tile.markerX / 256) * 100}%`,
                top: `${(tile.markerY / 256) * 100}%`,
              }}
            />
          </div>
        </div>
      )}
      <div className="event-atlas-shade" aria-hidden="true" />
      <div className="event-atlas-copy">
        <div className="event-atlas-date">
          {date}
          {time ? ` / ${time}` : ""}
        </div>
        <h2>{headlinerName}</h2>
        {supportingArtists.length > 0 && (
          <p className="event-atlas-support">
            with{" "}
            {supportingArtists.map((artist, index) => (
              <span key={artist.id}>
                {index > 0 && " + "}
                <Link to={`/artists/${artist.slug}`}>{artist.name}</Link>
              </span>
            ))}
          </p>
        )}
        <div className="event-atlas-bottom">
          {venue && (
            <div className="event-atlas-venue">
              <VenueNameLink venue={venue} />
              <p>{[venue.address, venue.city].filter(Boolean).join(", ")}</p>
            </div>
          )}
          <div className="event-atlas-admission">
            <span
              className={`event-atlas-status${status ? " event-atlas-status-alert" : ""}`}
            >
              {status ? status.replaceAll("-", " ").toUpperCase() : price}
            </span>
            {event.ageRestriction && <span>{event.ageRestriction}</span>}
            {event.tags
              ?.filter((tag) => tag !== "sold-out")
              .map((tag) => (
                <span key={tag}>
                  {tag === "multiple-show" ? "Multiple shows" : tag}
                </span>
              ))}
            {event.ticketUrl && (
              <a
                href={event.ticketUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Tickets ↗
              </a>
            )}
          </div>
          {addedLabel && <p className="event-atlas-added">{addedLabel}</p>}
          {(event.description || event.notes) && (
            <div className="event-atlas-notes">
              {event.description && <p>{event.description}</p>}
              {event.notes && <p>{event.notes}</p>}
            </div>
          )}
        </div>
        {mapUrl && (
          <a
            className="event-atlas-location"
            href={mapUrl}
            title="Map locations are approximate and do not identify a venue entrance."
          >
            {locationLabel}
          </a>
        )}
      </div>
      {mapVisible && (
        <a
          className="event-atlas-credit"
          href="https://www.openstreetmap.org/copyright"
        >
          © OpenStreetMap contributors
        </a>
      )}
    </article>
  );
}
