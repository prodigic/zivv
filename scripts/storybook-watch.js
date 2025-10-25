#!/usr/bin/env node

/**
 * Quick Storybook smoke test watcher
 * Runs the smoke test and watches for file changes
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

const STORYBOOK_URL = 'http://localhost:6006';
const WATCH_PATTERNS = [
    'src/stories/**/*.tsx',
    'src/components/**/*.tsx',
    'src/stories/**/*.ts',
];

let isStorybookRunning = false;
let testProcess = null;

// Check if Storybook is running
async function checkStorybookHealth() {
    try {
        const response = await fetch(STORYBOOK_URL);
        return response.ok;
    } catch {
        return false;
    }
}

// Start Storybook if not running
async function ensureStorybookRunning() {
    if (isStorybookRunning) return;

    const healthy = await checkStorybookHealth();
    if (healthy) {
        console.log('✅ Storybook is already running');
        isStorybookRunning = true;
        return;
    }

    console.log('🚀 Starting Storybook...');
    const storybookProcess = spawn('npm', ['run', 'storybook'], {
        stdio: 'inherit',
        shell: true,
    });

    // Wait for Storybook to be ready
    let attempts = 0;
    while (attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const healthy = await checkStorybookHealth();
        if (healthy) {
            console.log('✅ Storybook is ready');
            isStorybookRunning = true;
            return;
        }
        attempts++;
    }

    throw new Error('Storybook failed to start within 60 seconds');
}

// Run the smoke test
async function runSmokeTest() {
    if (testProcess) {
        testProcess.kill();
    }

    console.log('\n🧪 Running Storybook smoke test...');

    try {
        const { stdout, stderr } = await execAsync(
            'npx playwright test tests/storybook-smoke.spec.ts --config=playwright.storybook.config.ts --reporter=line'
        );

        console.log(stdout);
        if (stderr && !stderr.includes('Using config at')) {
            console.error('Test stderr:', stderr);
        }

        console.log('✅ Smoke test passed!');
        return true;
    } catch (error) {
        console.error('❌ Smoke test failed:');
        console.error(error.stdout || error.message);
        return false;
    }
}

// Watch for file changes
async function watchFiles() {
    const { default: chokidar } = await import('chokidar');

    const watcher = chokidar.watch(WATCH_PATTERNS, {
        ignored: [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/coverage/**',
        ],
        persistent: true,
    });

    let debounceTimer = null;

    watcher.on('change', (filePath) => {
        console.log(`\n📝 File changed: ${path.relative(process.cwd(), filePath)}`);

        // Debounce rapid file changes
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            runSmokeTest();
        }, 1000);
    });

    watcher.on('ready', () => {
        console.log('👀 Watching for story changes...');
        console.log('📁 Watching patterns:', WATCH_PATTERNS);
    });

    return watcher;
}

// Main function
async function main() {
    console.log('🎪 Storybook Smoke Test Watcher');
    console.log('================================');

    try {
        // Ensure Storybook is running
        await ensureStorybookRunning();

        // Run initial smoke test
        await runSmokeTest();

        // Start watching for changes
        await watchFiles();

        console.log('\n✨ Watch mode active. Press Ctrl+C to stop.\n');

        // Handle cleanup
        process.on('SIGINT', () => {
            console.log('\n👋 Stopping watcher...');
            process.exit(0);
        });

    } catch (error) {
        console.error('❌ Failed to start watcher:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
