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
      <span className="text-sm text-gray-600 dark:text-gray-300">
        {showUpcomingOnly ? "Upcoming only" : "Show all"}
      </span>
      <button
        onClick={toggleUpcomingOnly}
        className={`
          relative inline-flex h-5 w-9 items-center rounded-full 
          transition-colors duration-200 ease-in-out focus:outline-none 
          focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 
          focus:ring-offset-white dark:focus:ring-offset-gray-800
          ${showUpcomingOnly 
            ? "bg-primary-600 hover:bg-primary-700" 
            : "bg-gray-200 hover:bg-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500"
          }
        `}
        aria-label={showUpcomingOnly ? "Show all events" : "Show upcoming only"}
        role="switch"
        aria-checked={showUpcomingOnly}
      >
        <span
          className={`
            inline-block h-4 w-4 transform rounded-full bg-white 
            shadow-lg transition-transform duration-200 ease-in-out
            ${showUpcomingOnly ? "translate-x-4" : "translate-x-0"}
          `}
        />
      </button>
    </div>
  );
};