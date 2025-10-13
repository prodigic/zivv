import { test, expect } from '@playwright/test';

test.describe('Performance Testing', () => {
  test.beforeEach(async ({ page }) => {
    // Set up performance monitoring
    await page.addInitScript(() => {
      // Mark performance measurement start
      window.performance.mark('test-start');
    });
  });

  test('should load homepage within acceptable time limits', async ({ page }) => {
    const startTime = Date.now();
    
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const endTime = Date.now();
    const loadTime = endTime - startTime;
    
    // Homepage should load within 3 seconds
    expect(loadTime).toBeLessThan(3000);
    
    // Check for performance metrics
    const performanceMetrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return {
        domContentLoaded: navigation.domContentLoadedEventEnd - navigation.navigationStart,
        loadComplete: navigation.loadEventEnd - navigation.navigationStart,
        firstPaint: performance.getEntriesByType('paint').find(p => p.name === 'first-paint')?.startTime || 0,
        firstContentfulPaint: performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint')?.startTime || 0
      };
    });
    
    // DOM Content Loaded should be under 2 seconds
    expect(performanceMetrics.domContentLoaded).toBeLessThan(2000);
    
    // First Paint should be under 1.5 seconds
    expect(performanceMetrics.firstPaint).toBeLessThan(1500);
    
    console.log('Performance Metrics:', performanceMetrics);
  });

  test('should have acceptable Core Web Vitals', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Wait for interactions and potential layout shifts
    await page.waitForTimeout(3000);
    
    const webVitals = await page.evaluate(() => {
      return new Promise((resolve) => {
        const vitals: any = {};
        
        // Largest Contentful Paint (LCP)
        new PerformanceObserver((entryList) => {
          const entries = entryList.getEntries();
          const lastEntry = entries[entries.length - 1];
          vitals.lcp = lastEntry.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        
        // First Input Delay (FID) - simulated
        vitals.fid = 0; // Will be 0 in automated tests
        
        // Cumulative Layout Shift (CLS)
        let clsValue = 0;
        new PerformanceObserver((entryList) => {
          for (const entry of entryList.getEntries()) {
            if (!(entry as any).hadRecentInput) {
              clsValue += (entry as any).value;
            }
          }
          vitals.cls = clsValue;
        }).observe({ type: 'layout-shift', buffered: true });
        
        // Give time for measurements
        setTimeout(() => resolve(vitals), 1000);
      });
    });
    
    // Core Web Vitals thresholds
    // LCP should be under 2.5 seconds
    if ((webVitals as any).lcp) {
      expect((webVitals as any).lcp).toBeLessThan(2500);
    }
    
    // CLS should be under 0.1
    if ((webVitals as any).cls !== undefined) {
      expect((webVitals as any).cls).toBeLessThan(0.1);
    }
    
    console.log('Core Web Vitals:', webVitals);
  });

  test('should handle large datasets efficiently', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Measure memory usage
    const memoryBefore = await page.evaluate(() => {
      if ('memory' in performance) {
        return (performance as any).memory;
      }
      return null;
    });
    
    // Simulate loading more data (if pagination or infinite scroll exists)
    // This will depend on the actual UI implementation
    await page.evaluate(() => {
      // Trigger any data loading operations
      window.dispatchEvent(new CustomEvent('test-load-more-data'));
    });
    
    await page.waitForTimeout(2000);
    
    const memoryAfter = await page.evaluate(() => {
      if ('memory' in performance) {
        return (performance as any).memory;
      }
      return null;
    });
    
    if (memoryBefore && memoryAfter) {
      const memoryIncrease = memoryAfter.usedJSHeapSize - memoryBefore.usedJSHeapSize;
      
      // Memory increase should be reasonable (under 50MB for additional data)
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
      
      console.log('Memory Usage:', {
        before: memoryBefore.usedJSHeapSize,
        after: memoryAfter.usedJSHeapSize,
        increase: memoryIncrease
      });
    }
  });

  test('should render events efficiently', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Measure rendering performance
    const renderingMetrics = await page.evaluate(() => {
      const start = performance.now();
      
      // Force a reflow/repaint
      document.body.offsetHeight;
      
      const end = performance.now();
      
      return {
        renderTime: end - start,
        eventCards: document.querySelectorAll('.event-card, .event-item, [data-testid="event-card"]').length,
        totalElements: document.querySelectorAll('*').length
      };
    });
    
    // Rendering should be fast
    expect(renderingMetrics.renderTime).toBeLessThan(100);
    
    // Should efficiently handle DOM complexity
    if (renderingMetrics.eventCards > 0) {
      const elementsPerEvent = renderingMetrics.totalElements / renderingMetrics.eventCards;
      // Each event card should not create excessive DOM nodes
      expect(elementsPerEvent).toBeLessThan(200);
    }
    
    console.log('Rendering Metrics:', renderingMetrics);
  });

  test('should handle filter operations efficiently', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Find filter controls
    const cityFilter = page.locator('[data-testid="city-filter"], .city-filter').first();
    
    if (await cityFilter.isVisible()) {
      const filterStart = Date.now();
      
      await cityFilter.click();
      
      // Wait for filter to apply
      await page.waitForTimeout(100);
      
      const filterEnd = Date.now();
      const filterTime = filterEnd - filterStart;
      
      // Filtering should be responsive (under 300ms)
      expect(filterTime).toBeLessThan(300);
      
      // Measure filter responsiveness with rapid clicks
      const rapidFilterStart = Date.now();
      
      for (let i = 0; i < 5; i++) {
        await cityFilter.click();
        await page.waitForTimeout(50);
      }
      
      const rapidFilterEnd = Date.now();
      const rapidFilterTime = rapidFilterEnd - rapidFilterStart;
      
      // Rapid filtering should still be performant
      expect(rapidFilterTime).toBeLessThan(1000);
      
      console.log('Filter Performance:', {
        singleFilter: filterTime,
        rapidFiltering: rapidFilterTime
      });
    }
  });

  test('should handle search operations efficiently', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i]').first();
    
    if (await searchInput.isVisible()) {
      const searchStart = Date.now();
      
      await searchInput.fill('performance test');
      
      // Wait for search to process
      await page.waitForTimeout(300);
      
      const searchEnd = Date.now();
      const searchTime = searchEnd - searchStart;
      
      // Search should be responsive
      expect(searchTime).toBeLessThan(500);
      
      // Test incremental search performance
      await searchInput.clear();
      
      const incrementalStart = Date.now();
      const searchTerm = 'incremental';
      
      for (let i = 1; i <= searchTerm.length; i++) {
        await searchInput.fill(searchTerm.substring(0, i));
        await page.waitForTimeout(50);
      }
      
      const incrementalEnd = Date.now();
      const incrementalTime = incrementalEnd - incrementalStart;
      
      // Incremental search should remain fast
      expect(incrementalTime).toBeLessThan(1000);
      
      console.log('Search Performance:', {
        fullSearch: searchTime,
        incrementalSearch: incrementalTime
      });
    }
  });

  test('should maintain performance on mobile devices', async ({ page, browserName }) => {
    // Simulate mobile performance constraints
    const client = await page.context().newCDPSession(page);
    
    // Throttle CPU to simulate slower mobile device
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    
    const mobileLoadStart = Date.now();
    
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const mobileLoadEnd = Date.now();
    const mobileLoadTime = mobileLoadEnd - mobileLoadStart;
    
    // Should load reasonably fast even on slower mobile device
    expect(mobileLoadTime).toBeLessThan(5000);
    
    // Test mobile interaction performance
    const mobileFilter = page.locator('[data-testid="city-filter"], .city-filter').first();
    
    if (await mobileFilter.isVisible()) {
      const mobileInteractionStart = Date.now();
      
      await mobileFilter.tap(); // Use tap for mobile
      await page.waitForTimeout(200);
      
      const mobileInteractionEnd = Date.now();
      const mobileInteractionTime = mobileInteractionEnd - mobileInteractionStart;
      
      // Mobile interactions should still be responsive
      expect(mobileInteractionTime).toBeLessThan(400);
      
      console.log('Mobile Performance:', {
        loadTime: mobileLoadTime,
        interactionTime: mobileInteractionTime
      });
    }
    
    // Restore normal CPU
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });

  test('should have minimal bundle size impact', async ({ page }) => {
    // Monitor network requests
    const networkRequests: { url: string; size: number; type: string }[] = [];
    
    page.on('response', async (response) => {
      const url = response.url();
      const headers = response.headers();
      const size = parseInt(headers['content-length'] || '0');
      
      if (url.includes('localhost') && !url.includes('favicon')) {
        networkRequests.push({
          url,
          size,
          type: response.request().resourceType()
        });
      }
    });
    
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Calculate total bundle size
    const jsSize = networkRequests
      .filter(req => req.type === 'script')
      .reduce((total, req) => total + req.size, 0);
    
    const cssSize = networkRequests
      .filter(req => req.type === 'stylesheet')
      .reduce((total, req) => total + req.size, 0);
    
    // JavaScript bundle should be reasonable (under 2MB total)
    expect(jsSize).toBeLessThan(2 * 1024 * 1024);
    
    // CSS should be minimal (under 500KB)
    expect(cssSize).toBeLessThan(500 * 1024);
    
    console.log('Bundle Sizes:', {
      javascript: `${(jsSize / 1024).toFixed(2)} KB`,
      css: `${(cssSize / 1024).toFixed(2)} KB`,
      total: `${((jsSize + cssSize) / 1024).toFixed(2)} KB`,
      requests: networkRequests.length
    });
  });
});

