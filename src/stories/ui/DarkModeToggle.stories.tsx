import type { Meta, StoryObj } from "@storybook/react";
import {
  DarkModeToggle,
  CompactDarkModeToggle,
} from "@/components/ui/DarkModeToggle";
import React from "react";

const meta: Meta<typeof DarkModeToggle> = {
  title: "UI Components/DarkModeToggle",
  component: DarkModeToggle,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Dark mode toggle component with light/dark theme switching. Available in both full-size and compact variants. Includes smooth animations and proper accessibility support.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    className: {
      control: "text",
      description: "Additional CSS classes to apply to the component",
    },
    size: {
      control: "select",
      options: ["sm", "md", "lg"],
      description: "Size variant of the toggle",
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
type Story = StoryObj<typeof DarkModeToggle>;

/**
 * Default dark mode toggle
 */
export const Default: Story = {
  args: {
    className: "",
    size: "md",
  },
  parameters: {
    docs: {
      description: {
        story:
          "The default dark mode toggle in medium size. Click to see the toggle animation between light and dark modes.",
      },
    },
  },
};

/**
 * Small size variant
 */
export const SmallSize: Story = {
  args: {
    className: "",
    size: "sm",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Small size variant suitable for compact UI layouts or mobile interfaces.",
      },
    },
  },
};

/**
 * Large size variant
 */
export const LargeSize: Story = {
  args: {
    className: "",
    size: "lg",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Large size variant for prominent placement or accessibility requirements.",
      },
    },
  },
};

/**
 * All sizes comparison
 */
export const SizesComparison: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Comparison of all three size variants (small, medium, large) side by side.",
      },
    },
  },
  render: () => (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <span className="w-16 text-sm font-medium">Small:</span>
        <DarkModeToggle size="sm" />
      </div>
      <div className="flex items-center gap-4">
        <span className="w-16 text-sm font-medium">Medium:</span>
        <DarkModeToggle size="md" />
      </div>
      <div className="flex items-center gap-4">
        <span className="w-16 text-sm font-medium">Large:</span>
        <DarkModeToggle size="lg" />
      </div>
    </div>
  ),
};

/**
 * Compact variant
 */
export const CompactVariant: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Compact dark mode toggle variant designed for headers, toolbars, and mobile navigation. Uses icon-only design.",
      },
    },
  },
  render: (args) => <CompactDarkModeToggle className={args.className} />,
};

/**
 * Dark theme preview
 */
export const DarkThemePreview: Story = {
  args: {
    className: "",
    size: "md",
  },
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "Dark mode toggle displayed in dark theme to show proper contrast and styling.",
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
 * Compact variant in dark theme
 */
export const CompactDarkTheme: Story = {
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "Compact dark mode toggle in dark theme, showing icon visibility and hover states.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="dark p-8 bg-gray-900">
        <div className="max-w-md mx-auto">
          <CompactDarkModeToggle />
        </div>
      </div>
    ),
  ],
  render: () => <CompactDarkModeToggle />,
};

/**
 * Focus states demonstration
 */
export const FocusStates: Story = {
  args: {
    className: "",
    size: "md",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Demonstrates keyboard focus states for accessibility. Use Tab to focus the toggle and Enter/Space to activate.",
      },
    },
    pseudo: {
      focus: ["button"],
    },
  },
};

/**
 * Custom styling
 */
export const CustomStyling: Story = {
  args: {
    className: "ring-2 ring-purple-500 ring-offset-2 rounded-full",
    size: "lg",
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
 * Mobile layout
 */
export const MobileLayout: Story = {
  args: {
    className: "",
    size: "sm",
  },
  parameters: {
    viewport: {
      defaultViewport: "mobile",
    },
    docs: {
      description: {
        story:
          "Mobile layout showing how the toggle appears on smaller screens with appropriate touch target sizing.",
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
    size: "md",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Live interactive toggle. Click to switch between light and dark modes and see the smooth animation transition.",
      },
    },
  },
};

/**
 * Both variants side by side
 */
export const VariantsComparison: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Comparison of the full toggle and compact variants side by side to show the different use cases.",
      },
    },
  },
  render: () => (
    <div className="space-y-8">
      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Full Toggle
        </h3>
        <DarkModeToggle size="md" />
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Best for settings pages, preference panels, and standalone controls.
        </p>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Compact Toggle
        </h3>
        <CompactDarkModeToggle />
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Best for headers, toolbars, and compact navigation areas.
        </p>
      </div>
    </div>
  ),
};

