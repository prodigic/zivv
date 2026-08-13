import type { Event, EventStatus, EventTag, AgeRestriction, VenueType } from "./entities.ts";
import type { DateOnly } from "./dates.ts";
import { isDateOnlyInRange } from "./dates.ts";
import { normalizeCity } from "./normalization.ts";
import { priceOverlaps } from "./prices.ts";

export interface EventFilters {
  readonly cities?: readonly string[];
  readonly dates?: readonly DateOnly[];
  readonly venueIds?: readonly string[];
  readonly ageRestrictions?: readonly AgeRestriction[];
  readonly priceRange?: { readonly min?: number; readonly max?: number };
  readonly isFree?: boolean;
  readonly dateRange?: { readonly start?: DateOnly; readonly end?: DateOnly };
  readonly venueTypes?: readonly VenueType[];
  readonly tags?: readonly EventTag[];
  readonly statuses?: readonly EventStatus[];
}

export interface EventQuery {
  readonly text?: string;
  readonly filters?: EventFilters;
  readonly sort?: "date" | "relevance" | "price" | "venue";
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  readonly offset?: number;
}

export interface EventFilterContext {
  readonly cityByVenueId: ReadonlyMap<string, string>;
}

export function matchesEventFilters(
  event: Event,
  filters: EventFilters,
  context: EventFilterContext,
): boolean {
  const city = context.cityByVenueId.get(event.venueId);
  if (filters.cities && filters.cities.length > 0) {
    const selected = new Set(filters.cities.map(normalizeCity));
    if (city === undefined || !selected.has(normalizeCity(city))) return false;
  }
  if (filters.dates && filters.dates.length > 0 && !filters.dates.includes(event.date as DateOnly)) return false;
  if (filters.dateRange && !isDateOnlyInRange(event.date as DateOnly, filters.dateRange)) return false;
  if (filters.venueIds && filters.venueIds.length > 0 && !filters.venueIds.includes(event.venueId)) return false;
  if (filters.ageRestrictions && filters.ageRestrictions.length > 0 && !filters.ageRestrictions.includes(event.ageRestriction)) return false;
  if (filters.venueTypes && filters.venueTypes.length > 0 && !filters.venueTypes.includes(event.venueType)) return false;
  if (filters.statuses && filters.statuses.length > 0 && !filters.statuses.includes(event.status)) return false;
  if (filters.tags && filters.tags.some((tag) => !event.tags.includes(tag))) return false;
  if (filters.isFree !== undefined && event.price.isFree !== filters.isFree) return false;
  if (filters.priceRange && !priceOverlaps(event.price, filters.priceRange)) return false;
  return true;
}
