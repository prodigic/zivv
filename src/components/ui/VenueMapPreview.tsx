import { useState } from "react";
import type { Venue } from "@/types/events.js";
import { getVenueMapTile, type VenueMapTile } from "@/utils/venue-map.js";

type MapVenue = Pick<Venue, "id" | "name" | "address" | "city" | "mapLocation">;

/** A single lazy map tile; browser caching and the normal Referer are preserved. */
function MapTile({ tile, name }: { tile: VenueMapTile; name: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400 py-4">
        Map preview unavailable. Use the map link below to view the location.
      </p>
    );
  }

  return (
    <div className="relative block w-64 max-w-full aspect-square overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <a
        href={tile.mapUrl}
        aria-label={`Open map for ${name}`}
        className="block w-full h-full"
      >
        <img
          src={tile.url}
          alt={`Street map around ${name}`}
          width={256}
          height={256}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="block w-full h-full"
        />
        <span
          aria-hidden="true"
          data-testid="venue-map-marker"
          className="absolute h-4 w-4 rounded-full border-2 border-white bg-purple-700 shadow-md -translate-x-1/2 -translate-y-1/2"
          style={{
            left: `${(tile.markerX / 256) * 100}%`,
            top: `${(tile.markerY / 256) * 100}%`,
          }}
        />
      </a>
      <a
        href="https://www.openstreetmap.org/copyright"
        className="absolute bottom-0 right-0 z-10 bg-white text-gray-900 px-1 py-0.5 text-[11px] leading-tight underline"
      >
        © OpenStreetMap contributors
      </a>
    </div>
  );
}

/** Show a map only when reviewed coordinates are available; otherwise offer search. */
export default function VenueMapPreview({ venue }: { venue: MapVenue }) {
  const tile = getVenueMapTile(venue.mapLocation);
  const search = [venue.name, venue.address, venue.city]
    .filter(Boolean)
    .join(", ");
  const mapUrl =
    tile?.mapUrl ??
    `https://www.openstreetmap.org/search?query=${encodeURIComponent(search)}`;
  const caption = !tile
    ? "Location has not been mapped. Search by the venue name and listed address."
    : venue.mapLocation?.precision === "area"
      ? "Approximate area; the marker does not identify a venue entrance."
      : venue.mapLocation?.precision === "site"
        ? "Venue site location; the entrance may be elsewhere on the site."
        : "Approximate address location; the marker does not identify a venue entrance.";

  return (
    <section
      aria-label="Venue location"
      className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5 space-y-3"
    >
      <h2 className="text-base font-semibold text-gray-900 dark:text-white">
        Location
      </h2>
      {tile && (
        <MapTile
          key={`${venue.id}:${tile.url}`}
          tile={tile}
          name={venue.name}
        />
      )}
      <p className="text-sm text-gray-500 dark:text-gray-400">{caption}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <a
          href={mapUrl}
          className="text-purple-700 dark:text-purple-300 underline"
        >
          {tile ? "View on OpenStreetMap" : "Search OpenStreetMap"}
        </a>
      </div>
    </section>
  );
}
