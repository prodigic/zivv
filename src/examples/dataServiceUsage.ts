/**
 * Example usage of Phase 3 data layer components
 * Demonstrates how to integrate DataService, caching, workers, and error handling
 */

import { 
  DataService,
  LoadingStateManager,
  globalErrorHandler,
  createAsyncState,
  withErrorHandling,
  withRetry,
} from "../services/index.js";
import type { Event, Artist, Venue, AsyncState } from "../types/frontend.js";

/**
 * Example application class demonstrating Phase 3 integration
 */
export class ExampleApp {
  private dataService: DataService;
  private loadingManager: LoadingStateManager;
  private eventState: AsyncState<Event[]> = createAsyncState([]);
  private artistState: AsyncState<Artist[]> = createAsyncState([]);
  private venueState: AsyncState<Venue[]> = createAsyncState([]);

  constructor() {
    // Initialize data service with configuration
    this.dataService = new DataService({
      baseUrl: "/data",
      cacheName: "zivv-app-cache",
      maxCacheSize: 50 * 1024 * 1024, // 50MB
      maxCacheAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      retryAttempts: 3,
      retryDelay: 1000,
    });

    // Initialize loading state manager
    this.loadingManager = new LoadingStateManager();

    // Initialize global error handling
    globalErrorHandler.initialize();

    // Set up loading state subscriptions
    this.setupLoadingSubscriptions();
  }

  /**
   * Initialize the application data layer
   */
  async initialize(): Promise<void> {
    console.log("🚀 Initializing application...");

    try {
      // Initialize data service with error handling and retry logic
      await withRetry(
        () => this.dataService.initialize(),
        {
          maxAttempts: 3,
          delay: 1000,
          onRetry: (error, attempt) => {
            console.warn(`Initialization attempt ${attempt} failed:`, error);
          },
        }
      );

      console.log("✅ Application initialized successfully");

      // Load initial data
      await this.loadInitialData();

    } catch (error) {
      globalErrorHandler.handleError(error as Error, {
        operation: "app_initialization",
      });
      throw error;
    }
  }

  /**
   * Load initial application data
   */
  private async loadInitialData(): Promise<void> {
    console.log("📊 Loading initial data...");

    // Load core data in parallel with loading state management
    const operations = [
      this.loadArtists(),
      this.loadVenues(),
      this.loadRecentEvents(),
    ];

    try {
      await Promise.all(operations);
      console.log("✅ Initial data loaded successfully");
    } catch (error) {
      console.error("❌ Failed to load initial data:", error);
      throw error;
    }
  }

  /**
   * Load artists with error handling
   */
  async loadArtists(): Promise<void> {
    const operation = async () => {
      this.loadingManager.setLoading("artists");
      
      try {
        const artists = await this.dataService.loadArtists();
        this.artistState = {
          data: artists,
          loading: false,
          error: null,
          lastUpdated: Date.now(),
        };
        
        this.loadingManager.setSuccess("artists");
        console.log(`📚 Loaded ${artists.length} artists`);
        
      } catch (error) {
        this.artistState = {
          ...this.artistState,
          loading: false,
          error: error instanceof Error ? error.message : "Failed to load artists",
        };
        
        this.loadingManager.setError("artists");
        throw error;
      }
    };

    await withErrorHandling(operation, (error) => {
      globalErrorHandler.handleError(error, { operation: "load_artists" });
    });
  }

  /**
   * Load venues with error handling
   */
  async loadVenues(): Promise<void> {
    const operation = async () => {
      this.loadingManager.setLoading("venues");
      
      try {
        const venues = await this.dataService.loadVenues();
        this.venueState = {
          data: venues,
          loading: false,
          error: null,
          lastUpdated: Date.now(),
        };
        
        this.loadingManager.setSuccess("venues");
        console.log(`🏛️ Loaded ${venues.length} venues`);
        
      } catch (error) {
        this.venueState = {
          ...this.venueState,
          loading: false,
          error: error instanceof Error ? error.message : "Failed to load venues",
        };
        
        this.loadingManager.setError("venues");
        throw error;
      }
    };

    await withErrorHandling(operation, (error) => {
      globalErrorHandler.handleError(error, { operation: "load_venues" });
    });
  }

  /**
   * Load recent events (current month)
   */
  async loadRecentEvents(): Promise<void> {
    const operation = async () => {
      this.loadingManager.setLoading("events");
      
      try {
        // Get current month chunk
        const now = new Date();
        const chunkId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        
        const events = await this.dataService.loadChunk(chunkId);
        
        // Filter to upcoming events only
        const upcomingEvents = events.filter(event => event.dateEpochMs > Date.now());
        
        this.eventState = {
          data: upcomingEvents,
          loading: false,
          error: null,
          lastUpdated: Date.now(),
        };
        
        this.loadingManager.setSuccess("events");
        console.log(`🎵 Loaded ${upcomingEvents.length} upcoming events`);
        
      } catch (error) {
        this.eventState = {
          ...this.eventState,
          loading: false,
          error: error instanceof Error ? error.message : "Failed to load events",
        };
        
        this.loadingManager.setError("events");
        throw error;
      }
    };

    await withErrorHandling(operation, (error) => {
      globalErrorHandler.handleError(error, { operation: "load_events" });
    });
  }

  /**
   * Search for events by artist or venue name
   */
  async searchEvents(query: string): Promise<Event[]> {
    if (!query.trim()) {
      return [];
    }

    this.loadingManager.setLoading("search");

    try {
      const results = await withRetry(
        () => this.dataService.searchEvents(query.trim()),
        {
          maxAttempts: 2,
          delay: 500,
          shouldRetry: (error) => error.message.includes("timeout"),
        }
      );

      this.loadingManager.setSuccess("search");
      console.log(`🔍 Found ${results.length} events for query: "${query}"`);
      
      return results;

    } catch (error) {
      this.loadingManager.setError("search");
      globalErrorHandler.handleError(error as Error, {
        operation: "search_events",
        query,
      });
      
      return [];
    }
  }

  /**
   * Load events for a specific date range
   */
  async loadEventsForDateRange(startDate: string, endDate: string): Promise<Event[]> {
    this.loadingManager.setLoading("date-range-events");

    try {
      const events = await this.dataService.getEventsByDateRange(startDate, endDate);
      
      this.loadingManager.setSuccess("date-range-events");
      console.log(`📅 Loaded ${events.length} events for ${startDate} to ${endDate}`);
      
      return events;

    } catch (error) {
      this.loadingManager.setError("date-range-events");
      globalErrorHandler.handleError(error as Error, {
        operation: "load_events_date_range",
        startDate,
        endDate,
      });
      
      return [];
    }
  }

  /**
   * Get application statistics
   */
  async getApplicationStats(): Promise<{
    cache: any;
    memory: any;
    loadingStates: Record<string, string>;
  }> {
    try {
      const [cacheStats, memoryStats] = await Promise.all([
        this.dataService.getCacheStats(),
        Promise.resolve(this.dataService.getMemoryStats()),
      ]);

      return {
        cache: cacheStats,
        memory: memoryStats,
        loadingStates: this.loadingManager.getAllStates(),
      };

    } catch (error) {
      globalErrorHandler.handleError(error as Error, {
        operation: "get_app_stats",
      });
      
      return {
        cache: null,
        memory: null,
        loadingStates: this.loadingManager.getAllStates(),
      };
    }
  }

  /**
   * Refresh all application data
   */
  async refresh(): Promise<void> {
    console.log("🔄 Refreshing application data...");

    this.loadingManager.setLoading("refresh");

    try {
      await this.dataService.refresh();
      await this.loadInitialData();
      
      this.loadingManager.setSuccess("refresh");
      console.log("✅ Application data refreshed successfully");

    } catch (error) {
      this.loadingManager.setError("refresh");
      globalErrorHandler.handleError(error as Error, {
        operation: "refresh_data",
      });
      
      throw error;
    }
  }

  /**
   * Set up loading state subscriptions for monitoring
   */
  private setupLoadingSubscriptions(): void {
    const keys = ["artists", "venues", "events", "search", "refresh"];
    
    keys.forEach(key => {
      this.loadingManager.subscribe(key, (state) => {
        console.log(`Loading state changed: ${key} = ${state}`);
        
        // Here you could emit events or update UI components
        // For example: this.emitStateChange(key, state);
      });
    });
  }

  /**
   * Get current application state
   */
  getState(): {
    events: AsyncState<Event[]>;
    artists: AsyncState<Artist[]>;
    venues: AsyncState<Venue[]>;
    loading: Record<string, string>;
  } {
    return {
      events: this.eventState,
      artists: this.artistState,
      venues: this.venueState,
      loading: this.loadingManager.getAllStates(),
    };
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    console.log("🧹 Cleaning up application resources...");
    
    this.loadingManager.clear();
    this.dataService.dispose();
    
    console.log("✅ Application cleanup completed");
  }
}

/**
 * Example usage function
 */
export async function exampleUsage(): Promise<void> {
  const app = new ExampleApp();

  try {
    // Initialize the application
    await app.initialize();

    // Get current state
    const state = app.getState();
    console.log("Current application state:", {
      eventsLoaded: state.events.data?.length || 0,
      artistsLoaded: state.artists.data?.length || 0,
      venuesLoaded: state.venues.data?.length || 0,
      loadingStates: state.loading,
    });

    // Search for events
    const searchResults = await app.searchEvents("punk");
    console.log(`Search results: ${searchResults.length} events found`);

    // Load events for next month
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const startDate = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;
    const endDate = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-31`;
    
    const nextMonthEvents = await app.loadEventsForDateRange(startDate, endDate);
    console.log(`Next month events: ${nextMonthEvents.length} events`);

    // Get application statistics
    const stats = await app.getApplicationStats();
    console.log("Application statistics:", stats);

    // Cleanup when done
    // app.dispose();

  } catch (error) {
    console.error("Application example failed:", error);
  }
}

// Export the example for testing
export default ExampleApp;