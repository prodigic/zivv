import { createHash } from "node:crypto";
import { normalizeLatestContent } from "../etl/latest-content.js";
import { isNonPerformerArtistName } from "../etl/non-performer-artists.js";
import { EventParser } from "../etl/parsers.js";
import { VenueLineParser } from "../etl/utils.js";
import { prepareSteveBatch } from "./imports.js";
import type { IngestionLedger } from "../../types/ingestion.js";

export interface LineCorrection {
  pattern: string;
  replacement: string;
}

interface SourceLine {
  line: number;
  disposition: "wrapper" | "blank" | "header" | "club-info" | "row" | "invalid";
  row?: number;
}

export interface PreflightRow {
  id: number;
  sourceLines: number[];
  collapsed: string;
  corrected: string;
  corrections: number[];
  disposition: "accepted" | "programming" | "duplicate" | "invalid";
  duplicateOf?: number;
  excludedNames: string[];
  errors: string[];
}

/** Private deterministic preparation report; never place under public/ or Git. */
export interface StevePreflight {
  schemaVersion: 1;
  preflightVersion: "steve-preflight-v1";
  rawSha256: string;
  rulesSha256: string;
  preparedSha256: string | null;
  preparedContent: string | null;
  issueDate: string | null;
  sourceLines: SourceLine[];
  rows: PreflightRow[];
  errors: string[];
  counts: {
    rows: number;
    accepted: number;
    programming: number;
    duplicates: number;
    invalid: number;
  };
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const DATE_BOUNDARY =
  /^(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:\d{1,2}(?:\s|$)|\S+\s+(?:sun|mon|tue|wed|thu|fri|sat|\d{4})\b)|[A-Za-z]{2,9}\s+\d{1,2}\s+(?:sun|mon|tue|wed|thu|fri|sat|\d{4})\b|\d{1,2}[/-]\d)/i;
const VENUE_CONTINUATION =
  /^(?:a\/a\b|all ages\b|\d+\+|\$|\d{1,2}(?::\d{2})?\s*[ap]m\b|free\b|sold out\b|cancelled\b|doors\b)/i;

function hasRealDate(row: string, issueTime: number): boolean {
  const match = row.match(
    /^([a-z]{3})\s+(\d{1,2})\s+(\d{4}|sun|mon|tue|wed|thu|fri|sat)\s/i
  );
  if (!match || !Number.isFinite(issueTime)) return false;
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const month = months.indexOf(match[1].toLowerCase());
  if (month < 0) return false;
  const day = Number(match[2]);
  const issue = new Date(issueTime);
  let year = /^\d{4}$/.test(match[3])
    ? Number(match[3])
    : issue.getUTCFullYear();
  if (
    !/^\d{4}$/.test(match[3]) &&
    Date.UTC(year, month, day) <
      Date.UTC(year, issue.getUTCMonth(), issue.getUTCDate())
  )
    year++;
  const date = new Date(Date.UTC(year, month, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day
  );
}

/** Collapse first, then correct and account for every physical source line. No I/O. */
export function preflightSteveContent(
  raw: string,
  ledger: IngestionLedger,
  aliases: Record<string, string> = {},
  corrections: LineCorrection[] = []
): StevePreflight {
  const regexes = corrections.map((rule) => new RegExp(rule.pattern, "gim"));
  const normalized = normalizeLatestContent(raw);
  const rawLines = raw.replace(/\r\n?/g, "\n").split("\n");
  const lines = normalized.split("\n").slice(0, -1);
  const start = rawLines.findIndex((_, index) =>
    lines.every((line, offset) => rawLines[index + offset] === line)
  );
  if (!lines.length || start < 0)
    throw new Error("Cannot map normalized source lines");
  const sourceLines: SourceLine[] = rawLines.map((_, index) => ({
    line: index + 1,
    disposition: "wrapper",
  }));
  const rows: PreflightRow[] = [];
  const errors: string[] = [];
  for (const source of sourceLines) {
    if (
      (source.line <= start || source.line > start + lines.length) &&
      DATE_BOUNDARY.test(rawLines[source.line - 1].trim())
    ) {
      source.disposition = "invalid";
      errors.push(
        `Dated source row outside listing section at line ${source.line}`
      );
    }
  }
  const header = lines.find((line) =>
    /Upcoming shows of Interest\s+[A-Za-z]+\s+\d{1,2},?\s+\d{4}/i.test(line)
  );
  const issueDate =
    header?.match(
      /Upcoming shows of Interest\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i
    )?.[1] ?? null;
  let issueTime = issueDate ? Date.parse(`${issueDate} 12:00:00 GMT`) : NaN;
  const issueParts = issueDate?.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const issueMonth = monthNames.findIndex(
    (name) =>
      issueParts &&
      (name === issueParts[1].toLowerCase() ||
        name.slice(0, 3) === issueParts[1].toLowerCase())
  );
  const issue = new Date(issueTime);
  if (
    !issueParts ||
    issueMonth < 0 ||
    issue.getUTCMonth() !== issueMonth ||
    issue.getUTCDate() !== Number(issueParts[2]) ||
    issue.getUTCFullYear() !== Number(issueParts[3])
  )
    issueTime = NaN;
  if (!Number.isFinite(issueTime))
    errors.push("Missing or invalid dated issue header");
  let current: PreflightRow | undefined;
  let clubInfo = false;
  for (const [index, line] of lines.entries()) {
    const source = sourceLines[start + index];
    const text = line.trim();
    if (!text) {
      source.disposition = "blank";
      continue;
    }
    if (/^C\s*L\s*U\s*B\s+I\s*N\s*F\s*O\s*$/i.test(text)) clubInfo = true;
    if (clubInfo) {
      source.disposition = "club-info";
      if (DATE_BOUNDARY.test(text)) {
        source.disposition = "invalid";
        errors.push(
          `Dated source row after club-info section at line ${source.line}`
        );
      }
      continue;
    }
    // Broad date boundary also isolates malformed weekday tokens for correction.
    if (DATE_BOUNDARY.test(text)) {
      current = {
        id: rows.length + 1,
        sourceLines: [],
        collapsed: "",
        corrected: "",
        corrections: [],
        disposition: "accepted",
        excludedNames: [],
        errors: [],
      };
      rows.push(current);
    }
    if (!current) {
      source.disposition = "header";
      if (line !== header && !/^-+$/.test(text)) {
        source.disposition = "invalid";
        errors.push(`Unclassified header at source line ${source.line}`);
      }
      continue;
    }
    source.disposition = "row";
    source.row = current.id;
    current.sourceLines.push(source.line);
    if (/\s+at\s+/.test(current.collapsed) && !VENUE_CONTINUATION.test(text))
      current.errors.push(
        `Unclassified continuation after venue at source line ${source.line}`
      );
    current.collapsed = `${current.collapsed} ${text}`
      .replace(/\s{2,}/g, " ")
      .trim();
    if (
      /^(?:please feel free|unsubscribe|https?:\/\/|from:|to:|subject:)/i.test(
        text
      )
    )
      current.errors.push(
        `Unexpected delivery text at source line ${source.line}`
      );
  }
  const seen = new Map<string, number>();
  for (const row of rows) {
    row.corrected = row.collapsed;
    regexes.forEach((regex, index) => {
      const next = row.corrected.replace(regex, corrections[index].replacement);
      if (next !== row.corrected) row.corrections.push(index);
      row.corrected = next;
    });
    if (row.corrected.includes("\n") || row.corrected.includes("\r"))
      row.errors.push("Correction introduced additional source rows");
    if (!hasRealDate(row.corrected, issueTime))
      row.errors.push("Invalid calendar date or weekday token");
    const parsed = EventParser.parseEventsFile(row.corrected);
    if (
      parsed.rawEvents.length !== 1 ||
      parsed.errors.length ||
      parsed.warnings.length
    )
      row.errors.push("Row is not one complete parsed event");
    if (!row.errors.length) {
      const rawEvent = parsed.rawEvents[0];
      const venue = VenueLineParser.parse(rawEvent.venueLine);
      if (!venue?.venue.trim() || !venue.city.trim())
        row.errors.push("Venue and city must be explicitly present");
      const names = EventParser.parseArtistNames(rawEvent.artistLine);
      row.excludedNames = names.filter(isNonPerformerArtistName);
      if (
        !row.errors.length &&
        names.length > 0 &&
        row.excludedNames.length === names.length
      ) {
        const validated = EventParser.normalizeEvents(
          [rawEvent],
          new Map(),
          new Map(),
          aliases
        );
        if (
          validated.errors.length === 1 &&
          validated.errors[0].message === "No artists found"
        )
          row.disposition = "programming";
        else row.errors.push("Programming row has invalid date or venue data");
      } else if (!row.errors.length) {
        try {
          const batch = prepareSteveBatch(
            ledger,
            `${header ?? ""}\n${row.corrected}\n`,
            issueTime,
            aliases
          );
          if (batch.events.length !== 1)
            row.errors.push("Retained row did not yield exactly one event");
        } catch (error) {
          row.errors.push(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }
    if (row.errors.length) row.disposition = "invalid";
    else if (row.disposition === "accepted") {
      const duplicateOf = seen.get(row.corrected);
      if (duplicateOf !== undefined) {
        row.disposition = "duplicate";
        row.duplicateOf = duplicateOf;
      } else seen.set(row.corrected, row.id);
    }
  }
  const accepted = rows.filter((row) => row.disposition === "accepted");
  let preparedContent: string | null =
    `${header ?? ""}\n${accepted.map((row) => row.corrected).join("\n")}\n`;
  if (!accepted.length) errors.push("No performer events remain");
  if (rows.some((row) => row.disposition === "invalid"))
    errors.push("Invalid source rows require review");
  if (!errors.length) {
    // The importer reapplies configured corrections. Require a stable second pass.
    const reapplied = regexes.reduce(
      (text, regex, index) =>
        text.replace(regex, corrections[index].replacement),
      preparedContent
    );
    if (reapplied !== preparedContent)
      errors.push(
        "Corrections are not idempotent under the maintained importer"
      );
    try {
      const batch = prepareSteveBatch(
        ledger,
        preparedContent,
        issueTime,
        aliases
      );
      if (batch.events.length !== accepted.length)
        errors.push(
          "Non-exact duplicate or normalization loss requires review"
        );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length) preparedContent = null;
  return {
    schemaVersion: 1,
    preflightVersion: "steve-preflight-v1",
    rawSha256: sha256(raw),
    rulesSha256: sha256(
      JSON.stringify({
        corrections,
        aliases: Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)),
      })
    ),
    preparedSha256: preparedContent === null ? null : sha256(preparedContent),
    preparedContent,
    issueDate,
    sourceLines,
    rows,
    errors,
    counts: {
      rows: rows.length,
      accepted: accepted.length,
      programming: rows.filter((row) => row.disposition === "programming")
        .length,
      duplicates: rows.filter((row) => row.disposition === "duplicate").length,
      invalid: rows.filter((row) => row.disposition === "invalid").length,
    },
  };
}
