/**
 * Venue filter with text matching dropdown for filtering events by venue
 */

import React, { useState, useMemo, useRef, useEffect } from "react";
import { useFilterStore } from "@/stores/filterStore";
import { useAppStore } from "@/stores/appStore";

interface VenueFilterProps {
  className?: string;
}

export const VenueFilter: React.FC<VenueFilterProps> = ({ className = "" }) => {
  const { filters, updateFilter, clearFilter } = useFilterStore();
  const { venues, showUpcomingOnly } = useAppStore();

  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Get all venue names sorted alphabetically
  const allVenues = useMemo(() => {
    const venueList = Array.from(venues.values())
      .map((venue) => {
        const relevantEventCount = showUpcomingOnly
          ? venue.upcomingEventCount
          : venue.totalEventCount;
        const hasRelevantEvents = relevantEventCount > 0;

        return {
          id: venue.id,
          name: venue.name,
          city: venue.city,
          normalizedName: venue.normalizedName,
          upcomingEventCount: venue.upcomingEventCount,
          totalEventCount: venue.totalEventCount,
          relevantEventCount,
          hasUpcomingEvents: venue.upcomingEventCount > 0,
          hasRelevantEvents,
        };
      })
      .sort((a, b) => {
        // Sort venues with relevant events first, then alphabetically
        if (a.hasRelevantEvents && !b.hasRelevantEvents) return -1;
        if (!a.hasRelevantEvents && b.hasRelevantEvents) return 1;
        return a.name.localeCompare(b.name);
      });
    return venueList;
  }, [venues, showUpcomingOnly]);

  // Filter venues based on search text
  const filteredVenues = useMemo(() => {
    if (!searchText.trim()) return allVenues.slice(0, 50); // Show first 50 if no search

    const searchLower = searchText.toLowerCase();
    return allVenues
      .filter(
        (venue) =>
          venue.name.toLowerCase().includes(searchLower) ||
          venue.city.toLowerCase().includes(searchLower)
      )
      .slice(0, 20); // Limit to 20 results for performance
  }, [allVenues, searchText]);

  // Get currently selected venues
  const selectedVenues = filters.venues || [];

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Handle venue selection (toggle)
  const handleVenueToggle = (venueName: string, hasRelevantEvents: boolean) => {
    // Don't allow selection of venues with no relevant events
    if (!hasRelevantEvents) {
      return;
    }

    const currentVenues = selectedVenues;

    if (currentVenues.includes(venueName)) {
      // Remove venue
      const updatedVenues = currentVenues.filter((v) => v !== venueName);
      if (updatedVenues.length === 0) {
        clearFilter("venues");
      } else {
        updateFilter("venues", updatedVenues);
      }
    } else {
      // Add venue
      updateFilter("venues", [...currentVenues, venueName]);
    }

    // Close dropdown after selection
    setIsOpen(false);
  };

  // Clear all venue filters
  const handleClearAll = () => {
    clearFilter("venues");
    setSearchText("");
  };

  // Handle search input change
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchText(e.target.value);
  };

  // Handle Enter key to select first venue if none selected
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();

      // If no venues are selected and there are filtered venues with relevant events, select the first one
      if (selectedVenues.length === 0 && filteredVenues.length > 0) {
        const firstEnabledVenue = filteredVenues.find(
          (venue) => venue.hasRelevantEvents
        );
        if (firstEnabledVenue) {
          handleVenueToggle(
            firstEnabledVenue.name,
            firstEnabledVenue.hasRelevantEvents
          );
        }
      }
    }
  };

  return (
    <div className={`venue-filter ${className}`} ref={dropdownRef}>
      {/* Header with Clear All button */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Filter by Venue
        </div>
        {selectedVenues.length > 0 && (
          <button
            onClick={handleClearAll}
            className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-mono transition-colors"
          >
            CLEAR
          </button>
        )}
      </div>

      {/* Dropdown trigger and selected venues display */}
      <div className="relative">
        {/* Selected venues chips */}
        {selectedVenues.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {selectedVenues.map((venueName) => (
              <div
                key={venueName}
                className="inline-flex items-center px-2 py-1 rounded-md bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs font-mono"
              >
                <span className="mr-1 truncate max-w-[120px]">{venueName}</span>
                <button
                  onClick={() => handleVenueToggle(venueName, true)} // Selected venues always have relevant events
                  className="ml-1 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Search input / dropdown trigger */}
        <div className="relative">
          <input
            type="text"
            value={searchText}
            onChange={handleSearchChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsOpen(true)}
            placeholder="Search venues..."
            className="w-full px-3 py-2 text-sm border-2 border-dashed border-gray-300 dark:border-gray-600 
                     rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300
                     focus:border-red-300 dark:focus:border-red-600 focus:outline-none transition-colors
                     placeholder-gray-400 dark:placeholder-gray-500"
          />
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </div>

        {/* Dropdown menu */}
        {isOpen && (
          <div
            className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border-2 border-dashed border-gray-300 dark:border-gray-600 
                        rounded-lg shadow-lg max-h-64 overflow-y-auto"
          >
            {filteredVenues.length > 0 ? (
              <>
                {/* Results count */}
                <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-dashed border-gray-200 dark:border-gray-700">
                  {(() => {
                    const enabledCount = filteredVenues.filter(
                      (v) => v.hasRelevantEvents
                    ).length;
                    const totalCount = filteredVenues.length;
                    const showType = showUpcomingOnly
                      ? "upcoming shows"
                      : "shows";

                    if (searchText.trim()) {
                      return `${totalCount} matches${enabledCount < totalCount ? ` (${enabledCount} with ${showType})` : ""}`;
                    } else {
                      const totalEnabledCount = allVenues.filter(
                        (v) => v.hasRelevantEvents
                      ).length;
                      return `${allVenues.length} venues (${totalEnabledCount} with ${showType})`;
                    }
                  })()}
                  {searchText.trim() &&
                    allVenues.length > filteredVenues.length &&
                    " (showing top 20)"}
                </div>

                {/* Venue options */}
                {filteredVenues.map((venue) => {
                  const isSelected = selectedVenues.includes(venue.name);
                  const isDisabled = !venue.hasRelevantEvents;
                  return (
                    <button
                      key={venue.id}
                      onClick={() =>
                        handleVenueToggle(venue.name, venue.hasRelevantEvents)
                      }
                      disabled={isDisabled}
                      className={`w-full px-3 py-2 text-left text-sm transition-colors
                               border-b border-dashed border-gray-100 dark:border-gray-700 last:border-b-0
                                ${
                                  isDisabled
                                    ? "cursor-not-allowed opacity-50 text-gray-400 dark:text-gray-600 bg-gray-50 dark:bg-gray-800/50"
                                    : isSelected
                                      ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30"
                                      : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                                }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <div
                            className={`font-mono font-medium ${isDisabled ? "line-through" : ""}`}
                          >
                            {venue.name}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
                            <span>{venue.city}</span>
                            {isDisabled && (
                              <span className="text-xs text-red-500 dark:text-red-400 font-mono">
                                {showUpcomingOnly
                                  ? "NO UPCOMING SHOWS"
                                  : "NO SHOWS"}
                              </span>
                            )}
                            {!isDisabled && venue.relevantEventCount > 0 && (
                              <span className="text-xs text-green-600 dark:text-green-400 font-mono">
                                {venue.relevantEventCount} show
                                {venue.relevantEventCount !== 1 ? "s" : ""}
                                {!showUpcomingOnly &&
                                  venue.upcomingEventCount !==
                                    venue.totalEventCount && (
                                    <span className="text-blue-600 dark:text-blue-400">
                                      {" "}
                                      ({venue.upcomingEventCount} upcoming)
                                    </span>
                                  )}
                              </span>
                            )}
                          </div>
                        </div>
                        {isSelected && !isDisabled && (
                          <div className="text-red-600 dark:text-red-400 text-xs">
                            ✓
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </>
            ) : (
              <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400 text-center">
                No venues found matching "{searchText}"
              </div>
            )}
          </div>
        )}
      </div>

      {/* Selected count indicator */}
      {selectedVenues.length > 0 && (
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 font-mono">
          {selectedVenues.length} venue{selectedVenues.length === 1 ? "" : "s"}{" "}
          selected
        </div>
      )}
    </div>
  );
};
