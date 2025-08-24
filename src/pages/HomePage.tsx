/**
 * Home page - Event list with infinite scroll
 */

import React, { useEffect } from "react";
import { ContentArea } from "@/components/layout/AppShell.tsx";
import { useAppStore } from "@/stores/appStore.ts";
import { useFilterStore } from "@/stores/filterStore.ts";
import { EventCardSkeleton, ListSkeleton } from "@/components/ui/LoadingSpinner.tsx";

const HomePage: React.FC = () => {
  const getAllEvents = useAppStore(state => state.getAllEvents);
  const loading = useAppStore(state => state.loading);
  const errors = useAppStore(state => state.errors);
  const loadChunk = useAppStore(state => state.loadChunk);
  const initialize = useAppStore(state => state.initialize);
  const artists = useAppStore(state => state.artists);
  
  const { 
    filters, 
    searchQuery 
  } = useFilterStore();

  const [displayLimit, setDisplayLimit] = React.useState(25);
  const allEventsRaw = getAllEvents(Infinity); // Get all loaded events
  
  // Apply filters from filter store
  const allEvents = React.useMemo(() => {
    let filteredEvents = allEventsRaw;
    
    // Apply price filter (for free shows toggle)
    if (filters.priceRange && filters.priceRange.max !== undefined) {
      if (filters.priceRange.max === 0) {
        // Show only free events
        filteredEvents = filteredEvents.filter(event => event.isFree);
      } else {
        // Show events within price range
        filteredEvents = filteredEvents.filter(event => {
          if (event.isFree) return filters.priceRange!.min === 0;
          const eventPrice = event.priceMax || event.priceMin || 0;
          return eventPrice >= (filters.priceRange!.min || 0) && 
                 eventPrice <= (filters.priceRange!.max || Infinity);
        });
      }
    }
    
    // Apply display limit for pagination
    return filteredEvents.slice(0, displayLimit);
  }, [allEventsRaw, filters.priceRange, displayLimit]);

  useEffect(() => {
    const initializeAndLoadEvents = async () => {
      try {
        // Initialize the app store first if needed
        if (artists.size === 0 && loading.artists === "idle" && !errors.artists) {
          await initialize();
        }
        
        // Then load initial event chunks
        await Promise.all([
          loadChunk('2025-08'),
          loadChunk('2025-09'), 
          loadChunk('2025-10'),
        ]);
      } catch (error) {
        console.error('Failed to initialize HomePage:', error);
      }
    };

    // Initialize if we need artists OR if we need events
    const needsArtists = artists.size === 0 && loading.artists === "idle" && !errors.artists;
    const needsEvents = allEvents.length === 0 && loading.events === "idle" && !errors.events;
    
    if (needsArtists || needsEvents) {
      initializeAndLoadEvents();
    }
  }, [allEvents.length, loading.events, errors.events, artists.size, loading.artists, errors.artists, loadChunk, initialize]);

  if (loading.events === "loading" && allEvents.length === 0) {
    return (
      <ContentArea>
        <div className="space-y-6">
          <div className="flex flex-col space-y-4">
            <div className="h-8 bg-gray-200 rounded animate-pulse w-48"></div>
            <div className="h-4 bg-gray-200 rounded animate-pulse w-64"></div>
          </div>
          <ListSkeleton count={6} itemSkeleton={EventCardSkeleton} />
        </div>
      </ContentArea>
    );
  }

  if (errors.events) {
    return (
      <ContentArea>
        <div className="text-center py-12">
          <div className="text-red-600 mb-4">
            <svg className="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Unable to load events</h3>
          <p className="text-gray-600 mb-4">{errors.events}</p>
          <button 
            onClick={() => loadChunk('2025-08')}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            Try Again
          </button>
        </div>
      </ContentArea>
    );
  }

  return (
    <ContentArea>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Upcoming Shows</h1>
            <div className="text-sm text-gray-500">
              {allEvents.length} events
            </div>
          </div>
          <p className="text-gray-600 dark:text-gray-300">Bay Area punk and alternative shows</p>
        </div>

        {/* Debug info */}
        <div className="debug-info mb-4 space-y-1">
          <div className="debug-label">HomePage Debug Info:</div>
          <div>Events loaded: {allEvents.length}</div>
          <div>Artists loaded: {artists.size}</div>
          <div>Loading states: artists={loading.artists}, events={loading.events}</div>
          <div>Errors: artists={errors.artists}, events={errors.events}</div>
          <div>Search query: "{searchQuery}"</div>
          <div>Active city filters: {Object.keys(filters.cities || {}).length}</div>
          <div>Filter details: {JSON.stringify(filters)}</div>
        </div>

        {/* Event List */}
        {allEvents.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-400 mb-4">
              <svg className="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No events found</h3>
            <p className="text-gray-600">
              {searchQuery || Object.keys(filters.cities || {}).length > 0 
                ? "Try adjusting your search or filters"
                : "Check back soon for upcoming shows"}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {allEvents.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
            
            {/* Load More Button */}
            {allEvents.length > 0 && (
              <div className="text-center pt-6">
                <button
                  onClick={async () => {
                    const currentFilteredTotal = allEventsRaw.length;
                    const allAvailableEvents = getAllEvents(Infinity);
                    
                    // First try to show more from already loaded events
                    if (displayLimit < currentFilteredTotal) {
                      setDisplayLimit(prev => prev + 25);
                    } else if (displayLimit < allAvailableEvents.length) {
                      // Show more from all available events (different filters might have hidden some)
                      setDisplayLimit(prev => prev + 25);
                    } else {
                      // Need to load more chunks from server
                      const lastEvent = allAvailableEvents[allAvailableEvents.length - 1];
                      if (lastEvent) {
                        const lastEventDate = new Date(lastEvent.dateEpochMs);
                        const nextMonth = new Date(lastEventDate);
                        nextMonth.setMonth(nextMonth.getMonth() + 1);
                        
                        const year = nextMonth.getFullYear();
                        const month = nextMonth.getMonth() + 1;
                        const yearMonth = `${year}-${month.toString().padStart(2, '0')}`;
                        
                        console.log('Loading next chunk:', yearMonth);
                        await loadChunk(yearMonth);
                        setDisplayLimit(prev => prev + 25);
                      }
                    }
                  }}
                  disabled={loading.events === "loading"}
                  className="px-6 py-3 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading.events === "loading" ? (
                    <div className="flex items-center space-x-2">
                      <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                      <span>Loading...</span>
                    </div>
                  ) : (
                    "Load More Events"
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </ContentArea>
  );
};

// Event Card Component
const EventCard: React.FC<{ event: any }> = ({ event }) => {
  const getArtist = useAppStore(state => state.getArtist);
  const getVenue = useAppStore(state => state.getVenue);

  const formatDate = (epochMs: number) => {
    const date = new Date(epochMs);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const formatTime = (epochMs: number) => {
    const date = new Date(epochMs);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    });
  };

  // Get venue details
  const venue = event.venueId ? getVenue(event.venueId) : null;
  
  // Get artist details
  const artists = event.artistIds 
    ? event.artistIds.map((id: any) => getArtist(id)).filter((artist: any) => artist !== null && artist !== undefined)
    : [];
  const headlinerArtist = event.headlinerArtistId ? getArtist(event.headlinerArtistId) : null;

  // Note: isPastEvent logic available if needed later
  // const isPastEvent = event.dateEpochMs < Date.now();

  // Generate variant colors based on event ID
  const colorVariants = [
    { bg: 'linear-gradient(45deg, #fef3c7 0%, #fed7aa 100%)', border: '#d97706', header: '#d97706' }, // Orange
    { bg: 'linear-gradient(45deg, #ddd6fe 0%, #c7d2fe 100%)', border: '#7c3aed', header: '#7c3aed' }, // Purple
    { bg: 'linear-gradient(45deg, #fecaca 0%, #fed7d7 100%)', border: '#dc2626', header: '#dc2626' }, // Red  
    { bg: 'linear-gradient(45deg, #bbf7d0 0%, #d1fae5 100%)', border: '#059669', header: '#059669' }, // Green
    { bg: 'linear-gradient(45deg, #bfdbfe 0%, #dbeafe 100%)', border: '#2563eb', header: '#2563eb' }, // Blue
    { bg: 'linear-gradient(45deg, #fde68a 0%, #fef3c7 100%)', border: '#d97706', header: '#d97706' }, // Yellow
  ];
  
  const colorIndex = Math.abs(event.id) % colorVariants.length;
  const colors = colorVariants[colorIndex];

  return (
    <div className="relative border-2 border-dashed rounded-none mb-6 shadow-lg transform hover:scale-105 transition-transform duration-200" style={{
      background: colors.bg,
      borderLeft: `8px solid ${colors.border}`,
      borderRight: `8px solid ${colors.border}`,
      borderColor: colors.border,
      fontFamily: 'monospace'
    }}>
      
      {/* Ticket Header */}
      <div className="text-white text-center py-2 text-xs font-bold tracking-wider border-b-2 border-dashed" style={{
        backgroundColor: colors.header,
        borderColor: colors.border
      }}>
        ✦ PUNK ROCK SHOW TICKET ✦
      </div>
      
      {/* Main Content */}
      <div className="p-6">
        <div className="flex justify-between items-start">
          
          {/* Left Side - Event Info */}
          <div className="flex-1">
            <h2 className="text-2xl font-bold text-gray-900 mb-2 tracking-tight" style={{textShadow: '1px 1px 0px rgba(0,0,0,0.1)'}}>
              {headlinerArtist?.name || `Event ${event.id}`}
            </h2>
            
            <div className="space-y-1 text-sm text-gray-700">
              <div className="flex items-center">
                <span className="font-bold w-12">DATE:</span>
                <span className="font-mono">{formatDate(event.dateEpochMs)}</span>
              </div>
              
              {event.startTimeEpochMs && (
                <div className="flex items-center">
                  <span className="font-bold w-12">TIME:</span>
                  <span className="font-mono">{formatTime(event.startTimeEpochMs)}</span>
                </div>
              )}
              
              {venue && (
                <div className="flex items-center">
                  <span className="font-bold w-12">VENUE:</span>
                  <span className="font-mono">{venue.name}, {venue.city}</span>
                </div>
              )}
              
              {artists.length > 1 && (
                <div className="flex items-start">
                  <span className="font-bold w-12">WITH:</span>
                  <span className="font-mono text-xs">
                    {artists.slice(1).map((artist: any) => artist?.name).filter(Boolean).join(', ')}
                  </span>
                </div>
              )}
            </div>
          </div>
          
          {/* Right Side - Price & Stub */}
          <div className="border-l-2 border-dashed border-orange-300 pl-4 ml-4 text-center">
            <div className="transform -rotate-90 origin-center mb-4">
              <div className="text-xs font-bold text-gray-600 tracking-widest">ADMIT ONE</div>
            </div>
            
            {(event.priceMin || event.priceMax || event.isFree) && (
              <div className="bg-red-600 text-white px-3 py-2 rounded font-bold text-lg shadow-inner">
                {event.isFree ? 'FREE' : 
                 event.priceMin === event.priceMax ? `$${event.priceMin}` :
                 `$${event.priceMin}-$${event.priceMax}`}
              </div>
            )}
            
            <div className="text-xs text-gray-500 mt-2 transform rotate-90 origin-center">
              <div className="font-mono">#{event.id}</div>
            </div>
          </div>
        </div>
      </div>
      
      {/* Ticket Footer */}
      <div className="border-t-2 border-dashed px-4 py-2 text-xs text-gray-600" style={{
        backgroundColor: `${colors.border}20`, // 20% opacity of border color
        borderColor: colors.border
      }}>
        <div className="flex justify-between items-center">
          <span className="font-mono font-bold">
            {venue ? `${venue.name.toUpperCase()} • ${venue.city?.toUpperCase()}` : 'VENUE TBA'}
          </span>
          <span className="font-mono">KEEP THIS TICKET</span>
        </div>
      </div>
      
      {/* Debug ID Information */}
      <div className="debug-info absolute -bottom-6 left-0 text-xs text-gray-400 font-mono">
        Event: {event.id} | Venue: {event.venueId} | Headliner: {event.headlinerArtistId}
      </div>
      
      {/* Perforated Edge Effects */}
      <div className="absolute -left-2 top-0 bottom-0 w-4 bg-white opacity-60 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(circle, transparent 2px, white 2px)',
          backgroundSize: '8px 8px'
        }}>
      </div>
      <div className="absolute -right-2 top-0 bottom-0 w-4 bg-white opacity-60 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(circle, transparent 2px, white 2px)',
          backgroundSize: '8px 8px'
        }}>
      </div>
    </div>
  );
};

export default HomePage;