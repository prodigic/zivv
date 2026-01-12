import type { Meta, StoryObj } from "@storybook/react";
import { UpcomingToggle } from "@/components/ui/UpcomingToggle";
import React from "react";

const meta: Meta<typeof UpcomingToggle> = {
  title: "UI Components/UpcomingToggle",
  component: UpcomingToggle,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Toggle for showing only upcoming events/artists/venues vs. all events including past ones. Features smooth toggle animation and clear state labeling.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    className: {
      control: "text",
      description: "Additional CSS classes to apply to the component",
    },
  },
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
type Story = StoryObj<typeof UpcomingToggle>;

/**
 * Default state
 */
export const Default: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Default state of the upcoming toggle. Click to switch between showing all events vs. upcoming events only.",
      },
    },
  },
};

/**
 * Interactive demonstration
 */
export const Interactive: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Live interactive toggle. Click to switch between 'All' and 'Upcoming' modes. Watch the label change and the toggle animation.",
      },
    },
  },
};

/**
 * Dark mode
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
          "Upcoming toggle in dark mode, showing proper contrast and styling for dark themes.",
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
 * Focus states
 */
export const FocusStates: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Demonstrates keyboard focus states for accessibility. Use Tab to focus and Enter/Space to toggle.",
      },
    },
    pseudo: {
      focus: ["button"],
    },
  },
};

/**
 * Mobile layout
 */
export const MobileLayout: Story = {
  args: {
    className: "",
  },
  parameters: {
    viewport: {
      defaultViewport: "mobile",
    },
    docs: {
      description: {
        story:
          "Mobile layout showing how the toggle appears on smaller screens with appropriate touch targets.",
      },
    },
  },
};

/**
 * Custom styling
 */
export const CustomStyling: Story = {
  args: {
    className: "p-2 border border-blue-300 rounded-lg bg-blue-50",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Example with custom CSS classes applied for styling customization.",
      },
    },
  },
};

/**
 * Compact layout
 */
export const CompactLayout: Story = {
  args: {
    className: "text-xs",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Compact version with smaller text, suitable for toolbar or dense layouts.",
      },
    },
  },
};

/**
 * State demonstration
 */
export const StateDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Side-by-side demonstration showing both possible states of the toggle.",
      },
    },
  },
  render: () => (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Shows All Events (Default)
        </h3>
        <UpcomingToggle />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Toggle is off - shows both past and upcoming events
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Shows Upcoming Only
        </h3>
        <UpcomingToggle />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Toggle is on - shows only future events
        </p>
      </div>
    </div>
  ),
};

/**
 * Accessibility demonstration
 */
export const Accessibility: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Demonstrates accessibility features including proper ARIA labels, role='switch', and keyboard navigation support.",
      },
    },
  },
};

/**
 * Loading state simulation
 */
export const LoadingState: Story = {
  args: {
    className: "opacity-50 pointer-events-none",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Simulated loading state using CSS classes to show how the toggle might appear while data is being loaded.",
      },
    },
  },
};

