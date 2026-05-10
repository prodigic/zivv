import type { ParseError, ParseWarning, RawEventData } from "@/types/events.js";
import { EventParser, VenueParser } from "./parsers.js";
import { VenueLineParser, StringNormalizer, DeduplicationUtils } from "./utils.js";

export interface EventValidationIssue {
  severity: "error" | "warning";
  lineNumber: number;
  message: string;
  rawText: string;
  type: string;
}

export interface EventValidationResult {
  issues: EventValidationIssue[];
  errorCount: number;
  warningCount: number;
  eventsFound: number;
}

export interface NearDuplicateGroup {
  canonical: string;
  variants: string[];
  maxSimilarity: number;
  latestLineNumbers: Map<string, number[]>;
}

export interface AddressOnlyVenue {
  name: string;
  reason: string;
  lineNumbers: number[];
}

export interface VenueValidationResult {
  nearDuplicates: NearDuplicateGroup[];
  addressOnlyVenues: AddressOnlyVenue[];
  venueParseErrors: EventValidationIssue[];
  venueParseWarnings: EventValidationIssue[];
  errorCount: number;
  warningCount: number;
}

const VENUE_NAME_ALLOWLIST = new Set([
  "924 gilman street",
  "924 gilman st.",
  "924 gilman st",
  "924 gilman",
  "4 star theater",
  "1234 go! records",
  "3 disciples brewing",
  "9 lives warehouse",
]);

const NEAR_DUPE_THRESHOLD = 0.82;

export class LatestValidator {
  splitLatestFile(content: string): {
    eventsSection: string;
    clubInfoSection: string;
  } {
    const lines = content.split("\n");
    const headerIndex = lines.findIndex((line) =>
      /C\s*L\s*U\s*B\s+I\s*N\s*F\s*O/i.test(line)
    );

    if (headerIndex === -1) {
      return { eventsSection: content, clubInfoSection: "" };
    }

    return {
      eventsSection: lines.slice(0, headerIndex).join("\n"),
      clubInfoSection: lines.slice(headerIndex).join("\n"),
    };
  }

  validateEvents(latestContent: string): EventValidationResult {
    const { eventsSection } = this.splitLatestFile(latestContent);

    const { rawEvents, errors: parseErrors, warnings: parseWarnings } =
      EventParser.parseEventsFile(eventsSection);

    const { errors: normErrors, warnings: normWarnings } =
      EventParser.normalizeEvents(rawEvents, new Map(), new Map());

    const issues: EventValidationIssue[] = [
      ...parseErrors.map((e) => this.parseErrorToIssue(e, "error")),
      ...parseWarnings.map((w) => this.parseWarningToIssue(w, "warning")),
      ...normErrors.map((e) => this.parseErrorToIssue(e, "error")),
      ...normWarnings.map((w) => this.parseWarningToIssue(w, "warning")),
    ];

    issues.sort((a, b) => a.lineNumber - b.lineNumber);

    return {
      issues,
      errorCount: issues.filter((i) => i.severity === "error").length,
      warningCount: issues.filter((i) => i.severity === "warning").length,
      eventsFound: rawEvents.length,
    };
  }

  validateVenues(
    latestContent: string,
    venuesContent: string
  ): VenueValidationResult {
    const { eventsSection, clubInfoSection } =
      this.splitLatestFile(latestContent);

    // Extract venue names from event lines in latest.txt
    const { rawEvents } = EventParser.parseEventsFile(eventsSection);
    const latestEventVenues = this.extractVenueNamesFromEvents(rawEvents);

    // Extract venue names from the club info section
    const clubInfoNames = this.extractVenueNamesFromClubInfo(clubInfoSection);

    // Parse venues.txt
    const {
      rawVenues,
      errors: venueParseErrors,
      warnings: venueParseWarnings,
    } = VenueParser.parseVenuesFile(venuesContent);

    const registryNames = rawVenues.map((v) => v.name);

    // Build combined pool for near-dupe detection
    const pool = new Map<string, string>(); // normalized → raw representative name

    const addToPool = (names: Iterable<string>) => {
      for (const name of names) {
        const normalized = StringNormalizer.normalizeName(name);
        if (!pool.has(normalized)) {
          pool.set(normalized, name);
        }
      }
    };

    addToPool(latestEventVenues.keys());
    addToPool(clubInfoNames);
    addToPool(registryNames);

    const nearDuplicates = this.detectNearDuplicates(pool, latestEventVenues);
    const addressOnlyVenues = this.detectAddressOnlyVenues(latestEventVenues);

    const parsedVenueErrors = venueParseErrors.map((e) =>
      this.parseErrorToIssue(e, "error")
    );
    const parsedVenueWarnings = venueParseWarnings.map((w) =>
      this.parseWarningToIssue(w, "warning")
    );

    return {
      nearDuplicates,
      addressOnlyVenues,
      venueParseErrors: parsedVenueErrors,
      venueParseWarnings: parsedVenueWarnings,
      errorCount: parsedVenueErrors.length,
      warningCount:
        parsedVenueWarnings.length +
        nearDuplicates.length +
        addressOnlyVenues.length,
    };
  }

  private extractVenueNamesFromEvents(
    rawEvents: RawEventData[]
  ): Map<string, number[]> {
    const result = new Map<string, number[]>();

    for (const rawEvent of rawEvents) {
      const parsed = VenueLineParser.parse(rawEvent.venueLine);
      if (!parsed) continue;

      const name = parsed.venue;
      const existing = result.get(name);
      if (existing) {
        existing.push(rawEvent.lineNumber);
      } else {
        result.set(name, [rawEvent.lineNumber]);
      }
    }

    return result;
  }

  private extractVenueNamesFromClubInfo(clubInfoSection: string): string[] {
    if (!clubInfoSection) return [];

    const names: string[] = [];
    const lines = clubInfoSection.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || /C\s*L\s*U\s*B\s+I\s*N\s*F\s*O/i.test(trimmed)) {
        continue;
      }
      // Same format as venues.txt: "Name, Address, ..."
      const commaIndex = trimmed.indexOf(",");
      if (commaIndex > 0) {
        const name = trimmed.slice(0, commaIndex).trim();
        if (name) names.push(name);
      }
    }

    return names;
  }

  private detectNearDuplicates(
    pool: Map<string, string>,
    latestEventVenues: Map<string, number[]>
  ): NearDuplicateGroup[] {
    const entries = Array.from(pool.entries()); // [normalized, rawName]
    const groups: number[][] = []; // indices into entries[]
    const assigned = new Set<number>();

    for (let i = 0; i < entries.length; i++) {
      if (assigned.has(i)) continue;

      let group: number[] = [i];

      for (let j = i + 1; j < entries.length; j++) {
        if (assigned.has(j)) continue;

        const score = DeduplicationUtils.stringSimilarity(
          entries[i][0],
          entries[j][0]
        );

        if (score >= NEAR_DUPE_THRESHOLD && entries[i][0] !== entries[j][0]) {
          group.push(j);
        }
      }

      // Greedy expansion: check if any new group member is close to others not yet included
      let changed = true;
      while (changed) {
        changed = false;
        for (let k = 0; k < entries.length; k++) {
          if (assigned.has(k) || group.includes(k)) continue;
          for (const gi of group) {
            const score = DeduplicationUtils.stringSimilarity(
              entries[gi][0],
              entries[k][0]
            );
            if (score >= NEAR_DUPE_THRESHOLD && entries[gi][0] !== entries[k][0]) {
              group.push(k);
              changed = true;
              break;
            }
          }
        }
      }

      if (group.length > 1) {
        // Only report if at least one member appears in latest.txt event lines
        const hasLatestMember = group.some((idx) => {
          const rawName = entries[idx][1];
          return latestEventVenues.has(rawName);
        });

        if (hasLatestMember) {
          group.forEach((idx) => assigned.add(idx));
          groups.push(group);
        }
      }
    }

    // Build output structures
    const result: NearDuplicateGroup[] = groups.map((group) => {
      const rawNames = group.map((idx) => entries[idx][1]);

      // Canonical = most appearances in latest.txt events; tiebreak alphabetical
      const appearances = (name: string) =>
        latestEventVenues.get(name)?.length ?? 0;

      rawNames.sort((a, b) => {
        const diff = appearances(b) - appearances(a);
        return diff !== 0 ? diff : a.localeCompare(b);
      });

      const canonical = rawNames[0];
      const variants = rawNames.slice(1);

      let maxSimilarity = 0;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const s = DeduplicationUtils.stringSimilarity(
            entries[group[i]][0],
            entries[group[j]][0]
          );
          if (s > maxSimilarity) maxSimilarity = s;
        }
      }

      const latestLineNumbers = new Map<string, number[]>();
      for (const name of rawNames) {
        const lines = latestEventVenues.get(name);
        if (lines) latestLineNumbers.set(name, lines);
      }

      return { canonical, variants, maxSimilarity, latestLineNumbers };
    });

    result.sort((a, b) => b.variants.length - a.variants.length);
    return result;
  }

  private detectAddressOnlyVenues(
    venueNames: Map<string, number[]>
  ): AddressOnlyVenue[] {
    const result: AddressOnlyVenue[] = [];

    for (const [name, lineNumbers] of venueNames) {
      const check = this.isAddressOnly(name);
      if (check.isAddress) {
        result.push({ name, reason: check.reason, lineNumbers });
      }
    }

    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  private isAddressOnly(name: string): { isAddress: boolean; reason: string } {
    const lower = name.toLowerCase().trim();

    if (VENUE_NAME_ALLOWLIST.has(lower)) {
      return { isAddress: false, reason: "" };
    }

    // Bare ordinal: "19th", "5th", "15th"
    if (/^\d+(st|nd|rd|th)\.?$/i.test(name)) {
      return { isAddress: true, reason: "bare ordinal" };
    }

    // Pure number: "2", "42"
    if (/^\d+$/.test(name)) {
      return { isAddress: true, reason: "pure number" };
    }

    const streetSuffix =
      "(st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|way|lane|pl|place|ct|court)";

    // Ordinal + street suffix: "5th Street", "26th St."
    if (
      new RegExp(`^\\d+(st|nd|rd|th)\\.?\\s+${streetSuffix}\\.?$`, "i").test(
        name
      )
    ) {
      return { isAddress: true, reason: "ordinal street name" };
    }

    // Number + word(s) + street suffix: "1220 4th Street" (no proper name before it)
    if (
      new RegExp(`^\\d+\\s+\\w+\\s+${streetSuffix}\\.?$`, "i").test(name)
    ) {
      return { isAddress: true, reason: "street address" };
    }

    return { isAddress: false, reason: "" };
  }

  private parseErrorToIssue(
    e: ParseError,
    severity: "error" | "warning"
  ): EventValidationIssue {
    return {
      severity,
      lineNumber: e.line,
      message: e.message,
      rawText: e.rawText,
      type: e.type,
    };
  }

  private parseWarningToIssue(
    w: ParseWarning,
    severity: "error" | "warning"
  ): EventValidationIssue {
    return {
      severity,
      lineNumber: w.line,
      message: w.message,
      rawText: w.rawText,
      type: w.type,
    };
  }
}
