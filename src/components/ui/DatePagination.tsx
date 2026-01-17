/**
 * Date pagination navigation for filtering events by specific days
 * Shows TODAY, TOMORROW, and next 5 days with punk rock styling
 * Includes "This Week" and "This Month" options
 */

import React, { useMemo, useCallback } from "react";
import { useFilterStore } from "@/stores/filterStore";

interface DatePaginationProps {
  className?: string;
}

export const DatePagination: React.FC<DatePaginationProps> = ({
  className = "",
}) => {
  const { filters, updateFilter, clearFilter } = useFilterStore();

  // Helper functions for date range calculations
  const getThisWeekRange = useCallback(() => {
    const today = new Date();
    const startDate = today.toISOString().split("T")[0];
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 6);
    return {
      type: "week" as const,
      startDate,
      endDate: endDate.toISOString().split("T")[0],
    };
  }, []);

  const getThisMonthRange = useCallback(() => {
    const today = new Date();
    const startDate = today.toISOString().split("T")[0];
    const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return {
      type: "month" as const,
      startDate,
      endDate: endDate.toISOString().split("T")[0],
    };
  }, []);

  // Generate array of date strings for a range
  const getDateStringsInRange = useCallback(
    (startDate: string, endDate: string): string[] => {
      const start = new Date(startDate);
      const end = new Date(endDate);
      const dates: string[] = [];

      const current = new Date(start);
      while (current <= end) {
        dates.push(current.toISOString().split("T")[0]);
        current.setDate(current.getDate() + 1);
      }

      return dates;
    },
    []
  );

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
        label = "Today";
        shortLabel = "TODAY";
      } else if (i === 1) {
        label = "Tomorrow";
        shortLabel = "TOMORROW";
      } else {
        // Use abbreviated day names (SUN, MON, TUE, etc.)
        label = date
          .toLocaleDateString("en-US", { weekday: "short" })
          .toUpperCase();
        shortLabel = label; // Keep full 3-letter abbreviation (SUN, MON, TUE, etc.)
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

  // Check if this week is currently selected (all week dates are in the filter)
  const isThisWeekSelected = () => {
    const weekRange = getThisWeekRange();
    const weekDates = getDateStringsInRange(
      weekRange.startDate,
      weekRange.endDate
    );
    const currentDates = filters.dates || [];

    return (
      weekDates.length > 0 &&
      weekDates.every((date) => currentDates.includes(date))
    );
  };

  // Check if this month is currently selected (all month dates are in the filter)
  const isThisMonthSelected = () => {
    const monthRange = getThisMonthRange();
    const monthDates = getDateStringsInRange(
      monthRange.startDate,
      monthRange.endDate
    );
    const currentDates = filters.dates || [];

    return (
      monthDates.length > 0 &&
      monthDates.every((date) => currentDates.includes(date))
    );
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

  // Handle this week selection (toggle)
  const handleThisWeekClick = () => {
    const weekRange = getThisWeekRange();
    const weekDates = getDateStringsInRange(
      weekRange.startDate,
      weekRange.endDate
    );

    if (isThisWeekSelected()) {
      // Remove all week dates
      const currentDates = filters.dates || [];
      const updatedDates = currentDates.filter(
        (date) => !weekDates.includes(date)
      );
      if (updatedDates.length === 0) {
        clearFilter("dates");
      } else {
        updateFilter("dates", updatedDates);
      }
    } else {
      // Add all week dates (merge with existing)
      const currentDates = filters.dates || [];
      const newDates = [...currentDates];
      weekDates.forEach((date) => {
        if (!newDates.includes(date)) {
          newDates.push(date);
        }
      });
      updateFilter("dates", newDates);
    }
  };

  // Handle this month selection (toggle)
  const handleThisMonthClick = () => {
    const monthRange = getThisMonthRange();
    const monthDates = getDateStringsInRange(
      monthRange.startDate,
      monthRange.endDate
    );

    if (isThisMonthSelected()) {
      // Remove all month dates
      const currentDates = filters.dates || [];
      const updatedDates = currentDates.filter(
        (date) => !monthDates.includes(date)
      );
      if (updatedDates.length === 0) {
        clearFilter("dates");
      } else {
        updateFilter("dates", updatedDates);
      }
    } else {
      // Add all month dates (merge with existing)
      const currentDates = filters.dates || [];
      const newDates = [...currentDates];
      monthDates.forEach((date) => {
        if (!newDates.includes(date)) {
          newDates.push(date);
        }
      });
      updateFilter("dates", newDates);
    }
  };

  return (
    <div className={`date-pagination ${className}`}>
      {/* Header with icon and Clear All button */}
      <div className="flex items-center gap-3 xxs:gap-1 xs:gap-2">
        {/* Calendar Icon */}
        <div className="flex-shrink-0">
          <svg
            className="w-8 h-8 xxs:w-6 xxs:h-6 xs:w-7 xs:h-7 text-gray-600 dark:text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-label="Date Filter"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <span className="sr-only">Filter by Date</span>
        </div>

        <div className="flex-1">
          {/* Single row of all date filter options */}
          <div className="flex flex-wrap gap-2 items-center">
            {/* Month Button */}
            <button
              onClick={handleThisMonthClick}
              className={`
                px-3 py-2 rounded-md font-mono text-sm font-bold
                border border-dashed transition-all duration-200
                min-w-[60px] text-center
                ${
                  isThisMonthSelected()
                    ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-300 dark:border-green-600"
                    : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-green-50 dark:hover:bg-green-900/20"
                }
              `}
            >
              <span className="hidden sm:inline">Month</span>
              <span className="sm:hidden">MONTH</span>
            </button>

            {/* Week Button */}
            <button
              onClick={handleThisWeekClick}
              className={`
                px-3 py-2 rounded-md font-mono text-sm font-bold
                border border-dashed transition-all duration-200
                min-w-[60px] text-center
                ${
                  isThisWeekSelected()
                    ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-600"
                    : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                }
              `}
            >
              <span className="hidden sm:inline">Week</span>
              <span className="sm:hidden">WEEK</span>
            </button>

            {/* Day buttons - Today and Tomorrow first, then the rest */}
            {days.map((day) => {
              const selected = isSelected(day.dateString);
              return (
                <button
                  key={day.dateString}
                  onClick={() => handleDayClick(day.dateString)}
                  className={`
                    px-3 py-2 rounded-md font-mono text-sm font-bold
                    border border-dashed transition-all duration-200
                    min-w-[80px] text-center
                    ${
                      selected
                        ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-300 dark:border-red-600"
                        : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                    }
                  `}
                  title={day.label}
                >
                  {/* Full name for large screens */}
                  <span className="hidden sm:inline text-sm">
                    {day.label}
                  </span>
                  {/* Abbreviated name for small/medium screens */}
                  <span className="sm:hidden text-sm">{day.shortLabel}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
