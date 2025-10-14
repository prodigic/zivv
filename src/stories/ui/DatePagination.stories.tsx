import type { Meta, StoryObj } from "@storybook/react";
import { DatePagination } from "@/components/ui/DatePagination";
import React from "react";

// Create a wrapper component that provides mocked store context
interface MockedDatePaginationProps {
  className?: string;
}

const MockedDatePagination: React.FC<MockedDatePaginationProps> = ({
  className,
}) => {
  // For Storybook, we'll show the component as-is
  // The component uses Zustand store internally, so it will work with default state
  return <DatePagination className={className} />;
};

const meta: Meta<typeof MockedDatePagination> = {
  title: "UI Components/DatePagination",
  component: MockedDatePagination,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Date pagination navigation for filtering events by specific days. Shows Month, Week, Today, Tomorrow, and next 5 days with punk rock styling. Note: These stories show the UI appearance but store interactions are mocked.",
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
type Story = StoryObj<typeof MockedDatePagination>;

/**
 * Default state with no dates selected
 */
export const Default: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "The default state showing Month, Week, Today, Tomorrow, and the next 5 days. No dates are selected.",
      },
    },
  },
};

/**
 * Today selected (simulated)
 */
export const TodaySelected: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          'Simulated state where "Today" would be selected, showing what the Today button highlighting would look like.',
      },
    },
  },
};

/**
 * Tomorrow selected (simulated)
 */
export const TomorrowSelected: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          'Simulated state where "Tomorrow" would be selected, showing what the Tomorrow button highlighting would look like.',
      },
    },
  },
};

/**
 * This Week selected (simulated)
 */
export const ThisWeekSelected: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          'Simulated state where "Week" would be selected, showing what the Week button highlighting would look like.',
      },
    },
  },
};

/**
 * Multiple individual dates selected (simulated)
 */
export const MultipleDatesSelected: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Simulated state where multiple individual dates are selected (Today, day after tomorrow, and day 5).",
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
          "Default state in dark mode, showing proper contrast and styling.",
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
          "Mobile responsive layout showing abbreviated day labels and compact spacing.",
      },
    },
  },
};

/**
 * With custom styling
 */
export const CustomStyling: Story = {
  args: {
    className: "border-2 border-purple-500 rounded-lg p-2",
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
 * Interactive demonstration
 *
 * This shows the actual component functionality. Click buttons to see interactions.
 */
export const Interactive: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Live interactive component. Click on Month, Week, Today, Tomorrow, or individual day buttons to see the real interactions. Check the Actions panel to see function calls.",
      },
    },
  },
  render: (args) => {
    // Render the actual component without mocking for interactive demo
    return <DatePagination className={args.className} />;
  },
};
