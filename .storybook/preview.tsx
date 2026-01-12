import type { Preview } from "@storybook/react-vite";
import React from 'react';
import '../src/index.css'; // Import Tailwind CSS and global styles

// Import decorators and providers
import { BrowserRouter } from 'react-router-dom';

// Mock data for Storybook
const mockEvents = [
  {
    id: 1,
    title: "Sample Event",
    dateEpochMs: Date.now() + 86400000,
    venueId: 1,
    artistIds: [1, 2],
    priceMin: 20,
    isFree: false,
    ageRestriction: "21+",
    description: "A great punk rock show"
  }
];

const mockVenues = new Map([
  [1, { id: 1, name: "The Fillmore", city: "S.f", normalizedName: "the-fillmore" }],
  [2, { id: 2, name: "Fox Theater", city: "Oakland", normalizedName: "fox-theater" }]
]);

const mockArtists = new Map([
  [1, { id: 1, name: "The Ramones", normalizedName: "the-ramones" }],
  [2, { id: 2, name: "Dead Kennedys", normalizedName: "dead-kennedys" }]
]);

// Store decorators
const withMockStores = (Story) => {
  // Mock Zustand stores for Storybook
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <Story />
    </div>
  );
};

const withRouter = (Story) => (
  <BrowserRouter>
    <Story />
  </BrowserRouter>
);

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    
    // Accessibility testing
    a11y: {
      test: "todo", // Show a11y violations in test UI
      config: {
        rules: [
          {
            id: 'color-contrast',
            enabled: true,
          },
          {
            id: 'focus-order-semantics',
            enabled: true,
          }
        ]
      }
    },

    // Viewport addon configuration
    viewport: {
      viewports: {
        mobile: {
          name: 'Mobile',
          styles: {
            width: '375px',
            height: '667px',
          },
        },
        tablet: {
          name: 'Tablet', 
          styles: {
            width: '768px',
            height: '1024px',
          },
        },
        desktop: {
          name: 'Desktop',
          styles: {
            width: '1024px',
            height: '768px',
          },
        },
        largeDesktop: {
          name: 'Large Desktop',
          styles: {
            width: '1440px',
            height: '900px',
          },
        },
      },
    },

    // Backgrounds for dark/light mode testing
    backgrounds: {
      default: 'light',
      values: [
        {
          name: 'light',
          value: '#f9fafb',
        },
        {
          name: 'dark', 
          value: '#111827',
        },
      ],
    },

    // Layout configuration
    layout: 'padded',
    
    // Actions configuration
    actions: { argTypesRegex: "^on[A-Z].*" },
    
    // Documentation
    docs: {
      autodocs: 'tag',
    },
  },

  decorators: [
    withMockStores,
    withRouter,
  ],

  // Global types for toolbar controls
  globalTypes: {
    theme: {
      description: 'Global theme for components',
      defaultValue: 'light',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: ['light', 'dark'],
        dynamicTitle: true,
      },
    },
  },
};

export default preview;
