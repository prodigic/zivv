/**
 * Virtualized Event List with infinite scroll using react-virtuoso
 */

import React, { useCallback, useRef, useEffect } from "react";
import { Virtuoso } from "react-virtuoso";
import EventCard from "./EventCard";
import { EventCardSkeleton } from "./LoadingSpinner";
import type { Event } from "@/types/events";

interface VirtualizedEventListProps {
  events: Event[];
  isLoading?: boolean;
  viewMode?: "wide" | "narrow";
  onEndReached?: () => void;
  hasMore?: boolean;
}

const VirtualizedEventList: React.FC<VirtualizedEventListProps> = ({
  events,
  isLoading = false,
  viewMode = "wide",
  onEndReached,
  hasMore = false,
}) => {
  const footerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Set up Intersection Observer for narrow view
  useEffect(() => {
    if (viewMode !== "narrow" || !footerRef.current || !onEndReached) return;

    const footerElement = footerRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isLoading && hasMore) {
          onEndReached();
        }
      },
      {
        threshold: 0.1,
        root: scrollContainerRef.current, // Use the scroll container as the root
      }
    );

    observer.observe(footerElement);

    return () => {
      observer.unobserve(footerElement);
    };
  }, [viewMode, onEndReached, isLoading, hasMore]);

  // Item renderer for virtuoso
  const itemContent = useCallback(
    (index: number) => {
      const event = events[index];
      if (!event) {
        return <EventCardSkeleton />;
      }
      return <EventCard event={event} index={index} viewMode={viewMode} />;
    },
    [events, viewMode]
  );

  // List container with padding to prevent clipping on hover
  const List = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => {
    return (
      <div
        {...props}
        ref={ref}
        style={{
          ...props.style,
          padding: "1em",
        }}
      />
    );
  });
  List.displayName = "VirtuosoList";

  // Footer renderer for loading state
  const Footer = useCallback(() => {
    if (!isLoading && !hasMore) {
      return null;
    }

    if (isLoading) {
      return (
        <div className="py-8 flex justify-center">
          <div className="flex items-center space-x-2">
            <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
            <span className="text-gray-600 dark:text-gray-400">
              Loading more events...
            </span>
          </div>
        </div>
      );
    }

    return null;
  }, [isLoading, hasMore]);

  // Empty state
  if (events.length === 0 && !isLoading) {
    return (
      <div className="text-center py-12">
        <div className="text-gray-400 mb-4">
          <svg
            className="w-12 h-12 mx-auto mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
          No events found
        </h3>
        <p className="text-gray-600 dark:text-gray-400">
          Try adjusting your search or filters
        </p>
      </div>
    );
  }

  // Loading initial state
  if (events.length === 0 && isLoading) {
    return (
      <div className="space-y-4">
        <EventCardSkeleton />
        <EventCardSkeleton />
        <EventCardSkeleton />
      </div>
    );
  }

  // For narrow view, don't use virtualization - it doesn't work well with grid layouts
  if (viewMode === "narrow") {
    return (
      <div
        ref={scrollContainerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          scrollbarWidth: "none", // Firefox
          msOverflowStyle: "none", // IE/Edge
        }}
        className="[&::-webkit-scrollbar]:hidden"
      >
        <div className="flex flex-wrap gap-4 justify-start items-start p-4 flex-shrink-0">
          {events.map((event, index) => (
            <EventCard
              key={event.id}
              event={event}
              index={index}
              viewMode={viewMode}
            />
          ))}
        </div>

        {/* Sentinel element for intersection observer - triggers infinite scroll */}
        <div
          ref={footerRef}
          className="flex-shrink-0 w-full py-4 flex justify-center"
          style={{ minHeight: "60px" }}
        >
          {isLoading && hasMore && (
            <div className="flex items-center space-x-2">
              <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
              <span className="text-gray-600 dark:text-gray-400">
                Loading more events...
              </span>
            </div>
          )}
          {!isLoading && hasMore && (
            <span className="text-gray-500 dark:text-gray-400 text-sm">
              Scroll for more...
            </span>
          )}
          {!hasMore && events.length > 0 && (
            <span className="text-gray-500 dark:text-gray-400 text-sm">
              All events loaded
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <Virtuoso
      style={{
        height: "100%",
        scrollbarWidth: "none", // Firefox
        msOverflowStyle: "none", // IE/Edge
      }}
      className="[&::-webkit-scrollbar]:hidden"
      data={events}
      endReached={onEndReached}
      itemContent={itemContent}
      components={{
        List,
        Footer,
      }}
      overscan={200}
      increaseViewportBy={{ top: 400, bottom: 400 }}
    />
  );
};

export default React.memo(VirtualizedEventList);
