/**
 * Runtime type guards and validation utilities for ensuring data integrity
 */

import type {
  Event,
  Artist,
  Venue,
  EventChunk,
  AgeRestriction,
  EventStatus,
  EventTag,
  VenueType,
  EventId,
  ArtistId,
  VenueId,
} from "@/types/events.js";
import type {
  DataManifest,
  DataIndexes,
} from "@/types/data.js";
import type { TypeGuardResult } from "@/types/frontend.js";

/**
 * Check if a value is a valid branded ID
 */
export function isValidId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Check if a value is a valid EventId
 */
export function isEventId(value: unknown): value is EventId {
  return isValidId(value);
}

/**
 * Check if a value is a valid ArtistId
 */
export function isArtistId(value: unknown): value is ArtistId {
  return isValidId(value);
}

/**
 * Check if a value is a valid VenueId
 */
export function isVenueId(value: unknown): value is VenueId {
  return isValidId(value);
}

/**
 * Check if a value is a valid ISO date string
 */
export function isISODate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  
  const date = new Date(value);
  return !isNaN(date.getTime()) && value === date.toISOString().split('T')[0];
}

/**
 * Check if a value is a valid epoch timestamp
 */
export function isEpochTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value < Date.now() + (365 * 24 * 60 * 60 * 1000) // Not more than 1 year in future
  );
}

/**
 * Check if a value is a valid age restriction
 */
export function isAgeRestriction(value: unknown): value is AgeRestriction {
  const validAges: AgeRestriction[] = [
    "all-ages", "18+", "21+", "16+", "8+", "5+", "6+"
  ];
  return typeof value === "string" && validAges.includes(value as AgeRestriction);
}

/**
 * Check if a value is a valid event status
 */
export function isEventStatus(value: unknown): value is EventStatus {
  const validStatuses: EventStatus[] = [
    "confirmed", "sold-out", "cancelled", "postponed", "rescheduled"
  ];
  return typeof value === "string" && validStatuses.includes(value as EventStatus);
}

/**
 * Check if a value is a valid event tag
 */
export function isEventTag(value: unknown): value is EventTag {
  const validTags: EventTag[] = [
    "sold-out", "free", "tribute", "hip-hop", "reggae", "festival",
    "outdoor", "all-ages", "matinee", "late-show"
  ];
  return typeof value === "string" && validTags.includes(value as EventTag);
}

/**
 * Check if a value is a valid venue type
 */
export function isVenueType(value: unknown): value is VenueType {
  const validTypes: VenueType[] = [
    "major", "club", "diy", "outdoor", "festival", "unknown"
  ];
  return typeof value === "string" && validTypes.includes(value as VenueType);
}

/**
 * Validate Event object
 */
export function validateEvent(data: unknown): TypeGuardResult<Event> {
  const errors: string[] = [];
  
  if (!data || typeof data !== "object") {
    return { isValid: false, errors: ["Event must be an object"] };
  }

  const event = data as Record<string, unknown>;

  // Required fields
  if (!isEventId(event.id)) {
    errors.push("Event must have a valid numeric id");
  }

  if (!event.slug || typeof event.slug !== "string") {
    errors.push("Event must have a valid slug string");
  }

  if (!event.date || typeof event.date !== "string") {
    errors.push("Event must have a valid date string");
  }

  if (!isEpochTimestamp(event.dateEpochMs)) {
    errors.push("Event must have a valid dateEpochMs timestamp");
  }

  if (!isArtistId(event.headlinerArtistId)) {
    errors.push("Event must have a valid headlinerArtistId");
  }

  if (!Array.isArray(event.artistIds) || !event.artistIds.every(isArtistId)) {
    errors.push("Event must have a valid array of artistIds");
  }

  if (!isVenueId(event.venueId)) {
    errors.push("Event must have a valid venueId");
  }

  if (typeof event.isFree !== "boolean") {
    errors.push("Event must have a valid isFree boolean");
  }

  if (!isAgeRestriction(event.ageRestriction)) {
    errors.push("Event must have a valid ageRestriction");
  }

  // Optional fields validation
  if (event.startTimeEpochMs !== undefined && !isEpochTimestamp(event.startTimeEpochMs)) {
    errors.push("Event startTimeEpochMs must be a valid timestamp if provided");
  }

  if (event.priceMin !== undefined && (typeof event.priceMin !== "number" || event.priceMin < 0)) {
    errors.push("Event priceMin must be a non-negative number if provided");
  }

  if (event.priceMax !== undefined && (typeof event.priceMax !== "number" || event.priceMax < 0)) {
    errors.push("Event priceMax must be a non-negative number if provided");
  }

  if (event.status && !isEventStatus(event.status)) {
    errors.push("Event status must be a valid EventStatus if provided");
  }

  if (event.tags && (!Array.isArray(event.tags) || !event.tags.every(isEventTag))) {
    errors.push("Event tags must be an array of valid EventTags if provided");
  }

  return {
    isValid: errors.length === 0,
    data: errors.length === 0 ? (event as Event) : undefined,
    errors,
  };
}

/**
 * Validate Artist object
 */
export function validateArtist(data: unknown): TypeGuardResult<Artist> {
  const errors: string[] = [];
  
  if (!data || typeof data !== "object") {
    return { isValid: false, errors: ["Artist must be an object"] };
  }

  const artist = data as Record<string, unknown>;

  // Required fields
  if (!isArtistId(artist.id)) {
    errors.push("Artist must have a valid numeric id");
  }

  if (!artist.name || typeof artist.name !== "string") {
    errors.push("Artist must have a valid name string");
  }

  if (!artist.slug || typeof artist.slug !== "string") {
    errors.push("Artist must have a valid slug string");
  }

  if (!artist.normalizedName || typeof artist.normalizedName !== "string") {
    errors.push("Artist must have a valid normalizedName string");
  }

  if (!Array.isArray(artist.aliases) || !artist.aliases.every(alias => typeof alias === "string")) {
    errors.push("Artist must have a valid array of alias strings");
  }

  if (typeof artist.upcomingEventCount !== "number" || artist.upcomingEventCount < 0) {
    errors.push("Artist must have a valid non-negative upcomingEventCount");
  }

  if (typeof artist.totalEventCount !== "number" || artist.totalEventCount < 0) {
    errors.push("Artist must have a valid non-negative totalEventCount");
  }

  if (!isEpochTimestamp(artist.createdAtEpochMs)) {
    errors.push("Artist must have a valid createdAtEpochMs timestamp");
  }

  if (!isEpochTimestamp(artist.updatedAtEpochMs)) {
    errors.push("Artist must have a valid updatedAtEpochMs timestamp");
  }

  return {
    isValid: errors.length === 0,
    data: errors.length === 0 ? (artist as Artist) : undefined,
    errors,
  };
}

/**
 * Validate Venue object
 */
export function validateVenue(data: unknown): TypeGuardResult<Venue> {
  const errors: string[] = [];
  
  if (!data || typeof data !== "object") {
    return { isValid: false, errors: ["Venue must be an object"] };
  }

  const venue = data as Record<string, unknown>;

  // Required fields
  if (!isVenueId(venue.id)) {
    errors.push("Venue must have a valid numeric id");
  }

  if (!venue.name || typeof venue.name !== "string") {
    errors.push("Venue must have a valid name string");
  }

  if (!venue.slug || typeof venue.slug !== "string") {
    errors.push("Venue must have a valid slug string");
  }

  if (!venue.address || typeof venue.address !== "string") {
    errors.push("Venue must have a valid address string");
  }

  if (!venue.city || typeof venue.city !== "string") {
    errors.push("Venue must have a valid city string");
  }

  if (!isAgeRestriction(venue.ageRestriction)) {
    errors.push("Venue must have a valid ageRestriction");
  }

  if (typeof venue.upcomingEventCount !== "number" || venue.upcomingEventCount < 0) {
    errors.push("Venue must have a valid non-negative upcomingEventCount");
  }

  if (typeof venue.totalEventCount !== "number" || venue.totalEventCount < 0) {
    errors.push("Venue must have a valid non-negative totalEventCount");
  }

  // Optional fields
  if (venue.phone !== undefined && typeof venue.phone !== "string") {
    errors.push("Venue phone must be a string if provided");
  }

  if (venue.website !== undefined && typeof venue.website !== "string") {
    errors.push("Venue website must be a string if provided");
  }

  if (venue.capacity !== undefined && (typeof venue.capacity !== "number" || venue.capacity <= 0)) {
    errors.push("Venue capacity must be a positive number if provided");
  }

  return {
    isValid: errors.length === 0,
    data: errors.length === 0 ? (venue as Venue) : undefined,
    errors,
  };
}

/**
 * Validate DataManifest object
 */
export function validateManifest(data: unknown): TypeGuardResult<DataManifest> {
  const errors: string[] = [];
  
  if (!data || typeof data !== "object") {
    return { isValid: false, errors: ["Manifest must be an object"] };
  }

  const manifest = data as Record<string, unknown>;

  // Required fields
  if (!manifest.version || typeof manifest.version !== "string") {
    errors.push("Manifest must have a valid version string");
  }

  if (!manifest.datasetVersion || typeof manifest.datasetVersion !== "string") {
    errors.push("Manifest must have a valid datasetVersion string");
  }

  if (!isEpochTimestamp(manifest.lastUpdated)) {
    errors.push("Manifest must have a valid lastUpdated timestamp");
  }

  if (typeof manifest.totalEvents !== "number" || manifest.totalEvents < 0) {
    errors.push("Manifest must have a valid non-negative totalEvents count");
  }

  if (typeof manifest.totalArtists !== "number" || manifest.totalArtists < 0) {
    errors.push("Manifest must have a valid non-negative totalArtists count");
  }

  if (typeof manifest.totalVenues !== "number" || manifest.totalVenues < 0) {
    errors.push("Manifest must have a valid non-negative totalVenues count");
  }

  // Validate dateRange
  if (!manifest.dateRange || typeof manifest.dateRange !== "object") {
    errors.push("Manifest must have a valid dateRange object");
  } else {
    const dateRange = manifest.dateRange as Record<string, unknown>;
    
    if (!isEpochTimestamp(dateRange.startEpochMs)) {
      errors.push("Manifest dateRange must have a valid startEpochMs timestamp");
    }
    
    if (!isEpochTimestamp(dateRange.endEpochMs)) {
      errors.push("Manifest dateRange must have a valid endEpochMs timestamp");
    }
    
    if (!dateRange.startDate || typeof dateRange.startDate !== "string") {
      errors.push("Manifest dateRange must have a valid startDate string");
    }
    
    if (!dateRange.endDate || typeof dateRange.endDate !== "string") {
      errors.push("Manifest dateRange must have a valid endDate string");
    }
  }

  return {
    isValid: errors.length === 0,
    data: errors.length === 0 ? (manifest as DataManifest) : undefined,
    errors,
  };
}

/**
 * Validate EventChunk object
 */
export function validateEventChunk(data: unknown): TypeGuardResult<EventChunk> {
  const errors: string[] = [];
  
  if (!data || typeof data !== "object") {
    return { isValid: false, errors: ["EventChunk must be an object"] };
  }

  const chunk = data as Record<string, unknown>;

  // Required fields
  if (!chunk.chunkId || typeof chunk.chunkId !== "string") {
    errors.push("EventChunk must have a valid chunkId string");
  }

  if (!Array.isArray(chunk.events)) {
    errors.push("EventChunk must have a valid events array");
  } else {
    // Validate each event in the chunk
    for (let i = 0; i < chunk.events.length; i++) {
      const eventResult = validateEvent(chunk.events[i]);
      if (!eventResult.isValid) {
        errors.push(`Event at index ${i}: ${eventResult.errors.join(", ")}`);
      }
    }
  }

  // Validate dateRange if present
  if (chunk.dateRange) {
    if (typeof chunk.dateRange !== "object") {
      errors.push("EventChunk dateRange must be an object if provided");
    } else {
      const dateRange = chunk.dateRange as Record<string, unknown>;
      
      if (!isEpochTimestamp(dateRange.startEpochMs)) {
        errors.push("EventChunk dateRange must have a valid startEpochMs timestamp");
      }
      
      if (!isEpochTimestamp(dateRange.endEpochMs)) {
        errors.push("EventChunk dateRange must have a valid endEpochMs timestamp");
      }
    }
  }

  return {
    isValid: errors.length === 0,
    data: errors.length === 0 ? (chunk as EventChunk) : undefined,
    errors,
  };
}

/**
 * Validate an array of events
 */
export function validateEventArray(data: unknown): TypeGuardResult<Event[]> {
  const errors: string[] = [];
  
  if (!Array.isArray(data)) {
    return { isValid: false, errors: ["Must be an array"] };
  }

  const validEvents: Event[] = [];
  
  for (let i = 0; i < data.length; i++) {
    const eventResult = validateEvent(data[i]);
    if (eventResult.isValid && eventResult.data) {
      validEvents.push(eventResult.data);
    } else {
      errors.push(`Event at index ${i}: ${eventResult.errors.join(", ")}`);
    }
  }

  return {
    isValid: errors.length === 0,
    data: errors.length === 0 ? validEvents : undefined,
    errors,
  };
}

/**
 * Validate an array of artists
 */
export function validateArtistArray(data: unknown): TypeGuardResult<Artist[]> {
  const errors: string[] = [];
  
  if (!Array.isArray(data)) {
    return { isValid: false, errors: ["Must be an array"] };
  }

  const validArtists: Artist[] = [];
  
  for (let i = 0; i < data.length; i++) {
    const artistResult = validateArtist(data[i]);
    if (artistResult.isValid && artistResult.data) {
      validArtists.push(artistResult.data);
    } else {
      errors.push(`Artist at index ${i}: ${artistResult.errors.join(", ")}`);
    }
  }

  return {
    isValid: errors.length === 0,
    data: errors.length === 0 ? validArtists : undefined,
    errors,
  };
}

/**
 * Validate an array of venues
 */
export function validateVenueArray(data: unknown): TypeGuardResult<Venue[]> {
  const errors: string[] = [];
  
  if (!Array.isArray(data)) {
    return { isValid: false, errors: ["Must be an array"] };
  }

  const validVenues: Venue[] = [];
  
  for (let i = 0; i < data.length; i++) {
    const venueResult = validateVenue(data[i]);
    if (venueResult.isValid && venueResult.data) {
      validVenues.push(venueResult.data);
    } else {
      errors.push(`Venue at index ${i}: ${venueResult.errors.join(", ")}`);
    }
  }

  return {
    isValid: errors.length === 0,
    data: errors.length === 0 ? validVenues : undefined,
    errors,
  };
}