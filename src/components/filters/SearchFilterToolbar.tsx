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
      <div className="flex flex-row gap-4">
        <UpcomingToggle />
        <AgeRestrictionToggle />
      </div>

      {/* City filters */}
      <CityPagination />

      {/* Date filters */}
      <DatePagination />

      {/* Venue filter */}
      <VenueFilter />
    </div>
  );
};
