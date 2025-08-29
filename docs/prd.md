# Bay Area Punk Show Finder - Product Requirements Document

## 1. Problem Statement and Goals

### Problem

Bay Area punk and alternative music fans struggle to discover live shows across the region's diverse venue landscape. Current solutions like foopee.com/punk/the-list/ provide comprehensive data but lack modern mobile-friendly interfaces, filtering capabilities, and calendar views that today's users expect.

### Goals

1. **Primary**: Create a mobile-first web application that makes Bay Area punk show discovery effortless and engaging
2. **Discoverability**: Enable users to find shows by date, artist, venue, location, and price point
3. **Accessibility**: Ensure the app is usable by all fans regardless of technical ability or accessibility needs
4. **Performance**: Deliver fast, responsive experience even with large datasets
5. **Reliability**: Provide up-to-date, accurate show information with minimal downtime

### Non-Goals

- Ticket purchasing integration (link to external sources only)
- Social features (comments, reviews, check-ins)
- Artist/venue editorial content (bios, photos, etc.)
- Push notifications or mobile app
- Real-time updates (weekly batch updates sufficient)

## 2. User Personas and Stories

### Primary Persona: Active Show-Goer "Sam"

- Age: 22-35, tech-comfortable, attends 2-4 shows per month
- Uses mobile device 80% of the time
- Values efficiency and comprehensive information
- Often plans shows day-of or week-of

### Secondary Persona: Casual Explorer "Taylor"

- Age: 18-45, varies from tech novice to expert
- Attends shows monthly or less frequently
- Needs more context and guidance
- Often plans further in advance

### User Stories with Acceptance Criteria

**Epic 1: Show Discovery**

- **US1.1**: As Sam, I want to see upcoming shows in a scrollable feed so I can quickly browse tonight/this week's options
  - AC1: Infinite scroll list loads 20 shows initially, 20 more on scroll
  - AC2: Each card shows date, headliner, venue, city, price, age restriction
  - AC3: List defaults to next 30 days, sorted by date ascending
  - AC4: Scroll position maintained when navigating back from detail

- **US1.2**: As Taylor, I want to filter shows by city and date range so I can focus on relevant options
  - AC1: City filter shows all Bay Area cities with show counts
  - AC2: Date range picker supports relative ranges (This Weekend, Next Week, This Month)
  - AC3: Filters persist in URL for sharing and browser back
  - AC4: Clear visual indication of active filters with easy removal

**Epic 2: Calendar Views**

- **US2.1**: As Sam, I want to see shows in a calendar format so I can plan around my schedule
  - AC1: Month view shows events as dots/indicators on dates with show counts
  - AC2: Week view shows events in time slots with basic details
  - AC3: Agenda view provides chronological list grouped by date
  - AC4: Touch/click on calendar items shows event details

**Epic 3: Artist & Venue Exploration**

- **US3.1**: As Taylor, I want to browse artists alphabetically so I can discover new bands
  - AC1: Artist directory with A-Z navigation and search
  - AC2: Each artist shows upcoming show count and next show date
  - AC3: Artist detail page lists all upcoming shows for that artist
  - AC4: Support for artist aliases/alternate names

- **US3.2**: As Sam, I want to see all shows at my favorite venues so I can be a regular
  - AC1: Venue directory with city grouping and search
  - AC2: Venue detail shows address, age policy, upcoming shows
  - AC3: Optional: Map link for directions
  - AC4: Contact information (phone, website) when available

**Epic 4: Search & Filters**

- **US4.1**: As both personas, I want to search for specific artists or venues
  - AC1: Real-time search with results appearing as user types
  - AC2: Search covers artist names, venue names, and event descriptions
  - AC3: Search results highlight matching terms
  - AC4: Recent searches saved locally (optional)

- **US4.2**: As Taylor, I want to filter by show characteristics to find suitable events
  - AC1: All-ages filter excludes 18+/21+ shows
  - AC2: Price range slider with free show toggle
  - AC3: Multiple filters can be combined
  - AC4: Filter state visible and easily modifiable

## 3. Feature Specifications

### 3.1 Calendar Views

**Month View**

- Full month grid with responsive sizing
- Date cells show event count indicators (dots, numbers, or colored bars)
- Tap date to see day's events in popover or navigate to agenda view
- Navigation arrows for prev/next month
- Today highlighted distinctly
- Loading states for adjacent months

**Week View**

- 7-day horizontal scroll on mobile, full week on desktop
- Time slots from 6 PM to 2 AM (typical show times)
- Events positioned by start time with duration indicators
- Venue abbreviations to fit mobile width
- Swipe/arrow navigation between weeks

**Agenda/List View**

- Chronological list grouped by date
- Collapsible date headers
- Each event as compact card with key details
- Infinite scroll loading future months
- Jump-to-date functionality

### 3.2 Infinite Card Scroll (Primary View)

**Card Design**

- **Header**: Date + day of week, city tag
- **Primary**: Headliner artist name (larger font)
- **Secondary**: Supporting artists (smaller, max 2-3 shown with "+" indicator)
- **Venue**: Venue name + neighborhood/city
- **Meta**: Price, age restriction, time, special indicators
- **Actions**: Tap to expand/navigate to detail

**List Behavior**

- Initial load: 20 events
- Infinite scroll: Load 20 more when approaching bottom
- Pull-to-refresh support
- Empty states with helpful messaging
- Loading skeleton cards during fetch

### 3.3 Artist & Venue Directories

**Artist Directory (/artists)**

- Alphabetical sections with jump navigation (A, B, C...)
- Search bar at top
- Each entry shows: name, next show date, upcoming show count
- Filter by "Has upcoming shows" toggle

**Artist Detail (/artist/:slug)**

- Artist name and aliases
- Upcoming shows list (chronological)
- Past shows list (optional, if data available)
- External links (if available in data)

**Venue Directory (/venues)**

- Group by city with collapsible sections
- Search across venue names
- Each entry shows: name, city, next show date, upcoming count

**Venue Detail (/venue/:slug)**

- Venue name, address, contact info
- Age policy and capacity (if available)
- Upcoming shows chronological list
- Map link for directions
- Recent shows (optional)

### 3.4 Event Detail

**Detail View Options**

- Expandable card overlay (mobile-first)
- Dedicated route /event/:slug (shareable)
- Drawer/modal pattern for desktop

**Content**

- **Primary Info**: Date/time, headliner, venue, address
- **Artists**: Full lineup with headliner highlighted
- **Logistics**: Price, age restriction, door/show times
- **Actions**: Ticket link (external), venue directions, share
- **Meta**: Source attribution, last updated timestamp

### 3.5 Filters & Search

**Filter Categories**

1. **Geography**: City (multi-select)
2. **Time**: Date range picker + quick presets
3. **Price**: Range slider + "Free shows only" toggle
4. **Age**: "All ages only" toggle
5. **Future**: Genre tags (when available in data)

**Search Implementation**

- Debounced real-time search (300ms delay)
- Search targets: artist names, venue names, event descriptions
- Highlight matching terms in results
- Search within current filter context
- Clear search + filters action

**Filter Persistence**

- URL parameters for sharing filtered views
- Local storage for user preference defaults
- Clear indication of active filters

## 4. Information Architecture and Routing

### URL Structure

```
/ (Home - infinite card list)
/calendar (defaults to month view)
/calendar/month
/calendar/week
/calendar/agenda
/artists
/artist/:slug
/venues
/venue/:slug
/event/:slug (optional - could use modals instead)
```

### Navigation Structure

**Mobile Bottom Navigation**

- Home (infinite list icon)
- Calendar (calendar icon)
- Artists (people icon)
- Venues (location icon)

**Header Actions**

- Search toggle/input
- Filter panel toggle
- Settings (optional)

**GitHub Pages Configuration**

- Base path handling for repository deployment
- 404.html fallback for SPA routing
- Cache headers for static assets

## 5. Data Model and Schema

### 5.1 Core Entities

```typescript
interface Event {
  id: number;
  slug: string;
  dateEpochMs: number;
  startTimeEpochMs?: number; // Optional specific start time
  endTimeEpochMs?: number; // Optional, derived from typical show length
  tz: "America/Los_Angeles";
  headlinerArtistId: number;
  artistIds: number[]; // All artists including headliner
  venueId: number;
  address: string;
  city: string;
  priceMin?: number; // Null for free shows
  priceMax?: number; // Null if single price
  isFree: boolean;
  ageRestriction: "All Ages" | "18+" | "21+" | "16+" | "12+" | "8+" | "5+";
  ticketUrl?: string;
  sourceUrl?: string;
  description?: string;
  notes?: string; // Special instructions, themes, etc.
  tags: string[]; // ['sold-out', 'mosh-warning', 'under-21-surcharge']
  createdAtEpochMs: number; // For future "Recently Added" sort
  updatedAtEpochMs: number;
}

interface Artist {
  id: number;
  slug: string;
  name: string;
  altNames: string[]; // Alternative names, abbreviations
  tags: string[]; // Genre tags, characteristics
}

interface Venue {
  id: number;
  slug: string;
  name: string;
  address: string;
  city: string;
  phone?: string;
  website?: string;
  agePolicy?: string; // Default age restriction
  lat?: number; // For future map features
  lng?: number;
}
```

### 5.2 Pre-computed Indexes

```typescript
interface DataManifest {
  datasetVersion: string; // YYYY-MM-DD format
  lastUpdated: number; // Epoch timestamp
  totalEvents: number;
  dateRange: {
    startEpochMs: number;
    endEpochMs: number;
  };
  chunks: {
    events: ChunkInfo[]; // Monthly chunks
    artists: ChunkInfo; // Single file
    venues: ChunkInfo; // Single file
    indexes: ChunkInfo; // Single file
  };
}

interface ChunkInfo {
  filename: string;
  size: number;
  checksum: string;
  dateRange?: {
    // For event chunks
    startEpochMs: number;
    endEpochMs: number;
  };
}

interface Indexes {
  eventIdsByYYYYMM: Record<string, number[]>; // "2024-08" -> [1,2,3]
  eventIdsByCity: Record<string, number[]>; // "Oakland" -> [1,2,3]
  eventIdsByArtistId: Record<number, number[]>; // 123 -> [1,2,3]
  eventIdsByVenueId: Record<number, number[]>; // 456 -> [1,2,3]
  eventIdsByDateEpochMs: Record<number, number[]>; // Daily buckets
  artistIdBySlug: Record<string, number>; // "black-flag" -> 123
  venueIdBySlug: Record<string, number>; // "924-gilman" -> 456
  searchIndex?: {
    artists: SearchIndexEntry[];
    venues: SearchIndexEntry[];
    events: SearchIndexEntry[];
  };
}

interface SearchIndexEntry {
  id: number;
  text: string; // Normalized searchable text
  boost: number; // Search relevance boost (1.0 = normal)
}
```

### 5.3 JSON Schema Definitions

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "events": {
      "type": "array",
      "items": {
        "$ref": "#/definitions/Event"
      }
    },
    "artists": {
      "type": "array",
      "items": {
        "$ref": "#/definitions/Artist"
      }
    },
    "venues": {
      "type": "array",
      "items": {
        "$ref": "#/definitions/Venue"
      }
    }
  },
  "definitions": {
    "Event": {
      "type": "object",
      "required": [
        "id",
        "slug",
        "dateEpochMs",
        "headlinerArtistId",
        "artistIds",
        "venueId",
        "city",
        "isFree",
        "ageRestriction"
      ],
      "properties": {
        "id": { "type": "integer" },
        "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" },
        "dateEpochMs": { "type": "integer" },
        "startTimeEpochMs": { "type": "integer" },
        "tz": { "type": "string", "enum": ["America/Los_Angeles"] },
        "headlinerArtistId": { "type": "integer" },
        "artistIds": { "type": "array", "items": { "type": "integer" } },
        "venueId": { "type": "integer" },
        "address": { "type": "string" },
        "city": { "type": "string" },
        "priceMin": { "type": "number", "minimum": 0 },
        "priceMax": { "type": "number", "minimum": 0 },
        "isFree": { "type": "boolean" },
        "ageRestriction": {
          "type": "string",
          "enum": ["All Ages", "18+", "21+", "16+", "12+", "8+", "5+"]
        },
        "tags": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

## 6. Technical Architecture

### 6.1 Data Ingestion Pipeline

**Webhook → Serverless → GitHub Actions Flow**

1. **Webhook Endpoint** (Cloudflare Workers recommended)
   - Receives Friday data update webhook from provider
   - Validates payload and authenticates source
   - Triggers GitHub Actions via repository_dispatch API
   - Includes data URLs and version identifier in payload

2. **GitHub Actions ETL Workflow**
   - Triggered by repository_dispatch or manual workflow_dispatch
   - Downloads provider data using credentials from GitHub Secrets
   - Runs normalization, deduplication, and validation
   - Generates chunked JSON files and precomputed indexes
   - Creates PR with updated data files
   - On merge to main, triggers Pages deployment

3. **Data Processing Steps**
   - Parse source format (likely text-based like current files)
   - Normalize entities (events, artists, venues)
   - Deduplicate using date + venue + headliner key
   - Generate slugs and assign numeric IDs
   - Build search indexes and cross-references
   - Chunk events by YYYY-MM
   - Validate against JSON Schema
   - Generate data manifest with checksums

### 6.2 Client Application Architecture

**Tech Stack**

- **Framework**: React 18 with TypeScript
- **Styling**: Tailwind CSS 3.x
- **Build**: Vite 5.x for optimal performance
- **Routing**: React Router 6.x with GitHub Pages base path support
- **State**: Zustand (lightweight, good TypeScript support)
- **HTTP**: Native fetch with retry logic
- **Calendar UI**: FullCalendar React (mature, accessible, customizable)
- **Search**: MiniSearch (small bundle, good features)
- **Virtualization**: react-virtuoso (excellent mobile support)
- **Testing**: Vitest + Testing Library + Playwright
- **Code Quality**: ESLint + Prettier + TypeScript strict mode

**State Management Plan**

```typescript
interface AppState {
  // Data stores
  events: Record<number, Event>;
  artists: Record<number, Artist>;
  venues: Record<number, Venue>;
  indexes: Indexes;

  // UI state
  filters: FilterState;
  searchQuery: string;
  currentView: "list" | "calendar-month" | "calendar-week" | "calendar-agenda";

  // Loading states
  loadedChunks: Set<string>; // Track which YYYY-MM chunks are loaded
  isLoading: boolean;
  error?: string;

  // Cache metadata
  datasetVersion: string;
  lastRefresh: number;
}

interface FilterState {
  cities: string[];
  dateRange: {
    startEpochMs?: number;
    endEpochMs?: number;
  };
  priceRange: {
    min?: number;
    max?: number;
  };
  allAgesOnly: boolean;
  freeOnly: boolean;
}
```

### 6.3 Performance Strategy

**Bundle Optimization**

- Code splitting by route (React.lazy)
- Calendar and search libraries loaded on-demand
- Separate vendor chunk for stable dependencies
- Tree shaking and minification via Vite

**Data Loading**

- Lazy load event chunks by month/city as user navigates
- Web Worker for JSON parsing and index building
- IndexedDB cache keyed by datasetVersion
- Stale-while-revalidate pattern for updates

**Runtime Performance**

- Virtual scrolling for long lists (react-virtuoso)
- Memoized filter/search results (useMemo, React.memo)
- Debounced search input (300ms)
- Intersection Observer for infinite scroll

**Memory Management**

- LRU cache for event chunks (keep current + 2 adjacent months)
- Unload unused chunks when memory pressure detected
- Efficient data structures (arrays over objects, numeric IDs)

## 7. Accessibility Requirements

### WCAG 2.1 AA Compliance

- **Keyboard Navigation**: All interactive elements accessible via tab/arrow keys
- **Screen Readers**: Semantic HTML, proper ARIA labels, live regions for dynamic content
- **Color Contrast**: 4.5:1 minimum for normal text, 3:1 for large text
- **Focus Management**: Visible focus indicators, logical tab order, focus restoration
- **Motion**: Respect prefers-reduced-motion for animations

### Specific Implementations

- Skip links for main content
- Proper heading hierarchy (h1 → h2 → h3)
- Form labels and error messaging
- Alternative text for any decorative elements
- High contrast mode support
- Keyboard shortcuts for common actions

## 8. Performance Budget and Metrics

### Bundle Size Targets

- **Initial JavaScript**: ≤ 200KB gzipped
- **Initial CSS**: ≤ 50KB gzipped
- **Total initial payload**: ≤ 500KB (including critical data)
- **Per-month event chunk**: ≤ 100KB gzipped

### Core Web Vitals Targets

- **LCP (Largest Contentful Paint)**: ≤ 2.5s on 4G
- **TTI (Time to Interactive)**: ≤ 2.0s for main views
- **CLS (Cumulative Layout Shift)**: ≤ 0.1
- **FID (First Input Delay)**: ≤ 100ms

### Lighthouse Score Targets (Mobile)

- Performance: ≥ 90
- Accessibility: ≥ 95
- Best Practices: ≥ 90
- SEO: ≥ 90

## 9. Data Ingestion and Processing

### 9.1 Source Data Analysis

Based on the provided sample files, the current format appears to be:

**Events Format** (events.txt):

```
aug 15 fri L *Roneous & Gennessee, Bayokyo, Jay Stone, Persuadero, Know Morals
  at 924 Gilman Street, Berkeley a/a $10 7pm/7:30pm (hip hop night)
```

**Parsing Rules**:

- Date: "aug 15 fri" → parse month, day, infer year
- Artists: Comma-separated, headliner often marked with symbols
- Venue line: "at [venue], [city] [age] [price] [time] [notes]"
- Special markers: L (headliner?), \* (special?), # (sold out?), @ (mosh pit warning?)

### 9.2 Normalization Strategy

**Deduplication Logic**

- Primary key: date (YYYY-MM-DD) + venue + headliner artist
- Keep most recent updatedAt timestamp for conflicts
- Handle venue name variations (fuzzy matching)
- Artist name normalization (case, punctuation, "The" prefix)

**Data Quality Rules**

- Required fields validation
- Date range validation (no past dates beyond reasonable window)
- Price format standardization
- City name standardization
- Age restriction normalization

### 9.3 Update Workflow

**Friday Data Pipeline**

1. Provider webhook triggers serverless function
2. Function authenticates, downloads new data
3. Triggers GitHub Actions with data version identifier
4. Actions workflow processes, validates, chunks data
5. Opens PR with updated JSON files
6. On PR merge, GitHub Pages deploys updated site
7. Client apps detect new datasetVersion and refresh caches

**Failure Handling**

- Webhook retries with exponential backoff
- GitHub Actions timeout and retry configuration
- Data validation errors block deployment
- Rollback capability via Git revert
- Monitoring alerts for pipeline failures

## 10. Risks and Mitigations

### Technical Risks

1. **Large data spikes**: Pagination and lazy loading, memory management
2. **Provider format changes**: Robust parsing with fallbacks, validation
3. **GitHub Actions limits**: Monitor usage, consider alternative hosting for ETL
4. **Mobile performance**: Bundle analysis, performance budgets, testing on real devices

### Product Risks

1. **User adoption**: SEO optimization, social sharing, performance
2. **Data accuracy**: Source validation, user feedback mechanism
3. **Maintenance burden**: Automated testing, monitoring, documentation

### Business Risks

1. **Provider terms changes**: Legal review, backup data sources
2. **Hosting costs**: GitHub Pages is free, monitor any serverless costs
3. **Competition**: Focus on unique Bay Area expertise and mobile experience

## 11. Success Metrics and KPIs

### Launch Metrics (First 3 months)

- **Adoption**: 1,000+ monthly active users
- **Engagement**: 2.5+ pages per session, 60s+ average session
- **Performance**: Core Web Vitals in green, <5% error rate
- **Accessibility**: Zero critical a11y issues in automated scans

### Growth Metrics (6 months)

- **Retention**: 40%+ monthly retention rate
- **Discovery**: 50%+ users engage with calendar or directory views
- **Search Usage**: 30%+ users utilize search or filters
- **Mobile**: 80%+ mobile traffic (confirms mobile-first approach)

## 12. Future Enhancements (Post-Launch)

### Phase 2 Features

- "Recently Added" sort using createdAt timestamps
- PWA capabilities for offline access
- Map view integration with venue locations
- Rich search with genre/tag filtering
- Personal favorites and show tracking

### Advanced Features

- Calendar export (ICS file generation)
- Social sharing optimizations (OpenGraph)
- Show reminders (browser notifications)
- Artist/venue follow functionality
- Show history and statistics

---

_This PRD serves as the foundation for the implementation plan and development work. All features and requirements should be validated against these specifications during development._
