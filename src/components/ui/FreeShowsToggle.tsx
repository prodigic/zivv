/**
 * Toggle for showing only free shows
 */

import React from "react";
import { useFilterStore } from "@/stores/filterStore";

interface FreeShowsToggleProps {
  className?: string;
}

export const FreeShowsToggle: React.FC<FreeShowsToggleProps> = ({ className = "" }) => {
  const filters = useFilterStore(state => state.filters);
  const updateFilter = useFilterStore(state => state.updateFilter);

  // Check if free shows filter is active
  const isFreeShowsOnly = filters.priceRange?.max === 0;

  const toggleFreeShows = () => {
    if (isFreeShowsOnly) {
      // Clear the price filter to show all shows
      updateFilter('priceRange', {});
    } else {
      // Set price range to show only free shows (max price 0)
      updateFilter('priceRange', { min: 0, max: 0 });
    }
  };

  return (
    <div className={`flex items-center space-x-2 ${className}`}>
      <span className="text-sm text-gray-600 dark:text-gray-300">
        {isFreeShowsOnly ? "Free only" : "All prices"}
      </span>
      <button
        onClick={toggleFreeShows}
        className={`
          relative inline-flex h-5 w-9 items-center rounded-full 
          transition-colors duration-200 ease-in-out focus:outline-none 
          focus:ring-2 focus:ring-green-500 focus:ring-offset-2 
          focus:ring-offset-white dark:focus:ring-offset-gray-800
          ${isFreeShowsOnly 
            ? "bg-green-600 hover:bg-green-700" 
            : "bg-gray-200 hover:bg-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500"
          }
        `}
        aria-label={isFreeShowsOnly ? "Show all price events" : "Show free shows only"}
        role="switch"
        aria-checked={isFreeShowsOnly}
      >
        <span
          className={`
            inline-block h-4 w-4 transform rounded-full bg-white 
            shadow-lg transition-transform duration-200 ease-in-out
            ${isFreeShowsOnly ? "translate-x-4" : "translate-x-0"}
          `}
        />
      </button>
    </div>
  );
};