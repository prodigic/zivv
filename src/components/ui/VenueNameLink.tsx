import { Link } from "react-router-dom";
import type { Venue } from "@/types/events.js";

/** Link a venue name to its website, with directory navigation as a fallback. */
export default function VenueNameLink({
  venue,
  className = "",
}: {
  venue: Pick<Venue, "name" | "website" | "slug">;
  className?: string;
}) {
  if (!venue.website) {
    return (
      <Link to={`/venues/${venue.slug}`} className={className}>
        {venue.name}
      </Link>
    );
  }

  return (
    <a
      href={venue.website}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {venue.name}
      <svg
        aria-hidden="true"
        className="inline-block h-3.5 w-3.5 ml-1 align-baseline"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
        />
      </svg>
    </a>
  );
}
