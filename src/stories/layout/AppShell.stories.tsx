import type { Meta, StoryObj } from "@storybook/react";
import { AppShell } from "@/components/layout/AppShell";
import React from "react";

// Simple mock content component
const MockPageContent = () => (
  <div className="p-6 lg:p-8">
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">
        Sample Page Content
      </h1>
      <div className="grid gap-6">
        <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Event Cards
          </h2>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-700"
              >
                <div className="font-medium text-gray-900 dark:text-white">
                  Sample Event {i}
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-300">
                  Sample venue • Tonight at 8pm
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </div>
);

// Note: AppShell is complex to mock properly since it uses many internal hooks
// For now, we'll create a simplified demo that shows the visual structure

const AppShellDemo = ({
  showError,
  showLoading,
}: {
  showError?: boolean;
  showLoading?: boolean;
}) => {
  if (showLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (showError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md mx-auto text-center p-6 bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="text-red-600 mb-4">
            <svg
              className="h-12 w-12 mx-auto"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Failed to Load Application
          </h2>
          <p className="text-gray-600 mb-4">
            Unable to connect to the data service.
          </p>
          <button className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="flex flex-col min-h-screen lg:flex-row">
        {/* Simplified layout representation */}
        <div className="flex-1 flex flex-col min-h-screen">
          {/* Mock Header */}
          <header className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 h-16 flex items-center px-4">
            <div className="text-xl font-bold text-gray-900 dark:text-white">
              Zivv
            </div>
            <div className="flex-1 max-w-lg mx-4">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search artists, venues..."
                  className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  readOnly
                />
              </div>
            </div>
            <div className="flex items-center space-x-3">
              <button className="p-2 text-gray-500 dark:text-gray-400">
                🌙
              </button>
            </div>
          </header>

          {/* Mock Content */}
          <main className="flex-1 pb-16 lg:pb-0">
            <MockPageContent />
          </main>

          {/* Mock Bottom Navigation - Mobile */}
          <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 h-16">
            <div className="grid grid-cols-4 h-full">
              {["Home", "Calendar", "Artists", "Venues"].map((item) => (
                <div
                  key={item}
                  className="flex flex-col items-center justify-center"
                >
                  <div className="w-6 h-6 bg-gray-400 rounded mb-1"></div>
                  <span className="text-xs text-gray-500">{item}</span>
                </div>
              ))}
            </div>
          </nav>
        </div>
      </div>
    </div>
  );
};

const meta: Meta<typeof AppShellDemo> = {
  title: "Layout Components/AppShell",
  component: AppShellDemo,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Main application shell providing the overall layout structure with header, sidebar navigation, main content area, and bottom navigation. This is a simplified demo showing the visual structure.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ height: "100vh", overflow: "hidden" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AppShellDemo>;

/**
 * Default application shell with content loaded
 */
export const Default: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Default AppShell state with all components loaded and ready. Shows header, bottom navigation (mobile), and content area.",
      },
    },
  },
};

/**
 * Loading state during app initialization
 */
export const Loading: Story = {
  args: {
    showLoading: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "AppShell showing the loading state during application initialization. Displays a full-screen loading spinner.",
      },
    },
  },
};

/**
 * Error state when initialization fails
 */
export const InitializationError: Story = {
  args: {
    showError: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "AppShell error state when critical initialization fails. Shows error message with retry option.",
      },
    },
  },
};

/**
 * Mobile layout with bottom navigation
 */
export const MobileLayout: Story = {
  parameters: {
    viewport: {
      defaultViewport: "iphone13",
    },
    docs: {
      description: {
        story:
          "AppShell in mobile layout - bottom navigation is visible, and header is responsive.",
      },
    },
  },
};

/**
 * Dark mode shell
 */
export const DarkMode: Story = {
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "AppShell in dark mode - demonstrates dark theme styling across all layout components.",
      },
    },
  },
};
