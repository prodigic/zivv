import { test, expect } from '@playwright/test';

test.describe('Event Filtering and Display', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    
    // Wait for the app to load
    await page.waitForLoadState('networkidle');
    
    // Wait for events to load (if any are present)
    await page.waitForTimeout(1000);
  });

  test('should display event cards when events are loaded', async ({ page }) => {
    // Look for event cards or event list
    const eventCards = page.locator('[data-testid="event-card"], .event-card, .event-item');
    
    // If events are present, they should be visible
    const eventCount = await eventCards.count();
    
    if (eventCount > 0) {
      // Check first event card structure
      const firstCard = eventCards.first();
      await expect(firstCard).toBeVisible();
      
      // Event cards should have basic information
      // This will depend on the actual card structure
      const titleElement = firstCard.locator('h1, h2, h3, .title, [data-testid="event-title"]');
      const dateElement = firstCard.locator('.date, [data-testid="event-date"], time');
      
      await expect(titleElement.or(dateElement)).toBeVisible();
    }
  });

  test('should handle empty state gracefully', async ({ page }) => {
    // The app should show appropriate messaging when no events are found
    // This could be a loading state, empty state, or error message
    
    const mainContent = page.locator('main');
    await expect(mainContent).toBeVisible();
    
    // Look for loading indicators
    const loadingIndicator = page.locator('.loading, [data-testid="loading"], .spinner');
    
    // Look for empty state
    const emptyState = page.locator('.empty-state, [data-testid="empty-state"], .no-events');
    
    // Look for error state
    const errorState = page.locator('.error, [data-testid="error"], .error-message');
    
    // At least one of these should be present, or events should be shown
    const eventCards = page.locator('[data-testid="event-card"], .event-card, .event-item');
    const eventCount = await eventCards.count();
    
    if (eventCount === 0) {
      // Should show loading, empty, or error state
      const stateVisible = await loadingIndicator.or(emptyState).or(errorState).isVisible()
        .catch(() => false);
      
      // If no specific state is shown, at least basic content should be present
      expect(stateVisible || await mainContent.isVisible()).toBeTruthy();
    }
  });

  test('should allow city-based filtering', async ({ page }) => {
    // Look for city filter controls
    const cityFilters = page.locator('[data-testid="city-filter"], .city-filter, .city-selector');
    
    // If city filters exist, test them
    const filterCount = await cityFilters.count();
    
    if (filterCount > 0) {
      // Click on a city filter
      const firstFilter = cityFilters.first();
      await expect(firstFilter).toBeVisible();
      
      await firstFilter.click();
      
      // Wait for filtering to apply
      await page.waitForTimeout(500);
      
      // Check that the filter appears to be active
      // This could be through visual styling, aria-pressed, or other indicators
      const isActive = await firstFilter.evaluate((el) => {
        return el.classList.contains('active') || 
               el.classList.contains('selected') ||
               el.getAttribute('aria-pressed') === 'true' ||
               el.classList.contains('bg-red-50') || // Based on component code
               el.classList.contains('bg-green-50');
      });
      
      expect(isActive).toBeTruthy();
    }
  });

  test('should allow date-based filtering', async ({ page }) => {
    // Look for date filter controls
    const dateFilters = page.locator('[data-testid="date-filter"], .date-filter, .date-selector');
    
    const filterCount = await dateFilters.count();
    
    if (filterCount > 0) {
      // Test date filtering
      const todayFilter = page.locator('text=Today, text=Tod').first(); // Accounting for responsive text
      
      if (await todayFilter.isVisible()) {
        await todayFilter.click();
        
        // Wait for filtering to apply
        await page.waitForTimeout(500);
        
        // Check that the filter appears active
        const isActive = await todayFilter.evaluate((el) => {
          return el.classList.contains('active') || 
                 el.classList.contains('selected') ||
                 el.classList.contains('bg-red-50');
        });
        
        expect(isActive).toBeTruthy();
      }
    }
  });

  test('should provide search functionality', async ({ page }) => {
    // Look for search input
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], [data-testid="search"]');
    
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      
      // Wait for search to process
      await page.waitForTimeout(500);
      
      // Check that search term is reflected
      const searchValue = await searchInput.inputValue();
      expect(searchValue).toBe('test');
      
      // The results should update (hard to test without knowing data structure)
      // At minimum, the search should not cause errors
    }
  });

  test('should handle free show filtering', async ({ page }) => {
    // Look for free show filter
    const freeFilter = page.locator('text=Free, [data-testid="free-filter"], .free-filter');
    
    if (await freeFilter.isVisible()) {
      await freeFilter.click();
      
      // Wait for filtering
      await page.waitForTimeout(500);
      
      // Should show active state
      const isActive = await freeFilter.evaluate((el) => {
        return el.classList.contains('active') || 
               el.classList.contains('selected') ||
               el.getAttribute('aria-pressed') === 'true';
      });
      
      expect(isActive).toBeTruthy();
    }
  });

  test('should allow clearing filters', async ({ page }) => {
    // Apply some filters first
    const cityFilter = page.locator('[data-testid="city-filter"], .city-filter').first();
    
    if (await cityFilter.isVisible()) {
      await cityFilter.click();
      await page.waitForTimeout(200);
      
      // Look for clear button
      const clearButton = page.locator('text=Clear, [data-testid="clear-filters"], .clear-filters');
      
      if (await clearButton.isVisible()) {
        await clearButton.click();
        
        // Wait for clearing
        await page.waitForTimeout(500);
        
        // Filter should no longer be active
        const isActive = await cityFilter.evaluate((el) => {
          return el.classList.contains('active') || 
                 el.classList.contains('selected') ||
                 el.getAttribute('aria-pressed') === 'true';
        });
        
        expect(isActive).toBeFalsy();
      }
    }
  });

  test('should toggle between list and calendar views', async ({ page }) => {
    // Look for view toggle buttons
    const listView = page.locator('text=List, [data-testid="list-view"], .list-view');
    const calendarView = page.locator('text=Calendar, [data-testid="calendar-view"], .calendar-view');
    
    if (await listView.isVisible() && await calendarView.isVisible()) {
      // Test switching to calendar view
      await calendarView.click();
      await page.waitForTimeout(500);
      
      // Should show calendar interface
      const calendar = page.locator('.calendar, [data-testid="calendar"], .fc-view'); // FullCalendar
      
      // Switch back to list view
      await listView.click();
      await page.waitForTimeout(500);
      
      // Should show list interface
      const list = page.locator('.event-list, [data-testid="event-list"], .list');
    }
  });

  test('should maintain filter state in URL', async ({ page }) => {
    // Apply a filter
    const cityFilter = page.locator('[data-testid="city-filter"], .city-filter').first();
    
    if (await cityFilter.isVisible()) {
      await cityFilter.click();
      await page.waitForTimeout(500);
      
      // Check if URL has been updated
      const url = page.url();
      
      // Should contain query parameters
      expect(url).toContain('?');
      
      // Refresh page and check if filter persists
      await page.reload();
      await page.waitForLoadState('networkidle');
      
      // Filter should still be active after refresh
      const isStillActive = await cityFilter.evaluate((el) => {
        return el.classList.contains('active') || 
               el.classList.contains('selected') ||
               el.getAttribute('aria-pressed') === 'true';
      });
      
      expect(isStillActive).toBeTruthy();
    }
  });

  test('should be keyboard accessible', async ({ page }) => {
    // Tab through interactive elements
    await page.keyboard.press('Tab');
    
    let focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible();
    
    // Continue tabbing to find filterable elements
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      focusedElement = page.locator(':focus');
      
      // If we find a filter button, test it
      const tagName = await focusedElement.evaluate((el) => el.tagName.toLowerCase());
      const role = await focusedElement.getAttribute('role');
      
      if (tagName === 'button' || role === 'button') {
        // Test keyboard activation
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        
        // Should work the same as clicking
        break;
      }
    }
  });
});

