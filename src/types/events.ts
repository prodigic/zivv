// Branded types for IDs to prevent mixing
export type EventId = number & { readonly __brand: "EventId" };
export type ArtistId = number & { readonly __brand: "ArtistId" };
export type VenueId = number & { readonly __brand: "VenueId" };

// Raw data types (as they appear in source files)
export interface RawEventData {
  dateString: string; // e.g., "aug 15 fri"
  artistLine: string; // e.g., "Strfkr, Mamalarky, Happy Sad Face"
  venueLine: string; // e.g., "at the Fox Theater, Oakland a/a $50.60 7pm/8pm #"
  rawText: string; // Full original text
  lineNumber: number;
}

export interface RawVenueData {
  name: string;
  address: string;
  ageRestriction: string;
  phone?: string;
  lineNumber: number;
}

// Processed/normalized types
export interface Event {
  id: EventId;
  slug: string; // URL-safe identifier
  date: string; // ISO date string (YYYY-MM-DD)
  dateEpochMs: number;
  startTime?: string; // ISO datetime string
  startTimeEpochMs?: number;
  timezone: string; // e.g., "America/Los_Angeles"

  // Artists
  headlinerArtistId: ArtistId;
  artistIds: ArtistId[];

  // Venue
  venueId: VenueId;

  // Event details
  priceMin?: number;
  priceMax?: number;
  isFree: boolean;
  ageRestriction: AgeRestriction;

  // Optional details
  description?: string;
  notes?: string;
  ticketUrl?: string;

  // Status and metadata
  status: EventStatus;
  tags: EventTag[];
  venueType: VenueType;

  // Source tracking
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  sourceLineNumber: number;
}

export interface Artist {
  id: ArtistId;
  name: string;
  slug: string;
  normalizedName: string; // For deduplication
  aliases: string[]; // Alternative names/spellings
  upcomingEventCount: number;
  totalEventCount: number;

  // Metadata
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
}

export interface Venue {
  id: VenueId;
  name: string;
  slug: string;
  normalizedName: string;

  // Location
  address: string;
  city: string;
  neighborhood?: string;
  zipCode?: string;

  // Details
  ageRestriction: AgeRestriction;
  capacity?: number;
  phone?: string;
  website?: string;

  // Computed fields
  upcomingEventCount: number;
  totalEventCount: number;

  // Metadata
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  sourceLineNumber: number;
}

// Enums and unions
export type AgeRestriction =
  | "all-ages"
  | "18+"
  | "21+"
  | "16+"
  | "8+"
  | "5+"
  | "6+";

export type EventStatus =
  | "confirmed"
  | "sold-out"
  | "cancelled"
  | "postponed"
  | "rescheduled";

export type EventTag =
  | "sold-out"
  | "free"
  | "tribute"
  | "hip-hop"
  | "reggae"
  | "festival"
  | "outdoor"
  | "all-ages"
  | "matinee"
  | "late-show";

export type VenueType =
  | "major"
  | "club"
  | "diy"
  | "outdoor"
  | "festival"
  | "unknown";

// Data chunk types
export interface EventChunk {
  chunkId: string; // e.g., "2024-08"
  dateRange: {
    startEpochMs: number;
    endEpochMs: number;
  };
  events: Event[];
}

// Search and filtering types
export interface EventFilters {
  cities?: string[];
  dates?: string[]; // ISO dates for multi-select date filtering
  venues?: string[]; // Venue names for multi-select venue filtering
  ageRestrictions?: AgeRestriction[];
  priceRange?: {
    min?: number;
    max?: number;
  };
  isFree?: boolean;
  dateRange?: {
    startDate?: string; // ISO date
    endDate?: string; // ISO date
  };
  venueTypes?: VenueType[];
  tags?: EventTag[];
}

export interface SearchQuery {
  query?: string;
  filters?: EventFilters;
  sortBy?: "date" | "relevance" | "price" | "venue";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

// Processing context
export interface ParseContext {
  currentDate?: string;
  lineNumber: number;
  errors: ParseError[];
  warnings: ParseWarning[];
}

export interface ParseError {
  line: number;
  message: string;
  rawText: string;
  type: "parse" | "validation" | "format";
}

export interface ParseWarning {
  line: number;
  message: string;
  rawText: string;
  type: "ambiguous" | "incomplete" | "unusual" | "format" | "data-quality";
}
