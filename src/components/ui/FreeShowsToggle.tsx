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
  const clearFilter = useFilterStore(state => state.clearFilter);

  // Check if free shows filter is active
  const isFreeShowsOnly = filters.isFree === true;

  const toggleFreeShows = () => {
    if (isFreeShowsOnly) {
      // Clear the free filter to show all shows
      clearFilter('isFree');
    } else {
      // Set filter to show only free shows
      updateFilter('isFree', true);
    }
  };

  return (
    <div className={`flex items-center space-x-2 ${className}`}>
      <span className="text-sm text-gray-600 dark:text-gray-300 w-8 text-right">
        {isFreeShowsOnly ? "Free" : "$$"}
      </span>
      <button
        onClick={toggleFreeShows}
        className="relative inline-flex h-5 w-9 items-center rounded-full border-2 border-gray-300 dark:border-gray-500 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-gray-800"
        aria-label={isFreeShowsOnly ? "Show all price events" : "Show free shows only"}
        role="switch"
        aria-checked={isFreeShowsOnly}
      >
        <span
          className={`
            inline-block h-4 w-4 transform rounded-full shadow-lg border-2
            transition-all duration-200 ease-in-out
            ${isFreeShowsOnly 
              ? "translate-x-4 bg-blue-600 border-blue-600 dark:bg-blue-400 dark:border-blue-400" 
              : "translate-x-0 bg-white border-gray-300 dark:border-gray-500"
            }
          `}
        />
      </button>
    </div>
  );
};