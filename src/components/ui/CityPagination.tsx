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
      { name: "San Francisco", normalizedName: "S.f", slug: "sf" },
      { name: "Oakland", normalizedName: "Oakland", slug: "oakland" },
      { name: "Berkeley", normalizedName: "Berkeley", slug: "berkeley" },
      { name: "Santa Cruz", normalizedName: "Santa", slug: "santa-cruz" },
      { name: "Other", normalizedName: "Other", slug: "other" },
    ],
    []
  );

  // Check if a city is currently selected
  const isSelected = (cityName: string) => {
    const currentCities = filters.cities || [];

    if (cityName === "Other") {
      // Check if any other cities are selected
      return otherCities.some((city) => currentCities.includes(city));
    } else {
      // For main cities, check by normalized name
      const actualCityName =
        cities.find((c) => c.name === cityName)?.normalizedName || cityName;
      return currentCities.includes(actualCityName);
    }
  };

  // Handle city selection (toggle)
  const handleCityClick = (cityName: string) => {
    const currentCities = filters.cities || [];

    if (cityName === "Other") {
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
      // Handle main cities normally
      const actualCityName =
        cities.find((c) => c.name === cityName)?.normalizedName || cityName;

      if (isSelected(actualCityName)) {
        // Remove the city from selection
        const updatedCities = currentCities.filter((c) => c !== actualCityName);
        if (updatedCities.length === 0) {
          clearFilter("cities");
        } else {
          updateFilter("cities", updatedCities);
        }
      } else {
        // Add the city to selection
        updateFilter("cities", [...currentCities, actualCityName]);
      }
    }
  };

  // Clear all city filters
  const handleClearAll = () => {
    clearFilter("cities");
  };

  return (
    <div className={`city-pagination ${className}`}>
      {/* Header with Clear All button */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Filter by City
        </div>
        {filters.cities && filters.cities.length > 0 && (
          <button
            onClick={handleClearAll}
            className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-mono transition-colors"
          >
            CLEAR
          </button>
        )}
      </div>

      {/* City buttons - responsive wrapping */}
      <div className="flex flex-wrap gap-1 sm:gap-2">
        {cities.map((city) => {
          const selected = isSelected(city.name);

          return (
            <button
              key={city.slug}
              onClick={() => handleCityClick(city.name)}
              className={`
                px-2 py-1.5 sm:px-3 sm:py-2 rounded-lg font-mono text-xs font-bold
                border-2 border-dashed transition-all duration-200
                min-w-[48px] sm:min-w-[60px] text-center flex-1 sm:flex-initial
                ${
                  selected
                    ? "bg-red-600 text-white border-red-700 shadow-lg transform scale-105"
                    : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-red-50 dark:hover:bg-red-900/20 hover:border-red-300 dark:hover:border-red-600"
                }
                ${!selected ? "hover:scale-102" : ""}
              `}
              title={city.name}
            >
              <div className="leading-tight text-[10px] sm:text-xs">
                <span className="hidden sm:inline">{city.name}</span>
                <span className="sm:hidden">{city.slug.toUpperCase()}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
