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
  const { venues } = useAppStore();

  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Get all venue names, filtered by selected cities, sorted alphabetically
  const allVenues = useMemo(() => {
    const selectedCities = filters.cities || [];

    const venueList = Array.from(venues.values())
      .map((venue) => ({
        id: venue.id,
        name: venue.name,
        city: venue.city,
        normalizedName: venue.normalizedName,
      }))
      // Filter by selected cities if any are selected
      .filter((venue) => {
        if (selectedCities.length === 0) {
          return true; // Show all venues if no cities selected
        }

        // Map full city names back to normalized names for venue matching
        const cityMapping: Record<string, string> = {
          "San Francisco": "S.f",
          Oakland: "Oakland",
          Berkeley: "Berkeley",
          "Santa Cruz": "Santa",
        };

        return selectedCities.some((selectedCity) => {
          const normalizedCity = cityMapping[selectedCity] || selectedCity;
          return venue.city === normalizedCity;
        });
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return venueList;
  }, [venues, filters.cities]);

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
  const handleVenueToggle = (venueName: string, isFromChip = false) => {
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

      // Clear input and close dropdown when selecting from dropdown (not from chip)
      if (!isFromChip) {
        setSearchText("");
        setIsOpen(false);
      }
    }
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

  // Handle Enter key to select first venue
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && filteredVenues.length > 0) {
      e.preventDefault();
      const firstVenue = filteredVenues[0];
      if (!selectedVenues.includes(firstVenue.name)) {
        handleVenueToggle(firstVenue.name);
      }
    }
  };

  return (
    <div className={`venue-filter ${className}`} ref={dropdownRef}>
      {/* Header with icon and Clear All button */}
      <div className="flex items-center gap-3">
        {/* Building Icon */}
        <div className="flex-shrink-0">
          <svg
            className="w-8 h-8 text-gray-600 dark:text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-label="Venue Filter"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
            />
          </svg>
          <span className="sr-only">Filter by Venue</span>
        </div>

        <div className="flex-1">
          {/* Selected venues chips */}
          {selectedVenues.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {selectedVenues.map((venueName) => (
                <div
                  key={venueName}
                  className="inline-flex items-center px-2 py-1 rounded-md bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs font-mono"
                >
                  <span className="mr-1 truncate max-w-[120px]">
                    {venueName}
                  </span>
                  <button
                    onClick={() => handleVenueToggle(venueName, true)}
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
              className="w-full px-3 py-2 text-sm border border-dashed border-gray-300 dark:border-gray-600
                       rounded bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300
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
        </div>

        {/* Clear button */}
        {selectedVenues.length > 0 && (
          <button
            onClick={handleClearAll}
            className="flex-shrink-0 text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-mono transition-colors"
          >
            CLEAR
          </button>
        )}
      </div>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          className="absolute z-50 mt-1 bg-white dark:bg-gray-800 border border-dashed border-gray-300 dark:border-gray-600
                     rounded shadow-lg max-h-64 overflow-y-auto"
          style={{ left: "2.5rem", right: "0", width: "calc(100% - 2.5rem)" }}
        >
          {filteredVenues.length > 0 ? (
            <>
              {/* Results count */}
              <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-dashed border-gray-200 dark:border-gray-700">
                {searchText.trim()
                  ? `${filteredVenues.length} matches`
                  : `${allVenues.length} venues`}
                {searchText.trim() &&
                  allVenues.length > filteredVenues.length &&
                  " (showing top 20)"}
              </div>

              {/* Venue options */}
              {filteredVenues.map((venue) => {
                const isSelected = selectedVenues.includes(venue.name);
                return (
                  <button
                    key={venue.id}
                    onClick={() => handleVenueToggle(venue.name)}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors
                               border-b border-dashed border-gray-100 dark:border-gray-700 last:border-b-0
                               ${isSelected ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300" : "text-gray-700 dark:text-gray-300"}`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-mono font-medium">
                          {venue.name}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {venue.city}
                        </div>
                      </div>
                      {isSelected && (
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
  );
};
