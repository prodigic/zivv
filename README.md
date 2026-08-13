# Bay Area Punk Show Finder (zivv)

A modern, responsive web application for discovering punk and alternative music shows in the San Francisco Bay Area. Built with React, TypeScript, and Tailwind CSS.

## Features

- 📅 **Calendar Views** - Browse shows by month, week, or agenda view
- 🔍 **Advanced Search** - Find shows by artist, venue, or keyword
- 🏷️ **Smart Filtering** - Filter by city, price range, age restrictions, and more
- 📱 **Mobile-First Design** - Optimized for all devices
- ⚡ **Performance** - Fast loading with chunked data and virtual scrolling
- ♿ **Accessible** - WCAG 2.1 AA compliant

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS
- **Build Tool**: Vite
- **State Management**: Zustand
- **Calendar**: Custom calendar views
- **Virtualization**: react-virtuoso
- **Search**: Custom generated indexes and search documents
- **Testing**: Vitest, Testing Library
- **Deployment**: GitHub Pages

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/prodigic/zivv.git
   cd zivv
   ```

2. Install dependencies:

   ```bash
   npm ci
   ```

3. Start the development server:

   ```bash
   npm run dev
   ```

4. Open [http://localhost:5173](http://localhost:5173) in your browser.

## Development

### Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run preview` - Preview production build locally
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint errors automatically
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting
- `npm run test` - Run tests
- `npm run test:run` - Run tests once
- `npm run test:coverage` - Run tests with coverage
- `npm run test:e2e` - Run Playwright end-to-end tests
- `npm run build:etl` - Type-check the ETL pipeline
- `npm run etl` - Build the ETL pipeline and regenerate public data

### Project Structure

```
src/
├── components/        # React components
├── pages/            # Route components
├── hooks/            # Custom React hooks
├── stores/           # Zustand stores
├── types/            # TypeScript type definitions
├── utils/            # Utility functions
└── assets/           # Static assets
```

### Development Workflow

1. Create feature branch from main
2. Make changes with proper TypeScript types
3. Run linting and tests: `npm run lint && npm run test`
4. Build and verify: `npm run build`
5. Create pull request

The current architecture assessment and reorganization plan live in
[`docs/repo-state-and-architecture-reorg.md`](docs/repo-state-and-architecture-reorg.md) and
[`docs/reorg-parallel-agent-plan.md`](docs/reorg-parallel-agent-plan.md). The DuckDB decision is recorded in
[`docs/adr/0001-duckdb-build-time-canonical-store.md`](docs/adr/0001-duckdb-build-time-canonical-store.md).

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is open source and available under the [MIT License](LICENSE).

## Acknowledgments

- Event data provided by various Bay Area venues and promoters
- Built with modern web technologies and best practices
- Designed with accessibility and performance in mind
