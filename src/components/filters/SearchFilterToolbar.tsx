/**
 * SearchFilterToolbar - Complete filter toolbar combining all filter components
 */

import React from "react";
import { DatePagination } from "@/components/ui/DatePagination";
import { CityPagination } from "@/components/ui/CityPagination";
import { VenueFilter } from "@/components/ui/VenueFilter";
import { AgeRestrictionToggle } from "@/components/ui/AgeRestrictionToggle";
import { UpcomingToggle } from "@/components/ui/UpcomingToggle";

interface SearchFilterToolbarProps {
  className?: string;
}

export const SearchFilterToolbar: React.FC<SearchFilterToolbarProps> = ({
  className = "",
}) => {
  return (
    <div className={`space-y-4 ${className}`}>
      {/* Toggles - Upcoming and Age restriction */}
      <div className="flex flex-col space-y-3">
        <UpcomingToggle />
        <AgeRestrictionToggle />
      </div>

      {/* City filters */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Cities
        </label>
        <CityPagination />
      </div>

      {/* Date filters */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Dates
        </label>
        <DatePagination />
      </div>

      {/* Venue filter */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Venues
        </label>
        <VenueFilter />
      </div>
    </div>
  );
};
