/**
 * Main application store using Zustand
 * Manages global app state, data loading, and UI state
 */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { DataService } from "@/services/DataService.js";
import { globalErrorHandler } from "@/utils/errorHandling.js";
import type {
  Event,
  Artist,
  Venue,
  EventId,
  ArtistId,
  VenueId,
} from "@/types/events.js";
import type { DataManifest, DataIndexes } from "@/types/data.js";
import type { AsyncState, ViewState, LoadingState } from "@/types/frontend.js";

// App state interface
export interface AppState {
  // Data
  manifest: DataManifest | null;
  events: Map<EventId, Event>;
  artists: Map<ArtistId, Artist>;
  venues: Map<VenueId, Venue>;
  indexes: DataIndexes | null;
  loadedChunks: Set<string>;

  // Loading states
  loading: {
    manifest: LoadingState;
    artists: LoadingState;
    venues: LoadingState;
    indexes: LoadingState;
    events: LoadingState;
    search: LoadingState;
  };

  // Errors
  errors: {
    manifest: string | null;
    artists: string | null;
    venues: string | null;
    indexes: string | null;
    events: string | null;
    search: string | null;
  };

  // UI state
  view: ViewState;
  showUpcomingOnly: boolean;

  // Data service instance
  dataService: DataService | null;

  // Last updated timestamps
  lastUpdated: {
    manifest: number | null;
    artists: number | null;
    venues: number | null;
    indexes: number | null;
  };
}

// App actions interface
export interface AppActions {
  // Initialization
  initialize: () => Promise<void>;

  // Data loading
  loadManifest: () => Promise<void>;
  loadArtists: () => Promise<void>;
  loadVenues: () => Promise<void>;
  loadIndexes: () => Promise<void>;
  loadChunk: (chunkId: string) => Promise<void>;

  // Search
  searchEvents: (query: string) => Promise<Event[]>;

  // Data access helpers
  getEvent: (eventId: EventId) => Event | undefined;
  getArtist: (artistId: ArtistId) => Artist | undefined;
  getVenue: (venueId: VenueId) => Venue | undefined;
  getEventsForMonth: (yearMonth: string) => Event[];
  getAllEvents: (limit?: number) => Event[];
  getUpcomingEvents: (limit?: number) => Event[];

  // UI state management
  setCurrentView: (view: ViewState["currentView"]) => void;
  setSelectedDate: (date: string | undefined) => void;
  setSelectedEvent: (eventId: EventId | undefined) => void;
  updateScrollPosition: (position: number) => void;
  toggleUpcomingOnly: () => void;

  // Error handling
  clearError: (key: keyof AppState["errors"]) => void;
  clearAllErrors: () => void;

  // Cache management
  refresh: () => Promise<void>;
  getCacheStats: () => Promise<any>;

  // Cleanup
  dispose: () => void;
}

// Combined store type
export type AppStore = AppState & AppActions;

// Create the store
export const useAppStore = create<AppStore>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial state
        manifest: null,
        events: new Map(),
        artists: new Map(),
        venues: new Map(),
        indexes: null,
        loadedChunks: new Set(),

        loading: {
          manifest: "idle",
          artists: "idle",
          venues: "idle",
          indexes: "idle",
          events: "idle",
          search: "idle",
        },

        errors: {
          manifest: null,
          artists: null,
          venues: null,
          indexes: null,
          events: null,
          search: null,
        },

        view: {
          currentView: "list",
          selectedDate: undefined,
          selectedEvent: undefined,
          scrollPosition: 0,
          lastVisited: Date.now(),
        },

        showUpcomingOnly: true,

        dataService: null,

        lastUpdated: {
          manifest: null,
          artists: null,
          venues: null,
          indexes: null,
        },

        // Actions
        async initialize() {
          try {
            const dataService = new DataService();
            set({ dataService });

            await dataService.initialize();

            // Load core data
            await Promise.all([
              get().loadManifest(),
              get().loadArtists(),
              get().loadVenues(),
              get().loadIndexes(),
            ]);
          } catch (error) {
            globalErrorHandler.handleError(error as Error, {
              operation: "app_initialization",
            });
            throw error;
          }
        },

        async loadManifest() {
          const { dataService } = get();
          if (!dataService) throw new Error("DataService not initialized");

          set((state) => ({
            loading: { ...state.loading, manifest: "loading" },
            errors: { ...state.errors, manifest: null },
          }));

          try {
            const manifest = await dataService.loadManifest();
            set((state) => ({
              manifest,
              loading: { ...state.loading, manifest: "success" },
              lastUpdated: { ...state.lastUpdated, manifest: Date.now() },
            }));
          } catch (error) {
            const errorMessage =
              error instanceof Error
                ? error.message
                : "Failed to load manifest";
            set((state) => ({
              loading: { ...state.loading, manifest: "error" },
              errors: { ...state.errors, manifest: errorMessage },
            }));
            throw error;
          }
        },

        async loadArtists() {
          const { dataService } = get();
          if (!dataService) throw new Error("DataService not initialized");

          set((state) => ({
            loading: { ...state.loading, artists: "loading" },
            errors: { ...state.errors, artists: null },
          }));

          try {
            const artistsArray = await dataService.loadArtists();
            const artistsMap = new Map(
              artistsArray.map((artist) => [artist.id, artist])
            );

            set((state) => ({
              artists: artistsMap,
              loading: { ...state.loading, artists: "success" },
              lastUpdated: { ...state.lastUpdated, artists: Date.now() },
            }));
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Failed to load artists";
            set((state) => ({
              loading: { ...state.loading, artists: "error" },
              errors: { ...state.errors, artists: errorMessage },
            }));
            throw error;
          }
        },

        async loadVenues() {
          const { dataService } = get();
          if (!dataService) throw new Error("DataService not initialized");

          set((state) => ({
            loading: { ...state.loading, venues: "loading" },
            errors: { ...state.errors, venues: null },
          }));

          try {
            const venuesArray = await dataService.loadVenues();
            const venuesMap = new Map(
              venuesArray.map((venue) => [venue.id, venue])
            );

            set((state) => ({
              venues: venuesMap,
              loading: { ...state.loading, venues: "success" },
              lastUpdated: { ...state.lastUpdated, venues: Date.now() },
            }));
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Failed to load venues";
            set((state) => ({
              loading: { ...state.loading, venues: "error" },
              errors: { ...state.errors, venues: errorMessage },
            }));
            throw error;
          }
        },

        async loadIndexes() {
          const { dataService } = get();
          if (!dataService) throw new Error("DataService not initialized");

          set((state) => ({
            loading: { ...state.loading, indexes: "loading" },
            errors: { ...state.errors, indexes: null },
          }));

          try {
            const indexes = await dataService.loadIndexes();
            set((state) => ({
              indexes,
              loading: { ...state.loading, indexes: "success" },
              lastUpdated: { ...state.lastUpdated, indexes: Date.now() },
            }));
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Failed to load indexes";
            set((state) => ({
              loading: { ...state.loading, indexes: "error" },
              errors: { ...state.errors, indexes: errorMessage },
            }));
            throw error;
          }
        },

        async loadChunk(chunkId: string) {
          const { dataService, loadedChunks } = get();
          if (!dataService) throw new Error("DataService not initialized");

          // Skip if already loaded
          if (loadedChunks.has(chunkId)) return;

          set((state) => ({
            loading: { ...state.loading, events: "loading" },
            errors: { ...state.errors, events: null },
          }));

          try {
            const eventsArray = await dataService.loadChunk(chunkId);

            set((state) => {
              const newEvents = new Map(state.events);
              eventsArray.forEach((event) => newEvents.set(event.id, event));

              const newLoadedChunks = new Set(state.loadedChunks);
              newLoadedChunks.add(chunkId);

              return {
                events: newEvents,
                loadedChunks: newLoadedChunks,
                loading: { ...state.loading, events: "success" },
              };
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error
                ? error.message
                : "Failed to load events chunk";
            set((state) => ({
              loading: { ...state.loading, events: "error" },
              errors: { ...state.errors, events: errorMessage },
            }));
            throw error;
          }
        },

        async searchEvents(query: string) {
          const { dataService } = get();
          if (!dataService) throw new Error("DataService not initialized");

          set((state) => ({
            loading: { ...state.loading, search: "loading" },
            errors: { ...state.errors, search: null },
          }));

          try {
            const results = await dataService.searchEvents(query);

            set((state) => ({
              loading: { ...state.loading, search: "success" },
            }));

            return results;
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Search failed";
            set((state) => ({
              loading: { ...state.loading, search: "error" },
              errors: { ...state.errors, search: errorMessage },
            }));
            return [];
          }
        },

        // Data access helpers
        getEvent(eventId: EventId) {
          return get().events.get(eventId);
        },

        getArtist(artistId: ArtistId) {
          return get().artists.get(artistId);
        },

        getVenue(venueId: VenueId) {
          return get().venues.get(venueId);
        },

        getEventsForMonth(yearMonth: string) {
          const { events } = get();
          const [year, month] = yearMonth.split("-").map(Number);

          return Array.from(events.values()).filter((event) => {
            const eventDate = new Date(event.dateEpochMs);
            return (
              eventDate.getFullYear() === year &&
              eventDate.getMonth() + 1 === month
            );
          });
        },

        getAllEvents(limit = 50) {
          const { events } = get();

          return Array.from(events.values())
            .sort((a, b) => a.dateEpochMs - b.dateEpochMs)
            .slice(0, limit);
        },

        getUpcomingEvents(limit = 20) {
          const { events } = get();
          const now = Date.now();

          return Array.from(events.values())
            .filter((event) => event.dateEpochMs > now)
            .sort((a, b) => a.dateEpochMs - b.dateEpochMs)
            .slice(0, limit);
        },

        // UI state management
        setCurrentView(currentView: ViewState["currentView"]) {
          set((state) => ({
            view: {
              ...state.view,
              currentView,
              lastVisited: Date.now(),
            },
          }));
        },

        setSelectedDate(selectedDate: string | undefined) {
          set((state) => ({
            view: { ...state.view, selectedDate },
          }));
        },

        setSelectedEvent(selectedEvent: EventId | undefined) {
          set((state) => ({
            view: { ...state.view, selectedEvent },
          }));
        },

        updateScrollPosition(scrollPosition: number) {
          set((state) => ({
            view: { ...state.view, scrollPosition },
          }));
        },

        toggleUpcomingOnly() {
          set((state) => {
            const newShowUpcomingOnly = !state.showUpcomingOnly;
            // Apply CSS class to document for performance
            if (typeof window !== "undefined") {
              if (newShowUpcomingOnly) {
                document.documentElement.classList.add("show-upcoming-only");
              } else {
                document.documentElement.classList.remove("show-upcoming-only");
              }
            }
            return { showUpcomingOnly: newShowUpcomingOnly };
          });
        },

        // Error handling
        clearError(key: keyof AppState["errors"]) {
          set((state) => ({
            errors: { ...state.errors, [key]: null },
          }));
        },

        clearAllErrors() {
          set((state) => ({
            errors: {
              manifest: null,
              artists: null,
              venues: null,
              indexes: null,
              events: null,
              search: null,
            },
          }));
        },

        // Cache management
        async refresh() {
          const { dataService } = get();
          if (!dataService) throw new Error("DataService not initialized");

          // Clear current data
          set({
            manifest: null,
            events: new Map(),
            artists: new Map(),
            venues: new Map(),
            indexes: null,
            loadedChunks: new Set(),
          });

          // Refresh data service and reload
          await dataService.refresh();
          await get().initialize();
        },

        async getCacheStats() {
          const { dataService } = get();
          if (!dataService) return null;

          return dataService.getCacheStats();
        },

        // Cleanup
        dispose() {
          const { dataService } = get();
          if (dataService) {
            dataService.dispose();
          }
        },
      }),
      {
        name: "zivv-app-store",
        // Only persist UI state, not data or dark mode
        partialize: (state) => ({
          view: state.view,
          showUpcomingOnly: state.showUpcomingOnly,
        }),
      }
    ),
    {
      name: "zivv-app-store",
    }
  )
);
