import type { EventQuery } from "@/domain/filters.ts";
import { dateOnly, type DateOnly } from "@/domain/dates.ts";
import type { Venue } from "@/types/events.js";
import type { EventFilters } from "@/types/events.js";

export interface UiEventQueryInput {
  readonly searchQuery?: string;
  readonly filters?: EventFilters;
  readonly sortBy?: EventQuery["sort"];
  readonly sortOrder?: EventQuery["order"];
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Translate UI state into the domain query shape at the repository boundary.
 * Pages do not need to know how venue names become stable venue identifiers.
 */
export function buildEventQuery(
  input: UiEventQueryInput = {},
  venues: ReadonlyMap<number, Venue> = new Map(),
): EventQuery {
  const filters = input.filters;
  const venueIds = filters?.venues?.length
    ? [...venues.values()]
      .filter((venue) => filters.venues?.includes(venue.name))
      .map((venue) => String(venue.id))
    : undefined;

  const domainFilters = filters
    ? {
      ...(filters.cities?.length ? { cities: filters.cities } : {}),
      ...(filters.dates?.length ? { dates: filters.dates.map(dateOnly) as readonly DateOnly[] } : {}),
      ...(filters?.venues?.length ? { venueIds: venueIds?.length ? venueIds : ["__no_matching_venue__"] } : {}),
      ...(filters.ageRestrictions?.length ? { ageRestrictions: filters.ageRestrictions } : {}),
      ...(filters.priceRange && (filters.priceRange.min !== undefined || filters.priceRange.max !== undefined)
        ? { priceRange: filters.priceRange }
        : {}),
      ...(filters.isFree !== undefined ? { isFree: filters.isFree } : {}),
      ...(filters.dateRange?.startDate || filters.dateRange?.endDate
        ? {
          dateRange: {
            ...(filters.dateRange.startDate ? { start: dateOnly(filters.dateRange.startDate) } : {}),
            ...(filters.dateRange.endDate ? { end: dateOnly(filters.dateRange.endDate) } : {}),
          },
        }
        : {}),
      ...(filters.venueTypes?.length ? { venueTypes: filters.venueTypes } : {}),
      ...(filters.tags?.length ? { tags: filters.tags } : {}),
    }
    : undefined;

  return {
    ...(input.searchQuery?.trim() ? { text: input.searchQuery.trim() } : {}),
    ...(domainFilters && Object.keys(domainFilters).length > 0 ? { filters: domainFilters } : {}),
    ...(input.sortBy ? { sort: input.sortBy } : {}),
    ...(input.sortOrder ? { order: input.sortOrder } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  };
}
