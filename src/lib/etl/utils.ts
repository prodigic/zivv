import type { AgeRestriction, EventTag, VenueType } from "@/types/events.js";

// Date parsing utilities
export class DateParser {
  private static readonly MONTHS = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };

  // Day mappings (currently unused but available for future use)
  // private static readonly DAYS = {
  //   sun: 0, sunday: 0,
  //   mon: 1, monday: 1,
  //   tue: 2, tuesday: 2,
  //   wed: 3, wednesday: 3,
  //   thu: 4, thursday: 4,
  //   fri: 5, friday: 5,
  //   sat: 6, saturday: 6,
  // };

  /**
   * Parse date string like "aug 15 fri" to ISO date
   * Uses current year or next year if date has passed
   */
  static parseEventDate(
    dateString: string
  ): { date: string; epochMs: number } | null {
    const parts = dateString.trim().toLowerCase().split(/\s+/);
    if (parts.length < 2) return null;

    const monthStr = parts[0];
    const dayStr = parts[1];

    const month = this.MONTHS[monthStr as keyof typeof this.MONTHS];
    const day = parseInt(dayStr, 10);

    if (month === undefined || isNaN(day) || day < 1 || day > 31) {
      return null;
    }

    // Determine year (current or next if date has passed)
    const now = new Date();
    const currentYear = now.getFullYear();

    let eventDate = new Date(currentYear, month, day);

    // If the event date is more than 30 days in the past, assume it's next year
    if (eventDate.getTime() < now.getTime() - 30 * 24 * 60 * 60 * 1000) {
      eventDate = new Date(currentYear + 1, month, day);
    }

    return {
      date: eventDate.toISOString().split("T")[0],
      epochMs: eventDate.getTime(),
    };
  }

  /**
   * Parse time string like "7pm/8pm" or "7:30pm" to 24-hour format
   */
  static parseTime(
    timeString: string
  ): { startTime: string; doorTime?: string } | null {
    if (!timeString) return null;

    // Handle formats like "7pm/8pm" (door/show times)
    const timeParts = timeString.split("/");
    const startTimeStr = timeParts[timeParts.length - 1]; // Use show time as primary
    const doorTimeStr = timeParts.length > 1 ? timeParts[0] : undefined;

    const parseHour = (time: string): string | null => {
      const match = time.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (!match) return null;

      let hour = parseInt(match[1], 10);
      const minute = parseInt(match[2] || "0", 10);
      const ampm = match[3]?.toLowerCase();

      // Convert to 24-hour format
      if (ampm === "pm" && hour !== 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;

      // If no am/pm specified, assume pm for reasonable show times
      if (!ampm && hour >= 1 && hour <= 11) hour += 12;

      return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
    };

    const startTime = parseHour(startTimeStr);
    const doorTime = doorTimeStr ? parseHour(doorTimeStr) : null;

    return startTime ? { startTime, doorTime: doorTime || undefined } : null;
  }
}

// String normalization utilities
export class StringNormalizer {
  /**
   * Normalize artist/venue names for deduplication
   */
  static normalizeName(name: string): string {
    return (
      name
        .toLowerCase()
        .trim()
        // Remove common prefixes/suffixes
        .replace(/^(the|dj|a)\s+/i, "")
        .replace(/\s+(band|music|group)$/i, "")
        // Normalize punctuation
        .replace(/['']/g, "'")
        .replace(/[""]/g, '"')
        .replace(/[–—]/g, "-")
        // Remove extra whitespace
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  /**
   * Create URL-safe slug
   */
  static createSlug(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  /**
   * Clean city name for consistency
   */
  static normalizeCity(city: string): string {
    const cityMappings: Record<string, string> = {
      sf: "San Francisco",
      "s.f.": "San Francisco",
      "san francisco": "San Francisco",
      "san fran": "San Francisco",
      oakland: "Oakland",
      berkeley: "Berkeley",
      "san jose": "San Jose",
      "santa cruz": "Santa Cruz",
      petaluma: "Petaluma",
      napa: "Napa",
      novato: "Novato",
      saratoga: "Saratoga",
      "palo alto": "Palo Alto",
      "santa rosa": "Santa Rosa",
      livermore: "Livermore",
      "san leandro": "San Leandro",
    };

    const normalized = city.toLowerCase().trim().replace(/\.$/, "");
    return cityMappings[normalized] || this.toTitleCase(normalized);
  }

  /**
   * Convert to title case
   */
  static toTitleCase(str: string): string {
    return str.replace(
      /\w\S*/g,
      (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    );
  }
}

// Parsing utilities for venue lines
export class VenueLineParser {
  /**
   * Parse venue line like "at the Fox Theater, Oakland a/a $50.60 7pm/8pm #"
   */
  static parse(venueLine: string): {
    venue: string;
    city: string;
    ageRestriction: AgeRestriction;
    price: { min?: number; max?: number; isFree: boolean };
    time: { startTime?: string; doorTime?: string };
    venueType: VenueType;
    tags: EventTag[];
    notes?: string;
  } | null {
    // Remove "at " prefix
    let line = venueLine.replace(/^\s*at\s+/i, "").trim();

    // Extract notes in parentheses
    const noteMatches = line.match(/\(([^)]+)\)/g);
    const notes = noteMatches?.map((match) => match.slice(1, -1)).join("; ");
    line = line.replace(/\([^)]+\)/g, "").trim();

    // Extract special symbols at the end
    const symbolMatch = line.match(/([#@^]+)\s*$/);
    const symbols = symbolMatch?.[1] || "";
    line = line.replace(/[#@^]+\s*$/, "").trim();

    // Split by commas to separate venue/location from other info
    const parts = line.split(",");
    if (parts.length < 2) return null;

    const venue = parts[0].trim();
    const locationPart = parts[1].trim();

    // Extract city from location part
    const city = StringNormalizer.normalizeCity(locationPart.split(/\s+/)[0]);

    // Parse remaining parts for age, price, time
    const remainingText = parts.slice(1).join(" ");

    const ageRestriction = this.parseAgeRestriction(remainingText);
    const price = this.parsePrice(remainingText);
    const time = DateParser.parseTime(this.extractTime(remainingText)) || {};

    const venueType = this.determineVenueType(symbols, venue);
    const tags = this.extractTags(notes, remainingText, price.isFree);

    return {
      venue,
      city,
      ageRestriction,
      price,
      time,
      venueType,
      tags,
      notes,
    };
  }

  private static parseAgeRestriction(text: string): AgeRestriction {
    if (/\ba\/a\b/i.test(text)) return "all-ages";
    if (/\b21\+/i.test(text)) return "21+";
    if (/\b18\+/i.test(text)) return "18+";
    if (/\b16\+/i.test(text)) return "16+";
    if (/\b8\+/i.test(text)) return "8+";
    if (/\b6\+/i.test(text)) return "6+";
    if (/\b5\+/i.test(text)) return "5+";
    return "all-ages"; // default
  }

  private static parsePrice(text: string): {
    min?: number;
    max?: number;
    isFree: boolean;
  } {
    if (/\bfree\b/i.test(text)) return { isFree: true };

    // Match price patterns like $50.60, $10/$15, $199.70
    const priceMatches = text.match(/\$(\d+(?:\.\d{2})?)/g);
    if (!priceMatches) return { isFree: false };

    const prices = priceMatches.map((match) => parseFloat(match.slice(1)));

    return {
      min: Math.min(...prices),
      max: Math.max(...prices),
      isFree: false,
    };
  }

  private static extractTime(text: string): string {
    const timeMatch = text.match(
      /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\/\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)/i
    );
    return timeMatch?.[1] || "";
  }

  private static determineVenueType(symbols: string, venue: string): VenueType {
    if (symbols.includes("#")) return "major";
    if (symbols.includes("@")) return "diy";

    // Heuristics based on venue name
    const venueLower = venue.toLowerCase();
    if (
      venueLower.includes("theater") ||
      venueLower.includes("auditorium") ||
      venueLower.includes("hall")
    )
      return "major";
    if (
      venueLower.includes("warehouse") ||
      venueLower.includes("deli") ||
      venueLower.includes("gallery")
    )
      return "diy";

    return "club";
  }

  private static extractTags(
    notes?: string,
    text?: string,
    isFree = false
  ): EventTag[] {
    const tags: EventTag[] = [];

    if (isFree) tags.push("free");
    if (/sold out/i.test(text || "") || /sold out/i.test(notes || ""))
      tags.push("sold-out");
    if (/tribute/i.test(notes || "")) tags.push("tribute");
    if (/hip hop/i.test(notes || "")) tags.push("hip-hop");
    if (/reggae/i.test(notes || "")) tags.push("reggae");
    if (/festival/i.test(notes || "")) tags.push("festival");
    if (/(outdoor|park|amphitheater)/i.test(text || "")) tags.push("outdoor");
    if (/matinee|afternoon|12pm|1pm|2pm|3pm|4pm/i.test(text || ""))
      tags.push("matinee");
    if (/late|10pm|11pm|midnight/i.test(text || "")) tags.push("late-show");

    return tags;
  }
}

// Deduplication utilities
export class DeduplicationUtils {
  /**
   * Generate deduplication key for events
   */
  static generateEventKey(
    date: string,
    venue: string,
    headliner: string
  ): string {
    const normalizedVenue = StringNormalizer.normalizeName(venue);
    const normalizedHeadliner = StringNormalizer.normalizeName(headliner);
    return `${date}:${normalizedVenue}:${normalizedHeadliner}`;
  }

  /**
   * Calculate similarity between two strings (0-1)
   */
  static stringSimilarity(a: string, b: string): number {
    const normalize = (str: string) =>
      str.toLowerCase().replace(/[^a-z0-9]/g, "");
    const str1 = normalize(a);
    const str2 = normalize(b);

    if (str1 === str2) return 1;

    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1;

    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  private static levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }
}

// Hash-based ID generation utilities
export class HashGenerator {
  /**
   * Generate a simple hash from a string (similar to Java's hashCode)
   */
  private static simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Generate an artist ID from artist name
   */
  static generateArtistId(name: string): number {
    const normalizedName = StringNormalizer.normalizeName(name);
    return this.simpleHash(`artist:${normalizedName}`);
  }

  /**
   * Generate a venue ID from venue name and city
   */
  static generateVenueId(name: string, city: string): number {
    const normalizedName = StringNormalizer.normalizeName(name);
    const normalizedCity = StringNormalizer.normalizeName(city);
    return this.simpleHash(`venue:${normalizedName}:${normalizedCity}`);
  }

  /**
   * Generate an event ID from key attributes
   */
  static generateEventId(date: string, headlinerName: string, venueName: string): number {
    const normalizedHeadliner = StringNormalizer.normalizeName(headlinerName);
    const normalizedVenue = StringNormalizer.normalizeName(venueName);
    return this.simpleHash(`event:${date}:${normalizedHeadliner}:${normalizedVenue}`);
  }
}
