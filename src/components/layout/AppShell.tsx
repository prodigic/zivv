/**
 * Main application shell with responsive layout and navigation
 */

import React, { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Header } from "./Header.tsx";
import { BottomNavigation } from "./BottomNavigation.tsx";
import { SideNavigation } from "./SideNavigation.tsx";
import { useAppStore } from "@/stores/appStore.ts";
import { useDarkMode } from "@/hooks/useDarkMode";
import { PageLoading } from "@/components/ui/LoadingSpinner.tsx";
import { ErrorBoundary } from "@/components/error/ErrorBoundary.tsx";

export const AppShell: React.FC = () => {
  const location = useLocation();
  const initialize = useAppStore((state) => state.initialize);
  const loading = useAppStore((state) => state.loading);
  const errors = useAppStore((state) => state.errors);
  const dataService = useAppStore((state) => state.dataService);
  const showUpcomingOnly = useAppStore((state) => state.showUpcomingOnly);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isSideNavOpen, setIsSideNavOpen] = useState(false);
  const { setDarkMode } = useDarkMode();

  // Initialize dark mode on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("darkMode");
      if (saved !== null) {
        setDarkMode(saved === "true");
      } else {
        const systemPrefers =
          window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
        setDarkMode(systemPrefers);
      }
    }
  }, [setDarkMode]);

  // Initialize upcoming filter CSS class
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (showUpcomingOnly) {
        document.documentElement.classList.add("show-upcoming-only");
      } else {
        document.documentElement.classList.remove("show-upcoming-only");
      }
    }
  }, [showUpcomingOnly]);

  // Initialize app on mount
  useEffect(() => {
    if (!dataService && !isInitialized) {
      initialize()
        .then(() => setIsInitialized(true))
        .catch((error) => {
          console.error("Failed to initialize app:", error);
          setIsInitialized(true); // Still show UI even if init fails
        });
    }
  }, [initialize, dataService, isInitialized]);

  // Close side navigation on route changes (mobile)
  useEffect(() => {
    setIsSideNavOpen(false);
  }, [location.pathname]);

  // Show loading screen during initialization
  if (!isInitialized || loading.manifest === "loading") {
    return <PageLoading />;
  }

  // Show error if critical initialization failed
  if (errors.manifest && !dataService) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md mx-auto text-center p-6 bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="text-red-600 mb-4">
            <svg
              className="h-12 w-12 mx-auto"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Failed to Load Application
          </h2>
          <p className="text-gray-600 mb-4">
            Unable to connect to the data service. Please check your internet
            connection and try again.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-gray-50 dark:bg-gray-900">
      {/* Mobile-first layout */}
      <div className="flex flex-col h-full lg:flex-row">
        {/* Side Navigation - Desktop */}
        <SideNavigation
          isOpen={isSideNavOpen}
          onClose={() => setIsSideNavOpen(false)}
          className="hidden lg:block lg:fixed lg:left-0 lg:top-0 lg:h-screen lg:w-64 lg:z-30"
        />

        {/* Mobile Side Navigation Overlay */}
        {isSideNavOpen && (
          <div className="lg:hidden">
            {/* Backdrop */}
            <div
              className="fixed inset-0 bg-black bg-opacity-50 z-40"
              onClick={() => setIsSideNavOpen(false)}
            />

            {/* Side Navigation */}
            <SideNavigation
              isOpen={isSideNavOpen}
              onClose={() => setIsSideNavOpen(false)}
              className="fixed inset-y-0 left-0 w-64 z-50"
            />
          </div>
        )}

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col h-full lg:ml-64">
          {/* Header */}
          <Header
            onMenuToggle={() => setIsSideNavOpen(!isSideNavOpen)}
            className="flex-shrink-0"
          />

          {/* Page Content */}
          <main
            className="flex-1 pb-16 lg:pb-0 overflow-auto [&::-webkit-scrollbar]:hidden"
            style={{
              scrollbarWidth: "none", // Firefox
              msOverflowStyle: "none", // IE/Edge
            }}
          >
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </main>

          {/* Bottom Navigation - Mobile */}
          <BottomNavigation className="lg:hidden" />
        </div>
      </div>
    </div>
  );
};

// Layout wrapper for pages that need specific layout constraints
interface PageLayoutProps {
  children: React.ReactNode;
  maxWidth?: "sm" | "md" | "lg" | "xl" | "2xl" | "full";
  padding?: "none" | "sm" | "md" | "lg";
  className?: string;
}

export const PageLayout: React.FC<PageLayoutProps> = ({
  children,
  maxWidth = "lg",
  padding = "md",
  className = "",
}) => {
  const maxWidthClasses = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-4xl",
    xl: "max-w-6xl",
    "2xl": "max-w-7xl",
    full: "max-w-none",
  };

  const paddingClasses = {
    none: "",
    sm: "p-4",
    md: "p-6",
    lg: "p-8",
  };

  return (
    <div
      className={`mx-auto ${maxWidthClasses[maxWidth]} ${paddingClasses[padding]} ${className}`}
    >
      {children}
    </div>
  );
};

// Content area wrapper for consistent spacing
interface ContentAreaProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}

export const ContentArea: React.FC<ContentAreaProps> = ({
  children,
  title,
  subtitle,
  actions,
  className = "",
}) => (
  <PageLayout className={className}>
    {(title || subtitle || actions) && (
      <div className="mb-6">
        <div className="flex items-start justify-between">
          <div>
            {title && (
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
                {title}
              </h1>
            )}
            {subtitle && (
              <p className="text-gray-600 dark:text-gray-300">{subtitle}</p>
            )}
          </div>
          {actions && <div className="ml-4 flex-shrink-0">{actions}</div>}
        </div>
      </div>
    )}
    {children}
  </PageLayout>
);

// Two-column layout for desktop with sidebar
interface TwoColumnLayoutProps {
  sidebar: React.ReactNode;
  main: React.ReactNode;
  sidebarWidth?: "narrow" | "normal" | "wide";
}

export const TwoColumnLayout: React.FC<TwoColumnLayoutProps> = ({
  sidebar,
  main,
  sidebarWidth = "normal",
}) => {
  const sidebarWidthClasses = {
    narrow: "lg:w-64",
    normal: "lg:w-80",
    wide: "lg:w-96",
  };

  return (
    <PageLayout maxWidth="full" padding="md">
      <div className="lg:flex lg:gap-8">
        {/* Sidebar - Mobile: full width, Desktop: fixed width */}
        <aside
          className={`${sidebarWidthClasses[sidebarWidth]} lg:flex-shrink-0 mb-8 lg:mb-0`}
        >
          {sidebar}
        </aside>

        {/* Main content */}
        <main className="lg:flex-1 min-w-0">{main}</main>
      </div>
    </PageLayout>
  );
};
