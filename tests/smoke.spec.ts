import { test, expect } from "@playwright/test";

test.describe("Zivv Application Smoke Tests", () => {
  test("should load the homepage successfully", async ({ page }) => {
    await page.goto("/");

    // Check that the page loads without errors
    await expect(page).toHaveTitle(/Zivv/);

    // Check for main content area
    await expect(page.locator("main")).toBeVisible();

    // Check for navigation - on mobile nav may be hidden, so check header instead
    // which is always visible across all viewport sizes
    await expect(page.locator("header").first()).toBeVisible();

    // Wait for initial data loading to complete
    await page.waitForLoadState("networkidle");
  });

  test("should display the app shell correctly", async ({ page }) => {
    await page.goto("/");

    // Check for header/navigation
    const header = page.locator("header").first();
    await expect(header).toBeVisible();

    // Check for main content area
    const main = page.locator("main");
    await expect(main).toBeVisible();

    // Check that there are no console errors
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    await page.waitForTimeout(2000); // Wait for any async errors

    // Allow some expected errors but flag unexpected ones
    const criticalErrors = errors.filter(
      (error) =>
        !error.includes("favicon") &&
        !error.includes("manifest") &&
        !error.includes("404") &&
        !error.includes("Failed to fetch")
    );

    expect(criticalErrors.length).toBe(0);
  });

  test("should be responsive on mobile", async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    // Check that the page still renders properly on mobile
    await expect(page.locator("main")).toBeVisible();

    // Check for mobile-friendly layout - ensure at least one nav is visible
    await expect(page.locator("nav >> visible=true").first()).toBeVisible();

    // Verify no horizontal scroll
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 10); // Allow small margin
  });

  test("should handle network failures gracefully", async ({ page }) => {
    // Block network requests to simulate offline
    await page.route("**/*", (route) => {
      if (route.request().url().includes("/data/")) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto("/");

    // App should still load basic shell
    await expect(page.locator("main")).toBeVisible();

    // Should show appropriate loading or error state
    // This will depend on how the app handles loading states
    await page.waitForTimeout(2000);

    // The app should not crash - basic structure should remain
    await expect(page.locator("body")).toBeVisible();
  });

  test("should maintain accessibility standards", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Check for basic accessibility requirements
    // Page should have a title
    const title = await page.title();
    expect(title).toBeTruthy();
    expect(title.length).toBeGreaterThan(0);

    // Main content should be accessible
    const main = page.locator('main, [role="main"]');
    await expect(main).toBeVisible();

    // Check for skip links or similar accessibility features
    const skipLink = page.locator('a[href="#main"], .skip-link');
    // This is optional but good practice

    // Navigation should be properly marked up - ensure at least one nav is visible
    await expect(page.locator("nav >> visible=true").first()).toBeVisible();

    // Check that interactive elements are keyboard accessible
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
  });

  test("should load without JavaScript errors in console", async ({ page }) => {
    const consoleErrors: string[] = [];
    const networkErrors: string[] = [];

    // Listen for console errors
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // Listen for network errors
    page.on("requestfailed", (request) => {
      networkErrors.push(
        `${request.method()} ${request.url()} - ${request.failure()?.errorText}`
      );
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Filter out expected errors
    const criticalConsoleErrors = consoleErrors.filter(
      (error) =>
        !error.includes("favicon") &&
        !error.includes("manifest") &&
        !error.toLowerCase().includes("404") &&
        !error.includes("Failed to fetch")
    );

    const criticalNetworkErrors = networkErrors.filter(
      (error) =>
        !error.includes("favicon") &&
        !error.includes("manifest") &&
        !error.includes("404")
    );

    expect(criticalConsoleErrors.length).toBe(0);
    expect(criticalNetworkErrors.length).toBe(0);
  });
});
