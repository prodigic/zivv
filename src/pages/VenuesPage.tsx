/**
 * Venues directory page
 */

import React from "react";
import { Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import { VenueCardSkeleton, ListSkeleton } from "@/components/ui/LoadingSpinner.js";
import { useAppStore } from "@/stores/appStore.js";

const VenuesPage: React.FC = () => {
  const venues = useAppStore(state => state.venues);
  const loading = useAppStore(state => state.loading);
  const errors = useAppStore(state => state.errors);
  const getUpcomingEvents = useAppStore(state => state.getUpcomingEvents);
  const getArtist = useAppStore(state => state.getArtist);
  const showUpcomingOnly = useAppStore(state => state.showUpcomingOnly);
  
  const [venuesDisplayLimit, setVenuesDisplayLimit] = React.useState(25);
  
  // Filter venues based on upcoming events flag
  const allVenuesArray = React.useMemo(() => {
    const venuesArray = Array.from(venues.values());
    
    if (showUpcomingOnly) {
      // Only show venues with upcoming events
      return venuesArray.filter(venue => venue.upcomingEventCount > 0);
    }
    
    return venuesArray;
  }, [venues, showUpcomingOnly]);
  
  const venuesArray = allVenuesArray.slice(0, venuesDisplayLimit);

  // Helper function to get next event for a venue
  const getNextEventForVenue = (venueId: number) => {
    const allUpcomingEvents = getUpcomingEvents(100); // Get more events to search through
    return allUpcomingEvents.find(event => event.venueId === venueId);
  };

  // No longer grouping by city for better grid layout

  if (loading.venues === "loading") {
    return (
      <ContentArea title="Venues">
        <ListSkeleton count={10} itemSkeleton={VenueCardSkeleton} />
      </ContentArea>
    );
  }

  if (errors.venues) {
    return (
      <ContentArea title="Venues">
        <div className="text-center py-12">
          <div className="text-red-600 mb-4">
            <svg className="h-12 w-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            Unable to Load Venues
          </h3>
          <p className="text-gray-600">{errors.venues}</p>
        </div>
      </ContentArea>
    );
  }

  return (
    <ContentArea 
      title="Venues"
      subtitle={`${venuesArray.length} venues across the Bay Area`}
    >
      {/* Debug info */}
      <div className="debug-info mb-4 space-y-1">
        <div className="debug-label">Page Debug Info:</div>
        <div>Venues loaded: {venuesArray.length}</div>
        <div>Events loaded: {getUpcomingEvents(100).length}</div>
        <div>Loading states: venues={loading.venues}, events={loading.events}</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {venuesArray.map((venue) => {
                const nextEvent = getNextEventForVenue(venue.id);
                const headlinerArtist = nextEvent?.headlinerArtistId ? getArtist(nextEvent.headlinerArtistId) : null;
                
                return (
                  <div
                    key={venue.id}
                    className={`venue-card ${venue.upcomingEventCount === 0 ? 'no-upcoming' : ''} bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden hover:shadow-md transition-shadow cursor-pointer`}
                  >
                    {/* Google Maps Placeholder */}
                    <div className="h-32 bg-gradient-to-br from-green-100 to-blue-100 dark:from-green-900 dark:to-blue-900 relative flex items-center justify-center">
                      <div className="absolute inset-0 bg-gray-200 dark:bg-gray-700 opacity-30"></div>
                      <div className="relative z-10 text-center">
                        <svg className="w-8 h-8 mx-auto text-gray-500 dark:text-gray-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <div className="text-xs text-gray-600 dark:text-gray-400 font-medium">Map View</div>
                      </div>
                    </div>

                    <div className="p-6">
                      <div className="mb-4">
                        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                          {venue.name}
                        </h3>
                        <div className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                          {venue.address}
                        </div>
                        <div className="text-sm text-gray-600 dark:text-gray-300">
                          {venue.city}
                        </div>
                      </div>
                    
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center space-x-2">
                          <span className="inline-block bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs px-2 py-1 rounded-full">
                            {venue.ageRestriction}
                          </span>
                          {venue.capacity && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              Cap: {venue.capacity}
                            </span>
                          )}
                        </div>
                        
                        <div className="text-sm text-gray-600 dark:text-gray-300">
                          {venue.upcomingEventCount > 0 
                            ? `${venue.upcomingEventCount} upcoming` 
                            : 'No upcoming shows'
                          }
                        </div>
                      </div>

                      {/* Next Show */}
                      {nextEvent && (
                        <Link to={`/events/${nextEvent.id}`} className="block mb-4 bg-gray-50 dark:bg-gray-700 rounded-lg p-4 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors">
                          <div className="flex items-start space-x-3">
                            {/* Tear-off Calendar Date */}
                            <div className="flex-shrink-0">
                              <div className="bg-white dark:bg-gray-800 rounded shadow-sm border border-gray-200 dark:border-gray-600 overflow-hidden w-8">
                                {/* Calendar Header */}
                                <div className="bg-blue-500 text-white text-center py-0.5">
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
                                {headlinerArtist?.name || 'Show'} • {nextEvent.tags?.[0] || 'Live Music'}
                              </div>
                            </div>
                          </div>
                        </Link>
                      )}

                      {venue.phone && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {venue.phone}
                        </div>
                      )}

                      {/* Debug ID Information */}
                      <div className="debug-info mt-2 space-y-1">
                        <div className="debug-label">Venue Debug Info:</div>
                        <div>Venue: <span className="debug-id venue-id">{venue.id}</span></div>
                        {nextEvent && (
                          <div className="space-y-1">
                            <div>Next Event: <span className="debug-id event-id">{nextEvent.id}</span></div>
                            {nextEvent.headlinerArtistId && (
                              <div>Headliner: <span className="debug-id artist-id">{nextEvent.headlinerArtistId}</span></div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
        })}
        
        {/* Load More Venues Button */}
        {allVenuesArray.length > venuesDisplayLimit && (
          <div className="text-center pt-6 col-span-full">
          <button
            onClick={() => setVenuesDisplayLimit(prev => prev + 25)}
            className="px-6 py-3 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Load More Venues ({allVenuesArray.length - venuesDisplayLimit} remaining)
          </button>
        </div>
      )}
      </div>
    </ContentArea>
  );
};

export default VenuesPage;