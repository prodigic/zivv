import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SourceSnapshotFixture {
  filename: string;
  path: string;
  sourceDate: string;
  predecessor: string | null;
  rawText: string;
  lineCount: number;
  checksum: string;
}

const SNAPSHOT_PATTERN = /^week-\d{6}\.txt$/;
const HEADER_DATE_PATTERN =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i;
const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

export const snapshotDirectory = join(repositoryRoot, "data", "steve");

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isoDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function dateFromFilename(filename: string): string {
  const match = filename.match(/^week-(\d{2})(\d{2})(\d{2})\.txt$/);
  if (!match) {
    throw new Error(`Invalid snapshot filename: ${filename}`);
  }

  const year = 2000 + Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  return isoDate(year, month, day);
}

function dateFromText(text: string, fallback: string): string {
  const header = text.match(HEADER_DATE_PATTERN);
  if (!header) return fallback;

  const month = MONTHS[header[1].slice(0, 3).toLowerCase()];
  return isoDate(Number(header[3]), month, Number(header[2]));
}

export function discoverSourceSnapshots(
  directory = snapshotDirectory
): SourceSnapshotFixture[] {
  const filenames = readdirSync(directory)
    .filter((filename) => SNAPSHOT_PATTERN.test(filename))
    .sort();

  return filenames.map((filename, index) => {
    const path = join(directory, filename);
    const rawText = readFileSync(path, "utf8");
    const fallbackDate = dateFromFilename(filename);

    return {
      filename,
      path,
      sourceDate: dateFromText(rawText, fallbackDate),
      predecessor: index === 0 ? null : filenames[index - 1],
      rawText,
      lineCount: rawText.split(/\r?\n/).length,
      checksum: sha256(rawText),
    };
  });
}

export function loadSourceSnapshot(filename: string): SourceSnapshotFixture {
  const snapshot = discoverSourceSnapshots().find(
    (candidate) => candidate.filename === filename
  );
  if (!snapshot) {
    throw new Error(`Source snapshot not found: ${filename}`);
  }
  return snapshot;
}
