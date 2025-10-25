import type { Meta, StoryObj } from "@storybook/react";
import { AgeRestrictionToggle } from "@/components/ui/AgeRestrictionToggle";
import React from "react";

const meta: Meta<typeof AgeRestrictionToggle> = {
  title: "UI Components/AgeRestrictionToggle",
  component: AgeRestrictionToggle,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Toggle for filtering between all-ages shows only vs. all shows (all-ages, 18+, 21+). Uses purple theming to distinguish from other toggles and clear labeling to indicate age restriction filtering.",
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
type Story = StoryObj<typeof AgeRestrictionToggle>;

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
          "Default state showing all shows (all ages, 18+, 21+). Click to toggle to all-ages only mode.",
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
          "Live interactive toggle. Click to switch between 'All shows' and 'All ages' modes. Notice the purple theming and label changes.",
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
          "Age restriction toggle in dark mode, showing proper contrast and purple theming for dark themes.",
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
          "Demonstrates keyboard focus states with purple focus ring for accessibility. Use Tab to focus and Enter/Space to toggle.",
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
    className: "p-3 border border-purple-300 rounded-lg bg-purple-50",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Example with custom CSS classes applied for styling customization, enhancing the purple theme.",
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
          "Side-by-side demonstration showing both possible states of the toggle with clear explanations.",
      },
    },
  },
  render: () => (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          All Shows (Default)
        </h3>
        <AgeRestrictionToggle />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Shows 'All shows' label - displays events with any age restriction
          (all ages, 18+, 21+)
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          All Ages Only
        </h3>
        <AgeRestrictionToggle />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Shows 'All ages' label - displays only events that allow all ages
        </p>
      </div>
    </div>
  ),
};

/**
 * Theming comparison
 */
export const ThemingComparison: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Comparison showing the distinctive purple theming of the age restriction toggle compared to other toggles in the system.",
      },
    },
  },
  render: () => (
    <div className="space-y-8">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Age Restriction Toggle (Purple Theme)
        </h3>
        <AgeRestrictionToggle />
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Uses purple colors to distinguish from other filter toggles
        </p>
      </div>

      <div className="space-y-2 opacity-50">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Other Toggles (Blue Theme - for comparison)
        </h3>
        <div className="flex items-center space-x-2">
          <span className="text-sm text-gray-600 dark:text-gray-300">
            Example:
          </span>
          <div className="relative inline-flex h-5 w-9 items-center rounded-full bg-blue-600">
            <span className="inline-block h-4 w-4 transform rounded-full bg-white translate-x-4 shadow-lg" />
          </div>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Standard blue theme used by other toggles
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
 * With context explanation
 */
export const WithContextExplanation: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Example showing how the toggle might appear with additional context explaining the age restriction filtering.",
      },
    },
  },
  render: (args) => (
    <div className="space-y-3">
      <AgeRestrictionToggle className={args.className} />
      <div className="text-xs text-gray-500 dark:text-gray-400 max-w-xs">
        <strong>All shows:</strong> Displays events with any age restriction
        (all ages, 18+, 21+)
        <br />
        <strong>All ages:</strong> Shows only events that welcome attendees of
        all ages
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
          "Demonstrates accessibility features including proper ARIA labels that change based on state, role='switch', purple focus rings, and keyboard navigation support.",
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
          "Simulated loading state using CSS classes to show how the toggle might appear while age restriction data is being loaded.",
      },
    },
  },
};

