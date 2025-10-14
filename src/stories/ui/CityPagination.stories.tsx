import type { Meta, StoryObj } from "@storybook/react";
import { CityPagination } from "@/components/ui/CityPagination";
import React from "react";

const meta: Meta<typeof CityPagination> = {
  title: "UI Components/CityPagination",
  component: CityPagination,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "City filter component for selecting specific cities (San Francisco, Oakland, Berkeley, Santa Cruz). Shows buttons for each city with active state highlighting. Note: These stories show the UI appearance but store interactions are mocked.",
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
      <div className="p-4 bg-gray-50 dark:bg-gray-900">
        <div className="max-w-4xl mx-auto">
          <Story />
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CityPagination>;

/**
 * Default state with no cities selected
 */
export const Default: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "The default state showing all available cities (San Francisco, Oakland, Berkeley, Santa Cruz). No cities are selected.",
      },
    },
  },
};

/**
 * Interactive demonstration
 *
 * Click city buttons to see selection interactions
 */
export const Interactive: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Live interactive component. Click on city buttons (San Francisco, Oakland, Berkeley, Santa Cruz) to see real selection interactions. Check the Actions panel to see function calls.",
      },
    },
  },
};

/**
 * Hover states demonstration
 */
export const HoverStates: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Demonstration of hover states on city buttons. Hover over buttons to see the interaction effects and focus states.",
      },
    },
    pseudo: {
      hover: ["button:nth-of-type(1)"],
      focus: ["button:nth-of-type(2)"],
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
          "Default state in dark mode, showing proper contrast and styling for city buttons.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="dark p-4 bg-gray-900">
        <div className="max-w-4xl mx-auto">
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
          "Mobile responsive layout showing how city buttons adapt to smaller screens with proper touch targets and spacing.",
      },
    },
  },
};

/**
 * Tablet layout
 */
export const TabletLayout: Story = {
  args: {
    className: "",
  },
  parameters: {
    viewport: {
      defaultViewport: "tablet",
    },
    docs: {
      description: {
        story:
          "Tablet layout showing how city buttons scale for medium-sized screens.",
      },
    },
  },
};

/**
 * With custom styling
 */
export const CustomStyling: Story = {
  args: {
    className: "border-2 border-green-500 rounded-lg p-2 bg-green-50",
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
 * Accessibility focus demonstration
 */
export const AccessibilityFocus: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Demonstrates keyboard navigation and focus states for accessibility. Use Tab key to navigate between city buttons.",
      },
    },
  },
};

/**
 * Compact layout
 */
export const CompactLayout: Story = {
  args: {
    className: "space-y-1",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Compact version with reduced spacing, suitable for dense UI layouts.",
      },
    },
  },
};

/**
 * Error state simulation
 */
export const ErrorStateSimulation: Story = {
  args: {
    className: "border border-red-300 bg-red-50 p-2 rounded",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Simulated error state using custom CSS classes to show how the component might look during an error condition.",
      },
    },
  },
};

/**
 * Loading state simulation
 */
export const LoadingStateSimulation: Story = {
  args: {
    className: "opacity-50 pointer-events-none",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Simulated loading state using CSS classes to show how the component might look during data loading.",
      },
    },
  },
};
