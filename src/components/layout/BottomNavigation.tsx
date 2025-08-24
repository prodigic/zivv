/**
 * Bottom navigation for mobile devices
 */

import React from "react";
import { NavLink, useLocation } from "react-router-dom";

interface BottomNavigationProps {
  className?: string;
}

export const BottomNavigation: React.FC<BottomNavigationProps> = ({ className = "" }) => {
  const location = useLocation();

  const navigation = [
    {
      name: "Home",
      to: "/",
      icon: (active: boolean) => (
        <svg 
          className={`h-6 w-6 ${active ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`} 
          fill={active ? "currentColor" : "none"} 
          viewBox="0 0 24 24" 
          stroke="currentColor"
        >
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={active ? 0 : 2} 
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2z" 
          />
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={active ? 0 : 2} 
            d="M8 5a2 2 0 012-2h4a2 2 0 012 2v2H8V5z" 
          />
        </svg>
      ),
    },
    {
      name: "Calendar",
      to: "/calendar",
      icon: (active: boolean) => (
        <svg 
          className={`h-6 w-6 ${active ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`} 
          fill={active ? "currentColor" : "none"} 
          viewBox="0 0 24 24" 
          stroke="currentColor"
        >
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={active ? 0 : 2} 
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" 
          />
        </svg>
      ),
    },
    {
      name: "Artists",
      to: "/artists",
      icon: (active: boolean) => (
        <svg 
          className={`h-6 w-6 ${active ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`} 
          fill={active ? "currentColor" : "none"} 
          viewBox="0 0 24 24" 
          stroke="currentColor"
        >
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={active ? 0 : 2} 
            d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" 
          />
        </svg>
      ),
    },
    {
      name: "Venues",
      to: "/venues",
      icon: (active: boolean) => (
        <svg 
          className={`h-6 w-6 ${active ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`} 
          fill={active ? "currentColor" : "none"} 
          viewBox="0 0 24 24" 
          stroke="currentColor"
        >
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={active ? 0 : 2} 
            d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" 
          />
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={active ? 0 : 2} 
            d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" 
          />
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
      <div className="grid grid-cols-4 h-16">
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
      </div>
    </nav>
  );
};