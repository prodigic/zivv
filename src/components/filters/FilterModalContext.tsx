/**
 * Shared context for filter modal state - allows both header and bottom nav to control the same modal
 */

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { FilterBadge } from "./FilterBadge";
import { useFilterStore } from "@/stores/filterStore";

interface FilterModalContextType {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  toggleModal: () => void;
}

const FilterModalContext = createContext<FilterModalContextType | undefined>(undefined);

export const useFilterModal = () => {
  const context = useContext(FilterModalContext);
  if (context === undefined) {
    throw new Error("useFilterModal must be used within a FilterModalProvider");
  }
  return context;
};

interface FilterModalProviderProps {
  children: React.ReactNode;
}

export const FilterModalProvider: React.FC<FilterModalProviderProps> = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();

  // Close modal on route change
  useEffect(() => {
    setIsOpen(false);
  }, [location.pathname]);

  // Handle ESC key to close
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  // Prevent body scroll when mobile panel is open
  useEffect(() => {
    if (isOpen) {
      // Check if mobile (viewport < 768px)
      const isMobile = window.innerWidth < 768;
      if (isMobile) {
        document.body.style.overflow = "hidden";
      }
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  const toggleModal = () => setIsOpen(!isOpen);

  return (
    <FilterModalContext.Provider value={{ isOpen, setIsOpen, toggleModal }}>
      {children}
    </FilterModalContext.Provider>
  );
};

interface FilterModalProps {
  children: React.ReactNode;
  className?: string;
}

export const FilterModal: React.FC<FilterModalProps> = ({ children, className = "" }) => {
  const { isOpen, setIsOpen } = useFilterModal();
  const { activeFilterCount } = useFilterStore();
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Handle click outside to close dropdown (desktop only)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Check if we're on mobile (viewport < 768px)
      const isMobile = window.innerWidth < 768;

      // Only enable click-outside-to-close on desktop
      // Mobile full-screen modals should only close via X button or ESC key
      if (!isMobile && dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, setIsOpen]);

  if (!isOpen) return null;

  return (
    <>
      {/* Mobile/Small Screen Full Modal */}
      <div
        className="fixed top-0 left-0 right-0 bottom-0 z-50 bg-white dark:bg-gray-800 md:hidden flex flex-col animate-slide-up"
        style={{
          paddingBottom: "env(safe-area-inset-bottom)",
          width: "100vw",
          height: "100vh"
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Filter options"
      >
        {/* Mobile Handle */}
        <div className="flex justify-center py-3 xxs:py-2 border-b border-gray-200 dark:border-gray-700">
          <div className="w-12 h-1 bg-gray-300 dark:bg-gray-600 rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 xxs:px-2 xs:px-3 py-3 xxs:py-2 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                ({activeFilterCount} active)
              </span>
            )}
          </h3>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            aria-label="Close filters"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Filter Content - Full Screen Scrollable */}
        <div className="flex-1 p-4 xxs:p-2 xs:p-3 overflow-y-auto">{children}</div>
      </div>

      {/* Desktop Dropdown */}
      <div
        className={`hidden md:block absolute right-0 mt-2 w-96 max-h-[600px] bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 overflow-visible animate-fade-in z-50 isolation ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label="Filter options"
        ref={dropdownRef}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                ({activeFilterCount} active)
              </span>
            )}
          </h3>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            aria-label="Close filters"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Filter Content */}
        <div
          className="p-4 xxs:p-2 xs:p-3 overflow-visible max-w-full"
          style={{ maxHeight: "calc(600px - 60px)" }}
        >
          {children}
        </div>
      </div>
    </>
  );
};

interface FilterButtonProps {
  className?: string;
  isMobile?: boolean;
}

export const FilterButton: React.FC<FilterButtonProps> = ({ className = "", isMobile = false }) => {
  const { isOpen, toggleModal } = useFilterModal();
  const { hasActiveFilters, activeFilterCount } = useFilterStore();

  return (
    <button
      onClick={toggleModal}
      className={`${
        isMobile
          ? `flex flex-col items-center justify-center space-y-1 transition-colors ${
              hasActiveFilters || isOpen
                ? "text-blue-600 dark:text-blue-400"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            }`
          : `relative p-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
              hasActiveFilters || isOpen
                ? "text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 bg-blue-50 dark:bg-blue-900/20"
                : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            }`
      } ${className}`}
      aria-label="Open filters"
      title="Open filters"
      aria-expanded={isOpen}
      aria-haspopup="true"
    >
      {/* Filter Icon */}
      <div className="relative">
        <svg
          className={isMobile ? "h-6 w-6" : "h-5 w-5"}
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          fill={hasActiveFilters || isOpen ? "currentColor" : "none"}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
          />
        </svg>

        {/* Badge indicator */}
        {isMobile ? (
          activeFilterCount > 0 && (
            <div className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-4 w-4 flex items-center justify-center font-medium">
              {activeFilterCount > 9 ? "9+" : activeFilterCount}
            </div>
          )
        ) : (
          <FilterBadge count={activeFilterCount} />
        )}
      </div>

      {/* Mobile label */}
      {isMobile && (
        <span className={`text-xs font-medium ${hasActiveFilters || isOpen ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`}>
          Filters
        </span>
      )}
    </button>
  );
};