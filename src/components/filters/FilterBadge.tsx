/**
 * FilterBadge - Badge indicator showing count of active filters
 */

import React from "react";

interface FilterBadgeProps {
  count: number;
  className?: string;
}

export const FilterBadge: React.FC<FilterBadgeProps> = ({
  count,
  className = "",
}) => {
  if (count === 0) return null;

  return (
    <span
      className={`absolute -top-1 -right-1 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-blue-600 dark:bg-blue-500 rounded-full ${className}`}
      aria-label={`${count} active filters`}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
};
