/**
 * Dark mode toggle component
 */

import React, { useState, useEffect } from "react";
import { useDarkMode } from "@/hooks/useDarkMode";

interface DarkModeToggleProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

export const DarkModeToggle: React.FC<DarkModeToggleProps> = ({ 
  className = "", 
  size = "md" 
}) => {
  const { toggle, isDarkMode } = useDarkMode();
  const [isCurrentlyDark, setIsCurrentlyDark] = useState(false);

  useEffect(() => {
    setIsCurrentlyDark(isDarkMode());
  }, [isDarkMode]);

  const handleToggle = () => {
    const componentStartTime = performance.now();
    console.log("🔘 Toggle button clicked");
    
    toggle();
    
    const stateUpdateTime = performance.now();
    setIsCurrentlyDark(!isCurrentlyDark);
    console.log("🔘 React state update took:", performance.now() - stateUpdateTime, "ms");
    console.log("🔘 Button component total time:", performance.now() - componentStartTime, "ms");
  };
  
  const sizeClasses = {
    sm: "h-5 w-9",
    md: "h-6 w-11", 
    lg: "h-8 w-14",
  };
  
  const knobSizes = {
    sm: "h-4 w-4",
    md: "h-5 w-5",
    lg: "h-7 w-7",
  };

  return (
    <button
      onClick={handleToggle}
      className={`
        relative inline-flex ${sizeClasses[size]} items-center rounded-full 
        transition-colors duration-200 ease-in-out focus:outline-none 
        focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 
        focus:ring-offset-white dark:focus:ring-offset-gray-800
        ${isCurrentlyDark 
          ? "bg-primary-600 hover:bg-primary-700" 
          : "bg-gray-200 hover:bg-gray-300"
        }
        ${className}
      `}
      aria-label={isCurrentlyDark ? "Switch to light mode" : "Switch to dark mode"}
      role="switch"
      aria-checked={isCurrentlyDark}
    >
      {/* Toggle knob */}
      <span
        className={`
          inline-block ${knobSizes[size]} transform rounded-full bg-white 
          shadow-lg transition-transform duration-200 ease-in-out
          ${isCurrentlyDark 
            ? size === 'sm' 
              ? 'translate-x-4' 
              : size === 'md' 
                ? 'translate-x-5' 
                : 'translate-x-6'
            : "translate-x-0"
          }
        `}
      >
        {/* Icon inside knob */}
        <span className="flex items-center justify-center h-full w-full">
          {isCurrentlyDark ? (
            // Moon icon
            <svg
              className={`${size === 'sm' ? 'h-3 w-3' : size === 'md' ? 'h-3 w-3' : 'h-4 w-4'} text-primary-600`}
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            // Sun icon
            <svg
              className={`${size === 'sm' ? 'h-3 w-3' : size === 'md' ? 'h-3 w-3' : 'h-4 w-4'} text-yellow-500`}
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </span>
      </span>
    </button>
  );
};

// Compact version for mobile/header use
export const CompactDarkModeToggle: React.FC<{ className?: string }> = ({ 
  className = "" 
}) => {
  const { toggle, isDarkMode } = useDarkMode();
  const [isCurrentlyDark, setIsCurrentlyDark] = useState(false);

  useEffect(() => {
    setIsCurrentlyDark(isDarkMode());
  }, [isDarkMode]);

  const handleClick = () => {
    const componentStartTime = performance.now();
    console.log("🔘 Compact toggle button clicked");
    
    toggle();
    
    const stateUpdateTime = performance.now();
    setIsCurrentlyDark(!isCurrentlyDark);
    console.log("🔘 Compact React state update took:", performance.now() - stateUpdateTime, "ms");
    console.log("🔘 Compact button component total time:", performance.now() - componentStartTime, "ms");
  };

  return (
    <button
        onClick={handleClick}
        className={`
          p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100
          dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700
          transition-colors duration-200 focus:outline-none 
          ${className}
        `}
        aria-label={isCurrentlyDark ? "Switch to light mode" : "Switch to dark mode"}
      >
      {isCurrentlyDark ? (
        // Sun icon for light mode
        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        // Moon icon for dark mode
        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"
            clipRule="evenodd"
          />
        </svg>
      )}
    </button>
  );
};