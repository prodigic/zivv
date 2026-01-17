/**
 * Event Card Component - Punk rock ticket design
 * Optimized with React.memo for virtualization performance
 */

import React from "react";
import { useAppStore } from "@/stores/appStore.ts";
import type { Event, Artist, ArtistId } from "@/types/events";

// City display name mapping
const getCityDisplayName = (cityName: string): string => {
  const cityMappings: Record<string, string> = {
    Santa: "Santa Cruz",
    "S.f": "San Francisco",
    Uc: "Berkeley", // UC Berkeley area
    San: "San Jose", // Partial city names
    "140": "San Francisco", // Venue address codes
    "2045": "San Francisco",
    "23": "Petaluma",
    "27826": "Unknown",
    Mountain: "Mountain View",
  };

  return cityMappings[cityName] || cityName;
};

interface EventCardProps {
  event: Event;
  index?: number;
  viewMode?: "wide" | "narrow";
}

const EventCard: React.FC<EventCardProps> = ({
  event,
  index,
  viewMode = "wide",
}) => {
  const getArtist = useAppStore((state) => state.getArtist);
  const getVenue = useAppStore((state) => state.getVenue);

  const formatDate = (epochMs: number) => {
    const date = new Date(epochMs);
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatTime = (epochMs: number) => {
    const date = new Date(epochMs);
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  // Get venue details
  const venue = event.venueId ? getVenue(event.venueId) : null;

  // Get artist details
  const artists = event.artistIds
    ? event.artistIds
        .map((id: ArtistId) => getArtist(id))
        .filter((artist): artist is Artist => artist !== null && artist !== undefined)
    : [];
  const headlinerArtist = event.headlinerArtistId
    ? getArtist(event.headlinerArtistId)
    : null;

  // Generate variant colors based on event ID
  const colorVariants = [
    {
      bg: "linear-gradient(45deg, #fef3c7 0%, #fed7aa 100%)",
      border: "#d97706",
      header: "#d97706",
    }, // Orange
    {
      bg: "linear-gradient(45deg, #ddd6fe 0%, #c7d2fe 100%)",
      border: "#7c3aed",
      header: "#7c3aed",
    }, // Purple
    {
      bg: "linear-gradient(45deg, #fecaca 0%, #fed7d7 100%)",
      border: "#dc2626",
      header: "#dc2626",
    }, // Red
    {
      bg: "linear-gradient(45deg, #bbf7d0 0%, #d1fae5 100%)",
      border: "#059669",
      header: "#059669",
    }, // Green
    {
      bg: "linear-gradient(45deg, #bfdbfe 0%, #dbeafe 100%)",
      border: "#2563eb",
      header: "#2563eb",
    }, // Blue
    {
      bg: "linear-gradient(45deg, #fde68a 0%, #fef3c7 100%)",
      border: "#d97706",
      header: "#d97706",
    }, // Yellow
  ];

  const colorIndex = Math.abs(event.id) % colorVariants.length;
  const colors = colorVariants[colorIndex];

  // Create background text pattern
  const backgroundText = `${headlinerArtist?.name || "PUNK SHOW"} • ${venue?.name || "VENUE"} • `;

  // Generate random rotation between -1 and 1 degrees
  const randomRotation = (Math.random() - 0.5) * 2; // -1 to +1 degrees

  return (
    <div
      className={`mb-8 ${viewMode === "narrow" ? "w-full max-w-[250px]" : ""}`}
    >
      <div
        className={`relative border-2 border-dashed rounded-none shadow-lg transition-transform duration-200 overflow-hidden ${
          viewMode === "narrow" ? "text-xs" : ""
        }`}
        style={{
          background: colors.bg,
          borderLeft: `8px solid ${colors.border}`,
          borderRight: `8px solid ${colors.border}`,
          borderColor: colors.border,
          fontFamily: "monospace",
          transform: `rotate(${randomRotation}deg)`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = `rotate(${randomRotation}deg) scale(1.05)`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = `rotate(${randomRotation}deg)`;
        }}
      >
        {/* Background Pattern */}
        <div
          className="absolute inset-0 pointer-events-none select-none"
          style={{
            fontSize: "2rem",
            fontWeight: "bold",
            color: "rgba(0,0,0,0.05)",
            transform: "rotate(25deg) translateX(-20%) translateY(-20%)",
            lineHeight: "2.5rem",
            whiteSpace: "nowrap",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            width: "200%",
            height: "200%",
          }}
        >
          {Array.from({ length: 15 }, (_, i) => (
            <div
              key={i}
              style={{ transform: `translateX(${(i % 2) * -50}px)` }}
            >
              {backgroundText.repeat(10)}
            </div>
          ))}
        </div>

        {/* Ticket Header */}
        <div
          className="text-white text-center py-2 text-xs font-bold tracking-wider border-b-2 border-dashed"
          style={{
            backgroundColor: colors.header,
            borderColor: colors.border,
          }}
        >
          {viewMode === "narrow" ? (
            <>
              {formatDate(event.dateEpochMs)}
              {event.startTimeEpochMs && (
                <> • {formatTime(event.startTimeEpochMs)}</>
              )}
            </>
          ) : (
            "✦ PUNK ROCK SHOW TICKET ✦"
          )}
        </div>

        {/* Main Content - Full Width */}
        <div className="p-6">
          {/* Main Artist Name - Full Width */}
          <h2
            className={`font-bold text-gray-900 mb-3 tracking-tight ${
              viewMode === "narrow" ? "text-lg" : "text-2xl"
            }`}
            style={{ textShadow: "1px 1px 0px rgba(0,0,0,0.1)" }}
          >
            {headlinerArtist?.name || `Event ${event.id}`}
          </h2>

          {/* Date/Time Info (Wide View Only) */}
          {viewMode !== "narrow" && (
            <div className="space-y-1 text-sm text-gray-700 mb-3">
              <div className="flex items-center">
                <span className="font-bold w-12">DATE:</span>
                <span className="font-mono">
                  {formatDate(event.dateEpochMs)}
                </span>
              </div>

              {event.startTimeEpochMs && (
                <div className="flex items-center">
                  <span className="font-bold w-12">TIME:</span>
                  <span className="font-mono">
                    {formatTime(event.startTimeEpochMs)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Supporting Artists */}
          {artists.length > 1 && (
            <div className="mb-3">
              {viewMode !== "narrow" && (
                <span className="font-bold text-sm text-gray-700">WITH: </span>
              )}
              <span className="font-mono text-sm text-gray-600">
                {artists
                  .slice(1)
                  .map((artist: Artist) => artist?.name)
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </div>
          )}

          {/* Price */}
          {(event.priceMin || event.priceMax || event.isFree) && (
            <div className="mt-4">
              <span
                className={`bg-red-600 text-white rounded font-bold shadow-inner inline-block ${
                  viewMode === "narrow"
                    ? "px-2 py-1 text-sm"
                    : "px-3 py-2 text-lg"
                }`}
              >
                {event.isFree
                  ? "FREE"
                  : event.priceMin === event.priceMax
                    ? `$${Math.ceil(event.priceMin || 0)}`
                    : `$${Math.ceil(event.priceMin || 0)}-$${Math.ceil(event.priceMax || 0)}`}
              </span>
            </div>
          )}
        </div>

        {/* Ticket Footer - Venue Info */}
        <div
          className="border-t-2 border-dashed px-4 py-2 text-xs text-gray-600"
          style={{
            backgroundColor: `${colors.border}20`, // 20% opacity of border color
            borderColor: colors.border,
          }}
        >
          <div className="text-center">
            <span className="font-mono font-bold">
              {venue
                ? `${venue.name.toUpperCase()} • ${getCityDisplayName(venue.city).toUpperCase()}`
                : "VENUE TBA"}
            </span>
          </div>
        </div>

        {/* SOLD OUT Stamp */}
        {(event.status === "sold-out" || event.tags.includes("sold-out")) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
            <img
              src="/src/assets/soldout-transparent.png"
              alt="SOLD OUT"
              className="transform rotate-12 w-64 h-auto drop-shadow-2xl"
            />
          </div>
        )}

        {/* Perforated Edge Effects */}
        <div
          className="absolute -left-2 top-0 bottom-0 w-4 bg-white opacity-60 pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle, transparent 2px, white 2px)",
            backgroundSize: "8px 8px",
          }}
        ></div>
        <div
          className="absolute -right-2 top-0 bottom-0 w-4 bg-white opacity-60 pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle, transparent 2px, white 2px)",
            backgroundSize: "8px 8px",
          }}
        ></div>
      </div>

      {/* Debug Information - All Event Data */}
      <div className="debug-info mt-2 text-xs bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono p-3 rounded border-2 border-gray-300 dark:border-gray-600">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {index !== undefined && (
            <div>
              <span className="text-purple-700 dark:text-purple-300 font-bold">
                Position:
              </span>{" "}
              {index + 1}
            </div>
          )}
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              ID:
            </span>{" "}
            {event.id}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Slug:
            </span>{" "}
            {event.slug}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Status:
            </span>{" "}
            {event.status}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              VenueType:
            </span>{" "}
            {event.venueType}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              AgeRestrict:
            </span>{" "}
            {event.ageRestriction}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Timezone:
            </span>{" "}
            {event.timezone}
          </div>
          {event.description && (
            <div className="col-span-2">
              <span className="text-blue-700 dark:text-blue-300 font-bold">
                Desc:
              </span>{" "}
              {event.description}
            </div>
          )}
          {event.notes && (
            <div className="col-span-2">
              <span className="text-blue-700 dark:text-blue-300 font-bold">
                Notes:
              </span>{" "}
              {event.notes}
            </div>
          )}
          {event.ticketUrl && (
            <div className="col-span-2">
              <span className="text-blue-700 dark:text-blue-300 font-bold">
                Tix:
              </span>{" "}
              {event.ticketUrl}
            </div>
          )}
          {event.tags.length > 0 && (
            <div className="col-span-2">
              <span className="text-blue-700 dark:text-blue-300 font-bold">
                Tags:
              </span>{" "}
              {event.tags.join(", ")}
            </div>
          )}
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              SrcLine:
            </span>{" "}
            {event.sourceLineNumber}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Created:
            </span>{" "}
            {new Date(event.createdAtEpochMs).toLocaleDateString()}
          </div>
        </div>
      </div>
    </div>
  );
};

// Memoize for virtualization performance
export default React.memo(EventCard);
