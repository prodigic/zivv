#!/usr/bin/env node

/**
 * Merge latest.txt into events.txt
 *
 * Sanitizes latest.txt (collapsing multi-line entries to single lines),
 * deduplicates against existing events.txt content, and appends new entries.
 * Also discovers new venues and stubs them into venues.txt.
 *
 * Usage:
 *   node scripts/merge-latest.js
 *   npm run merge
 *
 * Run validation first:
 *   npm run validate && npm run merge
 */

import { EventSanitizer } from '../dist/lib/etl/sanitizer.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

// Stamp an explicit year onto a date line if it doesn't already have one.
// "may 1 fri Artist..." → "may 1 2026 Artist..." (year inserted after day, day-of-week removed)
// Lines that already have a 4-digit year token are left untouched.
function stampYear(line, year) {
  // Already has explicit year like "may 16 2027 ..." or "jan 9 2027 ..."
  if (/^[a-z]{3}\s+\d{1,2}\s+\d{4}\b/i.test(line)) return line;
  // Replace "mon DD dow " with "mon DD YEAR "
  return line.replace(
    /^([a-z]{3}\s+\d{1,2})\s+[a-z]{2,3}\s+/i,
    (_, datePart) => `${datePart} ${year} `
  );
}

// Resolve the year for an undated event line given its month and a reference year.
// If the event's month is in the past relative to today, it belongs to next year.
function resolveYear(line, referenceDate) {
  const m = line.match(/^([a-z]{3})\s+(\d{1,2})\s+/i);
  if (!m) return referenceDate.getFullYear();
  const mon = (MONTHS[m[1].toLowerCase()] ?? 1) - 1; // 0-based
  const day = parseInt(m[2], 10);
  const refYear = referenceDate.getFullYear();
  const candidate = new Date(refYear, mon, day);
  // If more than 6 months in the past, it's next year
  const sixMonthsAgo = new Date(referenceDate.getTime() - 180 * 24 * 60 * 60 * 1000);
  return candidate < sixMonthsAgo ? refYear + 1 : refYear;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const dataDir = resolve(projectRoot, 'data');

function normalizeName(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/^(the|dj|a)\s+/i, '')
    .replace(/\s+(band|music|group)$/i, '')
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract venue name from a single-line event string.
// Returns null if no "at " found.
function extractVenueName(eventLine, aliases) {
  const atIdx = eventLine.indexOf(' at ');
  if (atIdx === -1) return null;
  const afterAt = eventLine.slice(atIdx + 4);
  const commaIdx = afterAt.indexOf(',');
  const raw = commaIdx === -1 ? afterAt : afterAt.slice(0, commaIdx);
  const name = raw.trim();
  if (!name) return null;
  return aliases[name.toLowerCase()] || name;
}

function main() {
  const latestPath = resolve(dataDir, 'latest.txt');
  const eventsPath = resolve(dataDir, 'events.txt');
  const venuesPath = resolve(dataDir, 'venues.txt');
  const aliasesPath = resolve(dataDir, 'venue-aliases.json');

  for (const p of [latestPath, eventsPath, venuesPath]) {
    if (!existsSync(p)) {
      console.error(`❌ Not found: ${p}`);
      process.exit(1);
    }
  }

  const aliases = existsSync(aliasesPath)
    ? JSON.parse(readFileSync(aliasesPath, 'utf-8'))
    : {};

  // Load line corrections — static regex fixes applied to every incoming entry
  const correctionsPath = resolve(dataDir, 'line-corrections.json');
  const corrections = existsSync(correctionsPath)
    ? JSON.parse(readFileSync(correctionsPath, 'utf-8')).map(c => ({
        re: new RegExp(c.pattern, 'gi'),
        replacement: c.replacement,
        note: c.note,
      }))
    : [];

  const applyCorrections = (line) =>
    corrections.reduce((l, c) => l.replace(c.re, c.replacement), line);

  // Collapse latest.txt to single-line entries, then apply corrections
  const latestContent = readFileSync(latestPath, 'utf-8');
  const rawEntries = EventSanitizer.collapseToSingleLines(latestContent);
  const newEntries = rawEntries.map(applyCorrections);
  const correctedCount = rawEntries.filter((e, i) => e !== newEntries[i]).length;
  if (correctedCount > 0) console.log(`🔧 Applied line corrections to ${correctedCount} entries`);
  console.log(`📖 ${newEntries.length} entries parsed from latest.txt`);

  // Collapse existing events.txt and apply same corrections for consistent dedup
  const eventsContent = readFileSync(eventsPath, 'utf-8');
  const existingEntries = EventSanitizer.collapseToSingleLines(eventsContent).map(applyCorrections);
  console.log(`📖 ${existingEntries.length} existing entries in events.txt`);

  // Normalise a line for dedup: strip explicit year token and day-of-week so that
  // "may 1 2026 Artist..." and "may 1 fri Artist..." compare as equal.
  const dedupeKey = line =>
    line.replace(/^([a-z]{3}\s+\d{1,2})\s+(?:\d{4}|[a-z]{2,3})\s+/i, '$1 ');

  const existingKeys = new Set(existingEntries.map(dedupeKey));
  const toAdd = newEntries.filter(e => !existingKeys.has(dedupeKey(e)));
  console.log(`✨ ${toAdd.length} new entries to merge`);

  if (toAdd.length === 0) {
    console.log('Nothing to add — events.txt is already up to date.');
  } else {
    // Stamp explicit years onto new entries so the ETL date-parser never has
    // to guess the year from sequential context. Uses the same 6-month-ago
    // heuristic as DateParser: if the event month is > 6 months in the past,
    // it belongs to next year; otherwise it's the current year.
    const today = new Date();
    const stampedNew = toAdd.map(entry => stampYear(entry, resolveYear(entry, today)));

    // Merge existing (already have explicit years from prior stamps) + new
    const allEntries = [...existingEntries, ...stampedNew];

    // Sort by full date (YYYY * 10000 + MM * 100 + DD) so events.txt is always
    // chronological — makes the file human-readable and debug-friendly.
    const fullSortKey = line => {
      const m = line.match(/^([a-z]{3})\s+(\d{1,2})\s+(\d{4})/i);
      if (!m) return 0;
      const mon = MONTHS[m[1].toLowerCase()] ?? 0;
      return parseInt(m[3]) * 10000 + mon * 100 + parseInt(m[2]);
    };
    allEntries.sort((a, b) => fullSortKey(a) - fullSortKey(b));

    writeFileSync(eventsPath, allEntries.join('\n') + '\n', 'utf-8');
    console.log(`💾 events.txt updated (${allEntries.length} total entries)`);
  }

  // --- Venue discovery ---
  const venuesContent = readFileSync(venuesPath, 'utf-8');
  const existingVenueNames = new Set(
    venuesContent.split('\n')
      .filter(l => l.trim())
      .map(l => normalizeName(l.split(',')[0]))
  );

  const newVenues = new Set();
  for (const entry of toAdd) {
    const name = extractVenueName(entry, aliases);
    if (name && !existingVenueNames.has(normalizeName(name))) {
      newVenues.add(name);
    }
  }

  if (newVenues.size > 0) {
    const stubs = [...newVenues].sort().map(v => `${v},,,,`).join('\n');
    writeFileSync(venuesPath, venuesContent.trimEnd() + '\n' + stubs + '\n', 'utf-8');
    console.log(`🏛️  Added ${newVenues.size} new venue stub(s) to venues.txt`);
    for (const v of [...newVenues].sort()) console.log(`   + ${v}`);
  } else {
    console.log('No new venues discovered.');
  }

  console.log('\n✅ Merge complete. Run `npm run etl` to rebuild data.');
}

main();
