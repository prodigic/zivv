/**
 * Bottom navigation for mobile devices
 */

import React from "react";
import { NavLink, useLocation } from "react-router-dom";
import { FilterButton } from "@/components/filters/FilterModalContext";

interface BottomNavigationProps {
  className?: string;
}

export const BottomNavigation: React.FC<BottomNavigationProps> = ({ className = "" }) => {
  const location = useLocation();

  const navigation = [
    {
      name: "All",
      to: "/",
      icon: (active: boolean) => (
        <svg className={`h-6 w-6 ${active ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </svg>
      ),
    },
    {
      name: "Calendar",
      to: "/calendar",
      icon: (active: boolean) => (
        <svg className={`h-6 w-6 ${active ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      name: "Latest",
      to: "/new",
      icon: (active: boolean) => (
        <svg className={`h-6 w-6 ${active ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
    },
    {
      name: "Local",
      to: "/local-artists",
      icon: (active: boolean) => (
        <svg className={`h-6 w-6 ${active ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
        </svg>
      ),
    },
  ];

  // Check if current path matches navigation item
  const isActive = (to: string) => {
    if (to === "/") {
      return location.pathname === "/";
    }
    return location.pathname.startsWith(to);
  };

  return (
    <nav className={`fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 ${className}`}>
      <div className="grid grid-cols-5 h-16">
        {navigation.map((item) => {
          const active = isActive(item.to);

          return (
            <NavLink
              key={item.name}
              to={item.to}
              className={({ isActive }) => `
                flex flex-col items-center justify-center space-y-1 transition-colors
                ${isActive || active ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"}
              `}
            >
              {item.icon(active)}
              <span className={`text-xs font-medium ${active ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`}>
                {item.name}
              </span>
            </NavLink>
          );
        })}

        {/* Filter Button - Mobile Only */}
        <FilterButton isMobile={true} />
      </div>
    </nav>
  );
};