/**
 * Debug Toggle Component
 * Toggles debug information visibility across the app
 */

import React, { useState, useEffect } from "react";

export const DebugToggle: React.FC = () => {
  const [isDebugVisible, setIsDebugVisible] = useState(() => {
    // Check localStorage for saved preference
    const saved = localStorage.getItem('zivv-debug-mode');
    return saved === 'true';
  });

  // Apply/remove debug class from body
  useEffect(() => {
    const body = document.body;
    if (isDebugVisible) {
      body.classList.remove('hide-debug');
    } else {
      body.classList.add('hide-debug');
    }

    // Save preference
    localStorage.setItem('zivv-debug-mode', isDebugVisible.toString());
  }, [isDebugVisible]);

  // Initialize on mount
  useEffect(() => {
    const body = document.body;
    if (!isDebugVisible) {
      body.classList.add('hide-debug');
    }
  }, [isDebugVisible]);

  const toggleDebug = () => {
    setIsDebugVisible(!isDebugVisible);
  };

  return (
    <button
      onClick={toggleDebug}
      className={`
        relative p-1.5 rounded transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500
        ${isDebugVisible 
          ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' 
          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
        }
      `}
      title={isDebugVisible ? "Hide debug info" : "Show debug info"}
      aria-label={`${isDebugVisible ? 'Hide' : 'Show'} debug information`}
    >
      {/* Debug Icon - simplified for compact view */}
      <svg 
        className="w-4 h-4" 
        fill="none" 
        stroke="currentColor" 
        viewBox="0 0 24 24"
      >
        {isDebugVisible ? (
          // Bug icon when debug is visible  
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={2.5} 
            d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" 
          />
        ) : (
          // Code icon when debug is hidden
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            strokeWidth={2.5} 
            d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" 
          />
        )}
      </svg>

      {/* Debug indicator dot - smaller for compact view */}
      {isDebugVisible && (
        <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-blue-500 rounded-full"></div>
      )}
    </button>
  );
};