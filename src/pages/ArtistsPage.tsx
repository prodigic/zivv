/**
 * Artists directory page
 */

import React, { useEffect } from "react";
import { Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import { ArtistCardSkeleton, ListSkeleton } from "@/components/ui/LoadingSpinner.js";
import { useAppStore } from "@/stores/appStore.js";
import type { ArtistId } from "@/types/events.js";

const ArtistsPage: React.FC = () => {
  const artists = useAppStore(state => state.artists);
  const loading = useAppStore(state => state.loading);
  const errors = useAppStore(state => state.errors);
  const getUpcomingEvents = useAppStore(state => state.getUpcomingEvents);
  const getVenue = useAppStore(state => state.getVenue);
  const loadChunk = useAppStore(state => state.loadChunk);
  const initialize = useAppStore(state => state.initialize);
  const showUpcomingOnly = useAppStore(state => state.showUpcomingOnly);
  const manifest = useAppStore(state => state.manifest);
  
  const [artistsDisplayLimit, setArtistsDisplayLimit] = React.useState(25);
  
  // Filter artists based on upcoming events flag
  const allArtistsArray = React.useMemo(() => {
    const artistsArray = Array.from(artists.values());
    
    if (showUpcomingOnly) {
      // Only show artists with upcoming events
      return artistsArray.filter(artist => artist.upcomingEventCount > 0);
    }
    
    return artistsArray;
  }, [artists, showUpcomingOnly]);
  
  const artistsArray = allArtistsArray.slice(0, artistsDisplayLimit);

  // Initialize app and load initial event chunks
  useEffect(() => {
    const initializeApp = async () => {
      try {
        await initialize();
        // Load event chunks dynamically based on available data
        if (manifest?.chunks?.events) {
          // Load more chunks for artists page to show more comprehensive data
          const availableChunks = manifest.chunks.events
            .map(chunk => chunk.chunkId)
            .slice(0, 8); // Load first 8 months for artists page
          
          console.log('Loading event chunks for artists:', availableChunks);
          await Promise.all(
            availableChunks.map(chunkId => loadChunk(chunkId))
          );
        } else {
          // Fallback to known working chunks if manifest not available
          console.log('Manifest not available, using fallback chunks');
          await Promise.all([
            loadChunk('2025-09'), 
            loadChunk('2025-10'),
            loadChunk('2025-11'),
            loadChunk('2025-12'),
          ]);
        }
      } catch (error) {
        console.error('Failed to initialize ArtistsPage:', error);
      }
    };

    const currentEventCount = getUpcomingEvents(Infinity).length;

    // Initialize if we need artists OR if we need events
    const needsArtists = artists.size === 0 && loading.artists === "idle" && !errors.artists;
    const needsEvents = currentEventCount === 0 && loading.events === "idle" && !errors.events;
    
    if (needsArtists || needsEvents) {
      initializeApp();
    }
  }, [artists.size, loading.artists, errors.artists, loading.events, errors.events, initialize, loadChunk, getUpcomingEvents, manifest]);

  // Helper function to get next event for an artist
  const getNextEventForArtist = (artistId: ArtistId) => {
    const allUpcomingEvents = getUpcomingEvents(Infinity);
    
    return allUpcomingEvents.find(event => {
      const isHeadliner = event.headlinerArtistId === artistId;
      const isSupporting = event.artistIds && event.artistIds.includes(artistId);
      return isHeadliner || isSupporting;
    });
  };

  if (loading.artists === "loading") {
    return (
      <ContentArea title="Artists">
        <ListSkeleton count={12} itemSkeleton={ArtistCardSkeleton} />
      </ContentArea>
    );
  }

  if (errors.artists) {
    return (
      <ContentArea title="Artists">
        <div className="text-center py-12">
          <div className="text-red-600 mb-4">
            <svg className="h-12 w-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            Unable to Load Artists
          </h3>
          <p className="text-gray-600">{errors.artists}</p>
        </div>
      </ContentArea>
    );
  }

  // Don't render artists until we have both artists and some events loaded
  const hasEventsLoaded = getUpcomingEvents(Infinity).length > 0;
  const eventCount = getUpcomingEvents(Infinity).length;
  
  return (
    <ContentArea 
      title="Artists"
      subtitle={`${artistsArray.length} artists in the Bay Area`}
    >
      {/* Debug info */}
      <div className="debug-info mb-4 space-y-1">
        <div className="debug-label">Page Debug Info:</div>
        <div>Artists loaded: {artistsArray.length}</div>
        <div>Events loaded: {eventCount}</div>
        <div>Loading states: artists={loading.artists}, events={loading.events}</div>
        <div>Has events loaded: {hasEventsLoaded.toString()}</div>
      </div>

      {!hasEventsLoaded && artistsArray.length > 0 ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading events...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {artistsArray.map((artist) => {
            const nextEvent = getNextEventForArtist(artist.id);
            const venue = nextEvent?.venueId ? getVenue(nextEvent.venueId) : null;
          
          return (
            <div
              key={artist.id}
              className={`artist-card ${artist.upcomingEventCount === 0 ? 'no-upcoming' : ''} bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 hover:shadow-md transition-shadow cursor-pointer`}
            >
              <div className="space-y-4">
                {/* Header with Avatar and Title */}
                <div className="flex items-center space-x-4">
                  <div className="h-12 w-12 bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-900 dark:to-pink-900 rounded-full flex items-center justify-center">
                    <svg className="h-6 w-6 text-purple-600 dark:text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                      {artist.name}
                    </h3>
                    <div className="text-sm text-gray-600 dark:text-gray-300">
                      {artist.upcomingEventCount > 0 
                        ? `${artist.upcomingEventCount} upcoming show${artist.upcomingEventCount !== 1 ? 's' : ''}` 
                        : 'No upcoming shows'
                      }
                    </div>
                  </div>
                </div>

                {/* Full-width Upcoming Shows Inset */}
                {nextEvent && (
                  <Link to={`/events/${nextEvent.id}`} className="block bg-gray-50 dark:bg-gray-700 rounded-lg p-4 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors">
                    <div className="flex items-start space-x-3">
                      {/* Tear-off Calendar Date */}
                      <div className="flex-shrink-0">
                        <div className="bg-white dark:bg-gray-800 rounded shadow-sm border border-gray-200 dark:border-gray-600 overflow-hidden w-8">
                          {/* Calendar Header */}
                          <div className="bg-red-500 text-white text-center py-0.5">
                            <div className="text-xs font-bold uppercase leading-tight">
                              {new Date(nextEvent.dateEpochMs).toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}
                            </div>
                          </div>
                          {/* Date */}
                          <div className="text-center py-1">
                            <div className="text-sm font-bold text-gray-900 dark:text-white leading-none">
                              {new Date(nextEvent.dateEpochMs).getDate()}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Event Details */}
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="text-sm">
                          <span className="font-semibold text-green-600 dark:text-green-400">
                            {nextEvent.isFree ? 'FREE' : 
                             nextEvent.priceMin === nextEvent.priceMax ? `$${Math.ceil(nextEvent.priceMin || 0)}` :
                             `$${Math.ceil(nextEvent.priceMin || 0)}-${Math.ceil(nextEvent.priceMax || 0)}`}
                          </span>
                          <span className="font-medium text-gray-900 dark:text-gray-100 ml-2">
                            {nextEvent.startTimeEpochMs ? 
                              new Date(nextEvent.startTimeEpochMs).toLocaleTimeString('en-US', {
                                hour: 'numeric',
                                minute: '2-digit'
                              }) : 'TBA'
                            }
                          </span>
                        </div>
                        <div className="text-sm text-gray-600 dark:text-gray-400">
                          {venue?.name} • {venue?.city}
                        </div>
                      </div>
                    </div>
                  </Link>
                )}

                {/* Aliases */}
                {artist.aliases && artist.aliases.length > 0 && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Also known as: {artist.aliases.join(", ")}
                  </div>
                )}

                {/* Debug ID Information */}
                <div className="debug-info mt-2 space-y-1">
                  <div className="debug-label">Artist Debug Info:</div>
                  <div>Artist: <span className="debug-id artist-id">{artist.id}</span></div>
                  {nextEvent && (
                    <div className="space-y-1">
                      <div>Next Event: <span className="debug-id event-id">{nextEvent.id}</span></div>
                      {nextEvent.venueId && (
                        <div>Venue: <span className="debug-id venue-id">{nextEvent.venueId}</span></div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        
        {/* Load More Artists Button */}
        {allArtistsArray.length > artistsDisplayLimit && (
          <div className="text-center pt-6">
            <button
              onClick={() => setArtistsDisplayLimit(prev => prev + 25)}
              className="px-6 py-3 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Load More Artists ({allArtistsArray.length - artistsDisplayLimit} remaining)
            </button>
          </div>
        )}
        </div>
      )}
    </ContentArea>
  );
};

export default ArtistsPage;