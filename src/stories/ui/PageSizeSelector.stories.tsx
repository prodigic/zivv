import type { Meta, StoryObj } from "@storybook/react";
import { PageSizeSelector } from "@/components/ui/PageSizeSelector";
import React from "react";

// Simple action logger for Storybook
const action =
  (name: string) =>
  (...args: any[]) => {
    console.log(`Action: ${name}`, args);
  };

const meta: Meta<typeof PageSizeSelector> = {
  title: "UI Components/PageSizeSelector",
  component: PageSizeSelector,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Page size selector dropdown for controlling the number of items displayed per page. Supports 25, 50, and 100 items per page with a clean dropdown interface.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    value: {
      control: "select",
      options: [25, 50, 100],
      description: "Currently selected page size",
    },
    onChange: {
      action: "page size changed",
      description: "Callback function when page size changes",
    },
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
type Story = StoryObj<typeof PageSizeSelector>;

/**
 * Default state (25 items)
 */
export const Default: Story = {
  args: {
    value: 25,
    onChange: action("page-size-changed"),
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Default state showing 25 items per page selected. Click the dropdown to see other options.",
      },
    },
  },
};

/**
 * 50 items selected
 */
export const FiftyItemsSelected: Story = {
  args: {
    value: 50,
    onChange: action("page-size-changed"),
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "State with 50 items per page selected, showing how the component displays different values.",
      },
    },
  },
};

/**
 * 100 items selected
 */
export const HundredItemsSelected: Story = {
  args: {
    value: 100,
    onChange: action("page-size-changed"),
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "State with 100 items per page selected, showing the maximum available page size option.",
      },
    },
  },
};

/**
 * Interactive demonstration
 */
export const Interactive: Story = {
  render: () => {
    const [pageSize, setPageSize] = React.useState(25);

    return (
      <div className="space-y-4">
        <PageSizeSelector
          value={pageSize}
          onChange={(newSize) => {
            setPageSize(newSize);
            action("page-size-changed")(newSize);
          }}
        />
        <div className="text-sm text-gray-600 dark:text-gray-400">
          Current page size: <strong>{pageSize} items</strong>
        </div>
      </div>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "Live interactive selector. Choose different page sizes to see the state update and check the Actions panel for events.",
      },
    },
  },
};

/**
 * Dark mode
 */
export const DarkMode: Story = {
  args: {
    value: 25,
    onChange: action("page-size-changed"),
    className: "",
  },
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "Page size selector in dark mode, showing proper contrast and styling for dark themes.",
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
  args: {
    value: 25,
    onChange: action("page-size-changed"),
    className: "",
  },
  parameters: {
    viewport: {
      defaultViewport: "mobile",
    },
    docs: {
      description: {
        story:
          "Mobile layout showing how the dropdown appears and behaves on smaller screens with touch interactions.",
      },
    },
  },
};

/**
 * Custom styling
 */
export const CustomStyling: Story = {
  args: {
    value: 50,
    onChange: action("page-size-changed"),
    className: "border-2 border-purple-300 rounded-lg",
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
 * In context with pagination
 */
export const InPaginationContext: Story = {
  render: () => {
    const [pageSize, setPageSize] = React.useState(25);
    const [currentPage, setCurrentPage] = React.useState(1);
    const totalItems = 347;
    const totalPages = Math.ceil(totalItems / pageSize);

    return (
      <div className="space-y-4">
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-2">Events List</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Showing {(currentPage - 1) * pageSize + 1} to{" "}
            {Math.min(currentPage * pageSize, totalItems)} of {totalItems}{" "}
            events
          </p>

          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-sm text-gray-600 dark:text-gray-400">
                Show:
              </span>
              <PageSizeSelector
                value={pageSize}
                onChange={(newSize) => {
                  setPageSize(newSize);
                  setCurrentPage(1); // Reset to first page when changing page size
                  action("page-size-changed")(newSize);
                }}
              />
              <span className="text-sm text-gray-600 dark:text-gray-400">
                per page
              </span>
            </div>

            <div className="flex items-center space-x-2">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Previous
              </button>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() =>
                  setCurrentPage(Math.min(totalPages, currentPage + 1))
                }
                disabled={currentPage === totalPages}
                className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "Example showing the page size selector in context with pagination controls and item count display.",
      },
    },
  },
};

/**
 * Focus states
 */
export const FocusStates: Story = {
  args: {
    value: 25,
    onChange: action("page-size-changed"),
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Demonstrates keyboard focus states and accessibility features. Use Tab to focus and Enter/Space to open dropdown.",
      },
    },
    pseudo: {
      focus: ["button"],
    },
  },
};
