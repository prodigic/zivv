# Storybook Testing with Playwright

This document explains how to run automated tests for Storybook stories to ensure all components are rendering correctly and without errors.

## Overview

The Storybook tests verify that:

- All stories load without JavaScript errors
- Components render visible content
- Responsive layouts work correctly
- Dark mode stories display properly
- Interactive components function as expected
- Storybook navigation and controls work properly

## Test Files

- `tests/storybook.spec.ts` - Main test file with comprehensive story verification
- `playwright.storybook.config.ts` - Playwright configuration specific to Storybook testing

## Running Tests

### Prerequisites

1. **Install Dependencies**

   ```bash
   npm install
   ```

2. **Ensure Playwright Browsers are Installed**
   ```bash
   npx playwright install
   ```

### Manual Test Execution

1. **Start Storybook First** (in one terminal)

   ```bash
   npm run storybook
   ```

   Wait for Storybook to start on http://localhost:6006

2. **Run Tests** (in another terminal)

   ```bash
   # Run all Storybook tests
   npm run storybook:test:playwright

   # Run tests in a specific browser
   npx playwright test --config=playwright.storybook.config.ts --project=chromium

   # Run tests with UI mode for debugging
   npx playwright test --config=playwright.storybook.config.ts --ui

   # Run specific test group
   npx playwright test --config=playwright.storybook.config.ts --grep "UI Components"
   ```

### Automated CI Testing

For CI/CD pipelines, use the automated script that starts Storybook, runs tests, and cleans up:

```bash
npm run storybook:test:ci
```

This command:

1. Starts Storybook in the background
2. Waits 15 seconds for Storybook to initialize
3. Runs all Playwright tests
4. Stops Storybook process

## Test Coverage

### UI Components Tested

**Filter Components:**

- DatePagination (9 stories)
- VenueFilter (9 stories)
- CityPagination (9 stories)

**Toggle Components:**

- DarkModeToggle (7 stories)
- UpcomingToggle (2 stories)
- FreeShowsToggle (2 stories)
- AgeRestrictionToggle (2 stories)

**Utility Components:**

- LoadingSpinner (9 stories)
- PageSizeSelector (5 stories)
- DebugToggle (2 stories)

### Layout Components Tested

- Header (8 stories)
- AppShell (5 stories)
- SideNavigation (6 stories)
- BottomNavigation (7 stories)
- PageWrapper (6 stories)

### Component Groups Tested

- SearchFilterToolbar (7 stories)

### Additional Test Coverage

- **Responsive Behavior**: Mobile viewport testing
- **Dark Mode**: All dark mode story variants
- **Storybook Features**: Navigation, controls, docs panels
- **Performance**: Load time verification
- **Error Detection**: Console error monitoring

## Test Structure

Each test group follows this pattern:

```typescript
test.describe("Component Name", () => {
  test("stories render correctly", async ({ page }) => {
    const stories = [
      "component-name--story-1",
      "component-name--story-2",
      // ... more stories
    ];

    for (const storyId of stories) {
      const iframe = await navigateToStory(page, storyId);

      // Verify component renders
      await expect(iframe.locator("expected-element")).toBeVisible();

      // Additional assertions specific to component
      // ...

      await page.waitForTimeout(500);
    }
  });
});
```

## Debugging Failed Tests

### View Test Results

After running tests, view the HTML report:

```bash
npx playwright show-report playwright-report/storybook
```

### Run Tests in Debug Mode

```bash
npx playwright test --config=playwright.storybook.config.ts --debug
```

### Run Specific Failing Test

```bash
npx playwright test --config=playwright.storybook.config.ts --grep "specific test name"
```

### Common Issues

1. **Storybook Not Running**: Ensure Storybook is started before running tests
2. **Story Not Found**: Check story ID matches the actual Storybook story identifier
3. **Timeout Errors**: Increase timeout in config if stories load slowly
4. **Element Not Found**: Verify the component actually renders the expected elements

## Configuration

### Browsers Tested

- **Desktop**: Chrome, Firefox, Safari
- **Mobile**: Chrome (Pixel 5), Safari (iPhone 12)

### Timeouts

- Global test timeout: 60 seconds
- Action timeout: 15 seconds
- Navigation timeout: 30 seconds
- Assertion timeout: 10 seconds

### Retry Strategy

- **Local Development**: No retries (fail fast)
- **CI Environment**: 2 retries for flaky test resilience

## Maintenance

### Adding New Story Tests

When adding new components or stories:

1. Add the story ID to the appropriate test group in `storybook.spec.ts`
2. Add component-specific assertions for the new story type
3. Update this documentation

### Story ID Format

Story IDs follow the pattern: `category-component--story-name`

Examples:

- `ui-components-datepagination--default`
- `layout-components-header--mobile-layout`
- `component-groups-searchfiltertoolbar--with-active-filters`

## Integration with CI/CD

Add to your CI pipeline:

```yaml
# GitHub Actions example
- name: Install dependencies
  run: npm ci

- name: Install Playwright browsers
  run: npx playwright install

- name: Run Storybook tests
  run: npm run storybook:test:ci
```

## Performance Considerations

- Tests run in parallel across browsers for faster execution
- Storybook stories are cached between test runs
- Mobile tests use reduced parallel workers to avoid resource contention
- CI mode uses single worker to ensure stability

This testing approach ensures comprehensive verification of all Storybook stories and provides confidence that component documentation and examples are always functional.

