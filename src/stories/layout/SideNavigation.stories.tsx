import type { Meta, StoryObj } from "@storybook/react";
import { SideNavigation } from "@/components/layout/SideNavigation";
import React from "react";

// Create a wrapper that provides mock data
const SideNavigationWithMocks = (props: any) => {
  // Mock the store data
  const mockManifest = props.manifest || {
    totalEvents: 245,
    totalArtists: 89,
    totalVenues: 42,
    lastUpdated: "2025-10-14T00:00:00Z",
  };

  const mockUpcomingEvents = props.upcomingEvents || [
    { id: "event-1", dateEpochMs: Date.now() + 86400000 },
    { id: "event-2", dateEpochMs: Date.now() + 172800000 },
    { id: "event-3", dateEpochMs: Date.now() + 259200000 },
  ];

  // Mock the store hooks at render time
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__storybookMockAppStore = {
        manifest: mockManifest,
        getUpcomingEvents: (limit: number = 3) =>
          mockUpcomingEvents.slice(0, limit),
      };
      (window as any).__storybookMockFilterStore = {
        hasActiveFilters: props.hasActiveFilters || false,
        getFilterSummary: () => props.filterSummary || "No active filters",
      };
    }
  });

  return <SideNavigation {...props} />;
};

const meta: Meta<typeof SideNavigationWithMocks> = {
  title: "Layout Components/SideNavigation",
  component: SideNavigationWithMocks,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Side navigation component for desktop and mobile layouts. Features main navigation, active filter display, upcoming events preview, and data statistics with debug toggle.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="flex h-screen bg-gray-50 dark:bg-gray-900">
        <Story />
        <div className="flex-1 p-8 overflow-auto">
          <div className="max-w-2xl mx-auto bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
              Main Content Area
            </h2>
            <p className="text-gray-600 dark:text-gray-300 mb-4">
              This demonstrates how the side navigation works alongside main
              content. The sidebar is fixed on desktop and shows as an overlay
              on mobile.
            </p>
            <div className="space-y-3">
              <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded">
                Navigation State: Open
              </div>
              <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded">
                Current Route: /
              </div>
              <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded">
                Layout: Desktop (fixed sidebar) / Mobile (overlay)
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
  ],
  args: {
    isOpen: true,
    onClose: () => console.log("Side navigation closed"),
    className: "",
    hasActiveFilters: false,
    filterSummary: "No active filters",
  },
  argTypes: {
    isOpen: { control: "boolean" },
    onClose: { action: "navigation closed" },
    className: { control: "text" },
    hasActiveFilters: { control: "boolean" },
    filterSummary: { control: "text" },
  },
};

export default meta;
type Story = StoryObj<typeof SideNavigationWithMocks>;

/**
 * Default open sidebar navigation
 */
export const Default: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Default side navigation with all sections: main nav, upcoming events, and data statistics.",
      },
    },
  },
};

/**
 * Sidebar with active filters shown
 */
export const WithActiveFilters: Story = {
  args: {
    hasActiveFilters: true,
    filterSummary: "San Francisco, Tonight, Free shows",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Side navigation showing active filters section with current filter summary.",
      },
    },
  },
};

/**
 * Sidebar with no upcoming events
 */
export const NoUpcomingEvents: Story = {
  args: {
    upcomingEvents: [],
  },
  parameters: {
    docs: {
      description: {
        story: "Side navigation when there are no upcoming events to display.",
      },
    },
  },
};

/**
 * Closed sidebar state
 */
export const Closed: Story = {
  args: {
    isOpen: false,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Side navigation in closed state - useful for testing open/close animations and mobile overlay behavior.",
      },
    },
  },
};

/**
 * Mobile layout sidebar
 */
export const MobileLayout: Story = {
  args: {
    hasActiveFilters: true,
    filterSummary: "Oakland, Tomorrow",
  },
  parameters: {
    viewport: {
      defaultViewport: "iphone13",
    },
    docs: {
      description: {
        story:
          "Side navigation in mobile layout - shows mobile header with close button and full sidebar content.",
      },
    },
  },
};

/**
 * Dark mode sidebar
 */
export const DarkMode: Story = {
  args: {
    hasActiveFilters: true,
    filterSummary: "Berkeley, Free shows, All ages",
  },
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "Side navigation in dark mode with active filters and upcoming events.",
      },
    },
  },
};
