import type { Meta, StoryObj } from "@storybook/react";
import {
  LoadingSpinner,
  PageLoading,
  InlineLoading,
  Skeleton,
  EventCardSkeleton,
  ArtistCardSkeleton,
  VenueCardSkeleton,
  ListSkeleton,
  TableSkeleton,
  CalendarSkeleton,
  SearchSkeleton,
  FilterSkeleton,
  LoadingOverlay,
} from "@/components/ui/LoadingSpinner";
import React from "react";

const meta: Meta<typeof LoadingSpinner> = {
  title: "UI Components/LoadingSpinner",
  component: LoadingSpinner,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Comprehensive loading and skeleton components for different loading states. Includes basic spinners, page loading, inline loading, and various skeleton components for content placeholders.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    size: {
      control: "select",
      options: ["sm", "md", "lg", "xl"],
      description: "Size of the loading spinner",
    },
    className: {
      control: "text",
      description: "Additional CSS classes to apply to the component",
    },
  },
  decorators: [
    (Story) => (
      <div className="p-4 bg-gray-50 dark:bg-gray-900">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof LoadingSpinner>;

/**
 * Default loading spinner
 */
export const Default: Story = {
  args: {
    size: "md",
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "The basic loading spinner in medium size. Shows the rotating blue spinner animation.",
      },
    },
  },
};

/**
 * All sizes comparison
 */
export const AllSizes: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Comparison of all available spinner sizes: small, medium, large, and extra-large.",
      },
    },
  },
  render: () => (
    <div className="space-y-8">
      <div className="flex items-center space-x-4">
        <span className="w-16 text-sm font-medium">Small:</span>
        <LoadingSpinner size="sm" />
      </div>
      <div className="flex items-center space-x-4">
        <span className="w-16 text-sm font-medium">Medium:</span>
        <LoadingSpinner size="md" />
      </div>
      <div className="flex items-center space-x-4">
        <span className="w-16 text-sm font-medium">Large:</span>
        <LoadingSpinner size="lg" />
      </div>
      <div className="flex items-center space-x-4">
        <span className="w-16 text-sm font-medium">XL:</span>
        <LoadingSpinner size="xl" />
      </div>
    </div>
  ),
};

/**
 * Page loading component
 */
export const FullPageLoading: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Full page loading component with centered spinner and text. Designed for page transitions and initial app loading.",
      },
    },
  },
  render: () => <PageLoading />,
  decorators: [
    (Story) => (
      <div className="h-96 bg-gray-50 dark:bg-gray-900 rounded-lg overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

/**
 * Inline loading variations
 */
export const InlineLoadingVariations: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Inline loading components with different messages and sizes, suitable for buttons, forms, and inline content.",
      },
    },
  },
  render: () => (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Small inline loading</h3>
        <InlineLoading message="Saving..." size="sm" />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Medium inline loading</h3>
        <InlineLoading message="Loading events..." size="md" />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Large inline loading</h3>
        <InlineLoading message="Processing data..." size="lg" />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Default message</h3>
        <InlineLoading />
      </div>
    </div>
  ),
};

/**
 * Basic skeleton components
 */
export const BasicSkeletons: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Basic skeleton components for text and content placeholders with different shapes and sizes.",
      },
    },
  },
  render: () => (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Text skeletons</h3>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Different sizes</h3>
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-12 w-64" />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Shapes</h3>
        <div className="flex items-center space-x-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-16 w-16 rounded-lg" />
        </div>
      </div>
    </div>
  ),
};

/**
 * Event card skeleton
 */
export const EventCardSkeletonDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Skeleton placeholder for event cards, matching the structure of real event cards with header, title, venue, and footer elements.",
      },
    },
  },
  render: () => (
    <div className="max-w-md">
      <EventCardSkeleton />
    </div>
  ),
};

/**
 * Artist card skeleton
 */
export const ArtistCardSkeletonDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Skeleton placeholder for artist cards with circular avatar and artist information layout.",
      },
    },
  },
  render: () => (
    <div className="max-w-md">
      <ArtistCardSkeleton />
    </div>
  ),
};

/**
 * Venue card skeleton
 */
export const VenueCardSkeletonDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Skeleton placeholder for venue cards showing venue name, address, and additional information structure.",
      },
    },
  },
  render: () => (
    <div className="max-w-md">
      <VenueCardSkeleton />
    </div>
  ),
};

/**
 * List skeletons
 */
export const ListSkeletonDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "List skeleton component showing multiple skeleton items for different types of content lists.",
      },
    },
  },
  render: () => (
    <div className="space-y-8">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Event list skeleton</h3>
        <ListSkeleton count={3} itemSkeleton={EventCardSkeleton} />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Artist list skeleton</h3>
        <ListSkeleton count={4} itemSkeleton={ArtistCardSkeleton} />
      </div>
    </div>
  ),
};

/**
 * Table skeleton
 */
export const TableSkeletonDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Table skeleton with customizable rows and columns for data table loading states.",
      },
    },
  },
  render: () => (
    <div className="space-y-8">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">
          Default table (5 rows, 4 columns)
        </h3>
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <TableSkeleton />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">
          Custom table (3 rows, 6 columns)
        </h3>
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <TableSkeleton rows={3} cols={6} />
        </div>
      </div>
    </div>
  ),
};

/**
 * Calendar skeleton
 */
export const CalendarSkeletonDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Calendar skeleton showing the month view structure with days and placeholder events.",
      },
    },
  },
  render: () => <CalendarSkeleton />,
};

/**
 * Search results skeleton
 */
export const SearchSkeletonDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Search results skeleton with result count and individual search result item placeholders.",
      },
    },
  },
  render: () => <SearchSkeleton />,
};

/**
 * Filter panel skeleton
 */
export const FilterSkeletonDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Filter panel skeleton showing filter sections with checkboxes and options for sidebar filtering interfaces.",
      },
    },
  },
  render: () => (
    <div className="max-w-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <FilterSkeleton />
    </div>
  ),
};

/**
 * Loading overlay
 */
export const LoadingOverlayDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Loading overlay component that can be placed over existing content. Toggle the loading state to see the overlay effect.",
      },
    },
  },
  render: () => {
    const [isLoading, setIsLoading] = React.useState(false);

    return (
      <div className="space-y-4">
        <button
          onClick={() => setIsLoading(!isLoading)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          {isLoading ? "Stop Loading" : "Start Loading"}
        </button>

        <LoadingOverlay
          isLoading={isLoading}
          message="Processing your request..."
        >
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 min-h-[200px]">
            <h3 className="text-lg font-semibold mb-4">Sample Content</h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              This is some sample content that gets overlaid with a loading
              spinner when loading is active.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gray-100 dark:bg-gray-700 p-4 rounded">
                Item 1
              </div>
              <div className="bg-gray-100 dark:bg-gray-700 p-4 rounded">
                Item 2
              </div>
              <div className="bg-gray-100 dark:bg-gray-700 p-4 rounded">
                Item 3
              </div>
              <div className="bg-gray-100 dark:bg-gray-700 p-4 rounded">
                Item 4
              </div>
            </div>
          </div>
        </LoadingOverlay>
      </div>
    );
  },
};

/**
 * Dark mode skeletons
 */
export const DarkModeSkeletons: Story = {
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "Skeleton components in dark mode showing proper contrast and theming for dark backgrounds.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="dark p-4 bg-gray-900">
        <Story />
      </div>
    ),
  ],
  render: () => (
    <div className="space-y-8">
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-white">
          Text skeletons (dark)
        </h3>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-white">
          Event card skeleton (dark)
        </h3>
        <EventCardSkeleton />
      </div>
    </div>
  ),
};

/**
 * Custom colors
 */
export const CustomColors: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Examples showing how to customize spinner colors using CSS classes for different themes and use cases.",
      },
    },
  },
  render: () => (
    <div className="space-y-8">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Custom colored spinners</h3>
        <div className="flex items-center space-x-8">
          <div className="text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-red-600 mx-auto mb-2" />
            <span className="text-xs">Red</span>
          </div>
          <div className="text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-green-600 mx-auto mb-2" />
            <span className="text-xs">Green</span>
          </div>
          <div className="text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-purple-600 mx-auto mb-2" />
            <span className="text-xs">Purple</span>
          </div>
          <div className="text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-orange-600 mx-auto mb-2" />
            <span className="text-xs">Orange</span>
          </div>
        </div>
      </div>
    </div>
  ),
};

/**
 * Mobile layout
 */
export const MobileLayout: Story = {
  parameters: {
    viewport: {
      defaultViewport: "mobile",
    },
    docs: {
      description: {
        story:
          "Loading components optimized for mobile layouts with appropriate sizes and spacing.",
      },
    },
  },
  render: () => (
    <div className="space-y-6">
      <InlineLoading message="Loading..." size="sm" />
      <EventCardSkeleton />
      <div className="flex justify-center">
        <LoadingSpinner size="md" />
      </div>
    </div>
  ),
};

