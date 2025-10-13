/**
 * Date pagination navigation for filtering events by specific days
 * Shows TODAY, TOMORROW, and next 5 days with punk rock styling
 */

import React, { useMemo } from "react";
import { useFilterStore } from "@/stores/filterStore";

interface DatePaginationProps {
  className?: string;
}

export const DatePagination: React.FC<DatePaginationProps> = ({
  className = "",
}) => {
  const { filters, updateFilter, clearFilter } = useFilterStore();

  // Generate 7 consecutive days starting from today
  const days = useMemo(() => {
    const today = new Date();
    const days: Array<{
      date: Date;
      dateString: string; // YYYY-MM-DD format
      label: string;
      shortLabel: string;
      isToday: boolean;
      isTomorrow: boolean;
    }> = [];

    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);

      const dateString = date.toISOString().split("T")[0]; // YYYY-MM-DD

      let label: string;
      let shortLabel: string;

      if (i === 0) {
        label = "TODAY";
        shortLabel = "TOD";
      } else if (i === 1) {
        label = "TOMORROW";
        shortLabel = "TOM";
      } else {
        // Use abbreviated day names (SUN, MON, TUE, etc.)
        label = date
          .toLocaleDateString("en-US", { weekday: "short" })
          .toUpperCase();
        shortLabel = label.substring(0, 3);
      }

      days.push({
        date,
        dateString,
        label,
        shortLabel,
        isToday: i === 0,
        isTomorrow: i === 1,
      });
    }

    return days;
  }, []);

  // Check if a day is currently selected
  const isSelected = (dateString: string) => {
    return filters.dates?.includes(dateString) || false;
  };

  // Handle day selection (toggle)
  const handleDayClick = (dateString: string) => {
    const currentDates = filters.dates || [];

    if (isSelected(dateString)) {
      // Remove the date from selection
      const updatedDates = currentDates.filter((d) => d !== dateString);
      if (updatedDates.length === 0) {
        clearFilter("dates");
      } else {
        updateFilter("dates", updatedDates);
      }
    } else {
      // Add the date to selection
      updateFilter("dates", [...currentDates, dateString]);
    }
  };

  // Clear all date filters
  const handleClearAll = () => {
    clearFilter("dates");
  };

  return (
    <div className={`date-pagination ${className}`}>
      {/* Header with Clear All button */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Filter by Day
        </div>
        {filters.dates && filters.dates.length > 0 && (
          <button
            onClick={handleClearAll}
            className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-mono transition-colors"
          >
            CLEAR
          </button>
        )}
      </div>

      {/* Day buttons - responsive wrapping */}
      <div className="flex flex-wrap gap-1 sm:gap-2">
        {days.map((day) => {
          const selected = isSelected(day.dateString);

          return (
            <button
              key={day.dateString}
              onClick={() => handleDayClick(day.dateString)}
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
              title={day.label}
            >
              <div className="leading-tight text-[10px] sm:text-xs">
                <span className="hidden sm:inline">{day.label}</span>
                <span className="sm:hidden">{day.shortLabel}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
