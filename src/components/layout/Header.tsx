/**
 * Header component with search, filters, and navigation
 */

import React, { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useFilterStore } from "@/stores/filterStore.ts";
import { useAppStore } from "@/stores/appStore.ts";
import { CompactDarkModeToggle } from "@/components/ui/DarkModeToggle.tsx";
import {
  ToolbarFilterDropdown,
  SearchFilterToolbar,
} from "@/components/filters";
import type { Event } from "@/types/events";

interface HeaderProps {
  onMenuToggle: () => void;
  className?: string;
}

// View Toggle Component
const ViewToggle: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const isCalendarView = location.pathname.startsWith("/calendar");

  const toggleView = () => {
    if (isCalendarView) {
      navigate("/");
    } else {
      navigate("/calendar");
    }
  };

  return (
    <div className="hidden md:flex items-center space-x-2">
      <span className="text-sm text-gray-600 dark:text-gray-300 w-16 text-right">
        {isCalendarView ? "Calendar" : "List"}
      </span>
      <button
        onClick={toggleView}
        className="relative inline-flex h-5 w-9 items-center rounded-full border-2 border-gray-300 dark:border-gray-500 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-gray-800"
        aria-label={
          isCalendarView ? "Switch to list view" : "Switch to calendar view"
        }
        role="switch"
        aria-checked={isCalendarView}
      >
        <span
          className={`
            inline-block h-4 w-4 transform rounded-full shadow-lg border-2
            transition-all duration-200 ease-in-out
            ${
              isCalendarView
                ? "translate-x-4 bg-blue-600 border-blue-600 dark:bg-blue-400 dark:border-blue-400"
                : "translate-x-0 bg-white border-gray-300 dark:border-gray-500"
            }
          `}
        />
      </button>
    </div>
  );
};

// Language Dropdown Component
const LanguageDropdown: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [currentLang, setCurrentLang] = useState("EN");
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const languages = [
    { code: "EN", name: "English", flag: "🇺🇸" },
    { code: "ES", name: "Español", flag: "🇪🇸" },
    { code: "TL", name: "Tagalog", flag: "🇵🇭" },
    { code: "ZH-CN", name: "Mandarin", flag: "🇨🇳" },
    { code: "ZH-HK", name: "Cantonese", flag: "🇭🇰" },
    { code: "VI", name: "Tiếng Việt", flag: "🇻🇳" },
    { code: "FR", name: "Français", flag: "🇫🇷" },
    { code: "DE", name: "Deutsch", flag: "🇩🇪" },
  ];

  // Handle click outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-1 px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label="Select language"
      >
        <span className="text-base">🌐</span>
        <span className="hidden sm:inline">{currentLang}</span>
        <svg
          className="w-3 h-3 ml-1"
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
        <div className="absolute right-0 mt-1 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md shadow-lg z-50">
          <div className="py-1">
            {languages.map((lang) => (
              <button
                key={lang.code}
                onClick={() => {
                  setCurrentLang(lang.code);
                  setIsOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-sm flex items-center space-x-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
                  currentLang === lang.code
                    ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20"
                    : "text-gray-700 dark:text-gray-300"
                }`}
              >
                <span>{lang.flag}</span>
                <span>{lang.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export const Header: React.FC<HeaderProps> = ({
  onMenuToggle,
  className = "",
}) => {
  const navigate = useNavigate();
  const { searchQuery, setSearchQuery } = useFilterStore();
  const { searchEvents, loading } = useAppStore();

  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [searchResults, setSearchResults] = useState<Event[]>([]);

  // Handle search input
  const handleSearchChange = async (query: string) => {
    setSearchQuery(query);

    if (query.trim().length > 2) {
      try {
        const results = await searchEvents(query);
        setSearchResults(results.slice(0, 5)); // Show top 5 results
      } catch (error) {
        console.error("Search failed:", error);
        setSearchResults([]);
      }
    } else {
      setSearchResults([]);
    }
  };

  // Handle search submit
  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/?q=${encodeURIComponent(searchQuery.trim())}`);
      setIsSearchFocused(false);
      setSearchResults([]);
    }
  };

  return (
    <header
      className={`bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm shadow-sm border-b border-gray-200 dark:border-gray-700 sticky top-0 z-50 ${className}`}
    >
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Left: Menu Button + Logo */}
          <div className="flex items-center">
            {/* Mobile menu button */}
            <button
              onClick={onMenuToggle}
              className="lg:hidden p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
              aria-label="Open menu"
            >
              <svg
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>

            {/* Logo */}
            <Link to="/" className="ml-2 lg:ml-0 flex items-center">
              <div className="text-xl font-bold text-gray-900 dark:text-white">
                Zivv
              </div>
              <div className="ml-2 hidden sm:block text-sm text-gray-600 dark:text-gray-300">
                Bay Area Shows
              </div>
            </Link>
          </div>

          {/* Center: Search */}
          <div className="flex-1 max-w-lg mx-4 relative">
            <form onSubmit={handleSearchSubmit}>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg
                    className="h-5 w-5 text-gray-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  onFocus={() => setIsSearchFocused(true)}
                  onBlur={() =>
                    setTimeout(() => setIsSearchFocused(false), 150)
                  }
                  placeholder="Search artists, venues..."
                  aria-label="Search artists, venues, and events"
                  className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md leading-5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 dark:focus:ring-blue-400 dark:focus:border-blue-400 sm:text-sm"
                />
              </div>
            </form>

            {/* Search Results Dropdown */}
            {isSearchFocused && searchResults.length > 0 && (
              <div className="absolute z-50 mt-1 w-full bg-white rounded-md shadow-lg border border-gray-200">
                <div className="py-1 max-h-64 overflow-y-auto">
                  {searchResults.map((result, index) => (
                    <button
                      key={index}
                      onClick={() => {
                        navigate(`/event/${result.slug}`);
                        setIsSearchFocused(false);
                      }}
                      className="w-full text-left px-4 py-2 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
                    >
                      <div className="text-sm font-medium text-gray-900">
                        {/* This would show artist names - placeholder for now */}
                        Event {result.id}
                      </div>
                      <div className="text-sm text-gray-500">
                        {new Date(result.dateEpochMs).toLocaleDateString()}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Loading indicator */}
            {loading.search === "loading" && (
              <div className="absolute right-3 top-2.5">
                <svg
                  className="animate-spin h-4 w-4 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              </div>
            )}
          </div>

          {/* Right: Filter + View + Language + Dark Mode */}
          <div className="flex items-center space-x-3">
            {/* Unified Filter Dropdown */}
            <ToolbarFilterDropdown>
              <SearchFilterToolbar />
            </ToolbarFilterDropdown>

            {/* View Toggle - Desktop only */}
            <ViewToggle />

            {/* About Link - Desktop only */}
            <div className="hidden md:block">
              <Link
                to="/about"
                className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                About
              </Link>
            </div>

            {/* Language Dropdown */}
            <LanguageDropdown />

            {/* Dark Mode Toggle */}
            <CompactDarkModeToggle />
          </div>
        </div>
      </div>
    </header>
  );
};
