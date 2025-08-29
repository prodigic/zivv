/**
 * Side navigation for desktop layout
 */

import React from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAppStore } from "@/stores/appStore.ts";
import { useFilterStore } from "@/stores/filterStore.ts";
import { DebugToggle } from "@/components/ui/DebugToggle.tsx";

interface SideNavigationProps {
  isOpen: boolean;
  onClose: () => void;
  className?: string;
}

export const SideNavigation: React.FC<SideNavigationProps> = ({ 
  onClose, 
  className = "" 
}) => {
  const location = useLocation();
  const { manifest, getUpcomingEvents } = useAppStore();
  const { hasActiveFilters, getFilterSummary } = useFilterStore();

  const upcomingEvents = getUpcomingEvents(3);

  const navigation = [
    {
      name: "All Events",
      to: "/",
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14-7v4M5 4v4m0 0v10a2 2 0 002 2h10a2 2 0 002-2V8M7 8h10" />
        </svg>
      ),
      count: manifest?.totalEvents,
    },
    {
      name: "Calendar",
      to: "/calendar",
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      name: "Artists",
      to: "/artists",
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" />
        </svg>
      ),
      count: manifest?.totalArtists,
    },
    {
      name: "Venues",
      to: "/venues", 
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      count: manifest?.totalVenues,
    },
    {
      name: "About",
      to: "/about",
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
  ];

  const calendarSubNav = [
    { name: "Month View", to: "/calendar/month" },
    { name: "Week View", to: "/calendar/week" },
    { name: "Agenda", to: "/calendar/agenda" },
  ];

  // Check if current path matches navigation item
  const isActive = (to: string) => {
    if (to === "/") {
      return location.pathname === "/";
    }
    return location.pathname.startsWith(to);
  };

  return (
    <aside className={`bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 ${className}`}>
      <div className="flex flex-col h-full">
        
        {/* Header - Mobile Only */}
        <div className="lg:hidden flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="text-lg font-semibold text-gray-900 dark:text-white">Menu</div>
          <button
            onClick={onClose}
            className="p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          
          {/* Main Navigation */}
          {navigation.map((item) => {
            const active = isActive(item.to);
            
            return (
              <div key={item.name}>
                <NavLink
                  to={item.to}
                  onClick={() => onClose()}
                  className={({ isActive }) => `
                    group flex items-center justify-between px-3 py-2 text-sm font-medium rounded-md transition-colors
                    ${isActive || active 
                      ? "bg-blue-50 dark:bg-blue-900/50 border-blue-500 text-blue-700 dark:text-blue-300 border-r-2" 
                      : "text-gray-700 hover:text-gray-900 hover:bg-gray-50 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-700"
                    }
                  `}
                >
                  <div className="flex items-center space-x-3">
                    <span className={active ? "text-blue-500 dark:text-blue-400" : "text-gray-400 group-hover:text-gray-500 dark:text-gray-500 dark:group-hover:text-gray-400"}>
                      {item.icon}
                    </span>
                    <span>{item.name}</span>
                  </div>
                  
                  {item.count !== undefined && (
                    <span className={`text-xs px-2 py-1 rounded-full ${
                      active 
                        ? "bg-blue-100 dark:bg-blue-800 text-blue-600 dark:text-blue-200" 
                        : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                    }`}>
                      {item.count}
                    </span>
                  )}
                </NavLink>
                
                {/* Calendar Sub-navigation */}
                {item.to === "/calendar" && active && (
                  <div className="mt-1 ml-8 space-y-1">
                    {calendarSubNav.map((subItem) => (
                      <NavLink
                        key={subItem.name}
                        to={subItem.to}
                        onClick={() => onClose()}
                        className={({ isActive }) => `
                          block px-3 py-1 text-sm rounded-md transition-colors
                          ${isActive 
                            ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/50" 
                            : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                          }
                        `}
                      >
                        {subItem.name}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Current Filters - if any */}
        {hasActiveFilters && (
          <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700">
            <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
              Active Filters
            </div>
            <div className="text-xs text-gray-600 dark:text-gray-400">
              {getFilterSummary()}
            </div>
          </div>
        )}

        {/* Quick Stats / Upcoming Events */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-3">
            Coming Up
          </div>
          
          {upcomingEvents.length > 0 ? (
            <div className="space-y-2">
              {upcomingEvents.map((event) => (
                <div key={event.id} className="text-xs">
                  <div className="font-medium text-gray-900 dark:text-gray-100 truncate">
                    Event {event.id} {/* Would show artist name */}
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {new Date(event.dateEpochMs).toLocaleDateString()}
                  </div>
                </div>
              ))}
              
              <NavLink
                to="/"
                onClick={() => onClose()}
                className="inline-block text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium mt-2"
              >
                View all →
              </NavLink>
            </div>
          ) : (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              No upcoming events
            </div>
          )}
        </div>

        {/* Data Info & Debug Toggle */}
        {manifest && (
          <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700">
            <div className="text-xs text-gray-500 dark:text-gray-400 space-y-2">
              <div>
                Last updated: {new Date(manifest.lastUpdated).toLocaleDateString()}
              </div>
              <div>
                {manifest.totalEvents} events • {manifest.totalArtists} artists • {manifest.totalVenues} venues
              </div>
              
              {/* Debug Toggle */}
              <div className="pt-2 border-t border-gray-200 dark:border-gray-600">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Debug Mode:</span>
                  <div className="scale-75">
                    <DebugToggle />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};