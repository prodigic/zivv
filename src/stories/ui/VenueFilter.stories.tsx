import type { Meta, StoryObj } from "@storybook/react";
import { VenueFilter } from "@/components/ui/VenueFilter";
// import { within } from "@storybook/test";
// import { userEvent } from "@storybook/test";
import React from "react";

const meta: Meta<typeof VenueFilter> = {
  title: "UI Components/VenueFilter",
  component: VenueFilter,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Venue filter with text matching dropdown for filtering events by venue. Supports city-aware filtering and search functionality. Note: These stories show the UI appearance but store interactions are mocked.",
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
      <div className="p-4 bg-gray-50 dark:bg-gray-900 min-h-[400px]">
        <div className="max-w-2xl mx-auto">
          <Story />
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof VenueFilter>;

/**
 * Default state with dropdown closed
 */
export const Default: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "The default state showing the venue filter input with dropdown closed. No venues are selected.",
      },
    },
  },
};

/**
 * Interactive demonstration
 *
 * Click the input field to open the dropdown and see available venues
 */
export const Interactive: Story = {
  args: {
    className: "",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Live interactive component. Click the input field to open dropdown, type to search venues, and select venues to add them as chips. Check the Actions panel to see function calls.",
      },
    },
  },
};

/**
 * Dropdown interaction example
 */
export const DropdownInteraction: Story = {
  args: {
    className: "",
  },
  // play: async ({ canvasElement }) => {
  //   const canvas = within(canvasElement);
  //   try {
  //     const input = canvas.getByRole("textbox", { name: /search venues/i });
  //     await userEvent.click(input);
  //     await new Promise((resolve) => setTimeout(resolve, 500));
  //   } catch (error) {
  //     console.log(
  //       "Interaction demo - elements may not be available in mock state"
  //     );
  //   }
  // },
  parameters: {
    docs: {
      description: {
        story:
          "Automated interaction showing how to open the venue dropdown. The play function clicks the input to demonstrate the interaction pattern.",
      },
    },
  },
};

/**
 * Search interaction example
 */
export const SearchInteraction: Story = {
  args: {
    className: "",
  },
  // play: async ({ canvasElement }) => {
  //   const canvas = within(canvasElement);
  //   try {
  //     const input = canvas.getByRole("textbox", { name: /search venues/i });
  //     await userEvent.click(input);
  //     await new Promise((resolve) => setTimeout(resolve, 300));
  //     await userEvent.type(input, "fillmore");
  //     await new Promise((resolve) => setTimeout(resolve, 500));
  //   } catch (error) {
  //     console.log("Search demo - elements may not be available in mock state");
  //   }
  // },
  parameters: {
    docs: {
      description: {
        story:
          "Automated interaction showing venue search functionality. The play function demonstrates typing 'fillmore' to filter venues.",
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
          "Default state in dark mode, showing proper contrast and styling for dropdown and chips.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="dark p-4 bg-gray-900 min-h-[400px]">
        <div className="max-w-2xl mx-auto">
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
          "Mobile responsive layout showing compact venue filter and touch-friendly interactions.",
      },
    },
  },
};

/**
 * With custom styling
 */
export const CustomStyling: Story = {
  args: {
    className: "border-2 border-blue-500 rounded-xl",
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
 * Focus states demonstration
 */
export const FocusStates: Story = {
  args: {
    className: "",
  },
  // play: async ({ canvasElement }) => {
  //   const canvas = within(canvasElement);
  //   try {
  //     const input = canvas.getByRole("textbox", { name: /search venues/i });
  //     input.focus();
  //   } catch (error) {
  //     console.log("Focus demo - element may not be available in mock state");
  //   }
  // },
  parameters: {
    docs: {
      description: {
        story:
          "Demonstrates focus states and keyboard accessibility. Shows how the component looks when focused.",
      },
    },
  },
};

/**
 * Error state simulation
 */
export const ErrorStateSimulation: Story = {
  args: {
    className: "border-red-300 bg-red-50",
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
    className: "opacity-60 cursor-wait",
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
