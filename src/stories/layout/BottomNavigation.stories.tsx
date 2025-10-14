import type { Meta, StoryObj } from "@storybook/react";
import { BottomNavigation } from "@/components/layout/BottomNavigation";
import React from "react";

// Wrapper to control current path for demonstrations
const BottomNavigationWithPath = ({
  currentPath,
  ...props
}: { currentPath: string } & any) => {
  // Mock useLocation hook
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__storybookMockLocation = { pathname: currentPath };
    }
  });

  return <BottomNavigation {...props} />;
};

const meta: Meta<typeof BottomNavigationWithPath> = {
  title: "Layout Components/BottomNavigation",
  component: BottomNavigationWithPath,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Bottom navigation component for mobile devices. Provides quick access to main sections with visual indicators for the active page.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 pb-16">
        {/* Sample page content */}
        <div className="p-6">
          <div className="max-w-2xl mx-auto bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
              Page Content
            </h1>
            <p className="text-gray-600 dark:text-gray-300 mb-4">
              This demonstrates how the bottom navigation appears at the bottom
              of the screen on mobile devices, providing quick access to main
              sections.
            </p>

            {/* Sample content to show scrolling */}
            <div className="space-y-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div
                  key={i}
                  className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg"
                >
                  <div className="font-medium text-gray-900 dark:text-white">
                    Content Block {i}
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-300 mt-2">
                    This content shows how the bottom navigation works with
                    scrollable content. The navigation bar stays fixed at the
                    bottom while content scrolls.
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom Navigation */}
        <Story />
      </div>
    ),
  ],
  args: {
    className: "",
    currentPath: "/",
  },
  argTypes: {
    className: { control: "text" },
    currentPath: {
      control: {
        type: "select",
        options: ["/", "/calendar", "/artists", "/venues"],
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof BottomNavigationWithPath>;

/**
 * Home page active (default state)
 */
export const HomeActive: Story = {
  args: {
    currentPath: "/",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Bottom navigation with Home tab active - shows filled icon and blue color for current page.",
      },
    },
  },
};

/**
 * Calendar page active
 */
export const CalendarActive: Story = {
  args: {
    currentPath: "/calendar",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Bottom navigation with Calendar tab active - demonstrates active state styling on calendar icon.",
      },
    },
  },
};

/**
 * Artists page active
 */
export const ArtistsActive: Story = {
  args: {
    currentPath: "/artists",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Bottom navigation with Artists tab active - shows active state with filled people icon.",
      },
    },
  },
};

/**
 * Venues page active
 */
export const VenuesActive: Story = {
  args: {
    currentPath: "/venues",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Bottom navigation with Venues tab active - displays active state with filled location icon.",
      },
    },
  },
};

/**
 * Mobile portrait layout
 */
export const MobilePortrait: Story = {
  args: {
    currentPath: "/",
  },
  parameters: {
    viewport: {
      defaultViewport: "iphone13",
    },
    docs: {
      description: {
        story:
          "Bottom navigation in mobile portrait layout - optimized spacing and touch targets for mobile use.",
      },
    },
  },
};

/**
 * Dark mode bottom navigation
 */
export const DarkMode: Story = {
  args: {
    currentPath: "/artists",
  },
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "Bottom navigation in dark mode - shows dark theme styling with proper contrast and active states.",
      },
    },
  },
};

/**
 * With custom styling
 */
export const CustomStyling: Story = {
  args: {
    currentPath: "/venues",
    className: "border-t-2 border-blue-500",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Bottom navigation with custom styling - demonstrates how className prop can be used to customize appearance.",
      },
    },
  },
};
