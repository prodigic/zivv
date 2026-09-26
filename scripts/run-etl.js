#!/usr/bin/env node

/**
 * ETL Processing Script
 * 
 * This script processes the raw data files in the data/ directory
 * and outputs structured JSON files to public/data/
 * 
 * Usage:
 *   node scripts/run-etl.js
 *   npm run etl
 */

import { ETLProcessor } from '../dist/lib/etl/processor.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ─── Post-ingest verification ────────────────────────────────

function verifyOutput(projectRoot, stats) {
  const publicData = resolve(projectRoot, 'public', 'data');
  const dataDir    = resolve(projectRoot, 'data');
  const failures   = [];
  const warnings   = [];

  // 1. Required output files exist and are non-empty
  const required = ['manifest.json', 'artists.json', 'venues.json', 'indexes.json',
                    'search-documents.json', 'search-terms.json'];
  for (const f of required) {
    const p = resolve(publicData, f);
    if (!existsSync(p)) {
      failures.push(`Missing output file: ${f}`);
    } else if (readFileSync(p, 'utf-8').trim().length < 10) {
      failures.push(`Empty output file: ${f}`);
    }
  }

  // 2. At least one events-*.json chunk exists
  const chunks = readdirSync(publicData).filter(f => f.startsWith('events-') && f.endsWith('.json'));
  if (chunks.length === 0) failures.push('No events-*.json chunks written');

  // Load all events and venues for richer checks
  let allEvents = [];
  for (const chunk of chunks) {
    try {
      const data = JSON.parse(readFileSync(resolve(publicData, chunk), 'utf-8'));
      allEvents.push(...(data.events || []));
    } catch { failures.push(`Could not parse ${chunk}`); }
  }

  // 3. Source line count vs ETL output: warn if ETL kept < 80% of source lines
  const sourceLines = readFileSync(resolve(dataDir, 'events.txt'), 'utf-8')
    .split('\n')
    .filter(l => /^[a-z]{3}\s+\d{1,2}\s+\w{3}/i.test(l)).length;
  const etlCount = allEvents.length;
  const keepRate = sourceLines > 0 ? etlCount / sourceLines : 1;
  if (keepRate < 0.80) {
    warnings.push(
      `Low event retention: ${etlCount} ETL events from ${sourceLines} source lines ` +
      `(${(keepRate * 100).toFixed(1)}% — expected ≥80%)`
    );
  }

  // 4. Cross-year duplicates: same MM-DD + venueId + headlinerArtistId in 2+ years
  const keyCount = {};
  for (const e of allEvents) {
    const k = `${e.date.slice(5)}-${e.venueId}-${e.headlinerArtistId}`;
    keyCount[k] = (keyCount[k] || 0) + 1;
  }
  const crossYearDupes = Object.values(keyCount).filter(c => c > 1).length;
  if (crossYearDupes > 0) {
    warnings.push(`${crossYearDupes} cross-year duplicate event(s) detected (same MM-DD + venue + headliner in multiple years)`);
  }

  // 5. Year-drift guard: if 99%+ of events share a single year and that year is
  //    not the current or next year, something has gone wrong with date parsing.
  const yearCounts = {};
  for (const e of allEvents) yearCounts[e.date.slice(0, 4)] = (yearCounts[e.date.slice(0, 4)] || 0) + 1;
  const currentYear = new Date().getFullYear();
  const total = allEvents.length;
  for (const [year, count] of Object.entries(yearCounts)) {
    const y = parseInt(year);
    if (count / total > 0.99 && y !== currentYear && y !== currentYear + 1) {
      warnings.push(`Year-drift detected: ${count}/${total} events assigned to ${year} — expected ${currentYear} or ${currentYear + 1}`);
    }
  }

  // 6. Events have required fields
  const malformed = allEvents.filter(e => !e.id || !e.date || !e.venueId || !e.headlinerArtistId).length;
  if (malformed > 0) failures.push(`${malformed} events missing required fields (id/date/venueId/headlinerArtistId)`);

  // 7. Dates are plausible (no events before 2020 or after 2035)
  const badDates = allEvents.filter(e => {
    const y = parseInt(e.date.slice(0, 4));
    return y < 2020 || y > 2035;
  }).length;
  if (badDates > 0) failures.push(`${badDates} events with implausible dates (year outside 2020–2035)`);

  // 8. Orphaned venue IDs — events referencing a venueId not in venues.json
  try {
    const venuesPath = resolve(publicData, 'venues.json');
    if (existsSync(venuesPath)) {
      const venueIds = new Set(JSON.parse(readFileSync(venuesPath, 'utf-8')).map(v => v.id));
      const orphaned = allEvents.filter(e => e.venueId && !venueIds.has(e.venueId));
      if (orphaned.length > 0) {
        // Group by venueId to keep the message compact
        const byId = {};
        orphaned.forEach(e => { byId[e.venueId] = (byId[e.venueId] || 0) + 1; });
        const summary = Object.entries(byId).map(([id, n]) => `id=${id}(${n})`).join(', ');
        warnings.push(`${orphaned.length} event(s) reference venue IDs not in venues.json: ${summary}`);
      }
    }
  } catch { /* non-fatal */ }

  return { failures, warnings, sourceLines, etlCount };
}

async function main() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const projectRoot = resolve(__dirname, '..');
    const processor = new ETLProcessor(projectRoot);

    console.log('🚀 Starting ETL processing...');
    console.log(`📁 Project root: ${projectRoot}`);

    try {
        const result = await processor.processData();

        if (result.success) {
            console.log('\n✅ ETL processing completed successfully!');

            // Display summary
            console.log('\n📊 Processing Summary:');
            console.log(`   Events: ${result.stats.parsedEvents}`);
            console.log(`   Artists: ${result.stats.parsedArtists}`);
            console.log(`   Venues: ${result.stats.parsedVenues}`);
            console.log(`   Chunks: ${result.stats.chunks.total}`);
            console.log(`   Processing time: ${result.stats.processingTimeMs}ms`);

            if (result.errors.length > 0) {
                console.log(`\n⚠️  ${result.errors.length} errors:`);
                result.errors.forEach((error, i) => {
                    console.log(`   ${i + 1}. ${error.message} (${error.sourceFile}:${error.lineNumber})`);
                });
            }

            if (result.warnings.length > 0) {
                console.log(`\n⚠️  ${result.warnings.length} warnings:`);
                result.warnings.slice(0, 5).forEach((warning, i) => {
                    console.log(`   ${i + 1}. ${warning.message} (${warning.sourceFile}:${warning.lineNumber})`);
                });
                if (result.warnings.length > 5) {
                    console.log(`   ... and ${result.warnings.length - 5} more warnings`);
                }
            }

            console.log('\n💾 Output files written to public/data/');
            console.log('   📄 manifest.json - Data manifest and metadata');
            console.log('   📄 events-YYYY-MM.json - Monthly event chunks');
            console.log('   📄 artists.json - All artists');
            console.log('   📄 venues.json - All venues');
            console.log('   📄 indexes.json - Search and filter indexes');
            console.log('   📄 search-*.json - Search index files');

            // Post-ingest verification
            console.log('\n🔬 Post-ingest verification...');
            const verify = verifyOutput(projectRoot, result.stats);
            console.log(`   Source lines: ${verify.sourceLines}  →  ETL events: ${verify.etlCount}`);

            if (verify.warnings.length > 0) {
                console.warn('\n⚠️  Verification warnings:');
                verify.warnings.forEach((w, i) => console.warn(`   ${i + 1}. ${w}`));
            }
            if (verify.failures.length > 0) {
                console.error('\n❌ Verification FAILED:');
                verify.failures.forEach((f, i) => console.error(`   ${i + 1}. ${f}`));
                process.exit(1);
            }
            if (verify.warnings.length === 0 && verify.failures.length === 0) {
                console.log('   ✅ All checks passed');
            }

            process.exit(0);

        } else {
            console.error('\n❌ ETL processing failed!');

            if (result.errors.length > 0) {
                console.error('\n🚨 Critical errors:');
                result.errors.forEach((error, i) => {
                    console.error(`   ${i + 1}. ${error.message}`);
                    if (error.sourceFile && error.lineNumber) {
                        console.error(`      (${error.sourceFile}:${error.lineNumber})`);
                    }
                    if (error.rawData) {
                        console.error(`      Data: ${error.rawData.slice(0, 100)}...`);
                    }
                });
            }

            process.exit(1);
        }

    } catch (error) {
        console.error('\n💥 ETL processing crashed:', error);
        process.exit(1);
    }
}

// Handle CLI arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
ETL Processing Script

This script processes raw data files and creates structured JSON outputs.

Usage:
  node scripts/run-etl.js [options]

Options:
  --help, -h    Show this help message
  --verbose, -v Enable verbose logging

Input files:
  data/events.txt  - Raw events data
  data/venues.txt  - Raw venues data

Output files:
  public/data/manifest.json      - Data manifest
  public/data/events-*.json      - Monthly event chunks
  public/data/artists.json       - Artist directory
  public/data/venues.json        - Venue directory
  public/data/indexes.json       - Search indexes
  public/data/search-*.json      - Search index files

Examples:
  node scripts/run-etl.js        # Process data
  npm run etl                     # Using npm script
`);
    process.exit(0);
}

// Set verbose logging
if (args.includes('--verbose') || args.includes('-v')) {
    process.env.DEBUG = '1';
}

// Run the main function
main().catch(error => {
    console.error('Script error:', error);
    process.exit(1);
});
