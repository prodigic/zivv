import type {
  RawEventData,
  RawVenueData,
  Event,
  Artist,
  Venue,
  ParseError,
  ParseWarning,
  EventId,
  ArtistId,
  VenueId,
} from "@/types/events.js";
import {
  DateParser,
  StringNormalizer,
  VenueLineParser,
  DeduplicationUtils,
  HashGenerator,
} from "./utils.js";

export class EventParser {
  /**
   * Parse raw events.txt file content into structured data
   */
  static parseEventsFile(content: string): {
    rawEvents: RawEventData[];
    errors: ParseError[];
    warnings: ParseWarning[];
  } {
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const rawEvents: RawEventData[] = [];
    const errors: ParseError[] = [];
    const warnings: ParseWarning[] = [];

    let currentDate: string | null = null;
    let currentEvent: Partial<RawEventData> | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      try {
        // Check if this is a date line (e.g., "aug 15 fri")
        const dateMatch = line.match(/^(\w{3}\s+\d{1,2}\s+\w{3})\s+(.*)$/);
        if (dateMatch) {
          // Save previous event if exists
          if (currentEvent && this.isCompleteEvent(currentEvent)) {
            rawEvents.push(currentEvent as RawEventData);
          } else if (currentEvent) {
            warnings.push({
              line: currentEvent.lineNumber || lineNumber,
              message: "Incomplete event data",
              rawText: currentEvent.rawText || "",
              type: "incomplete",
            });
          }

          // Start new event
          currentDate = dateMatch[1];
          const artistLine = dateMatch[2];

          currentEvent = {
            dateString: currentDate,
            artistLine,
            venueLine: "",
            rawText: line,
            lineNumber,
          };

          // Check if venue info is on the same line (some entries do this)
          const atMatch = artistLine.match(/^(.+?)\s+at\s+(.+)$/);
          if (atMatch) {
            currentEvent.artistLine = atMatch[1].trim();
            currentEvent.venueLine = `at ${atMatch[2].trim()}`;
            rawEvents.push(currentEvent as RawEventData);
            currentEvent = null;
          }
        } else if (line.startsWith("at ") && currentEvent) {
          // This is a venue line
          currentEvent.venueLine = line;
          currentEvent.rawText += "\n" + line;

          // Event is now complete
          if (this.isCompleteEvent(currentEvent)) {
            rawEvents.push(currentEvent as RawEventData);
            currentEvent = null;
          }
        } else if (currentEvent && !currentEvent.venueLine) {
          // This might be a continuation of the artist line
          currentEvent.artistLine += ", " + line;
          currentEvent.rawText += "\n" + line;
        } else {
          // Unexpected line format
          warnings.push({
            line: lineNumber,
            message: "Unexpected line format, skipping",
            rawText: line,
            type: "format",
          });
        }
      } catch (error) {
        errors.push({
          line: lineNumber,
          message: `Parse error: ${error}`,
          rawText: line,
          type: "parse",
        });
      }
    }

    // Handle last event
    if (currentEvent && this.isCompleteEvent(currentEvent)) {
      rawEvents.push(currentEvent as RawEventData);
    } else if (currentEvent) {
      warnings.push({
        line: currentEvent.lineNumber || lines.length,
        message: "Incomplete event at end of file",
        rawText: currentEvent.rawText || "",
        type: "incomplete",
      });
    }

    return { rawEvents, errors, warnings };
  }

  private static isCompleteEvent(
    event: Partial<RawEventData>
  ): event is RawEventData {
    return Boolean(event.dateString && event.artistLine && event.venueLine);
  }

  /**
   * Convert raw event data to normalized Event objects
   */
  static normalizeEvents(
    rawEvents: RawEventData[],
    artistMap: Map<string, Artist>,
    venueMap: Map<string, Venue>
  ): {
    events: Event[];
    errors: ParseError[];
    warnings: ParseWarning[];
  } {
    const events: Event[] = [];
    const errors: ParseError[] = [];
    const warnings: ParseWarning[] = [];
    const eventKeys = new Set<string>();

    for (const rawEvent of rawEvents) {
      try {
        const parsedDate = DateParser.parseEventDate(rawEvent.dateString);
        if (!parsedDate) {
          errors.push({
            line: rawEvent.lineNumber,
            message: `Could not parse date: ${rawEvent.dateString}`,
            rawText: rawEvent.rawText,
            type: "validation",
          });
          continue;
        }

        const venueInfo = VenueLineParser.parse(rawEvent.venueLine);
        if (!venueInfo) {
          errors.push({
            line: rawEvent.lineNumber,
            message: `Could not parse venue line: ${rawEvent.venueLine}`,
            rawText: rawEvent.rawText,
            type: "validation",
          });
          continue;
        }

        // Parse artists
        const artistNames = this.parseArtistNames(rawEvent.artistLine);
        if (artistNames.length === 0) {
          errors.push({
            line: rawEvent.lineNumber,
            message: "No artists found",
            rawText: rawEvent.rawText,
            type: "validation",
          });
          continue;
        }

        // Add validation warnings for suspicious artist names
        this.validateArtistNames(
          artistNames,
          rawEvent.lineNumber,
          rawEvent.rawText,
          warnings
        );

        const headliner = this.detectHeadliner(
          artistNames,
          venueInfo,
          rawEvent
        );

        // Check for duplicates
        const eventKey = DeduplicationUtils.generateEventKey(
          parsedDate.date,
          venueInfo.venue,
          headliner
        );

        if (eventKeys.has(eventKey)) {
          warnings.push({
            line: rawEvent.lineNumber,
            message: `Duplicate event detected: ${headliner} at ${venueInfo.venue}`,
            rawText: rawEvent.rawText,
            type: "data-quality",
          });
          continue;
        }
        eventKeys.add(eventKey);

        // Find or create artists
        const artistIds: ArtistId[] = [];
        for (const artistName of artistNames) {
          const normalizedName = StringNormalizer.normalizeName(artistName);
          let artist = [...artistMap.values()].find(
            (a) => a.normalizedName === normalizedName
          );

          if (!artist) {
            const artistId = HashGenerator.generateArtistId(
              artistName
            ) as ArtistId;
            artist = {
              id: artistId,
              name: artistName.trim(),
              slug: StringNormalizer.createSlug(artistName),
              normalizedName,
              aliases: [],
              upcomingEventCount: 0,
              totalEventCount: 0,
              createdAtEpochMs: Date.now(),
              updatedAtEpochMs: Date.now(),
            };
            artistMap.set(normalizedName, artist);
          }

          artistIds.push(artist.id);
          artist.totalEventCount++;
          artist.updatedAtEpochMs = Date.now();
        }

        // Find or create venue
        const normalizedVenueName = StringNormalizer.normalizeName(
          venueInfo.venue
        );
        let venue = [...venueMap.values()].find(
          (v) => v.normalizedName === normalizedVenueName
        );

        if (!venue) {
          const venueId = HashGenerator.generateVenueId(
            venueInfo.venue,
            venueInfo.city
          ) as VenueId;
          venue = {
            id: venueId,
            name: venueInfo.venue.trim(),
            slug: StringNormalizer.createSlug(venueInfo.venue),
            normalizedName: normalizedVenueName,
            address: "", // Will be filled from venues.txt
            city: venueInfo.city,
            ageRestriction: venueInfo.ageRestriction,
            upcomingEventCount: 0,
            totalEventCount: 0,
            createdAtEpochMs: Date.now(),
            updatedAtEpochMs: Date.now(),
            sourceLineNumber: rawEvent.lineNumber,
          };
          venueMap.set(normalizedVenueName, venue);
        }

        venue.totalEventCount++;
        venue.updatedAtEpochMs = Date.now();

        // Create time strings if available
        let startTimeEpochMs: number | undefined;
        if (venueInfo.time.startTime) {
          const [hours, minutes] = venueInfo.time.startTime
            .split(":")
            .map(Number);
          const eventDateTime = new Date(parsedDate.epochMs);
          eventDateTime.setHours(hours, minutes, 0, 0);
          startTimeEpochMs = eventDateTime.getTime();
        }

        // Determine event status
        let status: Event["status"] = "confirmed";
        if (venueInfo.tags.includes("sold-out")) status = "sold-out";

        // Create event
        const event: Event = {
          id: HashGenerator.generateEventId(
            parsedDate.date,
            headliner,
            venueInfo.venue
          ) as EventId,
          slug: StringNormalizer.createSlug(
            `${parsedDate.date}-${headliner}-${venueInfo.venue}`
          ),
          date: parsedDate.date,
          dateEpochMs: parsedDate.epochMs,
          startTimeEpochMs,
          timezone: "America/Los_Angeles",

          headlinerArtistId: artistIds[0],
          artistIds,

          venueId: venue.id,

          priceMin: venueInfo.price.min,
          priceMax: venueInfo.price.max,
          isFree: venueInfo.price.isFree,
          ageRestriction: venueInfo.ageRestriction,

          notes: venueInfo.notes,

          status,
          tags: venueInfo.tags,
          venueType: venueInfo.venueType,

          createdAtEpochMs: Date.now(),
          updatedAtEpochMs: Date.now(),
          sourceLineNumber: rawEvent.lineNumber,
        };

        events.push(event);
      } catch (error) {
        errors.push({
          line: rawEvent.lineNumber,
          message: `Normalization error: ${error}`,
          rawText: rawEvent.rawText,
          type: "parse",
        });
      }
    }

    return { events, errors, warnings };
  }

  private static parseArtistNames(artistLine: string): string[] {
    // Split by commas, handling some edge cases
    const artists = artistLine
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    // Handle "feat." and "with" patterns
    const processed: string[] = [];
    for (const artist of artists) {
      // Split on " feat. " or " with " but keep as separate artists
      const featMatch = artist.match(
        /^(.+?)\s+(?:feat\.|featuring|with)\s+(.+)$/i
      );
      if (featMatch) {
        processed.push(this.correctArtistName(featMatch[1].trim()));
        processed.push(this.correctArtistName(featMatch[2].trim()));
      } else {
        processed.push(this.correctArtistName(artist));
      }
    }

    return processed.filter((name) => name.length > 0);
  }

  /**
   * Correct common concatenated or malformed artist names
   */
  private static correctArtistName(name: string): string {
    // Known concatenations that should be split
    const corrections: Record<string, string> = {
      // Obvious concatenations
      NateWantsToBattle: "Nate Wants To Battle",
      FeeFawfum: "Fee Faw Fum",
      "3UpFront": "3 Up Front",
      SosMula: "Sos Mula",
      BabyTron: "Baby Tron",
      UlyssesCFM: "Ulysses CFM",

      // Common spacing fixes
      BadBadNotGood: "BADBADNOTGOOD", // This is actually the correct stylization
    };

    // Apply direct corrections
    if (corrections[name]) {
      return corrections[name];
    }

    // Pattern-based corrections for camelCase artist names
    // Look for patterns like "ArtistName" that should be "Artist Name"
    const camelCasePattern = /^([A-Z][a-z]+)([A-Z][a-z]+)$/;
    const camelMatch = name.match(camelCasePattern);
    if (camelMatch && name.length > 8) {
      // Only apply to longer names to avoid false positives
      // Check if it's not a known legitimate camelCase name
      const legitimateNames = [
        "McCollum",
        "McCain",
        "McRae",
        "DiRusso",
        "McCraven",
        "McCarthy",
        "MacDonald",
        "McGuire",
        "O'Brien",
        "DeAngelo",
        "LaRue",
      ];

      const hasLegitimatePrefix = legitimateNames.some((legit) =>
        name.includes(legit)
      );
      if (!hasLegitimatePrefix) {
        return `${camelMatch[1]} ${camelMatch[2]}`;
      }
    }

    return name;
  }

  /**
   * Detect the actual headliner from the artist list using various heuristics
   */
  private static detectHeadliner(
    artistNames: string[],
    venueInfo: { venue: string; city: string; ageRestriction?: string },
    rawEvent: RawEventData
  ): string {
    if (artistNames.length === 1) {
      return artistNames[0];
    }

    // Check for explicit headliner indicators in the venue or event info
    const eventText = rawEvent.artistLine.toLowerCase();

    // Look for explicit headliner keywords
    const headlinerKeywords = [
      "headlined by",
      "headlines",
      "starring",
      "presents",
      "with special guest",
    ];

    for (const keyword of headlinerKeywords) {
      if (eventText.includes(keyword)) {
        // If we find "Artist headlines" or "presents Artist", that's likely the headliner
        const keywordIndex = eventText.indexOf(keyword);
        const beforeKeyword = eventText.substring(0, keywordIndex).trim();
        const afterKeyword = eventText
          .substring(keywordIndex + keyword.length)
          .trim();

        if (keyword === "with special guest" && beforeKeyword) {
          // "Artist with special guest" - first artist is headliner
          return artistNames[0];
        } else if (keyword === "presents" && afterKeyword) {
          // "Venue presents Artist" - find the artist after "presents"
          const presentedArtist = artistNames.find((artist) =>
            afterKeyword.toLowerCase().includes(artist.toLowerCase())
          );
          if (presentedArtist) return presentedArtist;
        }
      }
    }

    // Venue-based heuristics
    const venueName = venueInfo.venue.toLowerCase();
    const isLargeVenue = this.isLargeVenue(venueName);
    const isSmallDIYVenue = this.isSmallDIYVenue(venueName);

    // For large venues, the first artist is more likely to be the headliner
    if (isLargeVenue) {
      return artistNames[0];
    }

    // For small DIY venues, check for known local vs touring acts
    if (isSmallDIYVenue) {
      // If there's a significant name recognition difference, choose the more known artist
      const knownTouringActs = this.identifyTouringActs(artistNames);
      if (knownTouringActs.length === 1) {
        return knownTouringActs[0];
      }
    }

    // Price-based heuristic - higher priced shows usually have clearer headliners
    const hasHighPrice =
      rawEvent.rawText &&
      /\$[3-9][0-9]|\$[1-9][0-9][0-9]/.test(rawEvent.rawText);

    if (hasHighPrice) {
      // For expensive shows, first artist is likely headliner
      return artistNames[0];
    }

    // Default to first artist but add a warning for manual review
    return artistNames[0];
  }

  /**
   * Check if venue is a large/major venue where billing order matters more
   */
  private static isLargeVenue(venueName: string): boolean {
    const largeVenues = [
      "fox theater",
      "warfield",
      "fillmore",
      "regency ballroom",
      "great american music hall",
      "independent",
      "chapel",
      "greek theatre",
      "shoreline amphitheatre",
      "chase center",
      "oracle arena",
      "bill graham civic auditorium",
    ];

    return largeVenues.some((venue) => venueName.includes(venue));
  }

  /**
   * Check if venue is a small DIY venue where headliner order might be less clear
   */
  private static isSmallDIYVenue(venueName: string): boolean {
    const diyVenues = [
      "gilman",
      "secret gallery",
      "backyard",
      "house show",
      "diy space",
      "warehouse",
      "basement",
    ];

    return diyVenues.some((venue) => venueName.includes(venue));
  }

  /**
   * Identify potential touring acts vs local acts
   */
  private static identifyTouringActs(artistNames: string[]): string[] {
    // This is a simplified heuristic - in practice you'd want a database of known acts
    const touringIndicators = [
      // Names that suggest touring acts (simplified)
      /^[A-Z]{2,}$/, // All caps band names
      /\(.*tribute.*\)/i, // Tribute bands often tour
    ];

    return artistNames.filter((name) =>
      touringIndicators.some((pattern) => pattern.test(name))
    );
  }

  /**
   * Validate artist names and add warnings for suspicious patterns
   */
  private static validateArtistNames(
    artistNames: string[],
    lineNumber: number,
    rawText: string,
    warnings: ParseWarning[]
  ): void {
    for (const artistName of artistNames) {
      // Check for potential concatenations
      const suspiciousPatterns = [
        // CamelCase that might be concatenated names
        {
          pattern: /^([A-Z][a-z]{3,})([A-Z][a-z]{3,})$/,
          message: `Possible concatenated artist name: "${artistName}" - might be two separate names`,
        },

        // Names with numbers that might be typos
        {
          pattern: /^[A-Za-z]+[0-9]+[A-Za-z]*$/,
          message: `Artist name contains numbers: "${artistName}" - verify this is correct`,
        },

        // Very long single "words" that might be concatenated
        {
          pattern: /^[A-Za-z]{15,}$/,
          message: `Unusually long single-word artist name: "${artistName}" - check for concatenation`,
        },

        // Names with mixed case in unusual patterns
        {
          pattern: /^[a-z]+[A-Z][a-z]*$/,
          message: `Unusual capitalization in artist name: "${artistName}" - verify formatting`,
        },
      ];

      for (const { pattern, message } of suspiciousPatterns) {
        if (pattern.test(artistName)) {
          // Skip if it's a known legitimate name
          const legitimateExceptions = [
            "McCollum",
            "McCain",
            "McRae",
            "DiRusso",
            "McCraven",
            "McCarthy",
            "BADBADNOTGOOD",
            "3UpFront",
            "AC/DC",
            "DJ",
            "dj",
          ];

          const isKnownLegitimate = legitimateExceptions.some((exception) =>
            artistName.includes(exception)
          );

          if (!isKnownLegitimate) {
            warnings.push({
              line: lineNumber,
              message,
              rawText,
              type: "data-quality",
            });
            break; // Only add one warning per artist name
          }
        }
      }

      // Check for potential duplicate artists in the same event
      const duplicateCount = artistNames.filter(
        (name) =>
          StringNormalizer.normalizeName(name) ===
          StringNormalizer.normalizeName(artistName)
      ).length;

      if (duplicateCount > 1) {
        warnings.push({
          line: lineNumber,
          message: `Potential duplicate artist in same event: "${artistName}"`,
          rawText,
          type: "data-quality",
        });
      }
    }

    // Check for too many artists (might indicate parsing error)
    if (artistNames.length > 8) {
      warnings.push({
        line: lineNumber,
        message: `Event has ${artistNames.length} artists - verify parsing is correct`,
        rawText,
        type: "data-quality",
      });
    }
  }
}

export class VenueParser {
  /**
   * Parse venues.txt file content
   */
  static parseVenuesFile(content: string): {
    rawVenues: RawVenueData[];
    errors: ParseError[];
    warnings: ParseWarning[];
  } {
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const rawVenues: RawVenueData[] = [];
    const errors: ParseError[] = [];
    const warnings: ParseWarning[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      try {
        // Parse CSV-like format: "Name, Address, Age Restriction Phone"
        const parts = line.split(",").map((part) => part.trim());

        if (parts.length < 2) {
          warnings.push({
            line: lineNumber,
            message: "Incomplete venue data",
            rawText: line,
            type: "incomplete",
          });
          continue;
        }

        const name = parts[0];
        const addressPart = parts[1];

        // Extract age restriction and phone from remaining parts
        const remainingParts = parts.slice(2);
        let ageRestriction = "a/a";
        let phone: string | undefined;

        for (const part of remainingParts) {
          if (/\b(?:a\/a|all ages|\d+\+)\b/i.test(part)) {
            ageRestriction = part;
          } else if (/\d{3}-\d{3}-\d{4}|\(\d{3}\)\s*\d{3}-\d{4}/.test(part)) {
            phone = part;
          }
        }

        rawVenues.push({
          name,
          address: addressPart,
          ageRestriction,
          phone,
          lineNumber,
        });
      } catch (error) {
        errors.push({
          line: lineNumber,
          message: `Parse error: ${error}`,
          rawText: line,
          type: "parse",
        });
      }
    }

    return { rawVenues, errors, warnings };
  }

  /**
   * Normalize venue data and merge with existing venue map
   */
  static normalizeVenues(
    rawVenues: RawVenueData[],
    existingVenueMap: Map<string, Venue>
  ): {
    venues: Venue[];
    errors: ParseError[];
    warnings: ParseWarning[];
  } {
    const venues: Venue[] = [];
    const errors: ParseError[] = [];
    const warnings: ParseWarning[] = [];
    const processedNames = new Set<string>();

    for (const rawVenue of rawVenues) {
      try {
        const normalizedName = StringNormalizer.normalizeName(rawVenue.name);

        if (processedNames.has(normalizedName)) {
          warnings.push({
            line: rawVenue.lineNumber,
            message: `Duplicate venue: ${rawVenue.name}`,
            rawText: `${rawVenue.name}, ${rawVenue.address}`,
            type: "data-quality",
          });
          continue;
        }
        processedNames.add(normalizedName);

        // Check if venue already exists from events parsing
        let venue = existingVenueMap.get(normalizedName);

        if (venue) {
          // Update existing venue with address info
          venue.address = rawVenue.address;
          if (rawVenue.phone) venue.phone = rawVenue.phone;
          venue.updatedAtEpochMs = Date.now();
        } else {
          // Create new venue
          const city = this.extractCityFromAddress(rawVenue.address);

          venue = {
            id: HashGenerator.generateVenueId(rawVenue.name, city) as VenueId,
            name: rawVenue.name.trim(),
            slug: StringNormalizer.createSlug(rawVenue.name),
            normalizedName,
            address: rawVenue.address,
            city,
            ageRestriction: this.normalizeAgeRestriction(
              rawVenue.ageRestriction
            ),
            phone: rawVenue.phone,
            upcomingEventCount: 0,
            totalEventCount: 0,
            createdAtEpochMs: Date.now(),
            updatedAtEpochMs: Date.now(),
            sourceLineNumber: rawVenue.lineNumber,
          };
        }

        venues.push(venue);
      } catch (error) {
        errors.push({
          line: rawVenue.lineNumber,
          message: `Normalization error: ${error}`,
          rawText: `${rawVenue.name}, ${rawVenue.address}`,
          type: "parse",
        });
      }
    }

    return { venues, errors, warnings };
  }

  private static extractCityFromAddress(address: string): string {
    // Simple heuristic: last part of address is usually city
    const parts = address.split(",").map((part) => part.trim());
    const lastPart = parts[parts.length - 1];

    // Handle cases like "San Francisco" or "S.F."
    return StringNormalizer.normalizeCity(lastPart);
  }

  private static normalizeAgeRestriction(
    ageStr: string
  ): Event["ageRestriction"] {
    const normalized = ageStr.toLowerCase().trim();

    if (normalized.includes("a/a") || normalized.includes("all ages"))
      return "all-ages";
    if (normalized.includes("21+")) return "21+";
    if (normalized.includes("18+")) return "18+";
    if (normalized.includes("16+")) return "16+";
    if (normalized.includes("8+")) return "8+";
    if (normalized.includes("6+")) return "6+";
    if (normalized.includes("5+")) return "5+";

    return "all-ages"; // default
  }
}
