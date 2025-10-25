# Testing Guide

This document provides comprehensive guidance on testing in the Zivv project, covering unit tests, integration tests, E2E tests, and performance testing.

## Overview

The Zivv testing strategy follows a multi-layered approach:

- **Unit Tests**: Individual functions and components (Vitest + React Testing Library)
- **Integration Tests**: ETL pipeline and service interactions (Vitest)
- **E2E Tests**: Full user journeys and browser testing (Playwright)
- **Performance Tests**: Core Web Vitals and optimization (Playwright + Lighthouse)

## Test Coverage

### Phase 1: ETL Pipeline Testing ✅

- **EventParser.test.ts**: Event parsing, normalization, artist extraction
- **VenueParser.test.ts**: Venue parsing, address normalization, deduplication
- **ETLIntegration.test.ts**: Full pipeline integration testing

### Phase 2: Data Loading & Services Testing ✅

- **DataService.test.ts**: Chunk loading, cache invalidation, error handling
- **CacheService.test.ts**: IndexedDB operations, LRU eviction, version management
- **WorkerService.test.ts**: Web Worker communication, fallback behavior

### Phase 3: Core App Functionality ✅

- **filterStore.test.ts**: State management, URL synchronization, filter combinations
- **appStore.test.ts**: Data loading, UI state, error handling, cache management
- **DatePagination.test.tsx**: Date filtering UI, keyboard navigation, responsive design
- **CityPagination.test.tsx**: City filtering UI, selection logic, accessibility

### Phase 4: E2E Testing ✅

- **smoke.spec.ts**: Application smoke tests, basic functionality, accessibility
- **event-filtering.spec.ts**: Filter interactions, view toggles, state persistence
- **search-functionality.spec.ts**: Search features, autocomplete, keyboard access

### Phase 5: Performance Testing ✅

- **performance.spec.ts**: Core Web Vitals, load times, mobile performance
- **lighthouse.spec.ts**: Lighthouse audits, SEO, PWA compliance

### Phase 6: Test Infrastructure & Coverage Configuration ✅

- **storybook-smoke.spec.ts**: Parallel Storybook component testing with error detection
- **Comprehensive test mocking**: DataService, CacheService, and browser API mocking
- **Optimized test execution**: 5x performance improvement with concurrent testing
- **Error boundary validation**: Component crash detection and error handling testing

## Running Tests

### Unit Tests (Vitest)

```bash
# Watch mode (development)
npm run test

# Run once
npm run test:run

# With coverage
npm run test:coverage

# Interactive UI
npm run test:ui

# Watch specific files
npm run test -- src/test/stores/

# Single test file
npm run test -- src/test/DataService.test.ts
```

### E2E Tests (Playwright)

```bash
# All E2E tests
npm run test:e2e

# Headed mode (see browser)
npm run test:e2e:headed

# Interactive UI
npm run test:e2e:ui

# Debug mode (step through)
npm run test:e2e:debug

# Show last report
npm run test:e2e:report

# Smoke tests only
npm run test:smoke
```

### Performance Tests

```bash
# All performance tests
npm run test:performance

# Lighthouse audits only
npm run test:lighthouse
```

### Complete Test Suite

```bash
# All unit and E2E tests
npm run test:all

# All tests including performance
npm run test:all:coverage
```

## Test Configuration

### Vitest Configuration (`vitest.config.ts`)

- **Environment**: JSDOM for DOM testing
- **Coverage**: V8 provider with 75% line coverage threshold
- **Reporters**: Verbose console + HTML output
- **Path Aliases**: Full `@/` import support
- **Setup**: Global mocks for browser APIs

### Playwright Configuration (`playwright.config.ts`)

- **Browsers**: Chrome, Firefox, Safari + Mobile variants
- **Base URL**: `http://localhost:5173` (dev server)
- **Reporters**: HTML, JSON, JUnit for CI integration
- **Retries**: 2 on CI, 0 locally
- **Tracing**: On first retry for debugging

## Writing Tests

### Unit Test Best Practices

```typescript
// Component test example
import { render, screen, fireEvent } from '@testing-library/react';
import { DatePagination } from '@/components/ui/DatePagination';

test('should handle date selection', () => {
  const mockUpdateFilter = vi.fn();
  vi.mocked(useFilterStore).mockReturnValue({
    updateFilter: mockUpdateFilter,
    // ... other store properties
  });

  render(<DatePagination />);

  fireEvent.click(screen.getByText('Today'));

  expect(mockUpdateFilter).toHaveBeenCalledWith(
    'dates',
    expect.arrayContaining([expect.any(String)])
  );
});
```

### E2E Test Best Practices

```typescript
// E2E test example
test("should filter events by city", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const cityFilter = page.locator('[data-testid="city-filter"]').first();
  await cityFilter.click();

  await page.waitForTimeout(500);

  const isActive = await cityFilter.evaluate((el) => {
    return (
      el.classList.contains("active") ||
      el.getAttribute("aria-pressed") === "true"
    );
  });

  expect(isActive).toBeTruthy();
});
```

## Test Data Management

### Fixtures (`tests/fixtures/`)

- **test-data.json**: Mock events, artists, venues for E2E tests
- **Isolated data**: Each test uses predictable, isolated data sets

### Mocking Strategy

- **Service mocks**: Mock external dependencies (DataService, CacheService)
- **Store mocks**: Mock Zustand stores with factory pattern
- **Browser APIs**: Mock IndexedDB, Worker, ResizeObserver in setup
- **Time-based**: Use `vi.useFakeTimers()` for date-dependent tests

## Coverage Targets

### Current Coverage Thresholds

- **Lines**: 75%
- **Functions**: 70%
- **Branches**: 70%
- **Statements**: 75%

### Coverage Reports

- **HTML**: `./coverage/index.html`
- **JSON**: `./coverage/coverage.json`
- **Console**: Real-time during test runs

## Continuous Integration

### GitHub Actions Workflow

The project includes comprehensive CI testing:

```yaml
# .github/workflows/test.yml
- Unit tests with coverage
- E2E tests across multiple browsers
- Performance regression testing
- Test result artifacts and reports
```

### Pre-commit Hooks

Recommended pre-commit setup:

```bash
# Install husky for git hooks
npm install --save-dev husky

# Add pre-commit test hook
npx husky add .husky/pre-commit "npm run test:run"
```

## Debugging Tests

### Unit Test Debugging

```bash
# Debug specific test
npm run test -- --no-coverage src/test/DataService.test.ts

# Inspect DOM state
screen.debug(); // In test code
```

### E2E Test Debugging

```bash
# Step through test
npm run test:e2e:debug

# Visual debugging
npm run test:e2e:headed

# Trace viewer
npx playwright show-trace test-results/.../trace.zip
```

### Performance Test Debugging

```bash
# Run with console output
npm run test:performance -- --headed

# Check Core Web Vitals
# Results logged to console during test execution
```

## Test Maintenance

### Regular Maintenance Tasks

1. **Update test data**: Keep fixtures current with real data patterns
2. **Review coverage**: Address gaps in critical code paths
3. **Performance baselines**: Update thresholds as app evolves
4. **Flaky test fixes**: Address intermittent failures promptly
5. **Dependency updates**: Keep testing libraries current

### Adding New Tests

When adding new features:

1. **Unit tests**: Test individual functions/components
2. **Integration tests**: Test feature interactions with existing systems
3. **E2E tests**: Add user journey tests for critical paths
4. **Update documentation**: Add new test patterns to this guide

## Troubleshooting

### Common Issues

**IndexedDB tests timing out**:

```typescript
// Use proper async/await with setTimeout for mock responses
setTimeout(() => {
  if (mockRequest.onsuccess) mockRequest.onsuccess();
}, 0);
```

**Component tests failing with store errors**:

```typescript
// Use factory pattern for store mocks
const createMockStore = () => ({
  /* fresh mock */
});
beforeEach(() => {
  vi.mocked(useFilterStore).mockImplementation(createMockStore);
});
```

**E2E tests flaky on CI**:

```typescript
// Add proper wait conditions
await page.waitForLoadState("networkidle");
await page.waitForSelector('[data-testid="content"]');
```

**Performance tests inconsistent**:

```typescript
// Use multiple measurements and averages
const times = [];
for (let i = 0; i < 3; i++) {
  times.push(await measureLoadTime());
}
const avgTime = times.reduce((a, b) => a + b) / times.length;
```

## Test Results and Reporting

### Local Development

- Unit tests: Console output + `./test-results/unit-tests.html`
- E2E tests: `./playwright-report/index.html`
- Coverage: `./coverage/index.html`

### CI/CD Integration

- JUnit XML: `./test-results/e2e-results.xml`
- JSON: `./test-results/e2e-results.json`
- Artifacts: Uploaded to GitHub Actions for failed tests

## Performance Benchmarks

### Target Metrics

- **Load Time**: < 3 seconds (homepage)
- **First Contentful Paint**: < 1.8 seconds
- **Largest Contentful Paint**: < 2.5 seconds
- **Cumulative Layout Shift**: < 0.1
- **Bundle Size**: JS < 2MB, CSS < 500KB

### Monitoring

Performance tests run automatically and will fail if metrics regress beyond acceptable thresholds.
