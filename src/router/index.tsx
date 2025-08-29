/**
 * React Router configuration with GitHub Pages support
 */

import { createBrowserRouter, Navigate } from "react-router-dom";
import { lazy } from "react";
import { AppShell } from "@/components/layout/AppShell.tsx";
import { RouterErrorBoundary } from "@/components/error/ErrorBoundary.tsx";
import { PageWrapper } from "@/components/layout/PageWrapper.tsx";

// Lazy load page components for code splitting
const HomePage = lazy(() => import("@/pages/HomePage.tsx"));
const CalendarPage = lazy(() => import("@/pages/CalendarPage.tsx"));
const ArtistsPage = lazy(() => import("@/pages/ArtistsPage.tsx"));
const ArtistDetailPage = lazy(() => import("@/pages/ArtistDetailPage.tsx"));
const VenuesPage = lazy(() => import("@/pages/VenuesPage.tsx"));
const VenueDetailPage = lazy(() => import("@/pages/VenueDetailPage.tsx"));
const EventDetailPage = lazy(() => import("@/pages/EventDetailPage.tsx"));
const AboutPage = lazy(() => import("@/pages/AboutPage.tsx"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage.tsx"));

// PageWrapper now imported from components/layout/PageWrapper.tsx

// Router configuration
export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <AppShell />,
      errorElement: <RouterErrorBoundary />,
      children: [
        {
          index: true,
          element: (
            <PageWrapper>
              <HomePage />
            </PageWrapper>
          ),
        },
        {
          path: "calendar",
          children: [
            {
              index: true,
              element: <Navigate to="/calendar/month" replace />,
            },
            {
              path: "month",
              element: (
                <PageWrapper>
                  <CalendarPage view="month" />
                </PageWrapper>
              ),
            },
            {
              path: "week",
              element: (
                <PageWrapper>
                  <CalendarPage view="week" />
                </PageWrapper>
              ),
            },
            {
              path: "agenda",
              element: (
                <PageWrapper>
                  <CalendarPage view="agenda" />
                </PageWrapper>
              ),
            },
          ],
        },
        {
          path: "artists",
          children: [
            {
              index: true,
              element: (
                <PageWrapper>
                  <ArtistsPage />
                </PageWrapper>
              ),
            },
            {
              path: ":slug",
              element: (
                <PageWrapper>
                  <ArtistDetailPage />
                </PageWrapper>
              ),
            },
          ],
        },
        {
          path: "venues",
          children: [
            {
              index: true,
              element: (
                <PageWrapper>
                  <VenuesPage />
                </PageWrapper>
              ),
            },
            {
              path: ":slug",
              element: (
                <PageWrapper>
                  <VenueDetailPage />
                </PageWrapper>
              ),
            },
          ],
        },
        {
          path: "event/:slug",
          element: (
            <PageWrapper>
              <EventDetailPage />
            </PageWrapper>
          ),
        },
        {
          path: "about",
          element: (
            <PageWrapper>
              <AboutPage />
            </PageWrapper>
          ),
        },
        {
          path: "*",
          element: (
            <PageWrapper>
              <NotFoundPage />
            </PageWrapper>
          ),
        },
      ],
    },
  ],
  {
    basename: import.meta.env.PROD ? "/zivv" : "/",
  }
);

// Router hook for URL filter synchronization
export const useURLFilters = () => {
  // This will be implemented as a custom hook
  // that syncs filter state with URL parameters
};