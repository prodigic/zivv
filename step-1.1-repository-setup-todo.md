# Step 1.1 - Repository Setup and Tooling - Detailed Todo List

## Overview

**Total Effort**: 8 hours  
**Dependencies**: None  
**Goal**: Initialize repository with complete development environment and CI/CD foundation

---

## ✅ Core Repository Setup

### Initial Project Configuration

- [ ] Create new repository on GitHub named "zivv"
- [ ] Initialize Git repository in current zivv directory (if not already done)
  ```bash
  git init
  git remote add origin <github-repo-url>
  ```
- [ ] Initialize Vite project using React-TypeScript template in current directory
  ```bash
  npm create vite@latest . -- --template react-ts
  ```
- [ ] Verify project structure is created correctly (files should be in root zivv folder)
- [ ] Test initial dev server runs successfully (`npm run dev`)

### Git Configuration

- [ ] Create comprehensive `.gitignore` file
  - [ ] Add `node_modules/`
  - [ ] Add `dist/` and `build/` directories
  - [ ] Add `.env` and `.env.local` files
  - [ ] Add IDE-specific files (`.vscode/`, `.idea/`)
  - [ ] Add OS-specific files (`.DS_Store`, `Thumbs.db`)
  - [ ] Add testing artifacts (`coverage/`)
- [ ] Create initial `README.md` with project description
  - [ ] Include project purpose and goals
  - [ ] Add basic setup instructions
  - [ ] Include tech stack overview
  - [ ] Add development workflow guidelines

---

## ✅ Development Environment Setup

### Package Dependencies Installation

- [ ] Install and configure Tailwind CSS
  ```bash
  npm install -D tailwindcss postcss autoprefixer @tailwindcss/forms
  npx tailwindcss init -p
  ```
- [ ] Install development tools
  ```bash
  npm install -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser
  npm install -D prettier eslint-plugin-prettier eslint-config-prettier
  npm install -D @types/node
  ```
- [ ] Install testing framework
  ```bash
  npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom
  ```

### TypeScript Configuration

- [ ] Update `tsconfig.json` for strict mode
  - [ ] Enable `"strict": true`
  - [ ] Enable `"noImplicitAny": true`
  - [ ] Enable `"strictNullChecks": true`
  - [ ] Add path aliases configuration
    ```json
    {
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@/*": ["./src/*"],
          "@/components/*": ["./src/components/*"],
          "@/utils/*": ["./src/utils/*"],
          "@/types/*": ["./src/types/*"]
        }
      }
    }
    ```
- [ ] Configure Vite to recognize path aliases in `vite.config.ts`
  ```typescript
  export default defineConfig({
    base: process.env.NODE_ENV === "production" ? "/zivv/" : "/",
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  });
  ```

### Linting and Formatting Setup

- [ ] Create `.eslintrc.cjs` configuration
  - [ ] Configure TypeScript parser
  - [ ] Add React hooks rules
  - [ ] Enable accessibility linting
  - [ ] Configure import ordering rules
- [ ] Create `.prettierrc` configuration
  - [ ] Set consistent formatting rules
  - [ ] Configure line length, semicolons, quotes
  - [ ] Set up automatic trailing comma handling
- [ ] Create `.prettierignore` file
- [ ] Add format and lint scripts to `package.json`
  ```json
  {
    "scripts": {
      "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0",
      "lint:fix": "eslint . --ext ts,tsx --fix",
      "format": "prettier --write \"src/**/*.{ts,tsx,css,md}\"",
      "format:check": "prettier --check \"src/**/*.{ts,tsx,css,md}\""
    }
  }
  ```

---

## ✅ Tailwind CSS Configuration

### Basic Tailwind Setup

- [ ] Update `tailwind.config.js` with content paths
  ```javascript
  module.exports = {
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    theme: {
      extend: {},
    },
    plugins: [require("@tailwindcss/forms")],
  };
  ```
- [ ] Add Tailwind directives to main CSS file
  ```css
  @tailwind base;
  @tailwind components;
  @tailwind utilities;
  ```
- [ ] Test Tailwind classes work in a sample component

### Custom Design Tokens

- [ ] Define brand color palette in Tailwind config
  - [ ] Primary color variants (punk/alternative theme)
  - [ ] Secondary color variants
  - [ ] Neutral grays and backgrounds
  - [ ] Semantic colors (success, warning, error)
- [ ] Configure typography settings
  - [ ] Font families (headings vs body text)
  - [ ] Font size scale
  - [ ] Line height ratios
- [ ] Set up spacing scale customizations
- [ ] Configure breakpoint strategy for responsive design
- [ ] Add dark mode configuration
  ```javascript
  module.exports = {
    darkMode: "class", // or 'media'
    theme: {
      extend: {
        colors: {
          // Custom color definitions
        },
      },
    },
  };
  ```

---

## ✅ Testing Environment Setup

### Vitest Configuration

- [ ] Create `vite.config.ts` test configuration
  ```typescript
  export default defineConfig({
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
    },
  });
  ```
- [ ] Create test setup file with testing library configuration
- [ ] Add test scripts to `package.json`
  ```json
  {
    "scripts": {
      "test": "vitest",
      "test:run": "vitest run",
      "test:coverage": "vitest run --coverage"
    }
  }
  ```
- [ ] Create sample component test to verify testing setup
- [ ] Verify test runner works correctly

### Testing Dependencies

- [ ] Install additional testing utilities if needed
- [ ] Configure coverage reporting
- [ ] Set up test file patterns and conventions
- [ ] Create testing utilities and helpers directory structure

---

## ✅ GitHub Actions CI/CD Pipeline

### Basic Workflow Setup

- [ ] Create `.github/workflows/` directory
- [ ] Create `deploy.yml` workflow file
- [ ] Configure workflow triggers
  ```yaml
  name: Deploy to GitHub Pages
  on:
    push:
      branches: [main]
    pull_request:
      branches: [main]
  ```

### Build and Test Jobs

- [ ] Configure Node.js environment setup
  ```yaml
  - uses: actions/setup-node@v4
    with:
      node-version: "18"
      cache: "npm"
  ```
- [ ] Add dependency installation step
- [ ] Add linting check step
- [ ] Add type checking step
- [ ] Add test execution step
- [ ] Add build step with proper base path

### GitHub Pages Deployment

- [ ] Configure GitHub Pages deployment job
  ```yaml
  - name: Deploy to GitHub Pages
    uses: peaceiris/actions-gh-pages@v3
    with:
      github_token: ${{ secrets.GITHUB_TOKEN }}
      publish_dir: ./dist
  ```
- [ ] Set up proper permissions for GitHub Pages deployment
- [ ] Configure repository settings for GitHub Pages
- [ ] Test deployment process with sample build

### Environment and Secrets Management

- [ ] Configure any necessary environment variables
- [ ] Set up GitHub repository secrets if needed
- [ ] Document secret requirements in README
- [ ] Test workflow runs successfully on push to main

---

## ✅ GitHub Pages SPA Configuration

### SPA Route Handling

- [ ] Create `public/404.html` file
  - [ ] Copy content from `index.html`
  - [ ] Ensure client-side routing fallback works
- [ ] Configure base path handling in Vite config
  ```typescript
  base: process.env.NODE_ENV === "production" ? "/zivv/" : "/",
  ```
- [ ] Test that all routes work on GitHub Pages deployment

### Performance Configuration

- [ ] Configure caching headers (if applicable)
- [ ] Add CNAME file for custom domain (if planned)
- [ ] Optimize build output for GitHub Pages
- [ ] Test deployed site performance and routing

---

## ✅ Development Workflow Setup

### Project Structure

- [ ] Create recommended folder structure
  ```
  src/
    components/
    utils/
    types/
    hooks/
    stores/
    pages/
    assets/
  ```
- [ ] Add index files for clean imports
- [ ] Set up absolute import paths
- [ ] Create initial component examples

### Development Scripts

- [ ] Verify all npm scripts work correctly
- [ ] Test hot reload functionality
- [ ] Confirm TypeScript compilation works
- [ ] Validate linting and formatting commands
- [ ] Test build process generates correct output

### Quality Assurance

- [ ] Run full linting check - should pass with no errors
- [ ] Run formatting check - should pass with no changes needed
- [ ] Execute test suite - should pass (even if minimal)
- [ ] Build project - should complete without errors
- [ ] Start dev server - should run without warnings

---

## ✅ Final Verification

### Local Development Environment

- [ ] Test from fresh clone (optional verification step)
  - [ ] Clone repository to new location for testing
  - [ ] Run `npm install` from fresh clone
- [ ] Execute `npm run dev` - should start development server
- [ ] Execute `npm run build` - should create production build
- [ ] Execute `npm run lint` - should pass without errors
- [ ] Execute `npm run format:check` - should pass without changes
- [ ] Execute `npm run test` - should run and pass tests

### CI/CD Pipeline Verification

- [ ] Push changes to main branch
- [ ] Verify GitHub Actions workflow triggers
- [ ] Confirm all workflow steps pass (install, lint, test, build)
- [ ] Verify deployment to GitHub Pages completes
- [ ] Test deployed site loads and functions correctly
- [ ] Verify SPA routing works on deployed site

### Documentation and Repository

- [ ] Update README.md with setup instructions
- [ ] Document development workflow and commands
- [ ] Add contributing guidelines (if applicable)
- [ ] Tag initial release/milestone
- [ ] Create GitHub repository description and topics

---

## 📋 Acceptance Criteria Checklist

- [x] Repository created with proper .gitignore and README
- [x] Vite + React + TypeScript + Tailwind configured and working
- [x] ESLint + Prettier + TypeScript strict mode enforcing code quality
- [x] GitHub Actions workflow for build/test/deploy to Pages
- [x] Dev server running with hot reload
- [x] Base path configuration for GitHub Pages deployment
- [x] Path aliases configured (@/components, @/utils, etc.)
- [x] Vitest testing environment ready

---

## ⚠️ Notes and Considerations

- **IMPORTANT**: Initialize project directly in current `zivv` directory - do NOT create nested `zivv/zivv` folder structure
- When running `npm create vite@latest . -- --template react-ts`, the `.` ensures files are created in current directory
- Ensure Node.js version compatibility (recommend Node 18+)
- Test deployment thoroughly before marking complete
- Keep bundle size considerations in mind from the start
- Verify all paths work correctly with GitHub Pages base path (`/zivv/`)
- Consider mobile-first development approach
- Remember to test on multiple browsers during development

**Estimated Completion Time**: 8 hours
**Status**: Ready to begin implementation
