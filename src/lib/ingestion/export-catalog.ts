import type { IngestionLedger } from "../../types/ingestion.js";
import type { CandidateConfiguration } from "./export-configuration.js";
import { applyVenueLocationCorrectionEntries } from "./venue-location-corrections.js";
import { applyVenueDetails } from "./venue-details.js";
import { applyVenueMaps } from "./venue-maps.js";
import { applyEventPosters } from "./event-posters.js";
import { applyArtistReviews } from "./artist-reviews.js";
import { applyArtistLinks } from "./artist-links.js";
export function configurationJson(
  configuration: CandidateConfiguration,
  path: keyof CandidateConfiguration
): unknown {
  const bytes = configuration[path];
  return bytes === null ? null : JSON.parse(bytes.toString("utf8"));
}
/** Shared export/release validation view; reviewed metadata never changes canonical history. */
export function capturedExportCatalog(
  ledger: IngestionLedger,
  configuration: CandidateConfiguration
) {
  const events = structuredClone(ledger.events);
  const artists = structuredClone(ledger.artists);
  const venues = structuredClone(ledger.venues);
  const value = (path: keyof CandidateConfiguration) =>
    configurationJson(configuration, path);
  if (configuration["venue-location-corrections.json"] !== null)
    applyVenueLocationCorrectionEntries(
      venues,
      value("venue-location-corrections.json")
    );
  if (configuration["venue-sources.json"] !== null) {
    const registry = value("venue-sources.json") as {
      sources?: {
        sourceId: string;
        venueId: number;
        venueName: string;
        website: string;
      }[];
    };
    const pilot = new Set([
      "fillmore-sf",
      "rickshaw-stop-sf",
      "bottom-of-the-hill-sf",
    ]);
    for (const source of registry.sources ?? []) {
      if (!pilot.has(source.sourceId)) continue;
      const venue = venues.find((item) => item.id === source.venueId);
      if (
        !venue ||
        venue.name !== source.venueName ||
        new URL(source.website).protocol !== "https:"
      )
        throw new Error(
          `Pilot source identity/website mismatch: ${source.sourceId}`
        );
      venue.website = source.website;
    }
  }
  if (configuration["venue-details.json"] !== null)
    applyVenueDetails(
      venues,
      value("venue-details.json") as Parameters<typeof applyVenueDetails>[1]
    );
  if (configuration["venue-maps.json"] !== null)
    applyVenueMaps(
      venues,
      value("venue-maps.json") as Parameters<typeof applyVenueMaps>[1]
    );
  const posters =
    configuration["event-posters.json"] === null
      ? { applied: [], stale: [] }
      : applyEventPosters(
          events,
          venues,
          artists,
          value("event-posters.json") as Parameters<typeof applyEventPosters>[3]
        );
  const staleReviews =
    configuration["artist-reviews.json"] === null
      ? []
      : applyArtistReviews(artists, value("artist-reviews.json"));
  const staleArtistLinks =
    configuration["artist-links.json"] === null
      ? []
      : applyArtistLinks(artists, value("artist-links.json"));
  return { events, artists, venues, posters, staleReviews, staleArtistLinks };
}
