import type { Meta, StoryObj } from "@storybook/react";
import { DatePagination } from "@/components/ui/DatePagination";
import { CityPagination } from "@/components/ui/CityPagination";
import { VenueFilter } from "@/components/ui/VenueFilter";
import { UpcomingToggle } from "@/components/ui/UpcomingToggle";
import { FreeShowsToggle } from "@/components/ui/FreeShowsToggle";
import { AgeRestrictionToggle } from "@/components/ui/AgeRestrictionToggle";
import React from "react";

// Mock search filter toolbar component that combines all filter elements
const SearchFilterToolbar: React.FC<{ className?: string }> = ({
  className = "",
}) => {
  return (
    <div
      className={`bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 ${className}`}
    >
      {/* Main filter bar */}
      <div className="px-4 py-4 space-y-4">
        {/* Top row - toggles */}
        <div className="flex flex-wrap items-center gap-4 sm:gap-6">
          <UpcomingToggle />
          <FreeShowsToggle />
          <AgeRestrictionToggle />
        </div>

        {/* Second row - city filters */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Cities
          </label>
          <CityPagination />
        </div>

        {/* Third row - date filters */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Dates
          </label>
          <DatePagination />
        </div>

        {/* Fourth row - venue filter */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Venues
          </label>
          <VenueFilter />
        </div>
      </div>
    </div>
  );
};

// Compact version for mobile/smaller screens
const CompactSearchFilterToolbar: React.FC<{ className?: string }> = ({
  className = "",
}) => {
  const [isExpanded, setIsExpanded] = React.useState(false);

  return (
    <div
      className={`bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 ${className}`}
    >
      {/* Compact header with expand toggle */}
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <UpcomingToggle />
          <FreeShowsToggle />
        </div>

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center space-x-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
        >
          <span>Filters</span>
          <svg
            className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
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
      </div>

      {/* Expandable filter section */}
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-gray-100 dark:border-gray-700 space-y-4">
          <AgeRestrictionToggle />
          <CityPagination className="text-sm" />
          <DatePagination className="text-sm" />
          <VenueFilter className="text-sm" />
        </div>
      )}
    </div>
  );
};

const meta: Meta<typeof SearchFilterToolbar> = {
  title: "Component Groups/SearchFilterToolbar",
  component: SearchFilterToolbar,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Complete search and filter toolbar combining all filter components. Shows how DatePagination, CityPagination, VenueFilter, and toggle components work together to create a comprehensive filtering interface.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    className: {
      control: "text",
      description: "Additional CSS classes to apply to the toolbar",
    },
  },
};

export default meta;
type Story = StoryObj<typeof SearchFilterToolbar>;

/**
 * Default filter toolbar
 */
export const Default: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Complete filter toolbar with all components in their default states. Shows the full desktop layout with proper spacing and organization.",
      },
    },
  },
};

/**
 * Compact mobile version
 */
export const CompactMobile: Story = {
  render: () => <CompactSearchFilterToolbar />,
  parameters: {
    viewport: {
      defaultViewport: "mobile",
    },
    docs: {
      description: {
        story:
          "Compact mobile version with collapsible filters. Essential toggles are always visible, while detailed filters can be expanded.",
      },
    },
  },
};

/**
 * Dark mode toolbar
 */
export const DarkMode: Story = {
  args: {
    className: "",
  },
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "Filter toolbar in dark mode showing proper theming across all filter components.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="dark">
        <Story />
      </div>
    ),
  ],
};

/**
 * With active filters simulation
 */
export const WithActiveFilters: Story = {
  render: () => (
    <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {/* Filter status bar */}
      <div className="px-4 py-2 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-100 dark:border-blue-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 text-sm">
            <span className="text-blue-700 dark:text-blue-300 font-medium">
              Active filters:
            </span>
            <span className="px-2 py-1 bg-blue-100 dark:bg-blue-800 text-blue-800 dark:text-blue-200 rounded-full text-xs">
              San Francisco
            </span>
            <span className="px-2 py-1 bg-blue-100 dark:bg-blue-800 text-blue-800 dark:text-blue-200 rounded-full text-xs">
              This Week
            </span>
            <span className="px-2 py-1 bg-blue-100 dark:bg-blue-800 text-blue-800 dark:text-blue-200 rounded-full text-xs">
              Free Shows
            </span>
          </div>
          <button className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200">
            Clear all
          </button>
        </div>
      </div>

      {/* Main toolbar */}
      <SearchFilterToolbar />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Toolbar with simulated active filters showing a status bar with filter chips and clear all functionality.",
      },
    },
  },
};

/**
 * Horizontal layout variation
 */
export const HorizontalLayout: Story = {
  render: () => (
    <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <div className="px-4 py-3">
        {/* Single row layout for wider screens */}
        <div className="flex flex-wrap items-center gap-6">
          {/* Toggles group */}
          <div className="flex items-center space-x-4">
            <UpcomingToggle />
            <FreeShowsToggle />
            <AgeRestrictionToggle />
          </div>

          {/* Divider */}
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-600"></div>

          {/* Cities */}
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              Cities:
            </span>
            <CityPagination className="scale-90" />
          </div>

          {/* Divider */}
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-600"></div>

          {/* Dates */}
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              Dates:
            </span>
            <DatePagination className="scale-90" />
          </div>

          {/* Divider */}
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-600"></div>

          {/* Venues */}
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              Venues:
            </span>
            <VenueFilter className="min-w-[200px]" />
          </div>
        </div>
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Horizontal layout variation for wider screens, organizing all filters in a single row with visual separators.",
      },
    },
  },
};

/**
 * Loading state
 */
export const LoadingState: Story = {
  render: () => (
    <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <div className="px-4 py-4 space-y-4 animate-pulse">
        {/* Loading skeleton for toolbar */}
        <div className="flex space-x-4">
          <div className="h-8 w-20 bg-gray-200 dark:bg-gray-700 rounded"></div>
          <div className="h-8 w-16 bg-gray-200 dark:bg-gray-700 rounded"></div>
          <div className="h-8 w-24 bg-gray-200 dark:bg-gray-700 rounded"></div>
        </div>

        <div className="space-y-2">
          <div className="h-4 w-12 bg-gray-200 dark:bg-gray-700 rounded"></div>
          <div className="flex space-x-2">
            <div className="h-8 w-16 bg-gray-200 dark:bg-gray-700 rounded"></div>
            <div className="h-8 w-20 bg-gray-200 dark:bg-gray-700 rounded"></div>
            <div className="h-8 w-18 bg-gray-200 dark:bg-gray-700 rounded"></div>
            <div className="h-8 w-24 bg-gray-200 dark:bg-gray-700 rounded"></div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="h-4 w-10 bg-gray-200 dark:bg-gray-700 rounded"></div>
          <div className="flex space-x-1">
            {Array.from({ length: 7 }, (_, i) => (
              <div
                key={i}
                className="h-8 w-12 bg-gray-200 dark:bg-gray-700 rounded"
              ></div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="h-4 w-14 bg-gray-200 dark:bg-gray-700 rounded"></div>
          <div className="h-10 w-64 bg-gray-200 dark:bg-gray-700 rounded"></div>
        </div>
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Loading state simulation showing skeleton placeholders while filter data is being loaded.",
      },
    },
  },
};

/**
 * Responsive breakpoint demonstration
 */
export const ResponsiveBreakpoints: Story = {
  render: () => (
    <div className="space-y-4">
      {/* Desktop version */}
      <div className="hidden lg:block">
        <div className="bg-blue-50 dark:bg-blue-900/20 p-2 text-center text-sm text-blue-700 dark:text-blue-300">
          Desktop Layout (lg+)
        </div>
        <SearchFilterToolbar />
      </div>

      {/* Tablet version */}
      <div className="hidden md:block lg:hidden">
        <div className="bg-green-50 dark:bg-green-900/20 p-2 text-center text-sm text-green-700 dark:text-green-300">
          Tablet Layout (md)
        </div>
        <SearchFilterToolbar className="px-2" />
      </div>

      {/* Mobile version */}
      <div className="block md:hidden">
        <div className="bg-orange-50 dark:bg-orange-900/20 p-2 text-center text-sm text-orange-700 dark:text-orange-300">
          Mobile Layout (sm)
        </div>
        <CompactSearchFilterToolbar />
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Demonstration of responsive behavior across different screen sizes. Resize the viewport to see how the toolbar adapts.",
      },
    },
  },
};

/**
 * Accessibility features
 */
export const AccessibilityFeatures: Story = {
  render: () => (
    <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <div className="px-4 py-2 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-600">
        <p className="text-sm text-yellow-800 dark:text-yellow-200">
          ♿ Use Tab to navigate between filters, Enter/Space to activate, and
          Escape to close dropdowns
        </p>
      </div>

      <SearchFilterToolbar />

      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900/50 text-xs text-gray-600 dark:text-gray-400 space-y-1">
        <div>
          <strong>Keyboard navigation:</strong> Tab, Enter, Space, Escape
        </div>
        <div>
          <strong>Screen reader support:</strong> ARIA labels, roles, and live
          regions
        </div>
        <div>
          <strong>Focus management:</strong> Proper focus indicators and
          keyboard traps
        </div>
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Highlights accessibility features including keyboard navigation, ARIA labels, and screen reader support across all filter components.",
      },
    },
  },
};
