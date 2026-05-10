#!/usr/bin/env node

/**
 * Validation Script
 *
 * Validates data/latest.txt before merging into events.txt.
 *
 * Usage:
 *   node scripts/validate-latest.js
 *   npm run validate
 *
 * Output:
 *   data/events.err.txt  — event parse errors and warnings
 *   data/venues.err.txt  — venue errors: near-dupes, address-only venues
 *
 * Exit codes:
 *   0 — no errors (warnings are advisory only)
 *   1 — one or more hard errors found
 */

import { LatestValidator } from '../dist/lib/etl/validator.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const dataDir = resolve(projectRoot, 'data');

const SEP_HEAVY = '═'.repeat(56);
const SEP_LIGHT = '─'.repeat(56);

// ─── Formatters ─────────────────────────────────────────────

function formatEventsErrFile(result, timestamp, sourcePath) {
  const lines = [];

  lines.push('ZIVV VALIDATION — events errors/warnings');
  lines.push(`Generated: ${timestamp}`);
  lines.push(`Source: ${sourcePath}`);
  lines.push(SEP_HEAVY);
  lines.push('');

  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  lines.push(`ERRORS (${errors.length})`);
  lines.push(SEP_LIGHT);

  if (errors.length === 0) {
    lines.push('  (none)');
  } else {
    for (const issue of errors) {
      lines.push('');
      lines.push(`[LINE ${issue.lineNumber}] ERROR (${issue.type})`);
      lines.push(`  ${issue.message}`);
      if (issue.rawText) {
        lines.push('  Raw:');
        for (const rawLine of issue.rawText.split('\n')) {
          lines.push(`    ${rawLine}`);
        }
      }
    }
  }

  lines.push('');
  lines.push(`WARNINGS (${warnings.length})`);
  lines.push(SEP_LIGHT);

  if (warnings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const issue of warnings) {
      lines.push('');
      lines.push(`[LINE ${issue.lineNumber}] WARNING (${issue.type})`);
      lines.push(`  ${issue.message}`);
      if (issue.rawText) {
        lines.push('  Raw:');
        for (const rawLine of issue.rawText.split('\n')) {
          lines.push(`    ${rawLine}`);
        }
      }
    }
  }

  lines.push('');
  lines.push(SEP_HEAVY);
  lines.push(
    `Summary: ${errors.length} errors, ${warnings.length} warnings across ${result.eventsFound} events`
  );
  lines.push('');

  return lines.join('\n');
}

function formatVenuesErrFile(result, timestamp, sourcePaths) {
  const lines = [];

  lines.push('ZIVV VALIDATION — venue errors/warnings');
  lines.push(`Generated: ${timestamp}`);
  lines.push(`Source: ${sourcePaths}`);
  lines.push(SEP_HEAVY);
  lines.push('');

  // Parse errors from venues.txt
  lines.push(`VENUE PARSE ERRORS (${result.venueParseErrors.length})`);
  lines.push(SEP_LIGHT);

  if (result.venueParseErrors.length === 0) {
    lines.push('  (none)');
  } else {
    for (const issue of result.venueParseErrors) {
      lines.push('');
      lines.push(`[LINE ${issue.lineNumber}] ERROR (${issue.type})`);
      lines.push(`  ${issue.message}`);
      if (issue.rawText) {
        lines.push(`    ${issue.rawText}`);
      }
    }
  }

  lines.push('');

  // Address-only venues
  lines.push(`ADDRESS-ONLY VENUE NAMES (${result.addressOnlyVenues.length})`);
  lines.push(SEP_LIGHT);

  if (result.addressOnlyVenues.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push('  These look like bare addresses rather than named venues.');
    lines.push('');
    const nameWidth = Math.max(...result.addressOnlyVenues.map(v => v.name.length)) + 2;
    const reasonWidth = 20;
    for (const v of result.addressOnlyVenues) {
      const quotedName = `"${v.name}"`.padEnd(nameWidth);
      const reason = v.reason.padEnd(reasonWidth);
      const lineList = v.lineNumbers.slice(0, 8).join(', ') +
        (v.lineNumbers.length > 8 ? ` +${v.lineNumbers.length - 8} more` : '');
      lines.push(`  ${quotedName}  ${reason}  (lines: ${lineList})`);
    }
  }

  lines.push('');

  // Near-duplicate groups
  lines.push(`NEAR-DUPLICATE VENUE NAMES (${result.nearDuplicates.length} groups)`);
  lines.push(SEP_LIGHT);

  if (result.nearDuplicates.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push('  These may be spelling variants of the same venue.');
    lines.push('  * = appears in latest.txt events');
    for (let i = 0; i < result.nearDuplicates.length; i++) {
      const group = result.nearDuplicates[i];
      const allNames = [group.canonical, ...group.variants];
      const variantCount = allNames.length;
      const simPct = (group.maxSimilarity * 100).toFixed(0);
      lines.push('');
      lines.push(
        `  Group ${i + 1} — similarity ${simPct}% (${variantCount} variants)`
      );

      for (const name of allNames) {
        const inLatest = group.latestLineNumbers.has(name);
        const star = inLatest ? '* ' : '  ';
        const lineNums = group.latestLineNumbers.get(name);
        const suffix = lineNums
          ? `  [events lines: ${lineNums.slice(0, 6).join(', ')}${lineNums.length > 6 ? ` +${lineNums.length - 6} more` : ''}]`
          : '  [venues.txt or club info]';
        lines.push(`    ${star}"${name}"${suffix}`);
      }
    }
  }

  lines.push('');
  lines.push(SEP_HEAVY);
  lines.push(
    `Summary: ${result.venueParseErrors.length} parse errors, ` +
    `${result.addressOnlyVenues.length} address-only venues, ` +
    `${result.nearDuplicates.length} near-dupe groups`
  );
  lines.push('');

  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const latestPath = resolve(dataDir, 'latest.txt');
  const venuesPath = resolve(dataDir, 'venues.txt');
  const eventsErrPath = resolve(dataDir, 'events.err.txt');
  const venuesErrPath = resolve(dataDir, 'venues.err.txt');

  if (!existsSync(latestPath)) {
    console.error(`❌ Not found: ${latestPath}`);
    process.exit(1);
  }

  if (!existsSync(venuesPath)) {
    console.error(`❌ Not found: ${venuesPath}`);
    process.exit(1);
  }

  const latestContent = readFileSync(latestPath, 'utf-8');
  const venuesContent = readFileSync(venuesPath, 'utf-8');
  const timestamp = new Date().toISOString();

  const validator = new LatestValidator();

  console.log('🔍 Validating events...');
  const eventResult = validator.validateEvents(latestContent);

  console.log('🏛️  Validating venues...');
  const venueResult = validator.validateVenues(latestContent, venuesContent);

  writeFileSync(eventsErrPath, formatEventsErrFile(eventResult, timestamp, 'data/latest.txt'));
  writeFileSync(venuesErrPath, formatVenuesErrFile(venueResult, timestamp, 'data/latest.txt + data/venues.txt'));

  console.log('');
  console.log('📋 Results:');
  console.log(
    `   Events: ${eventResult.errorCount} errors, ${eventResult.warningCount} warnings` +
    ` (${eventResult.eventsFound} events parsed)`
  );
  console.log(
    `   Venues: ${venueResult.venueParseErrors.length} parse errors,` +
    ` ${venueResult.addressOnlyVenues.length} address-only,` +
    ` ${venueResult.nearDuplicates.length} near-dupe groups`
  );
  console.log('');
  console.log(`💾 Written: ${eventsErrPath}`);
  console.log(`💾 Written: ${venuesErrPath}`);

  const hasErrors = eventResult.errorCount > 0 || venueResult.errorCount > 0;

  if (hasErrors) {
    console.log('\n❌ Validation failed — fix errors before merging into events.txt');
    process.exit(1);
  } else {
    console.log('\n✅ No hard errors — review warnings in .err.txt files before merging');
    process.exit(0);
  }
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Validate data/latest.txt before merging into events.txt.

Usage:
  node scripts/validate-latest.js
  npm run validate

Output:
  data/events.err.txt  — event parse errors and warnings
  data/venues.err.txt  — venue parse errors, address-only venues, near-dupes

Exit codes:
  0 — no hard errors (warnings are advisory)
  1 — hard errors found
`);
  process.exit(0);
}

main().catch(error => {
  console.error('💥 Validation crashed:', error);
  process.exit(1);
});
