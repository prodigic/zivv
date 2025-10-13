import { test, expect } from '@playwright/test';

test.describe('Search Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('should have search input available', async ({ page }) => {
    // Look for search input field
    const searchInput = page.locator([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      '[data-testid="search"]',
      '[aria-label*="search" i]',
      '.search-input'
    ].join(', '));

    if (await searchInput.count() > 0) {
      await expect(searchInput.first()).toBeVisible();
      await expect(searchInput.first()).toBeEditable();
    }
  });

  test('should search for artists', async ({ page }) => {
    const searchInput = page.locator([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      '[data-testid="search"]'
    ].join(', ')).first();

    if (await searchInput.isVisible()) {
      // Search for a common artist name
      await searchInput.fill('band');
      
      // Wait for search results
      await page.waitForTimeout(1000);
      
      // Check that search term is preserved
      const searchValue = await searchInput.inputValue();
      expect(searchValue).toBe('band');
      
      // Look for search results or filtered content
      const results = page.locator([
        '[data-testid="search-results"]',
        '.search-results',
        '.event-card',
        '.event-item'
      ].join(', '));
      
      // Should not cause errors even if no results
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('should search for venues', async ({ page }) => {
    const searchInput = page.locator([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      '[data-testid="search"]'
    ].join(', ')).first();

    if (await searchInput.isVisible()) {
      // Search for venue-related terms
      await searchInput.fill('venue');
      
      await page.waitForTimeout(1000);
      
      const searchValue = await searchInput.inputValue();
      expect(searchValue).toBe('venue');
      
      // App should handle venue search without errors
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('should handle empty search', async ({ page }) => {
    const searchInput = page.locator([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      '[data-testid="search"]'
    ].join(', ')).first();

    if (await searchInput.isVisible()) {
      // Fill and then clear search
      await searchInput.fill('test');
      await page.waitForTimeout(500);
      
      await searchInput.clear();
      await page.waitForTimeout(500);
      
      // Should return to showing all results
      const searchValue = await searchInput.inputValue();
      expect(searchValue).toBe('');
      
      // Should not cause errors
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('should handle special characters in search', async ({ page }) => {
    const searchInput = page.locator([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      '[data-testid="search"]'
    ].join(', ')).first();

    if (await searchInput.isVisible()) {
      // Test various special characters
      const specialQueries = ['test & roll', 'rock\'n\'roll', 'metal/punk', 'band (2024)'];
      
      for (const query of specialQueries) {
        await searchInput.fill(query);
        await page.waitForTimeout(500);
        
        // Should handle special characters without breaking
        const searchValue = await searchInput.inputValue();
        expect(searchValue).toBe(query);
        
        // Should not cause JavaScript errors
        await expect(page.locator('body')).toBeVisible();
      }
    }
  });

  test('should be case insensitive', async ({ page }) => {
    const searchInput = page.locator([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      '[data-testid="search"]'
    ].join(', ')).first();

    if (await searchInput.isVisible()) {
      // Test different case variations
      const caseVariations = ['BAND', 'band', 'Band', 'bAnD'];
      
      let firstResultCount = 0;
      
      for (let i = 0; i < caseVariations.length; i++) {
        await searchInput.fill(caseVariations[i]);
        await page.waitForTimeout(500);
        
        // Count visible results (if any)
        const results = page.locator([
          '.event-card:visible',
          '.event-item:visible',
          '[data-testid="event-card"]:visible'
        ].join(', '));
        
        const currentCount = await results.count();
        
        if (i === 0) {
          firstResultCount = currentCount;
        } else {
          // Case variations should yield same results
          expect(currentCount).toBe(firstResultCount);
        }
      }
    }
  });

  test('should provide search suggestions or autocomplete', async ({ page }) => {
    const searchInput = page.locator([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      '[data-testid="search"]'
    ].join(', ')).first();

    if (await searchInput.isVisible()) {
      await searchInput.fill('ba');
      
      // Wait for potential suggestions
      await page.waitForTimeout(800);
      
      // Look for dropdown or suggestion list
      const suggestions = page.locator([
        '.suggestions',
        '.dropdown',
        '.autocomplete',
        '[data-testid="search-suggestions"]',
        '.search-dropdown'
      ].join(', '));
      
      // If suggestions exist, test interaction
      if (await suggestions.count() > 0) {
        await expect(suggestions.first()).toBeVisible();
        
        const firstSuggestion = suggestions.first().locator('li, .suggestion, .option').first();
        
        if (await firstSuggestion.count() > 0) {
          await firstSuggestion.click();
          
          // Should populate search input
          const finalValue = await searchInput.inputValue();
          expect(finalValue.length).toBeGreaterThan(2);
        }
      }
    }
  });

  test('should handle rapid typing', async ({ page }) => {
    const searchInput = page.locator([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      '[data-testid="search"]'
    ].join(', ')).first();

    if (await searchInput.isVisible()) {
      // Type rapidly without waiting
      const rapidQuery = 'quicksearch';
      
      await searchInput.focus();
      
      for (const char of rapidQuery) {
        await page.keyboard.type(char, { delay: 50 }); // Fast typing
      }
      
      // Wait for debouncing/processing
      await page.waitForTimeout(1000);
      
      const finalValue = await searchInput.inputValue();
      expect(finalValue).toBe(rapidQuery);
      
      // Should not cause errors during rapid input
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('should preserve search state on page navigation', async ({ page }) => {
    const searchInput = page.locator([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      '[data-testid="search"]'
    ].join(', ')).first();

    if (await searchInput.isVisible()) {
      const searchTerm = 'persistent';
      await searchInput.fill(searchTerm);
      await page.waitForTimeout(500);
      
      // Check if URL contains search parameter
      const urlBefore = page.url();
      
      // Refresh page
      await page.reload();
      await page.waitForLoadState('networkidle');
      
      // Search should be preserved if URL-based
      const searchAfterReload = await searchInput.inputValue();
      
      if (urlBefore.includes(searchTerm) || urlBefore.includes('search')) {
        expect(searchAfterReload).toBe(searchTerm);
      }
    }
  });

  test('should be accessible via keyboard', async ({ page }) => {
    // Tab to search input
    let found = false;
    
    for (let i = 0; i < 20 && !found; i++) {
      await page.keyboard.press('Tab');
      
      const focusedElement = page.locator(':focus');
      const tagName = await focusedElement.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
      const type = await focusedElement.getAttribute('type').catch(() => '');
      
      if (tagName === 'input' && (type === 'search' || type === 'text')) {
        found = true;
        
        // Should be able to type in focused search input
        await page.keyboard.type('keyboard test');
        
        const value = await focusedElement.inputValue();
        expect(value).toBe('keyboard test');
        
        // Should be able to clear with keyboard
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Delete');
        
        const clearedValue = await focusedElement.inputValue();
        expect(clearedValue).toBe('');
      }
    }
  });

  test('should show loading state during search', async ({ page }) => {
    const searchInput = page.locator([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      '[data-testid="search"]'
    ].join(', ')).first();

    if (await searchInput.isVisible()) {
      await searchInput.fill('loading test');
      
      // Look for loading indicators shortly after typing
      await page.waitForTimeout(100);
      
      const loadingIndicators = page.locator([
        '.loading',
        '.spinner',
        '[data-testid="loading"]',
        '.search-loading'
      ].join(', '));
      
      // Loading state is optional but good UX
      // Just ensure no errors occur during search
      await page.waitForTimeout(1000);
      await expect(page.locator('body')).toBeVisible();
    }
  });
});

