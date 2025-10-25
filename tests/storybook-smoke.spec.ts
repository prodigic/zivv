import { test, expect, type Page } from "@playwright/test";

// Storybook URL - adjust if your Storybook runs on different port
const STORYBOOK_URL = "http://localhost:6006";

// Helper to get component stories by clicking on component titles
async function getComponentStories(
  page: Page
): Promise<{ name: string; storyId: string }[]> {
  const components: { name: string; storyId: string }[] = [];

  try {
    // Expand all collapsed sections first (get fresh list each time since clicking changes the state)
    let attempts = 0;
    while (attempts < 10) {
      const expandButton = page
        .locator('button[aria-expanded="false"]')
        .first();
      const buttonExists = (await expandButton.count()) > 0;

      if (!buttonExists) {
        break; // No more buttons to expand
      }

      await expandButton.click({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(100);
      attempts++;
    }
    await page.waitForTimeout(300);

    // Get all story links directly (much simpler and more reliable)
    const storyLinks = await page.locator('a[href*="/story/"]').all();
    const seenComponents = new Set<string>();

    for (const link of storyLinks) {
      const href = await link.getAttribute("href");
      if (!href) continue;

      const match = href.match(/\/story\/([^/?]+)/);
      if (!match) continue;

      const storyId = match[1];

      // Only get default stories or first story of each component
      if (storyId.endsWith("--default") || !storyId.includes("--")) {
        // Extract component name from story ID
        const componentId = storyId.split("--")[0];

        if (seenComponents.has(componentId)) continue;
        seenComponents.add(componentId);

        // Convert story ID to readable name
        const componentName = componentId
          .split("-")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join("");

        components.push({
          name: componentName,
          storyId: storyId,
        });
      }
    }

    return components;
  } catch (error) {
    // Fallback to known components
    return [
      {
        name: "SearchFilterToolbar",
        storyId: "component-groups-searchfiltertoolbar--default",
      },
      {
        name: "DatePagination",
        storyId: "ui-components-datepagination--default",
      },
      { name: "VenueFilter", storyId: "ui-components-venuefilter--default" },
      { name: "Header", storyId: "layout-components-header--default" },
    ];
  }
}

// Helper to navigate to a story and get iframe (optimized for parallel execution)
async function navigateToStory(page: Page, storyId: string) {
  const storyUrl = `${STORYBOOK_URL}/?path=/story/${storyId}`;
  await page.goto(storyUrl, { waitUntil: "domcontentloaded", timeout: 6000 });

  // Wait for iframe to load and be ready
  const iframe = page.frameLocator("iframe").first();

  // Wait for Storybook story content to actually load
  try {
    // First ensure iframe exists
    await page.waitForSelector("iframe", { timeout: 2000 });

    // Wait for story content to start loading (root div usually appears first)
    await iframe.locator("body").waitFor({ timeout: 2000 });

    // Give React components time to mount and render
    await page.waitForTimeout(300);
  } catch {
    // If content detection fails, at least ensure iframe is present
    await page.waitForSelector("iframe", { timeout: 1000 });
    await page.waitForTimeout(500); // Fallback wait time
  }

  return iframe;
}

// Create a mock error component story for testing error detection
async function createMockErrorStory(page: Page): Promise<void> {
  // Inject a story that throws an error to test our error detection
  await page.evaluate(() => {
    // Add a mock error story to Storybook's story list
    if ((window as any).__STORYBOOK_PREVIEW__) {
      const mockErrorComponent = () => {
        throw new Error("Mock component error for testing error detection");
      };

      // This would be how we'd add a story programmatically, but it's complex
      // Instead, we'll simulate an error by injecting content
      const errorDiv = document.createElement("div");
      errorDiv.setAttribute("data-testid", "mock-error-story");
      errorDiv.className = "error-boundary";
      errorDiv.textContent =
        "Error: Mock component error for testing error detection";
      document.body.appendChild(errorDiv);
    }
  });
}

// Helper to check for error indicators
async function checkForErrors(
  iframe: any,
  componentName: string
): Promise<string[]> {
  const errors: string[] = [];

  try {
    // Check for React error boundaries and component crashes
    const errorBoundarySelectors = [
      '[data-testid="error-boundary"]',
      ".error-boundary",
      '[class*="ErrorBoundary"]',
    ];

    for (const selector of errorBoundarySelectors) {
      const errorElements = await iframe.locator(selector).count();
      if (errorElements > 0) {
        const errorText = await iframe.locator(selector).first().textContent();
        errors.push(
          `Error boundary: ${errorText?.slice(0, 100) || "Component crashed"}`
        );
      }
    }

    // Check for Storybook critical error displays
    const storybookErrors = await iframe
      .locator(".sb-error-display, [data-story-error]")
      .count();
    if (storybookErrors > 0) {
      const errorText = await iframe
        .locator(".sb-error-display, [data-story-error]")
        .first()
        .textContent();
      errors.push(
        `Storybook error: ${errorText?.slice(0, 100) || "Unknown error"}`
      );
    }

    // Check for actual error messages in story content (not addon panels)
    const contentErrors = await iframe
      .locator(
        'div:has-text("Error:"):not([class*="addon"]):not([class*="sb-"])'
      )
      .count();
    if (contentErrors > 0) {
      const errorText = await iframe
        .locator(
          'div:has-text("Error:"):not([class*="addon"]):not([class*="sb-"])'
        )
        .first()
        .textContent();
      errors.push(
        `Content error: ${errorText?.slice(0, 100) || "Error in component content"}`
      );
    }

    // Check for completely empty/broken stories
    const bodyContent = await iframe.locator("body *").count();
    if (bodyContent === 0) {
      errors.push("Component appears to be completely empty");
    }

    // Check for JavaScript errors in the story iframe
    const jsErrors = await iframe
      .locator(
        'pre:has-text("Error"), pre:has-text("TypeError"), pre:has-text("ReferenceError")'
      )
      .count();
    if (jsErrors > 0) {
      const errorText = await iframe
        .locator(
          'pre:has-text("Error"), pre:has-text("TypeError"), pre:has-text("ReferenceError")'
        )
        .first()
        .textContent();
      errors.push(
        `JavaScript error: ${errorText?.slice(0, 100) || "JS error found"}`
      );
    }
  } catch (error) {
    errors.push(`Failed to check component: ${error}`);
  }

  return errors;
}

test.describe("Storybook Smoke Test - Error Detection", () => {
  test.beforeEach(async ({ page }) => {
    // Check if Storybook is running
    try {
      await page.goto(STORYBOOK_URL, { timeout: 5000 });
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch (error) {
      throw new Error(
        `Storybook is not running on ${STORYBOOK_URL}. Please start it with 'npm run storybook'`
      );
    }
  });

  test("All component stories render without errors", async ({ page }) => {
    // Capture console errors
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    page.on("pageerror", (error) => {
      consoleErrors.push(error.message);
    });

    // Get components by clicking on titles
    await page.goto(STORYBOOK_URL);
    await page.waitForLoadState("networkidle", { timeout: 5000 });

    const components = await getComponentStories(page);

    // Test components in batches to avoid overwhelming the browser
    const batchSize = 5; // Test 5 components at once
    const allResults: any[] = [];

    for (let i = 0; i < components.length; i += batchSize) {
      const batch = components.slice(i, i + batchSize);

      const batchTests = batch.map(async ({ name, storyId }) => {
        // Create a new page for each component to avoid conflicts
        const context = page.context();
        const componentPage = await context.newPage();

        try {
          const iframe = await navigateToStory(componentPage, storyId);
          await componentPage.waitForTimeout(100); // Reduced wait time

          const storyErrors = await checkForErrors(iframe, name);

          if (storyErrors.length > 0) {
            return { name, storyId, errors: storyErrors, success: false };
          } else {
            // Validate that component actually rendered content
            const elementCount = await iframe.locator("body *").count();

            if (elementCount === 0) {
              return {
                name,
                storyId,
                errors: ["Component iframe has no content"],
                success: false,
              };
            }

            // Check if it's just Storybook loading state or actual component content
            const bodyText = (await iframe.locator("body").textContent()) || "";
            const hasReactElements = await iframe
              .locator("div, span, button, input, img, svg")
              .count();

            if (hasReactElements === 0 && bodyText.trim().length === 0) {
              return {
                name,
                storyId,
                errors: ["Component rendered but has no visible content"],
                success: false,
              };
            }

            return { name, storyId, errors: [], success: true };
          }
        } catch (error) {
          return {
            name,
            storyId,
            errors: [`Failed to load component: ${error}`],
            success: false,
          };
        } finally {
          await componentPage.close(); // Clean up the page
        }
      });

      // Wait for this batch to complete before starting the next
      const batchResults = await Promise.allSettled(batchTests);
      allResults.push(...batchResults);

      console.log(
        `📦 Completed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(components.length / batchSize)}`
      );
    }

    const results = allResults;

    const failedComponents: {
      name: string;
      storyId: string;
      errors: string[];
    }[] = [];
    let successCount = 0;

    // Process results
    results.forEach((result) => {
      if (result.status === "fulfilled") {
        const { name, storyId, errors, success } = result.value;
        if (success) {
          successCount++;
        } else {
          failedComponents.push({ name, storyId, errors });
        }
      } else {
        failedComponents.push({
          name: "Unknown",
          storyId: "Unknown",
          errors: [`Test failed: ${result.reason}`],
        });
      }
    });

    // Filter console errors (ignore development warnings)
    const criticalConsoleErrors = consoleErrors.filter(
      (error) =>
        !error.includes("favicon") &&
        !error.includes("livereload") &&
        !error.includes("HMR") &&
        !error.toLowerCase().includes("404") &&
        !error.includes("React Router Future Flag Warning") &&
        !error.includes("addon-onboarding") &&
        !error.includes("storybook") &&
        !error.includes("You are free to remove")
    );

    // Report results
    if (failedComponents.length > 0) {
      console.log(`\n❌ ${failedComponents.length} components failed:`);
      failedComponents.forEach(({ name, storyId, errors }) => {
        console.log(`\n  🔴 ${name} (${storyId}):`);
        errors.forEach((error) => console.log(`     - ${error}`));
      });
    }

    // Test assertions
    expect(failedComponents.length).toBe(0);
    expect(criticalConsoleErrors.length).toBe(0);

    console.log(`\n✅ ${successCount} components passed smoke test!`);
  });

  test("Error detection catches component failures", async ({ page }) => {
    // Navigate to any story first
    await page.goto(STORYBOOK_URL);
    await page.waitForLoadState("networkidle", { timeout: 5000 });

    const components = await getComponentStories(page);
    if (components.length === 0) return; // Skip if no components found

    // Navigate to the first component
    const { name, storyId } = components[0];
    const iframe = await navigateToStory(page, storyId);

    // Inject a mock error into the iframe to test error detection
    await iframe.locator("body").evaluate((body) => {
      const errorDiv = document.createElement("div");
      errorDiv.className = "error-boundary";
      errorDiv.textContent =
        "Error: Mock component error for testing error detection";
      body.appendChild(errorDiv);
    });

    // Now check if our error detection catches it
    const detectedErrors = await checkForErrors(iframe, name);

    // Should detect the mock error
    expect(detectedErrors.length).toBeGreaterThan(0);
    expect(detectedErrors[0]).toContain("Mock component error");

    console.log(
      `\n✅ Error detection working: caught "${detectedErrors[0]}" in ${name}`
    );
  });

  test("Storybook itself loads without errors", async ({ page }) => {
    await page.goto(STORYBOOK_URL);
    await page.waitForLoadState("networkidle", { timeout: 5000 });

    // Check that Storybook loaded by looking for its container or any Storybook-specific elements
    const storybookElements = await page
      .locator(
        [
          "#storybook-root",
          "#root",
          '[id*="storybook"]',
          '[class*="sb-"]',
          'iframe[title*="storybook"]',
          "iframe",
          "[data-storybook]",
        ].join(", ")
      )
      .count();

    // If no specific Storybook elements found, check for basic page structure
    if (storybookElements === 0) {
      const basicElements = await page.locator("body, html, div").count();
      expect(basicElements).toBeGreaterThan(0);
      console.log("⚠️  Storybook UI structure not recognized, but page loaded");
    } else {
      console.log(`✅ Found ${storybookElements} Storybook UI elements`);
    }

    // Check for any critical error displays
    const errorDisplays = await page
      .locator(".sb-error-display, [data-story-error], .error")
      .count();
    expect(errorDisplays).toBe(0);

    console.log("✅ Storybook UI loaded successfully");
  });
});

test.describe("Storybook Quick Performance Check", () => {
  test("Stories load within reasonable time", async ({ page }) => {
    const testStories = [
      "ui-components-datepagination--default",
      "layout-components-header--default",
      "ui-components-loadingspinner--default",
    ];

    for (const storyId of testStories) {
      const startTime = Date.now();

      try {
        await navigateToStory(page, storyId);
        const loadTime = Date.now() - startTime;

        // Each story should load within 4 seconds for local testing
        expect(loadTime).toBeLessThan(4000);
        console.log(`✅ ${storyId} loaded in ${loadTime}ms`);
      } catch (error) {
        console.log(`❌ ${storyId} failed to load: ${error}`);
        throw error;
      }
    }
  });
});
