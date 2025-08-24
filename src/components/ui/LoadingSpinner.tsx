/**
 * Loading spinner and skeleton components
 */

import React from "react";

// Base loading spinner
interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ 
  size = "md", 
  className = "" 
}) => {
  const sizeClasses = {
    sm: "h-4 w-4",
    md: "h-6 w-6",
    lg: "h-8 w-8",
    xl: "h-12 w-12",
  };

  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div
        className={`${sizeClasses[size]} animate-spin rounded-full border-2 border-gray-300 border-t-blue-600`}
        role="status"
        aria-label="Loading"
      >
        <span className="sr-only">Loading...</span>
      </div>
    </div>
  );
};

// Full page loading component
export const PageLoading: React.FC = () => (
  <div className="min-h-screen flex items-center justify-center bg-gray-50">
    <div className="text-center">
      <LoadingSpinner size="xl" className="mb-4" />
      <p className="text-gray-600">Loading...</p>
    </div>
  </div>
);

// Inline loading component
interface InlineLoadingProps {
  message?: string;
  size?: "sm" | "md" | "lg";
}

export const InlineLoading: React.FC<InlineLoadingProps> = ({ 
  message = "Loading...", 
  size = "sm" 
}) => (
  <div className="flex items-center space-x-2">
    <LoadingSpinner size={size} />
    <span className="text-gray-600 text-sm">{message}</span>
  </div>
);

// Skeleton components for content placeholders
export const Skeleton: React.FC<{ className?: string }> = ({ className = "" }) => (
  <div
    className={`animate-pulse bg-gray-200 dark:bg-gray-700 rounded ${className}`}
    role="status"
    aria-label="Loading content"
  />
);

// Event card skeleton
export const EventCardSkeleton: React.FC = () => (
  <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
    {/* Header */}
    <div className="flex items-center justify-between">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-4 w-16" />
    </div>
    
    {/* Title */}
    <Skeleton className="h-6 w-3/4" />
    
    {/* Subtitle */}
    <Skeleton className="h-4 w-1/2" />
    
    {/* Venue */}
    <div className="flex items-center space-x-2">
      <Skeleton className="h-4 w-4 rounded-full" />
      <Skeleton className="h-4 w-32" />
    </div>
    
    {/* Footer */}
    <div className="flex items-center justify-between pt-2">
      <div className="flex space-x-2">
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-6 w-12 rounded-full" />
      </div>
      <Skeleton className="h-4 w-20" />
    </div>
  </div>
);

// Artist card skeleton
export const ArtistCardSkeleton: React.FC = () => (
  <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
    <div className="flex items-center space-x-3">
      <Skeleton className="h-12 w-12 rounded-full" />
      <div className="space-y-2 flex-1">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
    <div className="flex justify-between text-xs">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-3 w-16" />
    </div>
  </div>
);

// Venue card skeleton
export const VenueCardSkeleton: React.FC = () => (
  <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
    <div className="space-y-2">
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
    <div className="flex justify-between items-center pt-2">
      <Skeleton className="h-6 w-16 rounded-full" />
      <Skeleton className="h-4 w-20" />
    </div>
  </div>
);

// List skeleton for multiple items
interface ListSkeletonProps {
  count?: number;
  itemSkeleton: React.ComponentType;
}

export const ListSkeleton: React.FC<ListSkeletonProps> = ({ 
  count = 5, 
  itemSkeleton: ItemSkeleton 
}) => (
  <div className="space-y-4">
    {Array.from({ length: count }, (_, index) => (
      <ItemSkeleton key={index} />
    ))}
  </div>
);

// Table skeleton
export const TableSkeleton: React.FC<{ rows?: number; cols?: number }> = ({ 
  rows = 5, 
  cols = 4 
}) => (
  <div className="overflow-hidden">
    {/* Header */}
    <div className="bg-gray-50 dark:bg-gray-700 px-6 py-3">
      <div className="flex space-x-4">
        {Array.from({ length: cols }, (_, index) => (
          <Skeleton key={index} className="h-4 flex-1" />
        ))}
      </div>
    </div>
    
    {/* Rows */}
    <div className="divide-y divide-gray-200 dark:divide-gray-700">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="px-6 py-4">
          <div className="flex space-x-4">
            {Array.from({ length: cols }, (_, colIndex) => (
              <Skeleton key={colIndex} className="h-4 flex-1" />
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
);

// Calendar skeleton
export const CalendarSkeleton: React.FC = () => (
  <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
    {/* Header */}
    <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-32" />
        <div className="flex space-x-2">
          <Skeleton className="h-8 w-8 rounded" />
          <Skeleton className="h-8 w-8 rounded" />
        </div>
      </div>
    </div>
    
    {/* Calendar grid */}
    <div className="p-6">
      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1 mb-2">
        {Array.from({ length: 7 }, (_, index) => (
          <Skeleton key={index} className="h-6 w-full" />
        ))}
      </div>
      
      {/* Calendar days */}
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: 35 }, (_, index) => (
          <div key={index} className="aspect-square p-2">
            <Skeleton className="h-4 w-6" />
            {Math.random() > 0.7 && (
              <div className="mt-1 space-y-1">
                <Skeleton className="h-2 w-full" />
                {Math.random() > 0.5 && <Skeleton className="h-2 w-3/4" />}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  </div>
);

// Search results skeleton
export const SearchSkeleton: React.FC = () => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-4 w-20" />
    </div>
    
    <div className="space-y-3">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="border-l-2 border-blue-200 dark:border-blue-600 pl-4 py-2">
          <Skeleton className="h-5 w-2/3 mb-2" />
          <Skeleton className="h-3 w-full mb-1" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  </div>
);

// Filter panel skeleton
export const FilterSkeleton: React.FC = () => (
  <div className="space-y-6">
    {Array.from({ length: 4 }, (_, sectionIndex) => (
      <div key={sectionIndex} className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, itemIndex) => (
            <div key={itemIndex} className="flex items-center space-x-2">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
);

// Loading overlay for existing content
interface LoadingOverlayProps {
  isLoading: boolean;
  children: React.ReactNode;
  message?: string;
}

export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({
  isLoading,
  children,
  message = "Loading..."
}) => (
  <div className="relative">
    {children}
    {isLoading && (
      <div className="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center z-10">
        <div className="text-center">
          <LoadingSpinner size="lg" className="mb-2" />
          <p className="text-gray-600 text-sm">{message}</p>
        </div>
      </div>
    )}
  </div>
);