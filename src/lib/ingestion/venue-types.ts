import type { AgeRestriction, EventStatus } from "../../types/events.js";

export interface VenueSource {
  sourceId: string;
  venueId: number;
  venueName: string;
  website: string;
  calendarUrl: string;
  timezone: string;
  feedUrls?: string[];
  providerVenueIds?: Record<string, string>;
  ticketHosts?: string[];
  enabled: boolean;
  conditionalValidator?: "etag" | "last-modified";
}

export interface FetchedText {
  url: string;
  text: string;
  status: number;
  fromCache: boolean;
  contentHash: string;
}

export interface VenueFetchContext {
  source: VenueSource;
  nowEpochMs: number;
  fetchText: (url: string) => Promise<FetchedText>;
  ticketmasterApiKey?: string;
}

/** Source facts before canonical artist and event identities are assigned. */
export interface VenueListing {
  key: string;
  url: string;
  title: string;
  date: string;
  artists: string[];
  startTimeEpochMs?: number;
  doorsTimeEpochMs?: number;
  ageRestriction?: AgeRestriction;
  status?: EventStatus;
  priceMin?: number;
  priceMax?: number;
  isFree?: boolean;
  ticketUrl?: string;
  session?: string;
  notes?: string;
  kind: "live" | "non-music" | "package" | "review";
  reason?: string;
  evidence?: string;
}

export interface VenueInventory {
  name: string;
  keys: string[];
  complete: boolean;
  reason?: string;
  /** Auxiliary evidence may be incomplete without invalidating an authoritative inventory. */
  requiredForCoverage?: boolean;
}

export interface VenueAdapterResult {
  sourceId: string;
  adapterVersion: string;
  listings: VenueListing[];
  inventories: VenueInventory[];
  complete: boolean;
  coverageStart?: string;
  coverageEnd?: string;
  warnings: string[];
}
