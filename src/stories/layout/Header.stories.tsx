import type { Meta, StoryObj } from "@storybook/react";
import { Header } from "@/components/layout/Header";
import React from "react";

// Create a wrapper component that provides mock store data via props
const HeaderWithMocks = (props: any) => {
  // Mock the store hooks with simple implementations
  const mockUseFilterStore = () => ({
    searchQuery: props.searchQuery || "",
    setSearchQuery: (query: string) => console.log("setSearchQuery:", query),
    hasActiveFilters: props.hasActiveFilters || false,
    clearFilters: () => console.log("clearFilters"),
  });

  const mockUseAppStore = () => ({
    searchEvents: async (query: string) => {
      console.log("searchEvents:", query);
      return [];
    },
    loading: props.loading || { search: "idle" },
    showUpcomingOnly: props.showUpcomingOnly || false,
    toggleUpcomingOnly: () => console.log("toggleUpcomingOnly"),
  });

  // Mock the store hooks at render time
  React.useEffect(() => {
    // Override the store hooks temporarily for this story
    if (typeof window !== "undefined") {
      (window as any).__storybookMockFilterStore = mockUseFilterStore();
      (window as any).__storybookMockAppStore = mockUseAppStore();
    }
  });

  return <Header {...props} />;
};

const meta: Meta<typeof HeaderWithMocks> = {
  title: "Layout Components/Header",
  component: HeaderWithMocks,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Main application header with search, navigation, toggles, and responsive design. Includes mobile menu, view toggle, language selector, and dark mode toggle.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <Story />
        <div className="p-8">
          <div className="max-w-4xl mx-auto bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              Header Demo Content
            </h2>
            <p className="text-gray-600 dark:text-gray-300">
              This content shows how the header looks when placed above page
              content. The header has a sticky position and backdrop blur
              effect.
            </p>
          </div>
        </div>
      </div>
    ),
  ],
  args: {
    onMenuToggle: () => console.log("Menu toggle clicked"),
    className: "",
    searchQuery: "",
    hasActiveFilters: false,
    showUpcomingOnly: false,
    loading: { search: "idle" },
  },
  argTypes: {
    onMenuToggle: { action: "menu toggled" },
    className: { control: "text" },
    searchQuery: { control: "text" },
    hasActiveFilters: { control: "boolean" },
    showUpcomingOnly: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<typeof HeaderWithMocks>;

/**
 * Default header state with no active search or filters
 */
export const Default: Story = {
  args: {
    searchQuery: "",
    hasActiveFilters: false,
    showUpcomingOnly: false,
    loading: { search: "idle" },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Default header state showing logo, search bar, toggles, and navigation elements.",
      },
    },
  },
};

/**
 * Header with active search query
 */
export const WithSearchQuery: Story = {
  args: {
    searchQuery: "punk rock",
    hasActiveFilters: false,
    showUpcomingOnly: false,
    loading: { search: "idle" },
  },
  parameters: {
    docs: {
      description: {
        story: "Header with an active search query in the input field.",
      },
    },
  },
};

/**
 * Header showing loading state during search
 */
export const SearchLoading: Story = {
  args: {
    searchQuery: "the strokes",
    hasActiveFilters: false,
    showUpcomingOnly: false,
    loading: { search: "loading" },
  },
  parameters: {
    docs: {
      description: {
        story: "Header displaying a loading spinner during search operations.",
      },
    },
  },
};

/**
 * Header with active filters enabled
 */
export const WithActiveFilters: Story = {
  args: {
    searchQuery: "",
    hasActiveFilters: true,
    showUpcomingOnly: true,
    loading: { search: "idle" },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Header with active filters - notice the highlighted filter icon and upcoming toggle enabled.",
      },
    },
  },
};

/**
 * Header with both search and filters active
 */
export const SearchWithFilters: Story = {
  args: {
    searchQuery: "concerts tonight",
    hasActiveFilters: true,
    showUpcomingOnly: true,
    loading: { search: "idle" },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Header with both search query and active filters - shows combined state indicators.",
      },
    },
  },
};

/**
 * Mobile layout demonstration
 */
export const MobileLayout: Story = {
  args: {
    searchQuery: "bay area",
    hasActiveFilters: false,
    showUpcomingOnly: false,
    loading: { search: "idle" },
  },
  parameters: {
    viewport: {
      defaultViewport: "iphone13",
    },
    docs: {
      description: {
        story:
          "Header in mobile layout - shows responsive behavior with collapsing elements and mobile menu button.",
      },
    },
  },
};

/**
 * Dark mode header
 */
export const DarkMode: Story = {
  args: {
    searchQuery: "underground shows",
    hasActiveFilters: true,
    showUpcomingOnly: true,
    loading: { search: "idle" },
  },
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "Header in dark mode with active search and filters - demonstrates dark theme styling.",
      },
    },
  },
};

/**
 * Interactive playground for testing all header states
 */
export const Playground: Story = {
  args: {
    searchQuery: "test query",
    hasActiveFilters: true,
    showUpcomingOnly: true,
    loading: { search: "idle" },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Interactive playground with all controls available for testing different header states and interactions.",
      },
    },
  },
};
