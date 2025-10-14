import type { Meta, StoryObj } from "@storybook/react";
import { FreeShowsToggle } from "@/components/ui/FreeShowsToggle";
import React from "react";

const meta: Meta<typeof FreeShowsToggle> = {
  title: "UI Components/FreeShowsToggle",
  component: FreeShowsToggle,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Toggle for filtering between free shows only vs. all shows (free and paid). Uses distinctive labels and smooth toggle animation to clearly indicate the price filtering state.",
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
type Story = StoryObj<typeof FreeShowsToggle>;

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
          "Default state showing all shows (both free and paid). Click to toggle to free shows only mode.",
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
          "Live interactive toggle. Click to switch between 'All Shows' ($$) and 'Free Shows Only' (Free) modes. Notice the label changes from '$$' to 'Free'.",
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
          "Free shows toggle in dark mode, showing proper contrast and styling for dark themes.",
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
          "Demonstrates keyboard focus states for accessibility. Use Tab to focus and Enter/Space to toggle between free and all shows.",
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
          "Mobile layout showing how the toggle appears on smaller screens with appropriate touch targets and compact labeling.",
      },
    },
  },
};

/**
 * Custom styling
 */
export const CustomStyling: Story = {
  args: {
    className: "p-3 border border-green-300 rounded-lg bg-green-50",
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
 * State demonstration
 */
export const StateDemo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Side-by-side demonstration showing both possible states of the toggle with explanations.",
      },
    },
  },
  render: () => (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          All Shows (Default)
        </h3>
        <FreeShowsToggle />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Shows '$$' label - displays both free and paid events
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Free Shows Only
        </h3>
        <FreeShowsToggle />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Shows 'Free' label - displays only free events
        </p>
      </div>
    </div>
  ),
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
          "Compact version with smaller text, suitable for toolbar or dense layouts where space is limited.",
      },
    },
  },
};

/**
 * With tooltip context
 */
export const WithTooltipContext: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Example showing how the toggle might appear with additional context or tooltips explaining the filtering behavior.",
      },
    },
  },
  render: (args) => (
    <div className="space-y-2">
      <FreeShowsToggle className={args.className} />
      <div className="text-xs text-gray-500 dark:text-gray-400 max-w-xs">
        Toggle between showing all events (free and paid) or only free events.
        The label changes to indicate the current filter state.
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
          "Demonstrates accessibility features including proper ARIA labels that change based on state, role='switch', and keyboard navigation support.",
      },
    },
  },
};

/**
 * Error state simulation
 */
export const ErrorState: Story = {
  args: {
    className: "border border-red-300 bg-red-50 p-2 rounded opacity-75",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Simulated error state showing how the toggle might appear when there's an issue with price filtering.",
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
          "Simulated loading state using CSS classes to show how the toggle might appear while price data is being loaded.",
      },
    },
  },
};
