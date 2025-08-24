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
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

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
