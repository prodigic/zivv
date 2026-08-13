import type { Event } from "@/types/events.js";
import { DeduplicationUtils, StringNormalizer } from "../utils.js";

export function artistIdentityKey(name: string): string {
  return `artist:${StringNormalizer.normalizeName(name)}`;
}

export function venueIdentityKey(name: string, city: string): string {
  return `venue:${StringNormalizer.normalizeName(name)}:${StringNormalizer.normalizeName(city)}`;
}

export function eventIdentityKey(date: string, venueId: number, headlinerArtistId: number): string {
  return `event:${date}:${venueId}:${headlinerArtistId}`;
}

export function rawEventIdentityKey(date: string, venue: string, headliner: string): string {
  return DeduplicationUtils.generateEventKey(date, venue, headliner);
}

export function stableEventIdentityKey(event: Pick<Event, "date" | "venueId" | "headlinerArtistId">): string {
  return eventIdentityKey(event.date, event.venueId, event.headlinerArtistId);
}
