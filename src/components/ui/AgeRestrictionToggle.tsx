/**
 * Toggle for showing all ages vs 21+ shows
 */

import React from "react";
import { useFilterStore } from "@/stores/filterStore";

interface AgeRestrictionToggleProps {
  className?: string;
}

export const AgeRestrictionToggle: React.FC<AgeRestrictionToggleProps> = ({ className = "" }) => {
  const filters = useFilterStore(state => state.filters);
  const updateFilter = useFilterStore(state => state.updateFilter);

  // Check if all ages filter is active
  const isAllAgesOnly = filters.ageRestrictions?.includes("all-ages") && filters.ageRestrictions.length === 1;

  const toggleAgeRestriction = () => {
    if (isAllAgesOnly) {
      // Clear the age restriction filter to show all shows
      updateFilter('ageRestrictions', []);
    } else {
      // Set to show only all-ages shows
      updateFilter('ageRestrictions', ["all-ages"]);
    }
  };

  return (
    <div className={`flex items-center space-x-2 ${className}`}>
      <span className="text-sm text-gray-600 dark:text-gray-300">
        {isAllAgesOnly ? "All ages" : "All shows"}
      </span>
      <button
        onClick={toggleAgeRestriction}
        className={`
          relative inline-flex h-5 w-9 items-center rounded-full 
          transition-colors duration-200 ease-in-out focus:outline-none 
          focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 
          focus:ring-offset-white dark:focus:ring-offset-gray-800
          ${isAllAgesOnly 
            ? "bg-purple-600 hover:bg-purple-700" 
            : "bg-gray-200 hover:bg-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500"
          }
        `}
        aria-label={isAllAgesOnly ? "Show all age shows" : "Show all ages shows only"}
        role="switch"
        aria-checked={isAllAgesOnly}
      >
        <span
          className={`
            inline-block h-4 w-4 transform rounded-full bg-white 
            shadow-lg transition-transform duration-200 ease-in-out
            ${isAllAgesOnly ? "translate-x-4" : "translate-x-0"}
          `}
        />
      </button>
    </div>
  );
};