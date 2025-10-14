import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for Storybook testing
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/storybook.spec.ts",

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,

  /* Reporter to use */
  reporter: [
    ["html", { outputFolder: "playwright-report/storybook" }],
    ["json", { outputFile: "test-results/storybook-results.json" }],
    ["junit", { outputFile: "test-results/storybook-results.xml" }],
  ],

  /* Shared settings for all the projects below */
  use: {
    /* Base URL for Storybook */
    baseURL: "http://localhost:6006",

    /* Collect trace when retrying the failed test */
    trace: "on-first-retry",

    /* Screenshot on failure */
    screenshot: "only-on-failure",

    /* Video recording for failures */
    video: "retain-on-failure",

    /* Timeout for individual actions */
    actionTimeout: 15000,

    /* Navigation timeout */
    navigationTimeout: 30000,
  },

  /* Global timeout for each test */
  timeout: 60000,

  /* Expect timeout for assertions */
  expect: {
    timeout: 10000,
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Use larger viewport for Storybook testing
        viewport: { width: 1280, height: 720 },
      },
    },

    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1280, height: 720 },
      },
    },

    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 720 },
      },
    },

    /* Test mobile viewports for responsive stories */
    {
      name: "Mobile Chrome",
      use: {
        ...devices["Pixel 5"],
      },
    },

    {
      name: "Mobile Safari",
      use: {
        ...devices["iPhone 12"],
      },
    },
  ],

  /*
   * Storybook web server configuration
   * Note: In CI, Storybook should be started separately before running tests
   */
  webServer: process.env.CI
    ? undefined
    : {
        command: "npm run storybook",
        url: "http://localhost:6006",
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
