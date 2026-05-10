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

  // Collapse latest.txt to single-line entries
  const latestContent = readFileSync(latestPath, 'utf-8');
  const newEntries = EventSanitizer.collapseToSingleLines(latestContent);
  console.log(`📖 ${newEntries.length} entries parsed from latest.txt`);

  // Collapse existing events.txt the same way so the comparison is apples-to-apples
  const eventsContent = readFileSync(eventsPath, 'utf-8');
  const existingEntries = EventSanitizer.collapseToSingleLines(eventsContent);
  const existingSet = new Set(existingEntries);
  console.log(`📖 ${existingEntries.length} existing entries in events.txt`);

  const toAdd = newEntries.filter(e => !existingSet.has(e));
  console.log(`✨ ${toAdd.length} new entries to merge`);

  if (toAdd.length === 0) {
    console.log('Nothing to add — events.txt is already up to date.');
  } else {
    // Re-write events.txt as sanitized single-line entries (existing + new)
    const allEntries = [...existingEntries, ...toAdd];
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
