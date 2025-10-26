# AGENTS.md

This file provides consolidated guidance and context for any AI agent working on the Zivv codebase. It combines key information from various project documentation to ensure a consistent and effective understanding of the project.

## 1. Project Overview

Zivv is a modern, responsive web application for discovering punk and alternative music shows in the San Francisco Bay Area. It is built with React, TypeScript, and Tailwind CSS, featuring calendar views, advanced search, smart filtering, and a mobile-first design.

### Current Status

The project has completed Phase 2 (ETL Pipeline), Phase 3 (Core Data Layer), Phase 4 (Application Shell & Routing), Phase 5 (Performance Testing & Lighthouse Integration), and Phase 6 (Test Infrastructure & Coverage Configuration) with significant enhancements. It provides a solid foundation with pre-processed, optimized data structures, comprehensive type safety, a polished user interface, and robust testing infrastructure.

**Key Completed Features**:

- Mobile-First Responsive Design (punk rock ticket interface)
- Advanced Filtering & Search
- Multi-View Support (List/Calendar toggle with routing)
- Accessibility Compliance (WCAG 2.1 AA standard)
- Debug & Development Tools
- Performance Optimized (Chunked loading, caching, Web Workers)
- Internationalization Ready (Language selector, multi-locale support)
- Dark/Light Mode

**Next Phases of Development**:

- **Phase 7**: Event List & Filtering - Virtualized infinite scroll, advanced filters
- **Phase 8**: Calendar Views - FullCalendar integration
- **Phase 9**: Multilingual Support - Complete i18n implementation
- **Phase 10**: Artist & Venue Directories
- **Phase 11**: Event Details & Interactions
- **Phase 12**: Venue Digital Signage

## 2. Development Environment and Commands

The project uses Node.js 18+ and npm/yarn.

### Core Development

- `npm run dev`: Start development server with hot reload on `http://localhost:5173`
- `npm run build`: Build for production (runs ETL, TypeScript, and Vite build)
- `npm run preview`: Preview production build locally

### Code Quality

- `npm run lint`: Run ESLint with TypeScript support
- `npm run lint:fix`: Auto-fix ESLint errors
- `npm run format`: Format code with Prettier
- `npm run format:check`: Check code formatting without modifying files

### Testing

- `npm run test`: Run Vitest in watch mode
- `npm run test:run`: Run all tests once
- `npm run test:coverage`: Run tests with coverage report
- `npm run test -- src/test/DataService.test.ts`: Run single test file

### ETL Data Processing

- `npm run etl`: Process raw data files and generate JSON outputs
- `npm run etl:verbose`: Run ETL with verbose logging
- `node scripts/run-etl.js`: Direct ETL script execution

**Note**: There are broken NVM aliases due to multiple NVM instances. Prefix affected commands with `\` (e.g., `\npx tsc --noEmit`).

## 3. Architecture Overview

### Data Pipeline (ETL)

- **Source Data**: `data/events.txt`, `data/venues.txt`, `data/radio-shows.txt`
- **Processing**: `src/lib/etl/` (processor.ts, parsers.ts, indexer.ts, utils.ts)
- **Output**: `public/data/` (manifest.json, events-YYYY-MM.json, artists.json, venues.json, indexes.json, search-\*.json)
- **Processing Order**: Events → Venues → Artists → Normalization → Indexing → Chunking
- **Data Validation**: All output validated against JSON schemas.
- **Error Handling**: Comprehensive error collection with line numbers and context.

### Type System

- Strict TypeScript with branded types for safety (`src/types/`)
- Branded types prevent ID mixing (EventId, ArtistId, VenueId)
- Strict TypeScript configuration with no `any` types.
- Runtime type guards for data validation.

### Frontend Architecture

- React 19, TypeScript, Vite, Tailwind CSS, Zustand, Vitest + Testing Library.
- **Path Aliases**: `@/` maps to `src/`, plus specific aliases for `@/components/*`, `@/utils/*`, `@/types/*`, `@/hooks/*`, `@/stores/*`, `@/pages/*`.
- **Base Path for GitHub Pages**: `/zivv/` in production.
- **Key Services**: `src/services/DataService.ts`, `CacheService.ts`, `WorkerService.ts`
- **Web Worker**: `src/workers/dataWorker.ts` for background processing.
- **Chunked Data Loading**: Events loaded by month for performance.
- **IndexedDB Caching**: Browser-based caching with version invalidation.

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

## 4. Development Guidelines and Code Quality

- **Strict TypeScript**: No `any` types.
- **Linting & Formatting**: Follow existing ESLint and Prettier configurations.
- **Documentation**: Maintain comprehensive JSDoc.
- **Error Handling**: All ETL functions and critical operations should include proper error handling.
- **Branded Types**: Use for entity IDs.
- **Testing**: Unit tests for ETL, integration tests for pipelines, component tests with Testing Library. Test files in `src/test/`.
- **Performance**: ETL optimized for large datasets, memory-conscious processing, efficient data structures.

## 6. Debug and Development Features

- **HomePage Debug Panel**: Displays loading counts, states, errors, search queries, filter states.
- **Event Card Debug Information**: Complete event data below each ticket (ID, slug, status, age, timezone, etc.).
- **Debug Styling**: Light/Dark Mode adaptive, high contrast labels, responsive grid.
- **Asset Management**: `src/assets/soldout-transparent.png` for sold-out overlays.

## 7. Multilingual Support (Phase 9 Implementation Plan)

### Language Infrastructure

- **React i18n Library**: Integration with `react-i18next` for dynamic translations.
- **Language State Management**: Zustand store for current language preference.
- **Browser Integration**: Automatic detection of user\'s preferred language.
- **Persistent Storage**: `localStorage` to remember user\'s language choice.

### Translation Architecture

**Translation Files Structure**:

```
public/locales/
├── en.json      # English translations
├── es.json      # Spanish translations
└── [fr, de]/... # Other languages
```

**Translation Keys Strategy**:

- **Nested JSON Structure**: Organized by feature/component.
- **Pluralization Support**: Handle singular/plural forms.
- **Variable Interpolation**: Dynamic content insertion.
- **Fallback System**: English as default for missing translations.

## 8. Documentation Guidelines (for Agents)

- The `docs` directory is the central location for all project documentation (planning, activity tracking, general docs, technical specs).
- When asked to understand project goals, architecture, or features, consult the `docs` directory first.
- When creating new documentation or plans, place them in the `docs` directory.
- Always consider the contents of the `docs` directory for context.

## 9. Key Files for Context

- `AGENTS.md`: Your primary instructions for AI agents.
- `CLAUDE.md`: General project overview and development guidance (if present).
- `README.md`: General project overview and setup.
- `docs/implementation-plan.md`: Detailed project roadmap and status.
- `docs/prd.md`: Product requirements, user stories, data model, architecture.
- `docs/step-1.1-repository-setup-todo.md`: Detailed setup checklist.

By adhering to the information within this `AGENTS.md` file, you will be well-equipped to contribute effectively to the Zivv project.
