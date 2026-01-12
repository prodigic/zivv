import type { Meta, StoryObj } from "@storybook/react";
import { PageWrapper } from "@/components/layout/PageWrapper";
import React from "react";

// Mock component for demonstration
const SamplePageContent = ({ hasError }: { hasError?: boolean }) => {
  if (hasError) {
    throw new Error("Sample error for testing error boundary");
  }

  return (
    <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow-sm">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
        Sample Page Content
      </h1>
      <p className="text-gray-600 dark:text-gray-300 mb-4">
        This content is wrapped by PageWrapper, which provides error boundary
        protection and loading states for lazy-loaded components.
      </p>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-2">
            Feature 1
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Sample feature content that would be protected by the error
            boundary.
          </p>
        </div>
        <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-2">
            Feature 2
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Another feature that benefits from the suspense fallback loading
            state.
          </p>
        </div>
      </div>
    </div>
  );
};

// Slow-loading component for suspense demo
const SlowLoadingContent = React.lazy(
  () =>
    new Promise<{ default: React.ComponentType }>((resolve) => {
      setTimeout(() => {
        resolve({
          default: () => (
            <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow-sm">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                Lazy Loaded Content
              </h1>
              <p className="text-gray-600 dark:text-gray-300">
                This content was lazy loaded with a 2-second delay to
                demonstrate the Suspense fallback spinner.
              </p>
            </div>
          ),
        });
      }, 2000);
    })
);

const meta: Meta<typeof PageWrapper> = {
  title: "Layout Components/PageWrapper",
  component: PageWrapper,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Wrapper component that provides error boundary protection and suspense loading states for lazy-loaded page components. Ensures consistent error handling and loading UX across all pages.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="min-h-96 bg-gray-50 dark:bg-gray-900 p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof PageWrapper>;

/**
 * Default wrapper with normal content
 */
export const Default: Story = {
  args: {
    children: <SamplePageContent />,
  },
  parameters: {
    docs: {
      description: {
        story:
          "PageWrapper with normal content - shows how it wraps page content with error boundary protection.",
      },
    },
  },
};

/**
 * Wrapper with error boundary triggered
 */
export const WithError: Story = {
  args: {
    children: <SamplePageContent hasError={true} />,
  },
  parameters: {
    docs: {
      description: {
        story:
          "PageWrapper with error in child component - demonstrates error boundary catching and displaying error fallback UI.",
      },
    },
  },
};

/**
 * Wrapper with suspense loading (lazy loaded content)
 */
export const WithSuspenseLoading: Story = {
  args: {
    children: <SlowLoadingContent />,
  },
  parameters: {
    docs: {
      description: {
        story:
          "PageWrapper with lazy loaded component - shows suspense fallback loading spinner while component loads.",
      },
    },
  },
};

/**
 * Multiple children wrapped
 */
export const MultipleChildren: Story = {
  args: {
    children: (
      <>
        <SamplePageContent />
        <div className="mt-4">
          <SamplePageContent />
        </div>
      </>
    ),
  },
  parameters: {
    docs: {
      description: {
        story:
          "PageWrapper with multiple child components - all children are protected by the same error boundary.",
      },
    },
  },
};

/**
 * Dark mode wrapper
 */
export const DarkMode: Story = {
  args: {
    children: <SamplePageContent />,
  },
  parameters: {
    backgrounds: { default: "dark" },
    docs: {
      description: {
        story:
          "PageWrapper in dark mode - demonstrates dark theme compatibility.",
      },
    },
  },
};

/**
 * Complex content with nested components
 */
export const ComplexContent: Story = {
  args: {
    children: (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">
            Complex Page Layout
          </h1>

          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 mb-4">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">
                  Main Content Area
                </h2>
                <p className="text-gray-600 dark:text-gray-300 mb-4">
                  This demonstrates how PageWrapper handles complex layouts with
                  multiple sections and components.
                </p>
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="p-3 bg-white dark:bg-gray-600 rounded border-l-4 border-blue-500"
                    >
                      <div className="font-medium text-gray-900 dark:text-white">
                        Item {i}
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-300">
                        Sample content item
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900 dark:text-white mb-2">
                  Sidebar
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Additional content that would also be protected by the error
                  boundary.
                </p>
              </div>

              <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900 dark:text-white mb-2">
                  Widget
                </h3>
                <div className="space-y-2">
                  <div className="h-2 bg-blue-200 rounded"></div>
                  <div className="h-2 bg-blue-300 rounded w-3/4"></div>
                  <div className="h-2 bg-blue-400 rounded w-1/2"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  parameters: {
    docs: {
      description: {
        story:
          "PageWrapper with complex, multi-section content - demonstrates protection of elaborate page layouts.",
      },
    },
  },
};
