/**
 * Page size selector dropdown for controlling events per page
 * Allows users to select 25, 50, or 100 events per page
 */

import React, { useState, useRef, useEffect } from "react";

interface PageSizeSelectorProps {
  value: number;
  onChange: (pageSize: number) => void;
  className?: string;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100];

export const PageSizeSelector: React.FC<PageSizeSelectorProps> = ({
  value,
  onChange,
  className = "",
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleSelect = (pageSize: number) => {
    onChange(pageSize);
    setIsOpen(false);
  };

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 px-3 py-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span>{value}/page</span>
        <svg
          className={`w-4 h-4 transition-transform ${
            isOpen ? "rotate-180" : "rotate-0"
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg z-50 min-w-[100px]">
          {PAGE_SIZE_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => handleSelect(option)}
              className={`
                w-full px-3 py-2 text-sm text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors
                first:rounded-t-md last:rounded-b-md
                ${
                  option === value
                    ? "bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    : "text-gray-700 dark:text-gray-300"
                }
              `}
              role="option"
              aria-selected={option === value}
            >
              {option} per page
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
