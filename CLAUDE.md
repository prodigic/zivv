# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Zivv is a Bay Area Punk Show Finder - a modern, responsive web application for discovering punk and alternative music shows in the San Francisco Bay Area. Built with React, TypeScript, and Tailwind CSS, it features calendar views, advanced search, smart filtering, and mobile-first design.

## Development Commands

**Note**: There are broken NVM aliases due to multiple NVM instances. Prefix affected commands with `\` to avoid broken aliases (e.g., `\npx tsc --noEmit` instead of `npx tsc --noEmit`).

### Core Development
- `npm run dev` - Start development server with hot reload on http://localhost:5173
- `npm run build` - Build for production (runs ETL build, TypeScript compilation, and Vite build)
- `npm run preview` - Preview production build locally

### Code Quality
- `npm run lint` - Run ESLint with TypeScript support
- `npm run lint:fix` - Auto-fix ESLint errors
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting without modifying files

### Testing
- `npm run test` - Run Vitest in watch mode
- `npm run test:run` - Run all tests once
- `npm run test:coverage` - Run tests with coverage report
- `npm run test -- src/test/DataService.test.ts` - Run single test file

### ETL Data Processing
- `npm run etl` - Process raw data files and generate JSON outputs
- `npm run etl:verbose` - Run ETL with verbose logging
- `node scripts/run-etl.js` - Direct ETL script execution

## Architecture Overview

### Data Pipeline (ETL)
The project uses a sophisticated ETL pipeline that processes raw text files into optimized JSON data:

**Source Data Location**: `data/`
- `events.txt` - Raw events data in structured text format
- `venues.txt` - Raw venue data with addresses and policies

**Processing Pipeline**: `src/lib/etl/`
- `processor.ts` - Main ETL orchestration class (ETLProcessor)
- `parsers.ts` - EventParser and VenueParser for text processing
- `indexer.ts` - DataIndexer, DataChunker, SearchIndexBuilder for optimization
- `utils.ts` - Utility functions for data transformation

**Output Data**: `public/data/`
- `manifest.json` - Data manifest with version and metadata
- `events-YYYY-MM.json` - Monthly event chunks for efficient loading
- `artists.json`, `venues.json` - Complete entity directories
- `indexes.json` - Pre-computed indexes for filtering and search
- `search-*.json` - Search index files for fast text search

### Type System
The codebase uses strict TypeScript with branded types for type safety:

**Core Types**: `src/types/`
- `events.ts` - Event, Artist, Venue interfaces with branded IDs
- `data.ts` - ETL pipeline types, manifests, indexes, processing results

**Type Safety Features**:
- Branded types prevent ID mixing (EventId, ArtistId, VenueId)
- Strict TypeScript configuration with no `any` types
- Runtime type guards for data validation
- Comprehensive JSDoc documentation

### Frontend Architecture
**Tech Stack**:
- React 19 with TypeScript and strict mode
- Vite for build tooling and hot reload
- Tailwind CSS for utility-first styling
- Vitest + Testing Library for testing

**Key Configuration**:
- Path aliases: `@/` maps to `src/`, plus specific aliases for `@/components/*`, `@/utils/*`, `@/types/*`, `@/hooks/*`, `@/stores/*`, `@/pages/*`
- Base path for GitHub Pages: `/zivv/` in production
- ESLint + Prettier with TypeScript integration

### Core Data Layer (Phase 3 - COMPLETED)
**Services**: `src/services/`
- `DataService.ts` - Main data loading and caching service
- `CacheService.ts` - IndexedDB-based caching with LRU eviction  
- `WorkerService.ts` - Web Worker manager for background processing

**Type System**: `src/types/`
- `frontend.ts` - Enhanced frontend-specific types and interfaces
- `events.ts` - Core entity types (Event, Artist, Venue)
- `data.ts` - ETL pipeline and processing types

**Utilities**: `src/utils/`
- `typeGuards.ts` - Runtime type validation and guards
- `loadingState.ts` - Async state management utilities
- `errorHandling.ts` - Comprehensive error handling and recovery

**Web Worker**: `src/workers/`
- `dataWorker.ts` - Background processing for JSON parsing, filtering, search

**Key Features**:
- **Chunked Data Loading**: Events loaded by month for performance
- **IndexedDB Caching**: Browser-based caching with version invalidation
- **Web Worker Processing**: JSON parsing and filtering off main thread
- **Comprehensive Error Handling**: Custom error types with recovery suggestions
- **Loading State Management**: Centralized loading state tracking
- **Runtime Type Safety**: Validation guards for all data operations

### Data Loading Strategy
- **Chunked Loading**: Events split by month for progressive loading
- **Caching Strategy**: Client-side caching with version-based invalidation  
- **Performance**: Virtual scrolling, memory management, Web Workers for parsing
- **Search**: MiniSearch integration with pre-built indexes

## Development Guidelines

### Application Shell & Routing (Phase 4 - COMPLETED)
**Router**: `src/router/`
- `index.tsx` - React Router configuration with GitHub Pages support
- Lazy-loaded pages with code splitting
- Error boundaries and loading states
- Calendar routes: `/calendar` → `/calendar/month`, `/calendar/week`, `/calendar/agenda`
- About page route: `/about` with project information and live statistics

**Components**: `src/components/`
- `layout/AppShell.tsx` - Main application shell with responsive layout
- `layout/Header.tsx` - Enhanced header with search, toggles, language selector, and dark mode
- `layout/BottomNavigation.tsx` - Mobile bottom navigation
- `layout/SideNavigation.tsx` - Desktop sidebar navigation
- `error/ErrorBoundary.tsx` - Error boundary with user-friendly messages
- `ui/LoadingSpinner.tsx` - Loading states and skeleton components
- `ui/DarkModeToggle.tsx` - Compact dark mode toggle component
- `ui/UpcomingToggle.tsx` - Toggle for upcoming vs all events
- `ui/FreeShowsToggle.tsx` - Toggle for free vs paid events

**Enhanced Header Features**:
- **Search Bar**: Live search with dropdown results and loading indicators
- **Toggle Controls**: Upcoming events, free shows, and list/calendar view toggles
- **Language Dropdown**: Multi-language support with flag icons and click-outside dismiss
- **About Page Link**: Desktop navigation entry point for project information
- **Dark Mode Toggle**: Positioned at end of header row for easy access
- **Filter Indicator**: Shows active filter state with clear functionality
- **Responsive Design**: Mobile-optimized with collapsible elements

**State Management**: `src/stores/`
- `appStore.ts` - Main app state with Zustand (data, loading, errors)
- `filterStore.ts` - Filter and search state with URL synchronization
- Persistent UI state, URL parameter sync

**Pages**: `src/pages/`
- `HomePage.tsx` - Event list with infinite scroll and debug information
- `CalendarPage.tsx` - Calendar views (month/week/agenda) 
- `ArtistsPage.tsx`, `VenuesPage.tsx` - Directory pages
- `AboutPage.tsx` - Project information and real-time statistics
- `*DetailPage.tsx` - Individual entity detail pages

**Event Display Features**:
- **Punk Rock Ticket Design**: Colorful ticket-style cards with perforated edges
- **Sold Out Stamps**: Visual overlay using `soldout-transparent.png` for sold-out events
- **Debug Information**: Comprehensive event data display with high-contrast accessibility
- **Responsive Tickets**: Mobile-first design with background patterns and gradients

**About Page Features**:
- **Project Information**: Mission, features overview, and technology stack
- **Stats for Geeks**: Real-time statistics with live data from app store
- **Community Links**: GitHub repository and feedback channels
- **Navigation Integration**: Available from both desktop header and mobile sidebar
- **Real-time Data**: Shows current counts for events, artists, venues with calculated averages
- **Visual Design**: Purple gradient theme with glassmorphism effects

### File Structure Conventions
```
src/
├── components/       # React components (layout, UI, error handling)
├── pages/           # Page components for routes
├── router/          # React Router configuration  
├── stores/          # Zustand state management
├── lib/etl/         # ETL processing pipeline
├── services/        # Data services and workers
├── types/           # TypeScript type definitions
├── utils/           # Utility functions and helpers
├── workers/         # Web Workers for background processing
└── test/            # Test setup and test files
```

### ETL Development
- **Processing Order**: Events → Venues → Artists → Normalization → Indexing → Chunking
- **Data Validation**: All output validated against JSON schemas
- **Error Handling**: Comprehensive error collection with line numbers and context
- **Performance**: Designed to handle large datasets efficiently

### Code Quality Standards
- Use strict TypeScript configuration - no `any` types
- Follow the existing ESLint and Prettier configuration
- Maintain comprehensive JSDoc documentation
- All ETL functions should include proper error handling
- Use branded types for entity IDs to prevent mixing

### Testing Approach
- Unit tests for ETL processing logic and utilities
- Integration tests for data transformation pipelines
- Component tests using Testing Library when frontend components are added
- Test files located in `src/test/` directory

### Performance Considerations
- ETL pipeline optimized for large datasets (1000+ events)
- Memory-conscious chunk processing
- Efficient data structures and algorithms
- Bundle size monitoring and optimization

## Debug and Development Features

### Debug Information Display
The application includes comprehensive debug information for development and troubleshooting:

**HomePage Debug Panel**:
- Events and artists loading counts
- Loading states for all data services
- Error states and messages
- Active search queries and filter states
- Filter details in JSON format

## Conventional Commit Guidelines

To maintain a clear and consistent commit history, all commits MUST adhere to the Conventional Commits specification with the following rules:

### Subject Line
- The subject line should be concise and descriptive, with **no more than 50 characters**.
- It should use the imperative mood (e.g., "feat: add user authentication", not "feat: added user authentication").

### Body
- The subject line is separated from the body by a **blank line**.
- The body provides a more detailed explanation of the changes and their impact.
- Each line of the body **MUST be kept within 72 characters** for readability in various Git tools.
- Use bullet points or paragraphs to clearly articulate the changes, reasons, and any potential side effects.

### Examples
```
feat: add user authentication module

This commit introduces the new user authentication module.
It includes:
- User registration and login
- Session management
- JWT token generation

The module uses bcrypt for password hashing and ensures secure
user data handling. It also updates the API routes to require
authentication for certain endpoints.
```

```
fix: correct off-by-one error in pagination

Resolves an issue where the pagination logic was incorrectly
calculating the last page, leading to missing items. The fix
adjusts the boundary condition in the `calculatePage` function.
```

**Event Card Debug Information**:
- Complete event data display below each ticket
- Shows all properties not visible on the ticket design:
  - Event ID, slug, status, venue type
  - Age restrictions, timezone information
  - Descriptions, notes, ticket URLs
  - Tags, source line numbers, creation dates
- High-contrast accessibility design for readability

**Debug Styling**:
- **Light/Dark Mode Adaptive**: `bg-gray-100/dark:bg-gray-900` backgrounds
- **High Contrast Labels**: `text-blue-700/dark:text-blue-300` for WCAG compliance
- **Responsive Grid**: Two-column layout with proper spacing
- **Accessibility**: Excellent contrast ratios and readable fonts

### Asset Management
**Sold Out Indicators**:
- Uses `src/assets/soldout-transparent.png` for visual overlays
- Automatically applied when `event.status === "sold-out"` or `event.tags.includes("sold-out")`
- Positioned with CSS transforms and proper z-indexing

### Accessibility Features
- **WCAG 2.1 AA Compliance**: Target standard for all UI components
- **High Contrast Mode**: Debug information uses optimized color schemes
- **Keyboard Navigation**: All interactive elements support tab navigation
- **Screen Reader Support**: Proper ARIA labels and semantic HTML
- **Focus Management**: Clear focus indicators on all controls
- **Responsive Design**: Mobile-first approach with touch-friendly targets

## Multilingual Support (Phase 7 Implementation Plan)

### Language Infrastructure
**Target Languages**: English (EN), Spanish (ES), Tagalog (TL), Mandarin (ZH-CN), Cantonese (ZH-HK), Vietnamese (VI), French (FR), German (DE)

**Implementation Strategy**:
- **React i18n Library**: Integration with `react-i18next` for dynamic translations
- **Language State Management**: Zustand store for current language preference
- **Browser Integration**: Automatic detection of user's preferred language
- **Persistent Storage**: localStorage to remember user's language choice

### Translation Architecture
**Translation Files Structure**:
```
public/locales/
├── en.json      # English translations
├── es.json      # Spanish translations
└── [fr, de]/... # Other languages
```

**Translation Keys Strategy**:
- **Nested JSON Structure**: Organized by feature/component
- **Pluralization Support**: Handle singular/plural forms
- **Variable Interpolation**: Dynamic content insertion
- **Fallback System**: English as default for missing translations

### Content Localization
**Static Content Translation**:
- UI labels, buttons, navigation elements
- Form validation messages and error states
- Loading states and empty state messages
- Accessibility labels and descriptions

**Dynamic Content Handling**:
- Event titles and descriptions (where available)
- Venue names and addresses (standardized format)
- Date and time formatting (locale-specific)
- Currency formatting for ticket prices

### Technical Implementation
**Language Context**:
```typescript
// Language store with Zustand
interface LanguageStore {
  currentLanguage: string;
  setLanguage: (lang: string) => void;
  isLoading: boolean;
}

// Translation hook
const useTranslation = (namespace?: string) => {
  const { t, i18n } = useTranslation(namespace);
  return { t, changeLanguage: i18n.changeLanguage };
};
```

**Component Integration**:
- **Header Language Dropdown**: Already implemented UI component
- **Automatic RTL Support**: CSS adjustments for Arabic/Hebrew (future)
- **Number/Date Formatting**: Locale-aware formatting utilities
- **Search Localization**: Multi-language search term handling

### SEO and URL Structure
**URL Localization Options**:
- **Subdirectory**: `/en/`, `/es/`, `/fr/`, `/de/` 
- **Query Parameters**: `?lang=es` (simpler implementation)
- **Domain Strategy**: Future consideration for `es.zivv.com`

**Meta Data Translation**:
- Page titles, descriptions, and OpenGraph tags
- Language-specific sitemap generation
- `hreflang` attributes for SEO

### Translation Workflow
**Development Process**:
1. **Key Extraction**: Automated scanning for translation keys
2. **AI Translation Pipeline**: Automated translation during build/CI workflow
3. **Translation Management**: Integration with translation services
4. **Quality Assurance**: Review process for translation accuracy
5. **Automated Testing**: i18n-specific test coverage

**AI Translation Workflow**:
- **Build Integration**: Automatic translation updates during `npm run build`
- **CI/CD Pipeline**: GitHub Actions workflow for translation automation
- **Translation Service**: Integration with OpenAI API or Google Translate API
- **Incremental Updates**: Only translate new/changed keys to optimize costs
- **Version Control**: Git-tracked translation files with change detection
- **Fallback Strategy**: AI translations as base with human review flags

**AI Translation Implementation**:
```typescript
// Translation automation script
interface TranslationConfig {
  sourceLanguage: 'en';
  targetLanguages: ['es', 'tl', 'zh-cn', 'zh-hk', 'vi', 'fr', 'de'];
  translationService: 'openai' | 'google' | 'azure';
  apiKey: string;
  reviewRequired: boolean;
}

// Build-time translation update
npm run translate:update    # Update all translations
npm run translate:verify    # Verify translation completeness
npm run translate:review    # Mark translations for human review
```

**Automation Features**:
- **Smart Detection**: Identify new/modified translation keys
- **Context Preservation**: Maintain formatting and interpolation variables
- **Quality Scoring**: AI confidence levels for translation accuracy
- **Batch Processing**: Efficient API usage with rate limiting
- **Rollback Support**: Version control for translation updates

**Content Sources**:
- **AI Translation**: Primary source for initial translations and updates
- **Community Translation**: GitHub-based contribution workflow for refinements
- **Professional Translation**: For critical UI elements and marketing content
- **Human Review**: Quality assurance for AI-generated translations

## Venue Digital Signage (Phase 10 Implementation Plan)

### Digital Signage Overview
**Target Users**: Venue owners, bartenders, staff members
**Display Formats**: TV screens, tablets, digital displays at venues
**Content Focus**: Upcoming shows, promotional materials, venue-specific branding

### Core Signage System
**Signage Application Architecture**:
```
/signage/
├── displays/
│   ├── VenueDisplayApp.tsx    # Main signage display component
│   ├── RotationController.tsx # Content rotation management
│   └── OfflineMode.tsx        # Offline fallback content
├── admin/
│   ├── SignageAdmin.tsx       # Venue admin configuration
│   ├── ContentManager.tsx     # Upload and manage custom content
│   └── ScheduleManager.tsx    # Rotation timing configuration
└── ingestion/
    ├── WebScraper.ts          # Automated poster extraction
    ├── ContentProcessor.ts    # Image optimization and validation
    └── FallbackGenerator.ts   # AI-generated backup content
```

**Rotation Timing System**:
- **Daily Rotation**: 24-hour cycle showing today's and tomorrow's events
- **Weekly Rotation**: 7-day overview with weekend focus
- **Monthly Rotation**: Full month calendar with highlighted peak periods
- **Custom Intervals**: Venue-configurable timing (15 min, 30 min, 1 hour cycles)

### Content Ingestion Pipeline
**Automated Poster Extraction**:
```typescript
interface PosterIngestionConfig {
  venueId: VenueId;
  websiteUrl: string;
  scrapingStrategy: 'social-media' | 'calendar-page' | 'event-listings';
  updateFrequency: 'hourly' | 'daily' | 'weekly';
  fallbackBehavior: 'ai-generate' | 'template' | 'skip';
}

// Web scraping targets
const scrapingSources = {
  facebook: 'Facebook events and photo posts',
  instagram: 'Instagram posts with event hashtags',
  bandsintown: 'Bandsintown venue listings',
  venueWebsite: 'Venue calendar and event pages',
  ticketingSites: 'Eventbrite, TicketMaster integration'
};
```

**Content Processing Workflow**:
1. **Web Scraping**: Automated extraction from venue websites and social media
2. **Image Recognition**: AI-powered detection of event posters vs. promotional content
3. **Content Validation**: Quality checks for image resolution, readability, appropriate content
4. **Metadata Extraction**: OCR and AI to extract dates, artist names, venue info from posters
5. **Content Optimization**: Resize and format for display screens
6. **Fallback Generation**: AI-created posters when originals unavailable

### Display Modes and Layouts
**Signage Display Options**:
- **Today's Shows**: Current day focus with large event cards
- **This Week**: 7-day grid layout with thumbnail posters
- **Monthly Calendar**: Full calendar with event density indicators
- **Featured Events**: Highlighted shows with promotional emphasis
- **Venue Branding**: Custom logos, messages, and promotional content

**Layout Templates**:
```typescript
interface SignageTemplate {
  id: string;
  name: string;
  orientation: 'landscape' | 'portrait';
  resolution: '1920x1080' | '1080x1920' | '1366x768';
  layout: {
    header: VenueBrandingSection;
    main: EventDisplaySection;
    sidebar: PromotionalContent;
    footer: VenueInfoSection;
  };
}
```

### Venue Admin Interface
**Configuration Dashboard**:
- **Display Settings**: Screen orientation, resolution, rotation timing
- **Content Management**: Upload custom graphics, logos, promotional messages
- **Scheduling**: Configure rotation patterns and display priorities
- **Content Filtering**: Show only specific genres, age restrictions, or event types
- **Branding**: Venue colors, fonts, and visual identity integration

**Real-time Management**:
- **Live Preview**: See current signage display remotely
- **Emergency Override**: Instantly push important announcements
- **Performance Analytics**: Track display uptime and content effectiveness
- **Remote Updates**: Push new content without physical access

### Technical Implementation
**Offline-First Architecture**:
- **Progressive Web App**: Installable on tablets and display devices
- **Local Caching**: Store content locally for offline operation
- **Sync Strategy**: Background updates when network available
- **Fallback Content**: Local backup content when sync fails

**Display Hardware Support**:
```typescript
interface DisplayDevice {
  deviceType: 'tablet' | 'smart-tv' | 'raspberry-pi' | 'computer';
  capabilities: {
    touchscreen: boolean;
    networkConnected: boolean;
    storageCapacity: number;
    displayResolution: string;
  };
  installMethod: 'browser-app' | 'kiosk-mode' | 'native-app';
}
```

### Content AI and Automation
**AI-Powered Features**:
- **Smart Poster Detection**: Machine learning to identify event posters vs. other content
- **Text Extraction**: OCR to read event details from poster images
- **Content Generation**: AI-created posters when venue content unavailable
- **Layout Optimization**: Auto-adjust content for different screen sizes
- **Trend Analysis**: Suggest optimal rotation timing based on venue traffic

**Automated Workflows**:
```typescript
// Daily content update pipeline
async function updateVenueSignage(venueId: VenueId) {
  const config = await getVenueConfig(venueId);
  const scrapedContent = await scrapeVenueContent(config);
  const processedPosters = await processPosters(scrapedContent);
  const fallbackContent = await generateFallbacks(processedPosters);
  const signageContent = await createSignageRotation(processedPosters, fallbackContent);
  
  await deployToVenueDisplay(venueId, signageContent);
}
```

### Integration with Existing System
**Data Sources**:
- **Zivv Event Database**: Primary source for event information
- **Venue Websites**: Scraped poster and promotional content
- **Social Media APIs**: Facebook, Instagram event content
- **Ticketing Platforms**: Official event graphics and details

**API Extensions**:
```typescript
// New signage-specific API endpoints
GET /api/venues/{id}/signage/config     // Get display configuration
POST /api/venues/{id}/signage/content   // Upload custom content
GET /api/venues/{id}/signage/rotation   // Current rotation schedule
PUT /api/venues/{id}/signage/override   // Emergency content override
```

### Deployment and Access
**Free and Open Deployment**:
- **Completely Free**: All signage features available at no cost to venues
- **Open Source**: Community-driven development and transparent operation
- **Anonymous Access**: No user registration or tracking required
- **Self-Hosted Options**: Venues can deploy their own instances if preferred
- **Community Support**: Volunteer-based help and documentation

## Common Development Tasks

### Running the ETL Pipeline
1. Place raw data files in `data/events.txt` and `data/venues.txt`
2. Run `npm run etl` to process data
3. Check `public/data/` for generated JSON files
4. Review console output for processing statistics and any errors

### Adding New ETL Features
1. Extend parser logic in `src/lib/etl/parsers.ts`
2. Update type definitions in `src/types/`
3. Modify processor orchestration in `src/lib/etl/processor.ts`
4. Add corresponding tests and validation

### Using the Application (Phase 4)
```typescript
// State management with Zustand
import { useAppStore, useFilterStore } from '@/stores';

// App state - data loading and management
const { 
  initialize, 
  getUpcomingEvents, 
  loadChunk, 
  searchEvents,
  loading,
  errors 
} = useAppStore();

// Filter state - search and filtering
const { 
  filters, 
  searchQuery, 
  setSearchQuery,
  updateFilter,
  hasActiveFilters 
} = useFilterStore();

// Initialize app
await initialize();

// Load and display events
const events = getUpcomingEvents(20);
await loadChunk('2024-08');

// Search and filter
setSearchQuery('punk rock');
updateFilter('cities', ['San Francisco', 'Oakland']);
```

### Using the Data Layer (Phase 3)
```typescript
import { DataService, LoadingStateManager, globalErrorHandler } from '@/services';

// Initialize data service
const dataService = new DataService();
await dataService.initialize();

// Load data with error handling
try {
  const events = await dataService.getEventsForMonth('2024-08');
  const artists = await dataService.loadArtists();
  const venues = await dataService.loadVenues();
} catch (error) {
  globalErrorHandler.handleError(error);
}

// Search functionality
const searchResults = await dataService.searchEvents('punk rock');

// Loading state management
const loadingManager = new LoadingStateManager();
loadingManager.setLoading('events');
// ... perform operation
loadingManager.setSuccess('events');
```

### Current Development Status (Phase 4+ Enhancements)
**Completed Phase 4 Features**:
- ✅ **Enhanced Event Display**: Punk rock ticket design with sold-out overlays
- ✅ **Advanced Header Controls**: Search, toggles, language selector, dark mode
- ✅ **Debug Information System**: Comprehensive development debugging tools
- ✅ **Accessibility Improvements**: WCAG 2.1 AA compliant contrast and navigation
- ✅ **Mobile-First Design**: Responsive ticket cards and header controls
- ✅ **About Page**: Project information with real-time statistics and community links

**Next Phase Development**:
- **Phase 5**: Event List & Filtering - Virtualized infinite scroll, advanced filters
- **Phase 6**: Calendar Views - FullCalendar integration with month/week/agenda views  
- **Phase 7**: Multilingual Support - Complete i18n implementation with content localization
- **Phase 8**: Artist & Venue Directories - Searchable directories with detail pages
- **Phase 9**: Event Details & Interactions - Modal/page views with full event information
- **Phase 10**: Venue Digital Signage - Automated signage system with content rotation and poster ingestion

**Frontend Architecture**:
- Components use Tailwind CSS with mobile-first responsive design
- State management with Zustand stores and URL synchronization
- Error boundaries provide graceful degradation and recovery
- Comprehensive debug tooling for development workflow

## Project Context

This project has completed Phase 2 (ETL Pipeline), Phase 3 (Core Data Layer), and Phase 4 (Application Shell & Routing) with significant enhancements. The architecture processes Bay Area punk show data into optimized JSON and provides a complete React application foundation with production-ready UI components.

**Current Capabilities**:
- ✅ **Mobile-First Responsive Design**: Touch-friendly punk rock ticket interface
- ✅ **Advanced Filtering & Search**: Real-time search with dropdown results  
- ✅ **Multi-View Support**: List/Calendar toggle with routing integration
- ✅ **Accessibility Compliance**: WCAG 2.1 AA standard with high contrast modes
- ✅ **Debug & Development Tools**: Comprehensive data inspection capabilities
- ✅ **Performance Optimized**: Chunked loading, caching, and Web Worker processing
- ✅ **Internationalization Ready**: Language selector and multi-locale support
- ✅ **Dark/Light Mode**: System preference detection with manual toggle

**Technical Foundation**:
- **High Performance**: Web Workers, IndexedDB caching, chunked data loading
- **Type Safety**: Strict TypeScript with branded types and runtime validation  
- **Modern Stack**: React 19, Vite, Tailwind CSS, Zustand state management
- **Production Ready**: Error boundaries, loading states, offline capabilities

The current implementation provides a solid foundation for rapid frontend development with pre-processed, optimized data structures, comprehensive type safety, and a polished user interface that's ready for production deployment.