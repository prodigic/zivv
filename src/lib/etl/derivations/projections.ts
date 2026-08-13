import type { Artist, Event, Venue } from "@/types/events.js";
import type { CanonicalArtist, CanonicalVenue, TemporalProjectionModel } from "../pipeline/types.js";

export function buildTemporalProjections(
  events: Event[],
  artists: readonly (Artist | CanonicalArtist)[],
  venues: readonly (Venue | CanonicalVenue)[],
  asOfEpochMs: number
): TemporalProjectionModel {
  const artistById = new Map(artists.map((artist) => [artist.id as number, artist]));
  const venueById = new Map(venues.map((venue) => [venue.id as number, venue]));
  const artistUpcomingEventCount = new Map<number, number>();
  const venueUpcomingEventCount = new Map<number, number>();
  const artistUpcomingEvents = new Map<number, Artist["upcomingEvents"]>();
  const venueUpcomingEvents = new Map<number, Venue["upcomingEvents"]>();

  for (const event of events) {
    if (event.dateEpochMs <= asOfEpochMs) continue;
    const venue = venueById.get(event.venueId as number);
    const headliner = artistById.get(event.headlinerArtistId as number);
    const artistProjection = {
      id: event.id,
      slug: event.slug,
      dateEpochMs: event.dateEpochMs,
      startTimeEpochMs: event.startTimeEpochMs,
      venueId: event.venueId,
      venueName: venue?.name ?? "",
      venueCity: venue?.city ?? "",
      headlinerName: headliner?.name ?? "",
      isFree: event.isFree,
      isSoldOut: event.status === "sold-out" || event.tags.includes("sold-out"),
      priceMin: event.priceMin,
      priceMax: event.priceMax,
      createdAtEpochMs: event.createdAtEpochMs,
    };
    const venueProjection = {
      id: event.id,
      slug: event.slug,
      dateEpochMs: event.dateEpochMs,
      startTimeEpochMs: event.startTimeEpochMs,
      headlinerName: headliner?.name ?? "",
      isFree: event.isFree,
      isSoldOut: event.status === "sold-out" || event.tags.includes("sold-out"),
      priceMin: event.priceMin,
      priceMax: event.priceMax,
      createdAtEpochMs: event.createdAtEpochMs,
    };

    for (const artistId of event.artistIds) {
      const id = artistId as number;
      artistUpcomingEventCount.set(id, (artistUpcomingEventCount.get(id) ?? 0) + 1);
      const list = artistUpcomingEvents.get(id) ?? [];
      list.push(artistProjection);
      artistUpcomingEvents.set(id, list);
    }
    const venueId = event.venueId as number;
    venueUpcomingEventCount.set(venueId, (venueUpcomingEventCount.get(venueId) ?? 0) + 1);
    const venueList = venueUpcomingEvents.get(venueId) ?? [];
    venueList.push(venueProjection);
    venueUpcomingEvents.set(venueId, venueList);
  }

  for (const list of artistUpcomingEvents.values()) list.sort((a, b) => a.dateEpochMs - b.dateEpochMs);
  for (const list of venueUpcomingEvents.values()) list.sort((a, b) => a.dateEpochMs - b.dateEpochMs);

  return { asOfEpochMs, artistUpcomingEventCount, venueUpcomingEventCount, artistUpcomingEvents, venueUpcomingEvents };
}

export function applyLegacyProjections(
  artists: Artist[],
  venues: Venue[],
  projections: TemporalProjectionModel
): void {
  for (const artist of artists) {
    artist.upcomingEventCount = projections.artistUpcomingEventCount.get(artist.id as number) ?? 0;
    artist.upcomingEvents = projections.artistUpcomingEvents.get(artist.id as number) ?? [];
  }
  for (const venue of venues) {
    venue.upcomingEventCount = projections.venueUpcomingEventCount.get(venue.id as number) ?? 0;
    venue.upcomingEvents = projections.venueUpcomingEvents.get(venue.id as number) ?? [];
  }
}
