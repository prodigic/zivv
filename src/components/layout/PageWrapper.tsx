/**
 * Wrapper component for lazy-loaded pages with error boundary
 */

import React, { Suspense } from "react";
import { ErrorBoundary } from "@/components/error/ErrorBoundary.tsx";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner.tsx";

export const PageWrapper: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <ErrorBoundary>
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
          <LoadingSpinner />
        </div>
      }
    >
      {children}
    </Suspense>
  </ErrorBoundary>
);
