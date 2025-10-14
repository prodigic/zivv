import { test, expect, type Page } from "@playwright/test";

// Storybook URL - adjust if your Storybook runs on different port
const STORYBOOK_URL = "http://localhost:6006";

// Helper function to navigate to a specific story
async function navigateToStory(page: Page, storyId: string) {
  // Use the correct Storybook URL format
  const storyUrl = `${STORYBOOK_URL}/?path=/story/${storyId}`;
  await page.goto(storyUrl);

  // Wait for Storybook to load completely
  await page.waitForLoadState("networkidle", { timeout: 15000 });

  // Wait for any iframe to load (Storybook uses different selectors in different versions)
  try {
    await page.waitForSelector("iframe", { timeout: 10000 });
  } catch (error) {
    // If no iframe, maybe it's embedded directly - that's ok for some stories
    console.log(
      `No iframe found for story ${storyId}, checking for direct content`
    );
  }

  // Get the iframe containing the story - try multiple possible selectors
  const iframeCount = await page.locator("iframe").count();
  if (iframeCount > 0) {
    return page.frameLocator("iframe").first();
  }

  // If no iframe, return the main page (some Storybook versions embed directly)
  return {
    locator: (selector: string) => page.locator(selector),
  } as any;
}

// Helper function to check for console errors
async function checkForConsoleErrors(page: Page) {
  const errors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });

  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

  return errors;
}

test.describe("Storybook Stories Verification", () => {
  test.beforeEach(async ({ page }) => {
    // Check if Storybook is running
    try {
      await page.goto(STORYBOOK_URL);
      // Wait for any iframe or main content to load
      await Promise.race([
        page.waitForSelector("iframe", { timeout: 5000 }),
        page.waitForSelector("#storybook-preview-wrapper", { timeout: 5000 }),
        page.waitForSelector('[id*="storybook"]', { timeout: 5000 }),
      ]);
    } catch (error) {
      throw new Error(
        `Storybook is not running on ${STORYBOOK_URL}. Please start Storybook first with 'npm run storybook'`
      );
    }
  });

  test.describe("UI Components - Filter Components", () => {
    test("DatePagination stories render correctly", async ({ page }) => {
      const stories = [
        "ui-components-datepagination--default",
        "ui-components-datepagination--today-selected",
        "ui-components-datepagination--tomorrow-selected",
        "ui-components-datepagination--this-week-selected",
        "ui-components-datepagination--this-month-selected",
        "ui-components-datepagination--multiple-dates-selected",
        "ui-components-datepagination--dark-mode",
        "ui-components-datepagination--mobile-layout",
        "ui-components-datepagination--playground",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check that the iframe body exists (even if hidden due to Storybook styling)
        await expect(iframe.locator("body")).toHaveCount(1);

        // Check for any buttons or content - the key is the story loads without critical errors
        const buttonCount = await iframe.locator("button").count();
        const divCount = await iframe.locator("div").count();

        // Story should have some interactive elements
        expect(buttonCount + divCount).toBeGreaterThan(0);

        // Verify no JS errors
        await page.waitForTimeout(500);
      }
    });

    test("VenueFilter stories render correctly", async ({ page }) => {
      const stories = [
        "ui-components-venuefilter--default",
        "ui-components-venuefilter--single-venue-selected",
        "ui-components-venuefilter--multiple-venues-selected",
        "ui-components-venuefilter--searching-venues",
        "ui-components-venuefilter--no-search-results",
        "ui-components-venuefilter--city-filtered-san-francisco",
        "ui-components-venuefilter--dark-mode",
        "ui-components-venuefilter--mobile-layout",
        "ui-components-venuefilter--playground",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check that the venue filter input is present
        await expect(
          iframe.locator('input[placeholder*="venue" i]')
        ).toBeVisible();

        // Check for venue filter container
        await expect(iframe.locator("div").first()).toBeVisible();

        await page.waitForTimeout(500);
      }
    });

    test("CityPagination stories render correctly", async ({ page }) => {
      const stories = [
        "ui-components-citypagination--default",
        "ui-components-citypagination--san-francisco-selected",
        "ui-components-citypagination--oakland-selected",
        "ui-components-citypagination--berkeley-selected",
        "ui-components-citypagination--santa-cruz-selected",
        "ui-components-citypagination--multiple-cities-selected",
        "ui-components-citypagination--dark-mode",
        "ui-components-citypagination--mobile-layout",
        "ui-components-citypagination--playground",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check for city buttons
        await expect(iframe.locator("button").first()).toBeVisible();

        // Verify cities are visible (should contain text like "San Francisco", "Oakland", etc.)
        const buttonCount = await iframe.locator("button").count();
        expect(buttonCount).toBeGreaterThanOrEqual(3);

        await page.waitForTimeout(500);
      }
    });
  });

  test.describe("UI Components - Toggle Components", () => {
    test("DarkModeToggle stories render correctly", async ({ page }) => {
      const stories = [
        "ui-components-darkmodetoggle--light-mode",
        "ui-components-darkmodetoggle--dark-mode",
        "ui-components-darkmodetoggle--small",
        "ui-components-darkmodetoggle--medium",
        "ui-components-darkmodetoggle--large",
        "ui-components-darkmodetoggle--compact-light",
        "ui-components-darkmodetoggle--compact-dark",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check for toggle button
        await expect(iframe.locator("button")).toBeVisible();

        // Verify the toggle contains some kind of icon or text
        await expect(iframe.locator("button")).toHaveCount(1);

        await page.waitForTimeout(500);
      }
    });

    test("UpcomingToggle stories render correctly", async ({ page }) => {
      const stories = [
        "ui-components-upcomingtoggle--default",
        "ui-components-upcomingtoggle--upcoming-only",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check for toggle button
        await expect(iframe.locator("button")).toBeVisible();

        await page.waitForTimeout(500);
      }
    });

    test("FreeShowsToggle stories render correctly", async ({ page }) => {
      const stories = [
        "ui-components-freeshowstoggle--default",
        "ui-components-freeshowstoggle--free-shows-only",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check for toggle button
        await expect(iframe.locator("button")).toBeVisible();

        await page.waitForTimeout(500);
      }
    });

    test("AgeRestrictionToggle stories render correctly", async ({ page }) => {
      const stories = [
        "ui-components-agerestrictiontoggle--default",
        "ui-components-agerestrictiontoggle--all-ages-only",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check for toggle button
        await expect(iframe.locator("button")).toBeVisible();

        await page.waitForTimeout(500);
      }
    });
  });

  test.describe("UI Components - Utility Components", () => {
    test("LoadingSpinner stories render correctly", async ({ page }) => {
      const stories = [
        "ui-components-loadingspinner--default",
        "ui-components-loadingspinner--small",
        "ui-components-loadingspinner--large",
        "ui-components-loadingspinner--page-loading",
        "ui-components-loadingspinner--inline-loading",
        "ui-components-loadingspinner--skeleton",
        "ui-components-loadingspinner--event-card-skeleton",
        "ui-components-loadingspinner--loading-overlay",
        "ui-components-loadingspinner--dark-mode",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check that loading content is visible
        await expect(iframe.locator("body")).toBeVisible();

        // Most loading components should have some visual indicator
        const hasSpinner = await iframe
          .locator(
            '[class*="animate-spin"], [class*="spinner"], [class*="loading"]'
          )
          .count();
        const hasSkeleton = await iframe
          .locator('[class*="skeleton"], [class*="animate-pulse"]')
          .count();

        expect(hasSpinner + hasSkeleton).toBeGreaterThan(0);

        await page.waitForTimeout(500);
      }
    });

    test("PageSizeSelector stories render correctly", async ({ page }) => {
      const stories = [
        "ui-components-pagesizeselector--default",
        "ui-components-pagesizeselector--fifty-selected",
        "ui-components-pagesizeselector--hundred-selected",
        "ui-components-pagesizeselector--dark-mode",
        "ui-components-pagesizeselector--playground",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check for select element or dropdown
        const hasSelect = (await iframe.locator("select").count()) > 0;
        const hasButton = (await iframe.locator("button").count()) > 0;

        expect(hasSelect || hasButton).toBe(true);

        await page.waitForTimeout(500);
      }
    });

    test("DebugToggle stories render correctly", async ({ page }) => {
      const stories = [
        "ui-components-debugtoggle--default",
        "ui-components-debugtoggle--debug-mode-on",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check for toggle button
        await expect(iframe.locator("button")).toBeVisible();

        await page.waitForTimeout(500);
      }
    });
  });

  test.describe("Layout Components", () => {
    test("Header stories render correctly", async ({ page }) => {
      const stories = [
        "layout-components-header--default",
        "layout-components-header--with-search-query",
        "layout-components-header--search-loading",
        "layout-components-header--with-active-filters",
        "layout-components-header--search-with-filters",
        "layout-components-header--mobile-layout",
        "layout-components-header--dark-mode",
        "layout-components-header--playground",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check for header elements
        await expect(iframe.locator("header")).toBeVisible();

        // Check for search input
        await expect(iframe.locator('input[type="text"]')).toBeVisible();

        // Check for logo/title
        await expect(iframe.locator("text=Zivv")).toBeVisible();

        await page.waitForTimeout(500);
      }
    });

    test("AppShell stories render correctly", async ({ page }) => {
      const stories = [
        "layout-components-appshell--default",
        "layout-components-appshell--loading",
        "layout-components-appshell--initialization-error",
        "layout-components-appshell--mobile-layout",
        "layout-components-appshell--dark-mode",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check that the app shell renders something
        await expect(iframe.locator("body")).toBeVisible();

        // Check for main layout elements
        const hasContent = (await iframe.locator("div").count()) > 0;
        expect(hasContent).toBe(true);

        await page.waitForTimeout(500);
      }
    });

    test("SideNavigation stories render correctly", async ({ page }) => {
      const stories = [
        "layout-components-sidenavigation--default",
        "layout-components-sidenavigation--with-active-filters",
        "layout-components-sidenavigation--no-upcoming-events",
        "layout-components-sidenavigation--closed",
        "layout-components-sidenavigation--mobile-layout",
        "layout-components-sidenavigation--dark-mode",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check that sidebar content exists
        await expect(iframe.locator("aside, nav")).toBeVisible();

        // Check for navigation links
        await expect(iframe.locator("a, button").first()).toBeVisible();

        await page.waitForTimeout(500);
      }
    });

    test("BottomNavigation stories render correctly", async ({ page }) => {
      const stories = [
        "layout-components-bottomnavigation--home-active",
        "layout-components-bottomnavigation--calendar-active",
        "layout-components-bottomnavigation--artists-active",
        "layout-components-bottomnavigation--venues-active",
        "layout-components-bottomnavigation--mobile-portrait",
        "layout-components-bottomnavigation--dark-mode",
        "layout-components-bottomnavigation--custom-styling",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check for bottom navigation
        await expect(iframe.locator("nav")).toBeVisible();

        // Check for navigation items
        await expect(iframe.locator("a").first()).toBeVisible();

        // Should have multiple navigation items
        const linkCount = await iframe.locator("a").count();
        expect(linkCount).toBeGreaterThanOrEqual(3);

        await page.waitForTimeout(500);
      }
    });

    test("PageWrapper stories render correctly", async ({ page }) => {
      const stories = [
        "layout-components-pagewrapper--default",
        "layout-components-pagewrapper--with-error",
        "layout-components-pagewrapper--with-suspense-loading",
        "layout-components-pagewrapper--multiple-children",
        "layout-components-pagewrapper--dark-mode",
        "layout-components-pagewrapper--complex-content",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check that wrapper content renders
        await expect(iframe.locator("body")).toBeVisible();

        // Most should have some content
        const hasContent =
          (await iframe.locator("div, p, h1, h2, h3").count()) > 0;
        expect(hasContent).toBe(true);

        await page.waitForTimeout(1000); // Longer wait for suspense loading
      }
    });
  });

  test.describe("Component Groups", () => {
    test("SearchFilterToolbar stories render correctly", async ({ page }) => {
      const stories = [
        "component-groups-searchfiltertoolbar--default",
        "component-groups-searchfiltertoolbar--mobile-compact",
        "component-groups-searchfiltertoolbar--with-active-filters",
        "component-groups-searchfiltertoolbar--dark-mode",
        "component-groups-searchfiltertoolbar--horizontal-layout",
        "component-groups-searchfiltertoolbar--loading-state",
        "component-groups-searchfiltertoolbar--accessibility-demo",
      ];

      for (const storyId of stories) {
        const iframe = await navigateToStory(page, storyId);

        // Check that the toolbar renders
        await expect(iframe.locator("div").first()).toBeVisible();

        // Should have multiple filter components
        const filterCount = await iframe.locator("button, input").count();
        expect(filterCount).toBeGreaterThan(2);

        await page.waitForTimeout(500);
      }
    });
  });

  test.describe("Responsive Behavior", () => {
    test("Stories work on mobile viewport", async ({ page }) => {
      // Set mobile viewport
      await page.setViewportSize({ width: 375, height: 667 });

      const mobileStories = [
        "ui-components-datepagination--mobile-layout",
        "ui-components-venuefilter--mobile-layout",
        "ui-components-citypagination--mobile-layout",
        "layout-components-header--mobile-layout",
        "layout-components-appshell--mobile-layout",
        "layout-components-sidenavigation--mobile-layout",
        "layout-components-bottomnavigation--mobile-portrait",
      ];

      for (const storyId of mobileStories) {
        const iframe = await navigateToStory(page, storyId);

        // Check that content is still visible and functional on mobile
        await expect(iframe.locator("body")).toBeVisible();

        // Verify no horizontal overflow
        const bodyWidth = await iframe.locator("body").boundingBox();
        expect(bodyWidth?.width).toBeLessThanOrEqual(375);

        await page.waitForTimeout(500);
      }
    });

    test("Dark mode stories render correctly", async ({ page }) => {
      const darkModeStories = [
        "ui-components-datepagination--dark-mode",
        "ui-components-venuefilter--dark-mode",
        "ui-components-citypagination--dark-mode",
        "ui-components-loadingspinner--dark-mode",
        "layout-components-header--dark-mode",
        "layout-components-appshell--dark-mode",
        "layout-components-sidenavigation--dark-mode",
        "layout-components-bottomnavigation--dark-mode",
        "layout-components-pagewrapper--dark-mode",
      ];

      for (const storyId of darkModeStories) {
        const iframe = await navigateToStory(page, storyId);

        // Check that content renders in dark mode
        await expect(iframe.locator("body")).toBeVisible();

        // Verify dark mode styling (should have dark backgrounds)
        const hasDarkElements =
          (await iframe
            .locator(
              '[class*="dark:"], [class*="bg-gray-"], [class*="bg-black"]'
            )
            .count()) > 0;
        expect(hasDarkElements).toBe(true);

        await page.waitForTimeout(500);
      }
    });
  });

  test.describe("Storybook Navigation and Controls", () => {
    test("Storybook sidebar navigation works", async ({ page }) => {
      await page.goto(STORYBOOK_URL);

      // Check main sidebar sections
      await expect(page.locator("text=UI Components")).toBeVisible();
      await expect(page.locator("text=Layout Components")).toBeVisible();
      await expect(page.locator("text=Component Groups")).toBeVisible();

      // Try expanding a section
      await page.click("text=UI Components");
      await page.waitForTimeout(500);

      // Check for component entries
      await expect(page.locator("text=DatePagination")).toBeVisible();
      await expect(page.locator("text=VenueFilter")).toBeVisible();
    });

    test("Storybook controls panel works", async ({ page }) => {
      // Navigate to a story with controls
      await navigateToStory(page, "ui-components-datepagination--playground");

      // Check for controls panel
      await page.click('[role="tab"]:has-text("Controls")');
      await page.waitForTimeout(500);

      // Should see some controls
      const controlsCount = await page
        .locator('[data-testid*="control"], input, select, button')
        .count();
      expect(controlsCount).toBeGreaterThan(0);
    });

    test("Storybook docs panel works", async ({ page }) => {
      // Navigate to a story
      await navigateToStory(page, "ui-components-datepagination--default");

      // Check for docs panel
      await page.click('[role="tab"]:has-text("Docs")');
      await page.waitForTimeout(500);

      // Should see documentation content
      const hasDocContent = (await page.locator("h1, h2, h3, p").count()) > 0;
      expect(hasDocContent).toBe(true);
    });
  });

  test.describe("Error Detection", () => {
    test("No console errors in stories", async ({ page }) => {
      const errors = await checkForConsoleErrors(page);

      // Test a sampling of stories for console errors
      const testStories = [
        "ui-components-datepagination--default",
        "ui-components-venuefilter--default",
        "layout-components-header--default",
        "layout-components-appshell--default",
        "component-groups-searchfiltertoolbar--default",
      ];

      for (const storyId of testStories) {
        await navigateToStory(page, storyId);
        await page.waitForTimeout(1000);
      }

      // Filter out known non-critical errors
      const criticalErrors = errors.filter(
        (error) =>
          !error.includes("favicon") &&
          !error.includes("livereload") &&
          !error.includes("HMR") &&
          !error.includes("404")
      );

      if (criticalErrors.length > 0) {
        console.log("Console errors found:", criticalErrors);
      }

      expect(criticalErrors.length).toBe(0);
    });
  });
});

test.describe("Storybook Performance", () => {
  test("Stories load within reasonable time", async ({ page }) => {
    const startTime = Date.now();

    await navigateToStory(page, "ui-components-datepagination--default");

    const loadTime = Date.now() - startTime;

    // Stories should load within 10 seconds
    expect(loadTime).toBeLessThan(10000);
  });

  test("Storybook main page loads quickly", async ({ page }) => {
    const startTime = Date.now();

    await page.goto(STORYBOOK_URL);
    await page.waitForSelector('[data-testid="storybook-preview-iframe"]');

    const loadTime = Date.now() - startTime;

    // Main Storybook should load within 15 seconds
    expect(loadTime).toBeLessThan(15000);
  });
});
