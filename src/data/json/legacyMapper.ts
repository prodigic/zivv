import type { Artist as LegacyArtist, Event as LegacyEvent, Venue as LegacyVenue } from "@/types/events.js";
import { artistId, eventId, stableKey, venueId } from "@/domain/identifiers.ts";
import type { Artist, Event, Venue } from "@/domain/entities.ts";

export function toDomainEvent(raw: LegacyEvent): Event {
  return {
    id: eventId(String(raw.id)),
    stableKey: stableKey(`${raw.date}:${raw.slug}`),
    slug: raw.slug,
    date: raw.date,
    timezone: raw.timezone,
    ...(raw.startTime === undefined ? {} : { startTime: raw.startTime }),
    artistIds: raw.artistIds.map((id) => artistId(String(id))),
    headlinerArtistId: artistId(String(raw.headlinerArtistId)),
    venueId: venueId(String(raw.venueId)),
    price: { isFree: raw.isFree, min: raw.priceMin, max: raw.priceMax },
    ageRestriction: raw.ageRestriction,
    status: raw.status,
    tags: raw.tags,
    venueType: raw.venueType,
    ...(raw.description === undefined ? {} : { description: raw.description }),
    ...(raw.notes === undefined ? {} : { notes: raw.notes }),
    ...(raw.ticketUrl === undefined ? {} : { ticketUrl: raw.ticketUrl }),
    provenance: [{ sourceName: "public/data/events-*.json", sourceLine: raw.sourceLineNumber }],
  };
}

export function toDomainArtist(raw: LegacyArtist): Artist {
  return {
    id: artistId(String(raw.id)),
    stableKey: stableKey(`artist:${raw.slug}`),
    name: raw.name,
    slug: raw.slug,
    normalizedName: raw.normalizedName,
    aliases: raw.aliases,
    provenance: [{ sourceName: "public/data/artists.json" }],
  };
}

export function toDomainVenue(raw: LegacyVenue): Venue {
  return {
    id: venueId(String(raw.id)),
    stableKey: stableKey(`venue:${raw.slug}`),
    name: raw.name,
    slug: raw.slug,
    normalizedName: raw.normalizedName,
    address: raw.address,
    city: raw.city,
    ...(raw.neighborhood === undefined ? {} : { neighborhood: raw.neighborhood }),
    ...(raw.zipCode === undefined ? {} : { zipCode: raw.zipCode }),
    ageRestriction: raw.ageRestriction,
    ...(raw.capacity === undefined ? {} : { capacity: raw.capacity }),
    ...(raw.phone === undefined ? {} : { phone: raw.phone }),
    ...(raw.website === undefined ? {} : { website: raw.website }),
    provenance: [{ sourceName: "public/data/venues.json", sourceLine: raw.sourceLineNumber }],
  };
}
