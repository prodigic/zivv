/**
 * City pagination navigation for filtering events by specific cities
 * Shows major Bay Area cities with punk rock styling
 */

import React, { useMemo } from "react";
import { useFilterStore } from "@/stores/filterStore";

interface CityPaginationProps {
  className?: string;
}

export const CityPagination: React.FC<CityPaginationProps> = ({
  className = "",
}) => {
  const { filters, updateFilter, clearFilter } = useFilterStore();

  // Define city categories
  const otherCities = ["Albany", "Napa", "Novato", "140", "2045"]; // Other cities from the data

  // Major Bay Area cities as requested
  const cities = useMemo(
    () => [
      { name: "San Francisco", normalizedName: "S.f", slug: "sf", shortName: "SF" },
      { name: "Oakland", normalizedName: "Oakland", slug: "oakland", shortName: "OAK" },
      { name: "Berkeley", normalizedName: "Berkeley", slug: "berkeley", shortName: "BRK" },
      { name: "Santa Cruz", normalizedName: "Santa", slug: "santa-cruz", shortName: "SCZ" },
      { name: "Other", normalizedName: "Other", slug: "other", shortName: "OTHER" },
    ],
    []
  );

  // Check if a city is currently selected
  const isSelected = (normalizedName: string) => {
    const currentCities = filters.cities || [];

    if (normalizedName === "Other") {
      // Check if any other cities are selected
      return otherCities.some((city) => currentCities.includes(city));
    } else {
      // For main cities, check by normalized name (the actual data city name)
      return currentCities.includes(normalizedName);
    }
  };

  // Handle city selection (toggle)
  const handleCityClick = (normalizedName: string) => {
    const currentCities = filters.cities || [];

    if (normalizedName === "Other") {
      // Handle "Other" category - toggle all other cities
      const hasOtherCities = otherCities.some((city) =>
        currentCities.includes(city)
      );

      if (hasOtherCities) {
        // Remove all other cities
        const updatedCities = currentCities.filter(
          (city) => !otherCities.includes(city)
        );
        if (updatedCities.length === 0) {
          clearFilter("cities");
        } else {
          updateFilter("cities", updatedCities);
        }
      } else {
        // Add all other cities
        const newOtherCities = otherCities.filter(
          (city) => !currentCities.includes(city)
        );
        updateFilter("cities", [...currentCities, ...newOtherCities]);
      }
    } else {
      // Handle main cities - store the normalized name (actual data city name)
      if (isSelected(normalizedName)) {
        // Remove the city from selection
        const updatedCities = currentCities.filter((c) => c !== normalizedName);
        if (updatedCities.length === 0) {
          clearFilter("cities");
        } else {
          updateFilter("cities", updatedCities);
        }
      } else {
        // Add the city to selection using normalized name
        updateFilter("cities", [...currentCities, normalizedName]);
      }
    }
  };

  return (
    <div className={`city-pagination ${className}`}>
      {/* Header with icon and Clear All button */}
      <div className="flex items-center gap-3 xxs:gap-1 xs:gap-2">
        {/* Cityscape Icon */}
        <div className="flex-shrink-0">
          <svg
            className="w-8 h-8 xxs:w-6 xxs:h-6 xs:w-7 xs:h-7 text-gray-600 dark:text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-label="City Filter"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 21h4V9h2V5h6v4h2v8h4m-4-8V7m-2 0V5m-2 4h2m-2 4h2m-6-6h2m-2 4h2m8 8V11m-2 4h2m-2 4h2"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 21h18"
            />
          </svg>
          <span className="sr-only">Filter by City</span>
        </div>

        <div className="flex-1">
          {/* Single row of city filter options */}
          <div className="flex flex-wrap gap-2 items-center">
            {cities.map((city) => {
              const selected = isSelected(city.normalizedName);
              return (
                <button
                  key={city.slug}
                  onClick={() => handleCityClick(city.normalizedName)}
                  className={`
                    px-3 py-2 rounded-md font-mono text-sm font-bold
                    border border-dashed transition-all duration-200
                    min-w-[60px] text-center
                    ${
                      selected
                        ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-300 dark:border-red-600"
                        : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                    }
                  `}
                  title={city.name}
                >
                  <div className="leading-tight">
                    {/* Full name for large screens */}
                    <span className="hidden sm:inline text-sm">{city.name}</span>
                    {/* Abbreviated name for small/medium screens */}
                    <span className="sm:hidden text-sm">{city.shortName}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
