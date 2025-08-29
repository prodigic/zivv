/**
 * Toggle for showing only upcoming events/artists/venues
 */

import React from "react";
import { useAppStore } from "@/stores/appStore";

interface UpcomingToggleProps {
  className?: string;
}

export const UpcomingToggle: React.FC<UpcomingToggleProps> = ({ className = "" }) => {
  const showUpcomingOnly = useAppStore(state => state.showUpcomingOnly);
  const toggleUpcomingOnly = useAppStore(state => state.toggleUpcomingOnly);

  return (
    <div className={`flex items-center space-x-2 ${className}`}>
      <span className="text-sm text-gray-600 dark:text-gray-300 w-16 text-right">
        {showUpcomingOnly ? "Upcoming" : "All"}
      </span>
      <button
        onClick={toggleUpcomingOnly}
        className="relative inline-flex h-5 w-9 items-center rounded-full border-2 border-gray-300 dark:border-gray-500 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-gray-800"
        aria-label={showUpcomingOnly ? "Show all events" : "Show upcoming only"}
        role="switch"
        aria-checked={showUpcomingOnly}
      >
        <span
          className={`
            inline-block h-4 w-4 transform rounded-full shadow-lg border-2
            transition-all duration-200 ease-in-out
            ${showUpcomingOnly 
              ? "translate-x-4 bg-blue-600 border-blue-600 dark:bg-blue-400 dark:border-blue-400" 
              : "translate-x-0 bg-white border-gray-300 dark:border-gray-500"
            }
          `}
        />
      </button>
    </div>
  );
};