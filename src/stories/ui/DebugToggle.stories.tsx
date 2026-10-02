import type { Meta, StoryObj } from "@storybook/react";
import { DebugToggle } from "@/components/ui/DebugToggle";
import React from "react";

const meta: Meta<typeof DebugToggle> = {
  title: "UI Components/DebugToggle",
  component: DebugToggle,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Debug toggle component for controlling debug information visibility across the application. Toggles between showing and hiding debug panels, performance metrics, and development information. Persists state in localStorage.",
      },
    },
  },
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="p-8 bg-gray-50 dark:bg-gray-900">
        <div className="max-w-md mx-auto">
          <Story />
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof DebugToggle>;

/**
 * Default debug toggle
 */
export const Default: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Default debug toggle button. Click to toggle debug mode on/off. The state is persisted in localStorage and affects debug panel visibility across the app.",
      },
    },
  },
};

/**
 * Interactive demonstration
 */
export const Interactive: Story = {
  render: () => (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Debug Toggle Control
        </h3>
        <DebugToggle />
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <h3 className="text-sm font-medium mb-2">Sample Debug Information</h3>
        <div className="debug-info space-y-1 text-xs text-gray-600 dark:text-gray-400">
          <div>Component render time: 2.3ms</div>
          <div>API response time: 127ms</div>
          <div>Memory usage: 45.2MB</div>
          <div>Active filters: 3</div>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-500 mt-2">
          This debug information would be hidden when debug mode is off
        </p>
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Interactive example showing how the debug toggle affects debug information visibility. Toggle debug mode to see how debug panels would be hidden/shown.",
      },
    },
  },
};

/**
 * Debug mode active state
 */
export const DebugModeActive: Story = {
  render: () => (
    <div className="space-y-4">
      <div className="flex items-center space-x-2">
        <DebugToggle />
        <span className="text-sm text-blue-600 dark:text-blue-400">
          Debug mode active
        </span>
      </div>

      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-600 rounded-lg p-3">
        <p className="text-sm text-blue-800 dark:text-blue-200">
          🐛 Debug panels and performance metrics are now visible across the
          application.
        </p>
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "State showing the debug toggle when debug mode is active, with visual feedback indicating the current state.",
      },
    },
  },
};

/**
 * Dark mode
 */
export const DarkMode: Story = {
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "Debug toggle in dark mode, showing proper contrast and styling for dark themes.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="dark p-8 bg-gray-900">
        <div className="max-w-md mx-auto">
          <Story />
        </div>
      </div>
    ),
  ],
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
          "Mobile layout showing how the debug toggle appears on smaller screens with appropriate touch targets.",
      },
    },
  },
};

/**
 * In toolbar context
 */
export const InToolbarContext: Story = {
  render: () => (
    <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-2">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Development Tools
        </h1>
        <div className="flex items-center space-x-2">
          <span className="text-sm text-gray-600 dark:text-gray-400">
            Debug:
          </span>
          <DebugToggle />
        </div>
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Example showing the debug toggle in a toolbar context, typically where it would appear in development interfaces.",
      },
    },
  },
};

/**
 * Focus states
 */
export const FocusStates: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Demonstrates keyboard focus states for accessibility. Use Tab to focus and Enter/Space to toggle debug mode.",
      },
    },
    pseudo: {
      focus: ["button"],
    },
  },
};

/**
 * State persistence demo
 */
export const StatePersistence: Story = {
  render: () => (
    <div className="space-y-4">
      <DebugToggle />

      <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-600 rounded-lg p-3">
        <p className="text-sm text-yellow-800 dark:text-yellow-200">
          💾 <strong>Persistence:</strong> The debug toggle state is saved to
          localStorage and will persist across browser sessions and page
          reloads.
        </p>
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-500 space-y-1">
        <div>
          Storage key:{" "}
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">
            zivv-debug-mode
          </code>
        </div>
        <div>
          Current value:{" "}
          <code
            className="bg-gray-100 dark:bg-gray-800 px-1 rounded"
            id="debug-value"
          >
            false
          </code>
        </div>
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Demonstration of the state persistence feature. Toggle debug mode and refresh the page to see that the state is maintained.",
      },
    },
  },
};

/**
 * Development vs production
 */
export const DevelopmentVsProduction: Story = {
  render: () => (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Development Environment
        </h3>
        <div className="flex items-center space-x-2">
          <DebugToggle />
          <span className="text-sm text-green-600 dark:text-green-400">
            Available
          </span>
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          Debug toggle is available in development builds
        </p>
      </div>

      <div className="space-y-2 opacity-60">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Production Environment
        </h3>
        <div className="flex items-center space-x-2">
          <div className="relative p-1.5 rounded opacity-50 cursor-not-allowed">
            <svg
              className="w-4 h-4 text-gray-400"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <span className="text-sm text-gray-500 dark:text-gray-500">
            Hidden
          </span>
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          Debug toggle is typically hidden in production builds
        </p>
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Comparison showing how the debug toggle appears in different environments - available in development, hidden in production.",
      },
    },
  },
};
