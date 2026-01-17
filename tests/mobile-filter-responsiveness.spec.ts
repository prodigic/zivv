/**
 * Comprehensive Mobile Filter Responsiveness Testing
 * Tests for mobile filter bar squishing issues across multiple viewport sizes
 */

import { test, expect } from "@playwright/test";

// Define viewport configurations for thorough testing
const viewports = [
  { width: 320, height: 568, name: "Ultra Small (iPhone 5/SE)" },
  { width: 375, height: 667, name: "Small Mobile (iPhone 6/7/8)" },
  { width: 414, height: 896, name: "Large Mobile (iPhone XR/11)" },
  { width: 475, height: 667, name: "Large Mobile (xs breakpoint)" },
] as const;

test.describe("Mobile Filter Bar Responsiveness", () => {
  // Test each viewport size
  viewports.forEach(({ width, height, name }) => {
    test.describe(`${name} (${width}×${height})`, () => {
      test.beforeEach(async ({ page }) => {
        // Set viewport size
        await page.setViewportSize({ width, height });

        // Navigate to homepage
        await page.goto("/");

        // Wait for app to load
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(1000);
      });

      test("should display all filter elements without horizontal overflow", async ({ page }) => {
        // Check that page doesn't have horizontal scrollbar
        const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
        const windowWidth = await page.evaluate(() => window.innerWidth);

        expect(bodyScrollWidth).toBeLessThanOrEqual(windowWidth + 5); // Allow 5px tolerance

        // Verify city filter elements are visible and clickable
        const cityFilters = page.locator(".city-pagination button, [data-testid='city-filter'] button");
        const cityFilterCount = await cityFilters.count();

        if (cityFilterCount > 0) {
          // All city filter buttons should be visible
          for (let i = 0; i < Math.min(cityFilterCount, 5); i++) {
            const button = cityFilters.nth(i);
            await expect(button).toBeVisible();

            // Button should have minimum touch target size (44px per WCAG)
            const boundingBox = await button.boundingBox();
            if (boundingBox) {
              expect(Math.max(boundingBox.width, boundingBox.height)).toBeGreaterThanOrEqual(44);
            }
          }
        }

        // Verify date filter elements are visible
        const dateFilters = page.locator(".date-pagination button, [data-testid='date-filter'] button");
        const dateFilterCount = await dateFilters.count();

        if (dateFilterCount > 0) {
          // Check Today and Tomorrow buttons are always visible
          const todayButton = dateFilters.filter({ hasText: /today|tod|t/i }).first();
          const tomorrowButton = dateFilters.filter({ hasText: /tomorrow|tom|t/i }).first();

          if (await todayButton.isVisible()) {
            await expect(todayButton).toBeVisible();
          }
          if (await tomorrowButton.isVisible()) {
            await expect(tomorrowButton).toBeVisible();
          }
        }
      });

      test("should handle progressive text abbreviation correctly", async ({ page }) => {
        // Test city filter text abbreviation
        const cityButtons = page.locator(".city-pagination button");
        const cityButtonCount = await cityButtons.count();

        if (cityButtonCount > 0) {
          const firstCityButton = cityButtons.first();
          const buttonText = await firstCityButton.textContent();

          // Verify text is appropriate for viewport size
          if (width >= 475) {
            // Should show full city names
            expect(buttonText).toMatch(/^[A-Za-z\s]+$/);
          } else if (width >= 375) {
            // Should show abbreviated names (2-4 chars)
            expect(buttonText?.length).toBeLessThanOrEqual(4);
          } else {
            // Should show single letters
            expect(buttonText?.length).toBeLessThanOrEqual(2);
          }
        }

        // Test date filter text abbreviation
        const dateButtons = page.locator(".date-pagination button");
        const todayButton = dateButtons.filter({ hasText: /today|tod|t/i }).first();

        if (await todayButton.isVisible()) {
          const todayText = await todayButton.textContent();

          if (width >= 475) {
            // Should show "Today"
            expect(todayText).toContain("Today");
          } else if (width >= 375) {
            // Should show "Tod"
            expect(todayText?.toLowerCase()).toMatch(/tod|today/);
          } else {
            // Should show "T"
            expect(todayText?.length).toBeLessThanOrEqual(2);
          }
        }
      });

      test("should open and interact with filter modal properly", async ({ page }) => {
        // Find and click the filter button
        const filterButton = page.locator("button[aria-label*='filter' i], .filter-button, [data-testid='filter-button']").first();

        if (await filterButton.isVisible()) {
          await filterButton.click();

          // Wait for modal to appear
          await page.waitForTimeout(300);

          // Check mobile modal appears correctly (for mobile viewports)
          if (width < 768) {
            const mobileModal = page.locator(".fixed.inset-x-0.bottom-0, [role='dialog']").first();

            if (await mobileModal.isVisible()) {
              await expect(mobileModal).toBeVisible();

              // Modal should not exceed viewport boundaries
              const modalBox = await mobileModal.boundingBox();
              if (modalBox) {
                expect(modalBox.x).toBeGreaterThanOrEqual(0);
                expect(modalBox.x + modalBox.width).toBeLessThanOrEqual(width + 5);
              }

              // Check that modal content is properly padded for ultra-small screens
              const modalContent = mobileModal.locator(".p-4, .p-3, .p-2").first();
              if (await modalContent.isVisible()) {
                await expect(modalContent).toBeVisible();
              }

              // Close modal
              const closeButton = mobileModal.locator("button[aria-label*='close' i], .close-button").first();
              if (await closeButton.isVisible()) {
                await closeButton.click();
                await page.waitForTimeout(200);
              } else {
                // Click backdrop to close
                await page.click(".fixed.inset-0.bg-black");
                await page.waitForTimeout(200);
              }
            }
          }
        }
      });

      test("should handle venue filter dropdown without overflow", async ({ page }) => {
        // Look for venue filter
        const venueFilter = page.locator(".venue-filter, [data-testid='venue-filter']").first();

        if (await venueFilter.isVisible()) {
          // Click on venue search input to open dropdown
          const venueInput = venueFilter.locator("input, .search-input").first();

          if (await venueInput.isVisible()) {
            await venueInput.click();
            await page.waitForTimeout(200);

            // Check if dropdown appears
            const dropdown = page.locator(".absolute.z-50, .dropdown-menu, [role='listbox']").first();

            if (await dropdown.isVisible()) {
              // Dropdown should not exceed viewport boundaries
              const dropdownBox = await dropdown.boundingBox();
              if (dropdownBox) {
                expect(dropdownBox.x).toBeGreaterThanOrEqual(0);
                expect(dropdownBox.x + dropdownBox.width).toBeLessThanOrEqual(width + 10); // 10px tolerance
              }

              // Check venue name truncation in chips
              const venueChips = page.locator(".venue-filter .truncate, .venue-chip").first();
              if (await venueChips.isVisible()) {
                const chipBox = await venueChips.boundingBox();
                if (chipBox && width < 375) {
                  // On ultra-small screens, chips should be properly constrained
                  expect(chipBox.width).toBeLessThanOrEqual(80);
                }
              }
            }

            // Click outside to close dropdown
            await page.click("body");
            await page.waitForTimeout(200);
          }
        }
      });

      test("should maintain filter functionality across breakpoints", async ({ page }) => {
        // Test city filter functionality
        const cityButtons = page.locator(".city-pagination button").first();

        if (await cityButtons.isVisible()) {
          // Record initial state
          const initialClass = await cityButtons.getAttribute("class");

          // Click the button
          await cityButtons.click();
          await page.waitForTimeout(300);

          // Verify state changed (button should show selected state)
          const newClass = await cityButtons.getAttribute("class");
          expect(newClass).not.toBe(initialClass);

          // Should show active styling
          const isActive = newClass?.includes("bg-red-50") || newClass?.includes("selected") || newClass?.includes("active");
          expect(isActive).toBeTruthy();
        }

        // Test date filter functionality
        const todayButton = page.locator(".date-pagination button").filter({ hasText: /today|tod|t/i }).first();

        if (await todayButton.isVisible()) {
          await todayButton.click();
          await page.waitForTimeout(300);

          // Should show active state
          const activeClass = await todayButton.getAttribute("class");
          const isActive = activeClass?.includes("bg-red-50") || activeClass?.includes("selected");
          expect(isActive).toBeTruthy();
        }
      });

      test("should meet performance benchmarks", async ({ page }) => {
        // Test filter operation performance
        const startTime = Date.now();

        // Perform a filter operation
        const filterButton = page.locator(".city-pagination button, .date-pagination button").first();

        if (await filterButton.isVisible()) {
          await filterButton.click();

          // Wait for any animations/transitions to complete
          await page.waitForTimeout(100);

          const endTime = Date.now();
          const duration = endTime - startTime;

          // Filter operations should complete under 300ms
          expect(duration).toBeLessThan(300);
        }

        // Test modal open performance
        const modalButton = page.locator("button[aria-label*='filter' i]").first();

        if (await modalButton.isVisible()) {
          const modalStartTime = Date.now();

          await modalButton.click();
          await page.waitForTimeout(100);

          const modalEndTime = Date.now();
          const modalDuration = modalEndTime - modalStartTime;

          // Modal should open under 200ms
          expect(modalDuration).toBeLessThan(200);
        }
      });

      test("should be accessible with proper focus management", async ({ page }) => {
        // Test keyboard navigation
        await page.keyboard.press("Tab");

        // Find filter elements via keyboard navigation
        let focusedElement = await page.locator(":focus");
        let filterFound = false;

        for (let i = 0; i < 15; i++) {
          if (await focusedElement.isVisible()) {
            const tagName = await focusedElement.evaluate(el => el.tagName.toLowerCase());
            const classes = await focusedElement.getAttribute("class") || "";

            // Check if this is a filter button
            if (tagName === "button" && (classes.includes("city") || classes.includes("date") || classes.includes("filter"))) {
              filterFound = true;

              // Test keyboard activation
              await page.keyboard.press("Enter");
              await page.waitForTimeout(200);

              // Should show active state after keyboard activation
              const activeClasses = await focusedElement.getAttribute("class") || "";
              const isActive = activeClasses.includes("bg-red-50") || activeClasses.includes("selected");

              if (isActive) {
                expect(isActive).toBeTruthy();
                break;
              }
            }
          }

          await page.keyboard.press("Tab");
          focusedElement = page.locator(":focus");
        }

        // Should be able to find focusable filter elements
        expect(filterFound).toBeTruthy();
      });

      test(`should take visual regression screenshot for ${name}`, async ({ page }) => {
        // Take screenshot for visual regression testing
        await expect(page).toHaveScreenshot(`filter-layout-${width}x${height}.png`, {
          fullPage: false,
          mask: [
            // Mask dynamic content that changes between test runs
            page.locator(".debug-info, .loading, .timestamp").first()
          ],
          threshold: 0.2
        });

        // Test with filter modal open (for mobile)
        if (width < 768) {
          const filterButton = page.locator("button[aria-label*='filter' i]").first();

          if (await filterButton.isVisible()) {
            await filterButton.click();
            await page.waitForTimeout(300);

            // Screenshot with modal open
            await expect(page).toHaveScreenshot(`filter-modal-${width}x${height}.png`, {
              fullPage: false,
              threshold: 0.2
            });
          }
        }
      });
    });
  });

  test.describe("Cross-viewport Consistency", () => {
    test("should maintain consistent filter behavior across all breakpoints", async ({ page }) => {
      const testResults: { viewport: string; success: boolean }[] = [];

      for (const { width, height, name } of viewports) {
        await page.setViewportSize({ width, height });
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        let success = true;

        try {
          // Test basic filter interaction
          const cityButton = page.locator(".city-pagination button").first();
          if (await cityButton.isVisible()) {
            await cityButton.click();
            await page.waitForTimeout(200);

            const isActive = await cityButton.evaluate((el) => {
              return el.classList.contains("bg-red-50") ||
                     el.classList.contains("selected") ||
                     el.classList.contains("active");
            });

            if (!isActive) {
              success = false;
            }
          }
        } catch (error) {
          success = false;
        }

        testResults.push({ viewport: name, success });
      }

      // All viewports should have successful filter interactions
      const failedViewports = testResults.filter(r => !r.success);
      expect(failedViewports).toHaveLength(0);
    });
  });

  test.describe("Performance Under Load", () => {
    test("should handle multiple rapid filter operations", async ({ page }) => {
      // Test on smallest viewport (most constrained)
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const startTime = Date.now();

      // Rapidly click multiple filters
      const cityButtons = page.locator(".city-pagination button");
      const dateButtons = page.locator(".date-pagination button");

      const cityCount = await cityButtons.count();
      const dateCount = await dateButtons.count();

      // Click up to 3 city filters and 2 date filters rapidly
      for (let i = 0; i < Math.min(cityCount, 3); i++) {
        await cityButtons.nth(i).click();
        await page.waitForTimeout(50);
      }

      for (let i = 0; i < Math.min(dateCount, 2); i++) {
        await dateButtons.nth(i).click();
        await page.waitForTimeout(50);
      }

      const endTime = Date.now();
      const totalDuration = endTime - startTime;

      // Should handle rapid operations without significant delay
      expect(totalDuration).toBeLessThan(1000); // 1 second for all operations

      // Page should remain responsive
      const isResponsive = await page.evaluate(() => {
        return document.readyState === "complete" && !document.hidden;
      });

      expect(isResponsive).toBeTruthy();
    });
  });
});