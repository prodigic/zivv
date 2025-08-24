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
- Path aliases: `@/` maps to `src/`
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

**Components**: `src/components/`
- `layout/AppShell.tsx` - Main application shell with responsive layout
- `layout/Header.tsx` - Header with search, filters, and navigation
- `layout/BottomNavigation.tsx` - Mobile bottom navigation
- `layout/SideNavigation.tsx` - Desktop sidebar navigation
- `error/ErrorBoundary.tsx` - Error boundary with user-friendly messages
- `ui/LoadingSpinner.tsx` - Loading states and skeleton components

**State Management**: `src/stores/`
- `appStore.ts` - Main app state with Zustand (data, loading, errors)
- `filterStore.ts` - Filter and search state with URL synchronization
- Persistent UI state, URL parameter sync

**Pages**: `src/pages/`
- `HomePage.tsx` - Event list with infinite scroll
- `CalendarPage.tsx` - Calendar views (month/week/agenda) 
- `ArtistsPage.tsx`, `VenuesPage.tsx` - Directory pages
- `*DetailPage.tsx` - Individual entity detail pages

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

### Frontend Development (Next Phases)
- **Phase 5**: Event List & Filtering - Virtualized infinite scroll, advanced filters
- **Phase 6**: Calendar Views - FullCalendar integration with month/week/agenda views  
- **Phase 7**: Artist & Venue Directories - Searchable directories with detail pages
- **Phase 8**: Event Details & Interactions - Modal/page views with full event information
- Components use Tailwind CSS with mobile-first responsive design
- State management with Zustand stores and URL synchronization
- Error boundaries provide graceful degradation and recovery

## Project Context

This project has completed Phase 2 (ETL Pipeline), Phase 3 (Core Data Layer), and Phase 4 (Application Shell & Routing). The architecture processes Bay Area punk show data into optimized JSON and provides a complete React application foundation. Current capabilities include:

- Mobile-first responsive design (planned)
- Advanced filtering and search capabilities 
- Calendar views (month, week, agenda)
- Artist and venue directories
- High performance with large datasets
- Accessibility compliance (WCAG 2.1 AA target)

The current implementation provides a solid foundation for rapid frontend development with pre-processed, optimized data structures and comprehensive type safety.