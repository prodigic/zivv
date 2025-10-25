# Storybook Testing Guide

This project includes automated testing for Storybook stories to catch UI regressions and ensure component health.

## Quick Smoke Test

For rapid development feedback, use the **smoke test** which quickly verifies that all default stories render without error panels:

### Commands

```bash
# Run smoke test once
npm run storybook:test:smoke

# Run smoke test with Playwright UI (interactive)
npm run storybook:test:smoke:watch

# Run file watcher (auto-runs test on story changes)
npm run storybook:watch
```

### What the Smoke Test Does

✅ **Fast & Focused**: Tests only default stories, not all variants  
✅ **Error Detection**: Looks for error boundaries, error panels, console errors  
✅ **Content Validation**: Ensures stories render with actual content  
✅ **Auto-Discovery**: Automatically finds all stories from Storybook  
✅ **Watch Mode**: Re-runs when story files change

### Development Workflow

#### Option 1: Manual Testing

```bash
# Terminal 1: Start Storybook
npm run storybook

# Terminal 2: Run smoke test
npm run storybook:test:smoke
```

#### Option 2: Interactive Mode

```bash
# Terminal 1: Start Storybook
npm run storybook

# Terminal 2: Interactive test runner
npm run storybook:test:smoke:watch
```

#### Option 3: Auto-Watch Mode (Recommended)

```bash
# Single command - starts Storybook + file watcher
npm run storybook:watch
```

The watch mode will:

- Start Storybook if not running
- Run initial smoke test
- Watch story files for changes
- Re-run test automatically when files change

### Error Types Detected

The smoke test looks for:

- **React Error Boundaries**: Components that failed to render
- **Storybook Error Displays**: Storybook-specific error panels
- **Empty Stories**: Stories that render no content
- **Console Errors**: JavaScript errors during story rendering
- **Missing Images**: Broken image references
- **Stack Traces**: Unhandled exceptions

### File Watching

The watcher monitors these patterns:

- `src/stories/**/*.tsx` - Story files
- `src/components/**/*.tsx` - Component files
- `src/stories/**/*.ts` - Story configuration

### Performance

- **Smoke Test**: ~10-30 seconds for all stories
- **Full Test Suite**: ~2-5 minutes (comprehensive testing)

Use the smoke test during development and the full suite for CI/pull requests.

## Comprehensive Testing

For thorough testing of all story variants and interactions:

```bash
# Full Storybook test suite
npm run storybook:test:playwright

# Run both smoke + comprehensive
npm run storybook:test:ci
```

## Troubleshooting

### "Storybook is not running"

Start Storybook first:

```bash
npm run storybook
```

### Test fails but stories look fine in browser

Check the browser console for JavaScript errors that may not be visible in the UI.

### File watcher not triggering

Ensure you're editing files in the watched directories:

- `src/stories/`
- `src/components/`

### Too many console errors

The smoke test filters out common non-critical errors (favicon, HMR, etc.). If you see legitimate errors, they should be fixed in the components.

## Integration with Development

### Pre-commit Hook

Consider adding the smoke test to your pre-commit hooks:

```json
{
  "pre-commit": "npm run storybook:test:smoke"
}
```

### VS Code Integration

You can run the smoke test from VS Code terminal or add it as a VS Code task:

```json
// .vscode/tasks.json
{
  "label": "Storybook Smoke Test",
  "type": "npm",
  "script": "storybook:test:smoke",
  "group": "test"
}
```

### CI Integration

The smoke test runs faster than the full suite, making it good for:

- Pull request checks
- Development branch validation
- Quick feedback loops

For production releases, use the comprehensive test suite.
